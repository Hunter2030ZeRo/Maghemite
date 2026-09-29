use super::{request, types::PAGE_BYTES};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
// Quotas and owner release use a process-global registry. Isolate fixture
// lifetimes without serializing the concurrent readers/workers under test.
static SEARCH_TESTS: Mutex<()> = Mutex::new(());
pub(super) struct Fixture {
    pub root: PathBuf,
    pub workspace: u64,
    temporary: PathBuf,
    _serial: MutexGuard<'static, ()>,
}
impl Fixture {
    pub fn new() -> Self {
        let serial = SEARCH_TESTS.lock().unwrap();
        let temporary = std::env::temp_dir().join(format!(
            "maghemite-search-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&temporary).unwrap();
        let root = temporary.join("workspace");
        fs::create_dir(&root).unwrap();
        let workspace =
            crate::workspace::open(root.clone(), temporary.join("index.sqlite")).unwrap();
        Self {
            root,
            workspace,
            temporary,
            _serial: serial,
        }
    }
    pub fn start(&self, mut options: Value) -> String {
        options["owner"] = json!("test-owner");
        request(self.workspace, "search.start", &options).unwrap()["search"]
            .as_str()
            .unwrap()
            .into()
    }
    pub fn call(&self, method: &str, mut parameters: Value) -> Result<Value, String> {
        parameters["owner"] = json!("test-owner");
        request(self.workspace, method, &parameters)
    }
    pub fn drain(&self, search: &str) -> (Vec<Value>, Value) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut cursor = 0;
        let mut matches = Vec::new();
        loop {
            assert!(Instant::now() < deadline, "search deadline");
            let page = self
                .call("search.read", json!({"search":search,"cursor":cursor}))
                .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() < PAGE_BYTES);
            matches.extend(page["matches"].as_array().unwrap().iter().cloned());
            cursor = page["cursor"].as_u64().unwrap();
            if page["done"] == true {
                return (matches, page);
            }
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        match crate::workspace::close(self.workspace) {
            Ok(()) | Err(crate::CoreError::UnknownWorkspace) => (),
            Err(error) => panic!("workspace cleanup: {error}"),
        }
        fs::remove_dir_all(&self.temporary).unwrap();
    }
}

#[test]
fn unopened_unicode_matches_when_search_reads_disk() {
    // Given an unopened UTF-8/CRLF file.
    let f = Fixture::new();
    let text = "😀é Needle\r\nNeedle x\n";
    fs::write(f.root.join("unopened.txt"), text).unwrap();
    // When searching directly through the native service.
    let search = f.start(json!({"query":"Needle","caseSensitive":true}));
    let (matches, page) = f.drain(&search);
    // Then offsets/columns use UTF-16 and versions cover original bytes.
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0]["from"], 4);
    assert_eq!(matches[0]["to"], 10);
    assert_eq!(matches[0]["column"], 4);
    assert_eq!(matches[1]["from"], 12);
    assert_eq!(matches[1]["line"], 2);
    assert_eq!(matches[1]["column"], 0);
    assert_eq!(
        matches[0]["version"],
        blake3::hash(text.as_bytes()).to_hex().to_string()
    );
    assert_eq!(page["error"], Value::Null);
}

#[test]
fn globs_case_and_ignores_when_scanning_workspace() {
    // Given nested, ignored, binary and draft files.
    let f = Fixture::new();
    for dir in ["src", "target", "node_modules", ".git", "ignored"] {
        fs::create_dir(f.root.join(dir)).unwrap();
    }
    for path in [
        "root.txt",
        "src/code.txt",
        "src/code.rs",
        "draft.txt",
        "target/output.txt",
        "node_modules/pkg.txt",
        ".git/config",
        "ignored/a.txt",
    ] {
        fs::write(f.root.join(path), "Needle needle").unwrap();
    }
    fs::write(f.root.join(".gitignore"), "ignored/\n").unwrap();
    fs::write(f.root.join("binary.txt"), b"Needle\0needle").unwrap();
    // When globbing with an exact draft exclusion.
    let search = f.start(json!({"query":"Needle","caseSensitive":true,
        "include":["*.txt"],"exclude":["src/**"],"skipPaths":["draft.txt"]}));
    let (matches, _) = f.drain(&search);
    // Then star spans separators, excludes prune subtrees, case is respected.
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["path"], "root.txt");
    f.call("search.release", json!({"search":search})).unwrap();
    let search = f.start(json!({"query":"needle","include":["src/*.rs"]}));
    assert_eq!(f.drain(&search).0.len(), 2);
}

