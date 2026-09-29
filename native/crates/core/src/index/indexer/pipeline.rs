use std::{
    fs::{self, File},
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread,
};

use rayon::prelude::*;
use rusqlite::{OptionalExtension, params};
use walkdir::WalkDir;

use crate::{CoreError, workspace::Workspace};

use super::{IndexStatus, Job, JobKind, RUNNING};
use crate::index::{metadata, storage, text};
use text::ANALYSIS_VERSION;

const MAX_PARSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_HASH_BYTES: i64 = 64 * 1024 * 1024;

struct PreparedEntry {
    metadata: metadata::EntryMetadata,
    hash: Option<[u8; 32]>,
    parsed: text::ParsedText,
}

enum Message {
    Entry(PreparedEntry),
    Error(CoreError),
}

struct StoredEntry {
    kind: i64,
    size: i64,
    modified_ns: i64,
    hash: Option<Vec<u8>>,
    analysis_version: i64,
}

fn worker_count() -> usize {
    thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2)
        .clamp(1, 8)
}

pub(super) fn scan(workspace: &Workspace, job: &Job, kind: &JobKind) -> Result<u64, CoreError> {
    let root_metadata = fs::symlink_metadata(&workspace.root)?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidArgument(
            "workspace root is no longer a directory",
        ));
    }

    let languages = text::Languages::new();
    let workers = worker_count();
    let queue_size = workers.saturating_mul(4).max(4);
    let (task_sender, task_receiver) = sync_channel::<PathBuf>(queue_size);
    let (result_sender, result_receiver) = sync_channel::<Message>(queue_size);
    let abort = AtomicBool::new(false);

    thread::scope(|scope| {
        let writer_abort = &abort;
        let writer =
            scope.spawn(move || write_results(workspace, job, kind, result_receiver, writer_abort));

        let worker_abort = &abort;
        let worker_languages = &languages;
        let worker_sender = result_sender.clone();
        let worker = scope.spawn(move || {
            rayon::ThreadPoolBuilder::new()
                .num_threads(workers)
                .thread_name(|index| format!("maghemite-file-worker-{index}"))
                .build_scoped(
                    |thread| thread.run(),
                    |pool| {
                        pool.install(|| {
                            task_receiver.into_iter().par_bridge().for_each_init(
                                || text::TextParser::new(worker_languages),
                                |parser, path| {
                                    if job.cancel.load(Ordering::Relaxed)
                                        || worker_abort.load(Ordering::Relaxed)
                                    {
                                        return;
                                    }
                                    let result = match prepare_entry(
                                        &workspace.root,
                                        &path,
                                        &job.cancel,
                                        worker_abort,
                                        parser,
                                    ) {
                                        Ok(Some(entry)) => Message::Entry(entry),
                                        Ok(None) => return,
                                        Err(error) => Message::Error(error),
                                    };
                                    if worker_sender.send(result).is_err() {
                                        worker_abort.store(true, Ordering::Relaxed);
                                    }
                                },
                            );
                        });
                    },
                )
                .map_err(|error| CoreError::Internal(format!("Rayon pool startup failed: {error}")))
        });

        let walk_result = enqueue_paths(workspace, kind, job, &abort, &task_sender);
        drop(task_sender);
        if let Err(error) = walk_result {
            let _ = result_sender.send(Message::Error(error));
        }
        match worker.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = result_sender.send(Message::Error(error));
            }
            Err(_) => {
                let _ = result_sender.send(Message::Error(CoreError::Internal(
                    "Rayon worker coordinator panicked".to_owned(),
                )));
            }
        }
        drop(result_sender);
        writer
            .join()
            .map_err(|_| CoreError::Internal("SQLite writer panicked".to_owned()))?
    })
}

