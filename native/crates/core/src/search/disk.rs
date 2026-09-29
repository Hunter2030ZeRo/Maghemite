use super::types::MAX_FILE;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicU64, Ordering},
};

/// Open each component without following symlinks and retain its directory capability.
pub(super) fn parent(root: &Dir, path: &str) -> Result<(Dir, String), String> {
    crate::services::path(path, false)?;
    let mut parts = path.split('/').peekable();
    let mut dir = root.try_clone().map_err(|e| e.to_string())?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((dir, part.to_owned()));
        }
        dir = dir.open_dir_nofollow(part).map_err(|e| e.to_string())?;
    }
    Err("Invalid search path".into())
}

pub(super) fn read(dir: &Dir, name: &str) -> Result<String, String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = dir.open_with(name, &options).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 {
        return Err("Search skips non-regular files and files over 2 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FILE || bytes.contains(&0) {
        return Err("Search skips binary or oversized files".into());
    }
    String::from_utf8(bytes).map_err(|_| "Search skips non-UTF-8 files".into())
}

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// Same-directory staged rename, serialized with existing files.* mutations.
pub(super) fn commit(
    dir: &Dir,
    name: &str,
    expected: &str,
    output: &str,
) -> Result<String, String> {
    crate::services::mutation(|| {
        let current = read(dir, name)?;
        if blake3::hash(current.as_bytes()).to_hex().as_str() != expected {
            return Err("File version conflict".into());
        }
        let temporary = format!(
            ".maghemite-write-search-{}-{}",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = dir
            .open_with(&temporary, OpenOptions::new().write(true).create_new(true))
            .map_err(|e| e.to_string())?;
        let result = (|| {
            file.set_permissions(dir.metadata(name).map_err(|e| e.to_string())?.permissions())
                .map_err(|e| e.to_string())?;
            file.write_all(output.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            if blake3::hash(read(dir, name)?.as_bytes()).to_hex().as_str() != expected {
                return Err("File version conflict".into());
            }
            dir.rename(&temporary, dir, name)
                .map_err(|e| e.to_string())?;
            Ok(blake3::hash(output.as_bytes()).to_hex().to_string())
        })();
        match dir.remove_file(&temporary) {
            Ok(()) => result,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => result,
            Err(e) => Err(format!(
                "Temporary search write cleanup failed: {e}; result: {result:?}"
            )),
        }
    })
}