#[cfg(unix)]
#[test]
fn symlinks_are_skipped_when_inside_or_outside_workspace() {
    // Given both kinds of symlink and a named pipe.
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::write(f.root.join("real.txt"), "needle").unwrap();
    fs::write(f.temporary.join("outside.txt"), "needle").unwrap();
    symlink("real.txt", f.root.join("alias.txt")).unwrap();
    symlink(f.temporary.join("outside.txt"), f.root.join("escape.txt")).unwrap();
    symlink(&f.root, f.root.join("cycle")).unwrap();
    // When traversing without following links.
    let search = f.start(json!({"query":"needle"}));
    let (matches, _) = f.drain(&search);
    // Then only the actual regular file is searched.
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["path"], "real.txt");
}

#[test]
fn invalid_patterns_fail_before_registering_workers() {
    // Given an otherwise valid workspace.
    let f = Fixture::new();
    // When compiling invalid query and glob syntax.
    for options in [
        json!({"query":"(","regex":true}),
        json!({"query":"x","include":["["]}),
    ] {
        assert!(f.call("search.start", options).is_err());
    }
    // Then neither consumed the two owned handle slots.
    let first = f.start(json!({"query":"x"}));
    let second = f.start(json!({"query":"x"}));
    f.call("search.release", json!({"search":first})).unwrap();
    f.call("search.release", json!({"search":second})).unwrap();
}

#[test]
fn pages_and_retention_are_bounded_when_contexts_are_large() {
    // Given a file whose full match context would overflow the SDK frame.
    let f = Fixture::new();
    fs::write(
        f.root.join("large.txt"),
        format!("{}\n{}", "a".repeat(60_000), "a\n".repeat(300)),
    )
    .unwrap();
    // When previewing a long replacement with a small result cap.
    let search = f.start(json!({"query":"a","maxResults":120,"replacement":"b".repeat(5000)}));
    let (matches, page) = f.drain(&search);
    // Then pages stay under 40KiB and all clipping/retention limits are explicit.
    assert_eq!(matches.len(), 120);
    assert_eq!(page["truncated"], true);
    assert_eq!(matches[0]["textTruncated"], true);
    assert_eq!(matches[0]["replacementTruncated"], true);
}

#[test]
fn ownership_cancel_and_close_when_handles_are_live() {
    // Given a live owned search.
    let f = Fixture::new();
    fs::write(f.root.join("large.txt"), "needle\n".repeat(100_000)).unwrap();
    let search = f.start(json!({"query":"needle","maxResults":10000}));
    // When a different owner tries every handle operation.
    for method in [
        "search.read",
        "search.cancel",
        "search.release",
        "search.replace",
    ] {
        let p = if method == "search.replace" {
            json!({"search":search,"owner":"other","resultIds":["0"],"skipPaths":[]})
        } else {
            json!({"search":search,"owner":"other"})
        };
        assert!(
            request(f.workspace, method, &p)
                .unwrap_err()
                .contains("owned")
        );
    }
    // Then the true owner can cancel, drain, and close without leaked workers.
    f.call("search.cancel", json!({"search":search})).unwrap();
    assert_eq!(f.drain(&search).1["cancelled"], true);
    crate::workspace::close(f.workspace).unwrap();
    assert!(f.call("search.read", json!({"search":search})).is_err());
}

#[test]
fn release_owner_wakes_pending_reads_without_polling() {
    // Given a search and a reader launched before resource release.
    let f = Fixture::new();
    fs::write(f.root.join("large.txt"), "x".repeat(2 * 1024 * 1024)).unwrap();
    let search = f.start(json!({"query":"absent"}));
    let (sender, receiver) = std::sync::mpsc::channel();
    let workspace = f.workspace;
    let reader = std::thread::spawn(move || {
        let result = request(
            workspace,
            "search.read",
            &json!({
                "search":search,"owner":"test-owner","waitMs":1000
            }),
        );
        sender.send(result).unwrap();
    });
    // When the owner is released through the production resource path.
    crate::services::request(
        workspace,
        "resources.release",
        &json!({"owner":"test-owner"}),
    )
    .unwrap();
    // Then the read settles and the handle is unavailable, whether release won registration or wait.
    let result = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(result.is_err() || result.unwrap()["done"] == true);
    reader.join().unwrap();
    assert!(
        super::lock(super::registry())
            .jobs
            .values()
            .all(|j| j.workspace != workspace)
    );
}

#[path = "replacement_tests.rs"]
mod replacement_tests;
