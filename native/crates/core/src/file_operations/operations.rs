use super::{TRASH, parent, read};
use cap_fs_ext::DirExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, DirBuilder, DirBuilderExt, Metadata, MetadataExt, OpenOptions},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{ErrorKind, Write},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_METADATA: u64 = 16 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Directory,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: u64,
    inode: u64,
}
impl Identity {
    fn of(meta: &Metadata) -> Self {
        Self { device: meta.dev(), inode: meta.ino() }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    format: u8,
    id: String,
    path: String,
    kind: Kind,
    version: Option<String>,
    deleted_at: u64,
    identity: Identity,
}

struct Source {
    kind: Kind,
    version: Option<String>,
    identity: Identity,
}

fn text<'a>(p: &'a Value, name: &str) -> Result<&'a str, String> {
    p[name].as_str().ok_or_else(|| format!("Missing {name}"))
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn expected(p: &Value) -> Result<Option<String>, String> {
    match p.get("version") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(hash)) if hash_valid(hash) => Ok(Some(hash.clone())),
        _ => Err("Expected file version or null for a directory".into()),
    }
}
fn metadata(dir: &Dir, name: &str) -> Result<Metadata, String> {
    dir.symlink_metadata(name).map_err(|e| e.to_string())
}
fn source(dir: &Dir, name: &str, expected: &Option<String>) -> Result<Source, String> {
    let meta = metadata(dir, name)?;
    let kind = if meta.is_file() {
        Kind::File
    } else if meta.is_dir() {
        Kind::Directory
    } else {
        return Err("Expected regular file or directory, not a symlink".into());
    };
    let version = match kind {
        Kind::File => Some(blake3::hash(&read(dir, name, MAX_FILE)?).to_hex().to_string()),
        Kind::Directory => {
            // A directory handle proves its shape without traversing or dereferencing its contents.
            let opened = dir.open_dir_nofollow(name).map_err(|e| e.to_string())?;
            if Identity::of(&opened.dir_metadata().map_err(|e| e.to_string())?) != Identity::of(&meta) {
                return Err("Directory identity conflict".into());
            }
            None
        }
    };
    if &version != expected {
        return Err("File version conflict (directories require null)".into());
    }
    let result = Source { kind, version, identity: Identity::of(&meta) };
    revalidate(dir, name, &result)?;
    Ok(result)
}
fn revalidate(dir: &Dir, name: &str, source: &Source) -> Result<(), String> {
    let meta = metadata(dir, name)?;
    let shape = match source.kind {
        Kind::File => meta.is_file(),
        Kind::Directory => meta.is_dir(),
    };
    if !shape || Identity::of(&meta) != source.identity {
        return Err("Source identity conflict".into());
    }
    if source.kind == Kind::File
        && Some(blake3::hash(&read(dir, name, MAX_FILE)?).to_hex().to_string()) != source.version
    {
        return Err("File version conflict".into());
    }
    Ok(())
}

