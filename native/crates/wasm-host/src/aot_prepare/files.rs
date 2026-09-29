//! Private parent-owned paths; no mkdir or replacing writes in the producer.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use wasmtime::{Result, error::ensure};

pub(super) fn directory(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "Expected absolute private path");
    for part in path.components() {
        ensure!(
            matches!(part, std::path::Component::RootDir | std::path::Component::Normal(_) | std::path::Component::Prefix(_)),
            "Invalid private path"
        );
    }
    for ancestor in path.ancestors() {
        let meta = std::fs::symlink_metadata(ancestor)?;
        ensure!(meta.is_dir() && !meta.file_type().is_symlink(), "Invalid private directory");
    }
    Ok(())
}

pub(super) fn open(path: &Path, writable: bool) -> Result<File> {
    directory(path.parent().ok_or_else(|| wasmtime::Error::msg("Missing parent"))?)?;
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let meta = std::fs::symlink_metadata(path)?;
    ensure!(meta.is_file() && !meta.file_type().is_symlink(), "Expected regular private file");
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected regular private file");
    Ok(file)
}

pub(super) fn read(path: &Path, size: u64) -> Result<Vec<u8>> {
    let file = open(path, false)?;
    ensure!(file.metadata()?.len() == size, "Source size mismatch");
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(usize::try_from(size)?)?;
    file.take(size + 1).read_to_end(&mut bytes)?;
    ensure!(u64::try_from(bytes.len())? == size, "Source changed while reading");
    Ok(bytes)
}

pub(super) fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    // Staging is app-owned and remains leased. create_new rejects links/existing files.
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub(super) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    Ok(())
}
