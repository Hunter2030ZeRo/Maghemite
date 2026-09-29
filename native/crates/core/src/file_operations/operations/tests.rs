use super::*;
use std::{fs, path::PathBuf};
use std::os::unix::fs::{PermissionsExt, symlink};

struct Fixture {
    temporary: PathBuf,
    root: PathBuf,
    workspace: u64,
}
impl Fixture {
    fn new() -> Self {
        let temporary = std::env::temp_dir().join(format!("maghemite-file-ops-{}-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&temporary).unwrap();
        let root = temporary.join("workspace");
        fs::create_dir(&root).unwrap();
        let workspace = crate::workspace::open(root.clone(), temporary.join("index.sqlite")).unwrap();
        Self { temporary, root, workspace }
    }
    fn call(&self, method: &str, p: Value) -> Result<Value, String> {
        crate::services::request(self.workspace, method, &p)
    }
    fn write(&self, path: &str, content: &str) -> String {
        fs::write(self.root.join(path), content).unwrap();
        blake3::hash(content.as_bytes()).to_hex().to_string()
    }
    fn cap(&self) -> Dir {
        Dir::open_ambient_dir(&self.root, ambient_authority()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        crate::workspace::close(self.workspace).unwrap();
        fs::remove_dir_all(&self.temporary).unwrap();
    }
}

#[test]
fn file_moves_without_changing_content_or_mode() {
    // Given a versioned executable file.
    let f = Fixture::new();
    let version = f.write("a", "bytes");
    fs::set_permissions(f.root.join("a"), fs::Permissions::from_mode(0o751)).unwrap();
    // When moving through the native service.
    let result = f.call("files.move", json!({"path":"a","to":"b","version":version})).unwrap();
    // Then the inode's contents and permissions survive.
    assert_eq!(result, json!({"path":"a","to":"b","kind":"file","version":version}));
    assert!(!f.root.join("a").exists());
    assert_eq!(fs::read(f.root.join("b")).unwrap(), b"bytes");
    assert_eq!(fs::metadata(f.root.join("b")).unwrap().permissions().mode() & 0o777, 0o751);
}

#[test]
fn directory_moves_with_nonempty_contents() {
    // Given a nonempty directory and a nested symlink that must not be followed.
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("a/nested")).unwrap();
    f.write("a/nested/file", "kept");
    symlink("/outside-not-followed", f.root.join("a/link")).unwrap();
    // When moving the directory as one filesystem object.
    let result = f.call("files.move", json!({"path":"a","to":"b","version":null})).unwrap();
    // Then nested contents and the symlink itself are preserved.
    assert_eq!(result["kind"], "directory");
    assert_eq!(result["version"], Value::Null);
    assert_eq!(fs::read(f.root.join("b/nested/file")).unwrap(), b"kept");
    assert_eq!(fs::read_link(f.root.join("b/link")).unwrap(), PathBuf::from("/outside-not-followed"));
}

#[test]
fn rejected_moves_never_destroy_source_or_destination() {
    // Given an occupied destination and a stale version.
    let f = Fixture::new();
    let version = f.write("a", "source");
    f.write("b", "destination");
    fs::create_dir(f.root.join("dir")).unwrap();
    fs::create_dir(f.root.join("dir/child")).unwrap();
    symlink(&f.temporary, f.root.join("escape")).unwrap();
    symlink("a", f.root.join("link")).unwrap();
    // When checking each invalid boundary independently.
    for input in [
        json!({"path":"a","to":"b","version":version}),
        json!({"path":"a","to":"new","version":blake3::hash(b"old").to_hex().to_string()}),
        json!({"path":"a","to":"../outside","version":version}),
        json!({"path":"a","to":"escape/outside","version":version}),
        json!({"path":"link","to":"new","version":version}),
        json!({"path":"dir","to":"dir/child/moved","version":null}),
        json!({"path":"","to":"new","version":null}),
        json!({"path":"a","to":"a","version":version}),
        json!({"path":"dir","to":"new","version":version}),
        json!({"path":"a","to":"/tmp/outside","version":version}),
    ] {
        assert!(f.call("files.move", input.clone()).is_err(), "{input}");
    }
    // Then all original content is still present.
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"source");
    assert_eq!(fs::read(f.root.join("b")).unwrap(), b"destination");
    assert!(f.root.join("dir/child").is_dir());
    assert!(!f.temporary.join("outside").exists());
}

#[test]
fn no_replace_syscall_rejects_a_destination_created_after_validation() {
    // Given an opened source and initially absent destination.
    let f = Fixture::new();
    let version = f.write("a", "source");
    let cap = f.cap();
    let validated = source(&cap, "a", &Some(version)).unwrap();
    assert!(absent(&cap, "b").unwrap());
    f.write("b", "external");
    revalidate(&cap, "a", &validated).unwrap();
    // When the external destination appears immediately before the syscall.
    assert!(rename(&cap, "a", &cap, "b").is_err());
    // Then the external file and source are untouched.
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"source");
    assert_eq!(fs::read(f.root.join("b")).unwrap(), b"external");
}

