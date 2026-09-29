use std::{fs, path::Path, time::UNIX_EPOCH};

pub(super) struct EntryMetadata {
    pub key: Vec<u8>,
    pub kind: i64,
    pub size: i64,
    pub modified_ns: i64,
}

pub(super) fn read(root: &Path, path: &Path) -> std::io::Result<EntryMetadata> {
    let metadata = fs::symlink_metadata(path)?;
    let relative = path
        .strip_prefix(root)
        .expect("walked path is beneath root");
    let kind = if metadata.file_type().is_symlink() {
        3
    } else if metadata.is_dir() {
        2
    } else if metadata.is_file() {
        1
    } else {
        4
    };
    let size = if kind == 1 || kind == 3 {
        i64::try_from(metadata.len()).unwrap_or(i64::MAX)
    } else {
        0
    };
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    Ok(EntryMetadata {
        key: path_key(relative),
        kind,
        size,
        modified_ns,
    })
}

// SQLite BLOB keys retain names that cannot be represented as UTF-8.
#[cfg(unix)]
pub(super) fn path_key(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
pub(super) fn path_key(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

pub(super) fn child_prefix(path: &Path) -> Vec<u8> {
    let mut key = path_key(path);
    #[cfg(unix)]
    key.push(b'/');
    #[cfg(windows)]
    key.extend_from_slice(&u16::to_le_bytes(b'\\' as u16));
    key
}
