use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use crate::CoreError;

use super::Workspace;

#[derive(Default)]
struct Registry {
    next_id: u64,
    workspaces: HashMap<u64, Workspace>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub(crate) fn open(root: PathBuf, database: PathBuf) -> Result<u64, CoreError> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(CoreError::InvalidArgument(
            "workspace root is not a directory",
        ));
    }
    if !database.is_absolute() {
        return Err(CoreError::InvalidArgument("database path must be absolute"));
    }
    let parent = database.parent().ok_or(CoreError::InvalidArgument(
        "database path has no parent directory",
    ))?;
    let name = database
        .file_name()
        .ok_or(CoreError::InvalidArgument("database path has no filename"))?;
    // SQLite and its WAL files must not become entries in the indexed workspace.
    if parent.starts_with(&root) {
        return Err(CoreError::InvalidArgument(
            "database path must be outside the workspace",
        ));
    }
    fs::create_dir_all(parent)?;
    let database = fs::canonicalize(parent)?.join(name);
    if database.starts_with(&root) {
        return Err(CoreError::InvalidArgument(
            "database path must be outside the workspace",
        ));
    }
    if fs::symlink_metadata(&database).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(CoreError::InvalidArgument(
            "database path cannot be a symbolic link",
        ));
    }

    let mut guard = registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if guard
        .workspaces
        .values()
        .any(|workspace| workspace.root == root || workspace.database == database)
    {
        return Err(CoreError::Busy);
    }
    guard.next_id = guard.next_id.checked_add(1).ok_or(CoreError::Busy)?;
    let id = guard.next_id;
    guard.workspaces.insert(id, Workspace { root, database });
    Ok(id)
}

pub(crate) fn lookup(id: u64) -> Result<Workspace, CoreError> {
    registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .workspaces
        .get(&id)
        .cloned()
        .ok_or(CoreError::UnknownWorkspace)
}

pub(crate) fn close(id: u64) -> Result<(), CoreError> {
    registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .workspaces
        .remove(&id)
        .map(|_| ())
        .ok_or(CoreError::UnknownWorkspace)?;
    crate::search::close_workspace(id);
    Ok(())
}

pub(crate) fn clear() {
    registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .workspaces
        .clear();
}