#[test]
fn directory_identity_rejects_a_replaced_source() {
    // Given a validated directory handle identity.
    let f = Fixture::new();
    fs::create_dir(f.root.join("a")).unwrap();
    let cap = f.cap();
    let original = source(&cap, "a", &None).unwrap();
    fs::rename(f.root.join("a"), f.root.join("original")).unwrap();
    fs::create_dir(f.root.join("a")).unwrap();
    // When revalidating after replacement.
    assert!(revalidate(&cap, "a", &original).is_err());
    // Then neither directory is moved or removed.
    assert!(f.root.join("original").is_dir());
    assert!(f.root.join("a").is_dir());
}

#[test]
fn trash_and_restore_survive_reopening_workspace() {
    // Given a directory with a nondefault mode and nested bytes.
    let mut f = Fixture::new();
    fs::create_dir_all(f.root.join("folder/nested")).unwrap();
    f.write("folder/nested/file", "recover");
    fs::set_permissions(f.root.join("folder"), fs::Permissions::from_mode(0o750)).unwrap();
    let trashed = f.call("files.trash", json!({"path":"folder","version":null})).unwrap();
    crate::workspace::close(f.workspace).unwrap();
    f.workspace = crate::workspace::open(f.root.clone(), f.temporary.join("index.sqlite")).unwrap();
    let listed = f.call("files.trashList", json!({})).unwrap();
    assert_eq!(listed["entries"][0]["id"], trashed["id"]);
    // When restoring by the durable ID after reopening.
    let restored = f.call("files.restoreTrash", json!({"id":trashed["id"]})).unwrap();
    // Then the directory and permissions are recovered and the ID is no longer listed.
    assert_eq!(restored, json!({"path":"folder","kind":"directory","version":null}));
    assert_eq!(fs::read(f.root.join("folder/nested/file")).unwrap(), b"recover");
    assert_eq!(fs::metadata(f.root.join("folder")).unwrap().permissions().mode() & 0o777, 0o750);
    assert_eq!(f.call("files.trashList", json!({})).unwrap()["entries"], json!([]));
}

#[test]
fn restore_collision_keeps_recoverable_payload() {
    // Given a trashed file whose original path was recreated externally.
    let f = Fixture::new();
    let version = f.write("a", "saved");
    fs::set_permissions(f.root.join("a"), fs::Permissions::from_mode(0o711)).unwrap();
    let trashed = f.call("files.trash", json!({"path":"a","version":version})).unwrap();
    f.write("a", "external");
    // When restoring onto the occupied original path.
    assert!(f.call("files.restoreTrash", json!({"id":trashed["id"]})).is_err());
    // Then the payload stays recoverable to a different path with its mode.
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"external");
    assert_eq!(f.call("files.trashList", json!({})).unwrap()["entries"].as_array().unwrap().len(), 1);
    f.call("files.restoreTrash", json!({"id":trashed["id"],"to":"b"})).unwrap();
    assert_eq!(fs::read(f.root.join("b")).unwrap(), b"saved");
    assert_eq!(fs::metadata(f.root.join("b")).unwrap().permissions().mode() & 0o777, 0o711);
}

