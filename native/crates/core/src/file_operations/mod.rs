//! Confined, non-overwriting workspace moves. All mutations share services' lock.
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, OpenOptions};
use std::io::Read;

pub(crate) const TRASH: &str = ".maghemite-trash";

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod operations;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) use operations::request;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn request(
    _root: &Dir,
    _workspace: &crate::workspace::Workspace,
    _method: &str,
    _parameters: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Atomic no-replace file operations are unsupported on this platform".into())
}

/// Every component is opened separately without following a symlink.
/// Callers retain the returned capability through validation and mutation.
pub(crate) fn parent(root: &Dir, path: &str) -> Result<(Dir, String), String> {
    crate::services::path(path, false)?;
    let mut parts = path.split('/').peekable();
    let mut dir = root.try_clone().map_err(|e| e.to_string())?;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            return Ok((dir, part.to_owned()));
        }
        dir = dir.open_dir_nofollow(part).map_err(|e| e.to_string())?;
    }
    Err("Invalid workspace path".into())
}

pub(crate) fn directory(root: &Dir, path: &str) -> Result<Dir, String> {
    if path.is_empty() {
        return root.try_clone().map_err(|e| e.to_string());
    }
    let (dir, name) = parent(root, path)?;
    dir.open_dir_nofollow(name).map_err(|e| e.to_string())
}

pub(crate) fn read(dir: &Dir, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    let file = dir.open_with(name, &options).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Expected bounded regular non-symlink file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if u64::try_from(bytes.len()).map_err(|e| e.to_string())? > limit {
        return Err("File exceeds size limit".into());
    }
    Ok(bytes)
}
