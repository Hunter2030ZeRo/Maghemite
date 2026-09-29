//! Capability-relative file operations and parameterized, read-only index queries.
use crate::{file_operations, workspace};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Write,
    path::{Component, Path},
    sync::{Mutex, OnceLock},
    time::Duration,
};

const MAX_FILE: usize = 2 * 1024 * 1024;
struct Upload {
    workspace: u64,
    owner: String,
    path: String,
    target: String,
    temporary: String,
    expected: Option<String>,
    file: cap_std::fs::File,
    bytes: usize,
    dir: Dir,
}
#[derive(Default)]
struct Services {
    next: u64,
    uploads: HashMap<String, Upload>,
}
static SERVICES: OnceLock<Mutex<Services>> = OnceLock::new();
fn text<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn offset(p: &Value) -> usize {
    p["offset"].as_u64().unwrap_or(0).min(1_000_000) as usize
}
pub(crate) fn path(value: &str, allow_root: bool) -> Result<&str, String> {
    if allow_root && value.is_empty() {
        return Ok(".");
    }
    if value.is_empty()
        || value.len() > 4096
        || value.contains(['\0', '\\', ':'])
        || value
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s == file_operations::TRASH || s.starts_with(".maghemite-write-"))
        || Path::new(value)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid workspace-relative path".into());
    }
    Ok(value)
}
fn read_file(dir: &Dir, path: &str) -> Result<Vec<u8>, String> {
    file_operations::read(dir, path, MAX_FILE as u64)
}
fn version(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn current(dir: &Dir, target: &str) -> Result<Option<String>, String> {
    match dir.symlink_metadata(target) {
        Ok(m) => {
            if !m.is_file() || m.file_type().is_symlink() {
                return Err("Mutations require a regular non-symlink file".into());
            }
            Ok(Some(version(&read_file(dir, target)?)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
fn check_version(dir: &Dir, target: &str, expected: &Option<String>) -> Result<(), String> {
    if &current(dir, target)? != expected {
        return Err("File version conflict".into());
    }
    Ok(())
}
fn expected(p: &Value) -> Result<Option<String>, String> {
    if p.get("version").is_none() {
        return Err("Expected file version (null for new file)".into());
    }
    match &p["version"] {
        Value::Null => Ok(None),
        Value::String(s) if s.len() == 64 => Ok(Some(s.clone())),
        _ => Err("Invalid file version".into()),
    }
}
fn release(s: &mut Services, owner: &str) {
    let ids: Vec<_> = s
        .uploads
        .iter()
        .filter(|(_, u)| u.owner == owner)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(u) = s.uploads.remove(&id) {
            let _ = u.dir.remove_file(&u.temporary);
        }
    }
}
pub(crate) fn shutdown() {
    crate::search::shutdown();
    if let Some(s) = SERVICES.get() {
        let mut s = s.lock().unwrap_or_else(|e| e.into_inner());
        for (_, u) in s.uploads.drain() {
            let _ = u.dir.remove_file(&u.temporary);
        }
    }
}
pub(crate) fn request(workspace_id: u64, method: &str, p: &Value) -> Result<Value, String> {
    if method.starts_with("search.") {
        return crate::search::request(workspace_id, method, p);
    }
    if method == "resources.release" {
        crate::search::release_owner(text(p, "owner")?);
    }
    let mut s = SERVICES
        .get_or_init(|| Mutex::new(Services::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if method == "resources.release" {
        release(&mut s, text(p, "owner")?);
        return Ok(Value::Null);
    }
    let workspace = workspace::lookup(workspace_id).map_err(|e| e.to_string())?;
    if method == "index.query" {
        return query(&workspace.database, p);
    }
    let root =
        Dir::open_ambient_dir(&workspace.root, ambient_authority()).map_err(|e| e.to_string())?;
    if matches!(method, "files.move" | "files.trash" | "files.rename") {
        let path = text(p, "path")?;
        if s.uploads.values().any(|u| u.workspace == workspace_id &&
            (u.path == path || u.path.starts_with(&format!("{path}/")))) {
            return Err("Source has an active file upload".into());
        }
    }
    match method {
        "files.move" | "files.trash" | "files.trashList" | "files.restoreTrash" => {
            file_operations::request(&root, &workspace, method, p)
        }
        "files.list" => {
            let dir = file_operations::directory(&root, p["path"].as_str().unwrap_or(""))?;
            let mut entries = Vec::new();
            for item in dir.entries().map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let Some(name) = item.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if name.starts_with(".maghemite-write-") || name == file_operations::TRASH {
                    continue;
                }
                let kind = item.file_type().map_err(|e| e.to_string())?;
                entries.push(json!({"name":name,"kind":if kind.is_symlink(){"symlink"}else if kind.is_dir(){"directory"}else if kind.is_file(){"file"}else{"other"}}));
                if entries.len() > 100_000 {
                    return Err("Directory listing limit exceeded".into());
                }
            }
            entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            let start = offset(p);
            let more = start + 20 < entries.len();
            Ok(
                json!({"entries":entries.into_iter().skip(start).take(20).collect::<Vec<_>>(),"nextOffset":if more{Some(start+20)}else{None}}),
            )
        }
        "files.stat" => {
            let name = text(p, "path")?;
            let (dir, name) = if name.is_empty() {
                (root.try_clone().map_err(|e| e.to_string())?, ".".to_owned())
            } else {
                file_operations::parent(&root, name)?
            };
            let meta = dir.symlink_metadata(&name).map_err(|e| e.to_string())?;
            let kind = if meta.file_type().is_symlink() {
                "symlink"
            } else if meta.is_dir() {
                "directory"
            } else if meta.is_file() {
                "file"
            } else {
                "other"
            };
            let hash = if kind == "file" && meta.len() <= MAX_FILE as u64 {
                Some(version(&read_file(&dir, &name)?))
            } else {
                None
            };
            Ok(json!({"kind":kind,"size":meta.len().to_string(),"version":hash}))
        }
        "files.read" => {
            let (dir, name) = file_operations::parent(&root, text(p, "path")?)?;
            let bytes = read_file(&dir, &name)?;
            let hash = version(&bytes);
            if let Some(expected) = p["version"].as_str()
                && expected != hash
            {
                return Err("File version conflict".into());
            }
            let start = p["offset"].as_u64().unwrap_or(0) as usize;
            if start > bytes.len() {
                return Err("Invalid file offset".into());
            }
            let end = (start + 16_384).min(bytes.len());
            Ok(
                json!({"data":B64.encode(&bytes[start..end]),"version":hash,"size":bytes.len(),"nextOffset":if end<bytes.len(){Some(end)}else{None}}),
            )
        }
        "files.beginWrite" => {
            let owner = text(p, "owner")?;
            let path = path(text(p, "path")?, false)?.to_owned();
            let expected = expected(p)?;
            if s.uploads.len() >= 32 || s.uploads.values().filter(|u| u.owner == owner).count() >= 4
            {
                return Err("Too many file uploads".into());
            }
            let (dir, target) = file_operations::parent(&root, &path)?;
            check_version(&dir, &target, &expected)?;
            s.next += 1;
            let id = s.next.to_string();
            let temporary = format!(".maghemite-write-{}-{}", std::process::id(), s.next);
            let file = dir
                .open_with(&temporary, OpenOptions::new().write(true).create_new(true))
                .map_err(|e| e.to_string())?;
            if let Ok(meta) = dir.metadata(&target)
                && let Err(e) = file.set_permissions(meta.permissions())
            {
                let _ = dir.remove_file(&temporary);
                return Err(e.to_string());
            }
            s.uploads.insert(
                id.clone(),
                Upload {
                    workspace: workspace_id,
                    owner: owner.into(),
                    path,
                    target,
                    temporary,
                    expected,
                    file,
                    bytes: 0,
                    dir,
                },
            );
            Ok(json!({"upload":id}))
        }
        "files.writeChunk" | "files.commitWrite" | "files.abortWrite" => {
            let id = text(p, "upload")?;
            let owner = text(p, "owner")?;
            let upload = s
                .uploads
                .get_mut(id)
                .filter(|u| u.owner == owner && u.workspace == workspace_id)
                .ok_or("Unknown owned upload")?;
            if method == "files.writeChunk" {
                let bytes = B64.decode(text(p, "data")?).map_err(|e| e.to_string())?;
                if bytes.len() > 16_384 || upload.bytes + bytes.len() > MAX_FILE {
                    return Err("File upload limit exceeded".into());
                }
                if p["offset"].as_u64() != Some(upload.bytes as u64) {
                    return Err("Upload offset conflict".into());
                }
                upload.file.write_all(&bytes).map_err(|e| e.to_string())?;
                upload.bytes += bytes.len();
                return Ok(json!({"offset":upload.bytes}));
            }
            let upload = s.uploads.remove(id).unwrap();
            let result = (|| {
                if method == "files.abortWrite" {
                    return Ok(Value::Null);
                }
                upload.file.sync_all().map_err(|e| e.to_string())?;
                let bytes = read_file(&upload.dir, &upload.temporary)?;
                if bytes.len() != upload.bytes {
                    return Err("Incomplete file upload".into());
                }
                let saved_version = version(&bytes);
                check_version(&upload.dir, &upload.target, &upload.expected)?;
                // Keep a directory handle across validation and rename: ancestor
                // changes cannot redirect this write outside the opened directory.
                upload
                    .dir
                    .rename(&upload.temporary, &upload.dir, &upload.target)
                    .map_err(|e| e.to_string())?;
                Ok(json!({"version":saved_version,"size":upload.bytes}))
            })();
            let _ = upload.dir.remove_file(&upload.temporary);
            result
        }
        "files.mkdir" => {
            let (dir, name) = file_operations::parent(&root, text(p, "path")?)?;
            dir.create_dir(name).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "files.remove" => {
            let (dir, name) = file_operations::parent(&root, text(p, "path")?)?;
            let meta = dir.symlink_metadata(&name).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                dir.remove_dir(&name).map_err(|e| e.to_string())?;
            } else {
                check_version(&dir, &name, &expected(p)?)?;
                dir.remove_file(&name).map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "files.rename" => {
            // Preserve the file-only input and null output of the original API.
            text(p, "version")?;
            file_operations::request(&root, &workspace, "files.move", p)?;
            Ok(Value::Null)
        }
        _ => Err("Unknown native service".into()),
    }
}

/// Serialize search commits with all existing staged file mutations.
pub(crate) fn mutation<T>(run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = SERVICES.get_or_init(|| Mutex::new(Services::default()))
        .lock().unwrap_or_else(|e| e.into_inner());
    run()
}

fn query(database: &Path, p: &Value) -> Result<Value, String> {
    let connection =
        rusqlite::Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let kind = text(p, "kind")?;
    let query = p["query"].as_str().unwrap_or("");
    let path = p["path"].as_str().unwrap_or("").as_bytes();
    let start = offset(p);
    let sql = match kind {
        "files" => {
            "SELECT path,kind,size,CASE WHEN content_hash IS NULL THEN NULL ELSE lower(hex(content_hash)) END FROM entries WHERE instr(CAST(path AS TEXT),?1)>0 AND (?2=x'' OR path=?2) ORDER BY path LIMIT 21 OFFSET ?3"
        }
        "symbols" => {
            "SELECT s.path,s.name,s.kind,s.line,s.column,s.language,s.start_byte,s.end_byte,s.container,CASE WHEN e.content_hash IS NULL THEN NULL ELSE lower(hex(e.content_hash)) END FROM symbols s JOIN entries e ON e.path=s.path WHERE instr(s.name,?1)>0 AND (?2=x'' OR s.path=?2) ORDER BY s.path,s.line,s.column,s.name LIMIT 21 OFFSET ?3"
        }
        "links" => {
            "SELECT source_path,target,line FROM links WHERE instr(target,?1)>0 AND (?2=x'' OR source_path=?2) ORDER BY source_path,line,target LIMIT 21 OFFSET ?3"
        }
        "backlinks" => {
            "SELECT source_path,target,line FROM links WHERE target=?1 AND (?2=x'' OR source_path=?2) ORDER BY source_path,line LIMIT 21 OFFSET ?3"
        }
        _ => return Err("Unknown index query kind".into()),
    };
    let mut statement = connection.prepare(sql).map_err(|e| e.to_string())?;
    let rows=statement.query_map(rusqlite::params![query,path,start as i64],|row|{
        let bytes:Vec<u8>=row.get(0)?;let path=String::from_utf8_lossy(&bytes);
        Ok(match kind {
            "files"=>json!({"path":path,"kind":row.get::<_,i64>(1)?,"size":row.get::<_,i64>(2)?.to_string(),"version":row.get::<_,Option<String>>(3)?}),
            "symbols"=>json!({"path":path,"name":row.get::<_,String>(1)?,"kind":row.get::<_,String>(2)?,"line":row.get::<_,i64>(3)?,"column":row.get::<_,i64>(4)?,"language":row.get::<_,Option<String>>(5)?,"startByte":row.get::<_,Option<i64>>(6)?,"endByte":row.get::<_,Option<i64>>(7)?,"container":row.get::<_,Option<String>>(8)?,"version":row.get::<_,Option<String>>(9)?}),
            _=>json!({"source":path,"target":row.get::<_,String>(1)?,"line":row.get::<_,i64>(2)?}),
        })
    }).map_err(|e|e.to_string())?;
    let mut result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let more = result.len() > 20;
    result.truncate(20);
    let revision: i64 = connection
        .query_row("SELECT generation FROM index_meta WHERE id=1", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"items":result,"nextOffset":if more{Some(start+20)}else{None},"revision":revision.to_string(),"encoding":"utf-8"}),
    )
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;
