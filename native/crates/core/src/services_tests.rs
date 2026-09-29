use serde_json::json;

#[test]
fn indexed_files_and_symbols_report_the_same_content_version() {
    // Given one committed index generation and its content hash.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "maghemite-index-version-{}-{nonce}.sqlite",
        std::process::id()
    ));
    let hash = blake3::hash(b"fn answer() {}");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE index_meta(id INTEGER PRIMARY KEY,generation INTEGER);
         INSERT INTO index_meta VALUES(1,7);
         CREATE TABLE entries(path BLOB PRIMARY KEY,kind INTEGER,size INTEGER,content_hash BLOB);
         CREATE TABLE symbols(path BLOB,name TEXT,kind TEXT,line INTEGER,column INTEGER,
           language TEXT,start_byte INTEGER,end_byte INTEGER,container TEXT);",
    ).unwrap();
    db.execute(
        "INSERT INTO entries VALUES(?1,1,14,?2)",
        rusqlite::params![b"src/a.rs".as_slice(), hash.as_bytes().as_slice()],
    ).unwrap();
    db.execute(
        "INSERT INTO symbols VALUES(?1,'answer','function',1,3,'Rust',3,9,NULL)",
        [b"src/a.rs".as_slice()],
    ).unwrap();
    // When both public query forms read that generation.
    let files = super::query(&path, &json!({"kind":"files"})).unwrap();
    let symbols = super::query(&path, &json!({"kind":"symbols","path":"src/a.rs"})).unwrap();
    // Then callers can reject positions from a different file version.
    assert_eq!(files["items"][0]["version"], hash.to_hex().to_string());
    assert_eq!(symbols["items"][0]["version"], files["items"][0]["version"]);
    assert_eq!(symbols["items"][0]["name"], "answer");
    assert_eq!(symbols["revision"], "7");
    drop(db);
    std::fs::remove_file(path).unwrap();
}
