use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;
use wasmtime::{Result, error::ensure};

/// A retained no-follow directory handle; child reads cannot follow a replaced
/// pathname on Unix. The caller still supplies trusted receipt authority.
pub(super) struct GenerationDirectory {
    #[cfg(unix)]
    directory: File,
    #[cfg(not(unix))]
    path: std::path::PathBuf,
}

impl GenerationDirectory {
    pub(super) fn open(path: &Path) -> Result<Self> {
        ensure!(path.is_absolute(), "Generation path must be absolute");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
            // Walk each component with openat, never follow ancestor symlinks.
            let mut directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open("/")?;
            for component in path.components() {
                match component {
                    std::path::Component::RootDir => {}
                    std::path::Component::Normal(name) => {
                        directory = open_child(&directory, name, libc::O_DIRECTORY)?;
                    }
                    _ => wasmtime::error::bail!("Invalid generation path"),
                }
            }
            let metadata = directory.metadata()?;
            ensure!(
                metadata.mode() & 0o077 == 0,
                "Generation must be private (0700)"
            );
            // SAFETY: [FFI] geteuid has no preconditions or borrowed memory.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() },
                "Foreign generation owner"
            );
            Ok(Self { directory })
        }
        #[cfg(not(unix))]
        {
            for ancestor in path.ancestors() {
                let metadata = std::fs::symlink_metadata(ancestor)?;
                ensure!(
                    metadata.is_dir() && !is_link(&metadata),
                    "Invalid generation directory"
                );
            }
            Ok(Self {
                path: path.to_owned(),
            })
        }
    }

    pub(super) fn read(&self, name: &str, limit: u64) -> Result<Vec<u8>> {
        ensure!(
            !name.is_empty() && !name.contains(['/', '\\', ':', '\0']),
            "Invalid artifact filename"
        );
        #[cfg(unix)]
        let file = open_child(&self.directory, std::ffi::OsStr::new(name), 0)?;
        #[cfg(not(unix))]
        let file = {
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // Open the reparse point itself rather than its target.
                options.custom_flags(0x0020_0000);
            }
            let file = options.open(self.path.join(name))?;
            ensure!(!is_link(&file.metadata()?), "Artifact is a link");
            file
        };
        let metadata = file.metadata()?;
        ensure!(metadata.is_file(), "Artifact must be a regular file");
        ensure!(metadata.len() <= limit, "Artifact exceeds size bound");
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(usize::try_from(metadata.len())?)?;
        // Also bound growth after metadata: at most one extra byte is read.
        file.take(limit + 1).read_to_end(&mut bytes)?;
        ensure!(
            u64::try_from(bytes.len())? <= limit,
            "Artifact grew beyond size bound"
        );
        Ok(bytes)
    }
}

#[cfg(unix)]
fn open_child(directory: &File, name: &std::ffi::OsStr, flags: libc::c_int) -> Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(name.as_bytes())?;
    // SAFETY: [FFI] directory owns a valid fd; name is live and NUL-terminated.
    // O_NONBLOCK prevents a substituted FIFO from hanging before fstat rejects it.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK | flags,
        )
    };
    ensure!(
        fd >= 0,
        "Cannot open generation entry: {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: [Double free] openat returned a new owned fd, wrapped exactly once.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(not(unix))]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
