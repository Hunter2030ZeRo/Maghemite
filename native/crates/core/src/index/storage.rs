use std::{path::Path, time::Duration};

use rusqlite::Connection;

use crate::CoreError;

pub(super) fn open(path: &Path) -> Result<Connection, CoreError> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS index_meta (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             generation INTEGER NOT NULL
         );
         INSERT OR IGNORE INTO index_meta (id, generation) VALUES (1, 0);
         CREATE TABLE IF NOT EXISTS entries (
             path BLOB PRIMARY KEY,
             kind INTEGER NOT NULL,
             size INTEGER NOT NULL,
             modified_ns INTEGER NOT NULL,
             generation INTEGER NOT NULL,
             content_hash BLOB,
             analysis_version INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS links (
             source_path BLOB NOT NULL REFERENCES entries(path) ON DELETE CASCADE,
             target TEXT NOT NULL,
             line INTEGER NOT NULL,
             PRIMARY KEY (source_path, target, line)
         );
         CREATE INDEX IF NOT EXISTS links_target ON links(target);",
    )?;
    let transaction = connection.transaction()?;
    let mut columns = transaction.prepare("PRAGMA table_info(entries)")?;
    let names = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(columns);
    if !names.iter().any(|name| name == "content_hash") {
        transaction.execute("ALTER TABLE entries ADD COLUMN content_hash BLOB", [])?;
    }
    if !names.iter().any(|name| name == "analysis_version") {
        transaction.execute(
            "ALTER TABLE entries ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    let mut columns = transaction.prepare("PRAGMA table_info(symbols)")?;
    let names = columns
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(columns);
    if !names.is_empty() && !names.iter().any(|name| name == "start_byte") {
        transaction.execute_batch("ALTER TABLE symbols RENAME TO legacy_symbols;")?;
        transaction.execute_batch(SYMBOL_SCHEMA)?;
        transaction.execute_batch(
            "INSERT INTO symbols (path, name, kind, line)
                 SELECT path, name, kind, line FROM legacy_symbols;
             DROP TABLE legacy_symbols;
             UPDATE entries SET analysis_version = 0;",
        )?;
    } else {
        transaction.execute_batch(SYMBOL_SCHEMA)?;
    }
    transaction.commit()?;
    Ok(connection)
}

// Column is part of the key so same-line names in different scopes survive.
// Old and Markdown symbols retain their line and have no source range.
const SYMBOL_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS symbols (
        path BLOB NOT NULL REFERENCES entries(path) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL DEFAULT 0,
        language TEXT,
        start_byte INTEGER,
        end_byte INTEGER,
        end_line INTEGER,
        end_column INTEGER,
        declaration_start_byte INTEGER,
        declaration_end_byte INTEGER,
        container TEXT,
        PRIMARY KEY (path, name, kind, line, column)
    );";