fn enqueue_paths(
    workspace: &Workspace,
    kind: &JobKind,
    job: &Job,
    abort: &AtomicBool,
    sender: &SyncSender<PathBuf>,
) -> Result<(), CoreError> {
    let visible = |path: &Path| {
        path.strip_prefix(&workspace.root).is_ok_and(|relative| {
            !relative.components().any(|part| part.as_os_str() == crate::file_operations::TRASH)
        })
    };
    let enqueue = |path: &Path| -> Result<(), CoreError> {
        if job.cancel.load(Ordering::Relaxed) {
            return Err(CoreError::Cancelled);
        }
        if abort.load(Ordering::Relaxed) {
            return Err(CoreError::Internal("index writer stopped".to_owned()));
        }
        sender
            .send(path.to_path_buf())
            .map_err(|_| CoreError::Internal("Rayon workers stopped".to_owned()))
    };
    match kind {
        JobKind::Full => {
            for entry in WalkDir::new(&workspace.root).follow_links(false).into_iter()
                .filter_entry(|entry| visible(entry.path())) {
                let entry = entry?;
                if entry.depth() > 0 {
                    enqueue(entry.path())?;
                }
            }
        }
        JobKind::Refresh(paths) => {
            for path in paths {
                if !visible(path) {
                    continue;
                }
                if job.cancel.load(Ordering::Relaxed) {
                    return Err(CoreError::Cancelled);
                }
                match fs::symlink_metadata(path) {
                    Ok(_) => {
                        for entry in WalkDir::new(path).follow_links(false).into_iter()
                            .filter_entry(|entry| visible(entry.path())) {
                            enqueue(entry?.path())?;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(())
}

fn prepare_entry(
    root: &Path,
    path: &Path,
    cancel: &AtomicBool,
    abort: &AtomicBool,
    parser: &mut text::TextParser<'_>,
) -> Result<Option<PreparedEntry>, CoreError> {
    let metadata = match metadata::read(root, path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.kind != 1 || !should_hash(root, path, metadata.size) {
        return Ok(Some(PreparedEntry {
            metadata,
            hash: None,
            parsed: text::ParsedText::default(),
        }));
    }
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut reader = BufReader::new(file);
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut parse_bytes = Vec::new();
    let mut collect_text = metadata.size <= MAX_PARSE_BYTES as i64 && text::supports(path);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CoreError::Cancelled);
        }
        if abort.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        if collect_text {
            if parse_bytes.len().saturating_add(read) <= MAX_PARSE_BYTES {
                parse_bytes.extend_from_slice(&buffer[..read]);
            } else {
                collect_text = false;
                parse_bytes.clear();
            }
        }
    }
    let parsed = if collect_text {
        parser.parse(path, &parse_bytes, cancel, abort)?
    } else {
        text::ParsedText::default()
    };
    Ok(Some(PreparedEntry {
        metadata,
        hash: Some(*hasher.finalize().as_bytes()),
        parsed,
    }))
}

fn should_hash(root: &Path, path: &Path, size: i64) -> bool {
    if size > MAX_HASH_BYTES {
        return false;
    }
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    !relative.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules" | "target" | ".venv")
        )
    })
}

fn write_results(
    workspace: &Workspace,
    job: &Job,
    kind: &JobKind,
    receiver: Receiver<Message>,
    abort: &AtomicBool,
) -> Result<u64, CoreError> {
    let result = write_transaction(workspace, job, kind, &receiver, abort);
    if result.is_err() {
        abort.store(true, Ordering::Relaxed);
        // Keep receiving after a setup failure so blocked producers can exit.
        while receiver.recv().is_ok() {}
    }
    result
}

fn write_transaction(
    workspace: &Workspace,
    job: &Job,
    kind: &JobKind,
    receiver: &Receiver<Message>,
    abort: &AtomicBool,
) -> Result<u64, CoreError> {
    let mut connection = storage::open(&workspace.database)?;
    let transaction = connection.transaction()?;
    let previous: i64 = transaction.query_row(
        "SELECT generation FROM index_meta WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    let generation = previous.checked_add(1).ok_or(CoreError::Busy)?;
    let mut progress = IndexStatus {
        phase: RUNNING,
        ..IndexStatus::default()
    };
    let mut first_error: Option<CoreError> = None;

    {
        let mut existing = transaction.prepare_cached(
            "SELECT kind, size, modified_ns, content_hash, analysis_version
             FROM entries WHERE path = ?1",
        )?;
        let mut upsert = transaction.prepare_cached(
            "INSERT INTO entries
             (path, kind, size, modified_ns, generation, content_hash, analysis_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET
                 kind = excluded.kind,
                 size = excluded.size,
                 modified_ns = excluded.modified_ns,
                 generation = excluded.generation,
                 content_hash = excluded.content_hash,
                 analysis_version = excluded.analysis_version",
        )?;
        let mut clear_symbols =
            transaction.prepare_cached("DELETE FROM symbols WHERE path = ?1")?;
        let mut clear_links =
            transaction.prepare_cached("DELETE FROM links WHERE source_path = ?1")?;
        let mut add_symbol = transaction.prepare_cached(
            "INSERT OR IGNORE INTO symbols
             (path, name, kind, line, column, language, start_byte, end_byte,
              end_line, end_column, declaration_start_byte, declaration_end_byte, container)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )?;
        let mut add_link = transaction.prepare_cached(
            "INSERT OR IGNORE INTO links (source_path, target, line)
             VALUES (?1, ?2, ?3)",
        )?;

        let mut write_entry = |entry: PreparedEntry| -> Result<(), CoreError> {
            let key = &entry.metadata.key;
            let hash = entry.hash.as_ref().map(|hash| hash.as_slice());
            let old: Option<StoredEntry> = existing
                .query_row([key], |row| {
                    Ok(StoredEntry {
                        kind: row.get(0)?,
                        size: row.get(1)?,
                        modified_ns: row.get(2)?,
                        hash: row.get(3)?,
                        analysis_version: row.get(4)?,
                    })
                })
                .optional()?;
            let analysis_changed = old.as_ref().is_none_or(|old| {
                old.kind != entry.metadata.kind
                    || old.hash.as_deref() != hash
                    || old.analysis_version != ANALYSIS_VERSION
            });
            match &old {
                None => progress.added += 1,
                Some(old)
                    if old.kind != entry.metadata.kind
                        || old.size != entry.metadata.size
                        || old.modified_ns != entry.metadata.modified_ns
                        || old.hash.as_deref() != hash
                        || old.analysis_version != ANALYSIS_VERSION =>
                {
                    progress.updated += 1;
                }
                Some(_) => {}
            }
            upsert.execute(params![
                key,
                entry.metadata.kind,
                entry.metadata.size,
                entry.metadata.modified_ns,
                generation,
                hash,
                ANALYSIS_VERSION,
            ])?;
            if analysis_changed {
                clear_symbols.execute([key])?;
                clear_links.execute([key])?;
                for symbol in entry.parsed.symbols {
                    let source = symbol.source.as_ref();
                    add_symbol.execute(params![
                        key,
                        symbol.name,
                        symbol.kind,
                        symbol.line,
                        source.map_or(0, |s| s.column as i64),
                        source.map(|s| s.language),
                        source.map(|s| s.start_byte as i64),
                        source.map(|s| s.end_byte as i64),
                        source.map(|s| s.end_line as i64),
                        source.map(|s| s.end_column as i64),
                        source.map(|s| s.declaration_start_byte as i64),
                        source.map(|s| s.declaration_end_byte as i64),
                        symbol.container,
                    ])?;
                }
                for link in entry.parsed.links {
                    add_link.execute(params![key, link.target, link.line])?;
                }
            }
            progress.scanned += 1;
            if entry.metadata.kind == 1 {
                progress.bytes = progress.bytes.saturating_add(entry.metadata.size as u64);
            }
            if progress.scanned.is_multiple_of(128) {
                job.update(|status| {
                    status.scanned = progress.scanned;
                    status.added = progress.added;
                    status.updated = progress.updated;
                    status.bytes = progress.bytes;
                });
            }
            Ok(())
        };

        while let Ok(message) = receiver.recv() {
            if job.cancel.load(Ordering::Relaxed) || first_error.is_some() {
                continue;
            }
            let result = match message {
                Message::Entry(entry) => write_entry(entry),
                Message::Error(error) => Err(error),
            };
            if let Err(error) = result {
                first_error = Some(error);
                abort.store(true, Ordering::Relaxed);
            }
        }
    }

    if let Some(error) = first_error {
        return Err(error);
    }
    if job.cancel.load(Ordering::Relaxed) {
        return Err(CoreError::Cancelled);
    }
    progress.removed = match kind {
        JobKind::Full => {
            transaction.execute("DELETE FROM entries WHERE generation != ?1", [generation])? as u64
        }
        JobKind::Refresh(paths) => {
            let mut removed = 0;
            for path in paths {
                let relative = path
                    .strip_prefix(&workspace.root)
                    .map_err(|_| CoreError::InvalidArgument("refresh path is outside workspace"))?;
                let key = metadata::path_key(relative);
                let children = metadata::child_prefix(relative);
                removed += transaction.execute(
                    "DELETE FROM entries
                     WHERE (path = ?1 OR substr(path, 1, length(?2)) = ?2)
                       AND generation != ?3",
                    params![key, children, generation],
                )? as u64;
            }
            removed
        }
    };
    transaction.execute(
        "UPDATE index_meta SET generation = ?1 WHERE id = 1",
        [generation],
    )?;
    transaction.commit()?;
    job.update(|status| {
        status.scanned = progress.scanned;
        status.added = progress.added;
        status.updated = progress.updated;
        status.removed = progress.removed;
        status.bytes = progress.bytes;
    });
    Ok(generation as u64)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::atomic::Ordering, time::SystemTime};

    use rusqlite::Connection;

    use super::{Job, JobKind, Workspace, scan};
    use crate::CoreError;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "maghemite-index-test-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temporary directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parallel_pipeline_migrates_and_reconciles_analysis_atomically() {
        let temp = TempDirectory::new();
        let root = temp.0.join("workspace");
        let data = temp.0.join("data");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&data).unwrap();
        let note = root.join("note.md");
        let first_text = "# Design\nSee [[Architecture]] and [API](api.md).\n";
        fs::write(&note, first_text).unwrap();
        fs::write(root.join("source.rs"), "pub fn build_index() {}\n").unwrap();
        for number in 0..128 {
            fs::write(root.join(format!("file-{number}.txt")), b"contents").unwrap();
        }
        let database = data.join("index.sqlite");
        let old = Connection::open(&database).unwrap();
        old.execute_batch(
            "CREATE TABLE index_meta (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
             INSERT INTO index_meta (id, generation) VALUES (1, 0);
             CREATE TABLE entries (
                 path BLOB PRIMARY KEY,
                 kind INTEGER NOT NULL,
                 size INTEGER NOT NULL,
                 modified_ns INTEGER NOT NULL,
                 generation INTEGER NOT NULL
             );",
        )
        .unwrap();
        drop(old);

        let workspace = Workspace { root, database };
        assert_eq!(scan(&workspace, &Job::new(1), &JobKind::Full).unwrap(), 1);
        let connection = Connection::open(&workspace.database).unwrap();
        let entry_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(entry_count, 130);
        let hash: Vec<u8> = connection
            .query_row(
                "SELECT content_hash FROM entries WHERE path = ?1",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hash, blake3::hash(first_text.as_bytes()).as_bytes());
        let heading_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE path = ?1 AND name = 'Design'",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(heading_count, 1);
        let source_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE path = ?1 AND name = 'build_index'",
                [b"source.rs".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_count, 1);
        let old_links: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM links WHERE source_path = ?1",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_links, 2);

        fs::write(&note, "# Updated\nSee [[New Target]].\n").unwrap();
        assert_eq!(
            scan(
                &workspace,
                &Job::new(2),
                &JobKind::Refresh(vec![note.clone()])
            )
            .unwrap(),
            2
        );
        let stale_links: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM links WHERE source_path = ?1 AND target = 'Architecture'",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_links, 0);
        let new_links: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM links WHERE source_path = ?1 AND target = 'New Target'",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new_links, 1);

        fs::remove_file(&note).unwrap();
        assert_eq!(
            scan(
                &workspace,
                &Job::new(3),
                &JobKind::Refresh(vec![note.clone()])
            )
            .unwrap(),
            3
        );
        let orphaned: i64 = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM symbols WHERE path = ?1)
                      + (SELECT COUNT(*) FROM links WHERE source_path = ?1)",
                [b"note.md".as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphaned, 0);

        let cancelled = Job::new(4);
        cancelled.cancel.store(true, Ordering::Relaxed);
        assert!(matches!(
            scan(&workspace, &cancelled, &JobKind::Full),
            Err(CoreError::Cancelled)
        ));
        let revision: i64 = connection
            .query_row(
                "SELECT generation FROM index_meta WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 3);
    }

    #[test]
    fn tree_sitter_replaces_legacy_analysis_and_stores_distinct_same_line_symbols() {
        let temp = TempDirectory::new();
        let root = temp.0.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let source = "function first() { let same = 1; } function second() { let same = 2; }";
        let path = root.join("source.ts");
        fs::write(&path, source).unwrap();
        let database = temp.0.join("index.sqlite");
        let old = Connection::open(&database).unwrap();
        old.execute_batch(
            "CREATE TABLE entries (
                 path BLOB PRIMARY KEY, kind INTEGER NOT NULL, size INTEGER NOT NULL,
                 modified_ns INTEGER NOT NULL, generation INTEGER NOT NULL,
                 content_hash BLOB, analysis_version INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE symbols (
                 path BLOB NOT NULL REFERENCES entries(path) ON DELETE CASCADE,
                 name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL,
                 PRIMARY KEY (path, name, kind, line)
             );",
        )
        .unwrap();
        old.execute(
            "INSERT INTO entries VALUES (?1, 1, ?2, 0, 0, ?3, 1)",
            rusqlite::params![
                b"source.ts".as_slice(),
                source.len() as i64,
                blake3::hash(source.as_bytes()).as_bytes().as_slice()
            ],
        )
        .unwrap();
        old.execute(
            "INSERT INTO symbols VALUES (?1, 'legacy', 'declaration', 1)",
            [b"source.ts".as_slice()],
        )
        .unwrap();
        drop(old);

        // Schema migration preserves the last committed symbols until scanning succeeds.
        let migrated = crate::index::storage::open(&database).unwrap();
        let legacy: String = migrated
            .query_row("SELECT name FROM symbols", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy, "legacy");
        drop(migrated);
        let workspace = Workspace { root, database };
        scan(&workspace, &Job::new(1), &JobKind::Full).unwrap();
        let connection = Connection::open(&workspace.database).unwrap();
        let mut query = connection
            .prepare(
                "SELECT name, kind, line, column, language, start_byte, end_byte,
                    declaration_start_byte, declaration_end_byte, container
             FROM symbols WHERE name = 'same' ORDER BY start_byte",
            )
            .unwrap();
        let rows = query
            .query_map([], |row| {
                let start = row.get::<_, i64>(5)? as usize;
                let end = row.get::<_, i64>(6)? as usize;
                let declaration_start = row.get::<_, i64>(7)? as usize;
                let declaration_end = row.get::<_, i64>(8)? as usize;
                assert_eq!(&source[start..end], row.get::<_, String>(0)?);
                assert_eq!(row.get::<_, String>(1)?, "variable");
                assert_eq!(row.get::<_, i64>(2)?, 1);
                assert_eq!(row.get::<_, i64>(3)? as usize, start);
                assert_eq!(row.get::<_, String>(4)?, "typescript");
                assert!(declaration_start <= start && declaration_end >= end);
                row.get::<_, String>(9)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows, ["first", "second"]);
        let legacy: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE name = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
        let version: i64 = connection
            .query_row("SELECT analysis_version FROM entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, super::ANALYSIS_VERSION);

        let unchanged = Job::new(2);
        scan(&workspace, &unchanged, &JobKind::Full).unwrap();
        // Force an old analysis version with an unchanged hash: queries must run again.
        connection
            .execute("UPDATE entries SET analysis_version = 1", [])
            .unwrap();
        connection
            .execute("UPDATE symbols SET kind = 'obsolete'", [])
            .unwrap();
        scan(&workspace, &Job::new(3), &JobKind::Full).unwrap();
        let obsolete: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM symbols WHERE kind = 'obsolete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(obsolete, 0);

        fs::write(&path, "export const fresh = () => 1;").unwrap();
        scan(&workspace, &Job::new(4), &JobKind::Refresh(vec![path])).unwrap();
        let names = connection
            .prepare("SELECT name FROM symbols")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(names, ["fresh"]);
    }
}