/// Only single validated names cross this syscall boundary. Unlike check+rename,
/// NOREPLACE is atomic against an external destination creator, including symlinks.
fn rename(from: &Dir, name: &str, to: &Dir, destination: &str) -> Result<(), String> {
    rustix::fs::renameat_with(from, name, to, destination, rustix::fs::RenameFlags::NOREPLACE)
        .map_err(|e| format!("Atomic move failed (destination occupied or filesystem unsupported): {e}"))
}
fn sync(dir: &Dir) -> Result<(), String> {
    // cap-std directory capabilities may be O_PATH handles, which cannot fsync.
    // Reopen "." relative to the retained capability as a readable descriptor.
    dir.open(".").map_err(|e| e.to_string())?.sync_all().map_err(|e| e.to_string())
}
fn absent(dir: &Dir, name: &str) -> Result<bool, String> {
    match dir.symlink_metadata(name) {
        Ok(_) => Ok(false),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
fn write_json(dir: &Dir, name: &str, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut file = dir.open_with(name, OpenOptions::new().write(true).create_new(true))
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    sync(dir)
}

/// The trusted receipt is outside the workspace, beside its index database.
/// Neither a marker planted inside a preexisting directory nor a symlink can
/// authorize adoption. A missing/corrupt receipt leaves all payloads untouched.
fn storage(root: &Dir, workspace: &crate::workspace::Workspace, create: bool) -> Result<Option<Dir>, String> {
    let receipt_path = workspace.database.with_extension("trash-owner.json");
    let receipt_parent = receipt_path.parent().ok_or("Missing receipt parent")?;
    let receipt_name = receipt_path.file_name().and_then(|s| s.to_str()).ok_or("Invalid receipt name")?;
    let trusted = Dir::open_ambient_dir(receipt_parent, ambient_authority()).map_err(|e| e.to_string())?;
    if absent(root, TRASH)? {
        if !absent(&trusted, receipt_name)? {
            return Err("Owned trash directory is missing; refusing replacement".into());
        }
        if !create {
            return Ok(None);
        }
        let mut builder = DirBuilder::new();
        builder.mode(0o700);
        root.create_dir_with(TRASH, &builder).map_err(|e| e.to_string())?;
        let trash = root.open_dir_nofollow(TRASH).map_err(|e| e.to_string())?;
        let identity = Identity::of(&trash.dir_metadata().map_err(|e| e.to_string())?);
        sync(root)?;
        write_json(&trusted, receipt_name, &identity)?;
        return Ok(Some(trash));
    }
    let trash = root.open_dir_nofollow(TRASH).map_err(|e| e.to_string())?;
    let bytes = read(&trusted, receipt_name, MAX_METADATA)
        .map_err(|e| format!("Unowned trash directory: {e}"))?;
    let identity: Identity = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid trash ownership: {e}"))?;
    if identity != Identity::of(&trash.dir_metadata().map_err(|e| e.to_string())?) {
        return Err("Unowned trash directory identity".into());
    }
    Ok(Some(trash))
}

fn entry(trash: &Dir, id: &str) -> Result<Option<(Dir, Record, Source)>, String> {
    if !hash_valid(id) {
        return Err("Invalid trash ID".into());
    }
    let dir = trash.open_dir_nofollow(id).map_err(|e| e.to_string())?;
    // A crash before the move or a completed restore leaves only metadata.
    if absent(&dir, "payload")? {
        return Ok(None);
    }
    let record: Record = serde_json::from_slice(&read(&dir, "metadata.json", MAX_METADATA)?)
        .map_err(|e| format!("Invalid trash metadata: {e}"))?;
    crate::services::path(&record.path, false)?;
    if record.format != 1 || record.id != id || record.deleted_at > 9_007_199_254_740_991
        || match record.kind {
            Kind::File => !record.version.as_deref().is_some_and(hash_valid),
            Kind::Directory => record.version.is_some(),
        }
    {
        return Err("Invalid trash metadata fields".into());
    }
    let payload = source(&dir, "payload", &record.version)?;
    if payload.kind != record.kind || payload.identity != record.identity {
        return Err("Trash payload identity conflict".into());
    }
    Ok(Some((dir, record, payload)))
}

pub(crate) fn request(root: &Dir, workspace: &crate::workspace::Workspace, method: &str, p: &Value) -> Result<Value, String> {
    match method {
        "files.move" => {
            let path = text(p, "path")?;
            let to = text(p, "to")?;
            let (from_dir, name) = parent(root, path)?;
            let (to_dir, destination) = parent(root, to)?;
            if path == to || to.starts_with(&format!("{path}/")) {
                return Err("Cannot move a path onto itself or into its descendant".into());
            }
            let source = source(&from_dir, &name, &expected(p)?)?;
            revalidate(&from_dir, &name, &source)?;
            rename(&from_dir, &name, &to_dir, &destination)?;
            sync(&to_dir).and_then(|()| sync(&from_dir))
                .map_err(|e| format!("Move completed to {to}, but durability sync failed: {e}"))?;
            Ok(json!({"path":path,"to":to,"kind":source.kind,"version":source.version}))
        }
        "files.trash" => {
            let path = text(p, "path")?;
            let (from_dir, name) = parent(root, path)?;
            let source = source(&from_dir, &name, &expected(p)?)?;
            let trash = storage(root, workspace, true)?.ok_or("Missing trash storage")?;
            let time = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
            let id = blake3::hash(format!("{}:{}:{}", time.as_nanos(), std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)).as_bytes()).to_hex().to_string();
            trash.create_dir(&id).map_err(|e| e.to_string())?;
            let dir = trash.open_dir_nofollow(&id).map_err(|e| e.to_string())?;
            let record = Record { format: 1, id: id.clone(), path: path.into(), kind: source.kind,
                version: source.version.clone(), deleted_at: u64::try_from(time.as_millis()).map_err(|e| e.to_string())?,
                identity: source.identity };
            write_json(&dir, "metadata.json", &record)?;
            sync(&trash)?;
            let source = source_from_record(&record);
            revalidate(&from_dir, &name, &source)?;
            rename(&from_dir, &name, &dir, "payload")?;
            sync(&dir).and_then(|()| sync(&from_dir))
                .map_err(|e| format!("Trash committed; recoverable ID {id}; durability sync failed: {e}"))?;
            Ok(json!({"id":id,"path":path,"kind":record.kind,"version":record.version}))
        }
        "files.trashList" => {
            let offset = match p.get("offset") {
                None => 0,
                Some(v) => v.as_u64().filter(|n| *n <= 1_000_000).ok_or("Invalid trash offset")?,
            };
            let Some(trash) = storage(root, workspace, false)? else {
                return Ok(json!({"entries":[],"nextOffset":null}));
            };
            let mut ids = Vec::new();
            for item in trash.entries().map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let id = item.file_name().into_string().map_err(|_| "Invalid trash entry name")?;
                if !hash_valid(&id) || ids.len() >= 100_000 {
                    return Err("Invalid or excessive trash entries".into());
                }
                ids.push(id);
            }
            ids.sort_unstable();
            let mut entries = Vec::new();
            let mut active = 0;
            let mut bytes = 128;
            let mut more = false;
            for id in ids {
                if let Some((_, record, _)) = entry(&trash, &id)? {
                    if active >= offset {
                        let item = json!({"id":record.id,"path":record.path,"kind":record.kind,
                            "version":record.version,"deletedAt":record.deleted_at});
                        let size = serde_json::to_vec(&item).map_err(|e| e.to_string())?.len() + 1;
                        if entries.len() == 20 || bytes + size >= 48 * 1024 {
                            more = true;
                            break;
                        }
                        bytes += size;
                        entries.push(item);
                    }
                    active += 1;
                }
            }
            let next = if more {
                Some(offset + u64::try_from(entries.len()).map_err(|e| e.to_string())?)
            } else {
                None
            };
            Ok(json!({"entries":entries,"nextOffset":next}))
        }
        "files.restoreTrash" => {
            let id = text(p, "id")?;
            if !hash_valid(id) { return Err("Invalid trash ID".into()); }
            let trash = storage(root, workspace, false)?.ok_or("Unknown trash ID")?;
            let (dir, record, source) = entry(&trash, id)?.ok_or("Trash entry has no payload")?;
            let to = match p.get("to") {
                None => record.path.as_str(),
                Some(Value::String(to)) => to,
                _ => return Err("Invalid restore destination".into()),
            };
            let (to_dir, destination) = parent(root, to)?;
            revalidate(&dir, "payload", &source)?;
            rename(&dir, "payload", &to_dir, &destination)?;
            sync(&to_dir).and_then(|()| sync(&dir))
                .map_err(|e| format!("Restore completed to {to}; durability sync failed: {e}"))?;
            Ok(json!({"path":to,"kind":record.kind,"version":record.version}))
        }
        _ => Err("Unknown file operation".into()),
    }
}

fn source_from_record(record: &Record) -> Source {
    Source { kind: record.kind, version: record.version.clone(),
        identity: Identity { device: record.identity.device, inode: record.identity.inode } }
}
