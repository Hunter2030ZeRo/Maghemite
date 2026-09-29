use std::path::PathBuf;

#[derive(Clone, Debug)]
pub(crate) struct Workspace {
    pub root: PathBuf,
    pub database: PathBuf,
}