#[test]
fn unowned_storage_is_not_adopted() {
    // Given a preexisting directory at the reserved name.
    let f = Fixture::new();
    let version = f.write("a", "source");
    fs::create_dir(f.root.join(TRASH)).unwrap();
    f.write(".maghemite-trash/user-data", "unowned");
    // When attempting trash initialization.
    assert!(f.call("files.trash", json!({"path":"a","version":version})).is_err());
    // Then neither user file is disturbed.
    assert_eq!(fs::read(f.root.join("a")).unwrap(), b"source");
    assert_eq!(fs::read(f.root.join(TRASH).join("user-data")).unwrap(), b"unowned");
}

#[test]
fn corrupt_metadata_and_symlink_aliases_cannot_escape_boundaries() {
    // Given a trashed file with tampered metadata and aliases to internal storage.
    let f = Fixture::new();
    let version = f.write("a", "source");
    let trashed = f.call("files.trash", json!({"path":"a","version":version})).unwrap();
    let id = trashed["id"].as_str().unwrap();
    let record_path = f.root.join(TRASH).join(id).join("metadata.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
    record["path"] = json!("../outside");
    fs::write(&record_path, serde_json::to_vec(&record).unwrap()).unwrap();
    symlink(TRASH, f.root.join("alias")).unwrap();
    // When restoring invalid metadata or using ordinary APIs through the reserved alias.
    assert!(f.call("files.restoreTrash", json!({"id":id})).is_err());
    for method in ["files.list", "files.read", "files.stat", "files.mkdir", "files.remove", "files.beginWrite"] {
        assert!(f.call(method, json!({"path":format!("alias/{id}/payload"),"version":version,"owner":"test"})).is_err());
        assert!(f.call(method, json!({"path":format!("{TRASH}/{id}/payload"),"version":version,"owner":"test"})).is_err());
    }
    // Then the payload remains in place and no outside file is created.
    assert_eq!(fs::read(f.root.join(TRASH).join(id).join("payload")).unwrap(), b"source");
    assert!(!f.temporary.join("outside").exists());
    assert!(f.call("files.list", json!({})).unwrap()["entries"].as_array().unwrap()
        .iter().all(|entry| entry["name"] != TRASH));
}

#[test]
fn active_upload_prevents_moving_its_parent_into_trash() {
    // Given a retained upload directory capability.
    let f = Fixture::new();
    fs::create_dir(f.root.join("folder")).unwrap();
    let upload = f.call("files.beginWrite", json!({"path":"folder/file","version":null,"owner":"test"})).unwrap();
    // When attempting to move the upload's parent into reserved storage.
    assert!(f.call("files.trash", json!({"path":"folder","version":null})).is_err());
    // Then the original parent remains and the upload can be explicitly aborted.
    assert!(f.root.join("folder").is_dir());
    f.call("files.abortWrite", json!({"upload":upload["upload"],"owner":"test"})).unwrap();
}

#[test]
fn interrupted_metadata_only_entry_is_not_restorable() {
    // Given durable metadata from a trash operation interrupted before the move.
    let f = Fixture::new();
    let workspace = crate::workspace::lookup(f.workspace).unwrap();
    let trash = storage(&f.cap(), &workspace, true).unwrap().unwrap();
    let id = "a".repeat(64);
    trash.create_dir(&id).unwrap();
    f.write("original", "still here");
    // When listing/recovering an entry with no payload.
    assert_eq!(f.call("files.trashList", json!({})).unwrap()["entries"], json!([]));
    assert!(f.call("files.restoreTrash", json!({"id":id})).is_err());
    // Then the source remains outside trash, untouched.
    assert_eq!(fs::read(f.root.join("original")).unwrap(), b"still here");
}
