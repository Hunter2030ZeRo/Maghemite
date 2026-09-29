use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use wasmtime::{Cache, CacheConfig};

/// Host-enforced budgets available to every WebAssembly module.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ResourceProfile {
    #[default]
    Standard,
    Compute,
}
impl ResourceProfile {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "standard" => Ok(Self::Standard),
            "compute" => Ok(Self::Compute),
            _ => Err("Unknown resource profile"),
        }
    }
    pub fn memory_bytes(self) -> usize {
        (match self {
            Self::Standard => 128,
            Self::Compute => 256,
        }) * 1024
            * 1024
    }
    pub fn call_fuel(self) -> u64 {
        match self {
            Self::Standard => 50_000_000,
            Self::Compute => 10_000_000_000,
        }
    }
    pub fn startup_fuel(self) -> u64 {
        match self {
            Self::Standard => 500_000_000,
            Self::Compute => 50_000_000_000,
        }
    }
}
/// Application-validated options. A manifest selects only a bounded profile;
/// it cannot supply numeric budgets or disable fuel/memory/deadline enforcement.
#[derive(Debug)]
pub struct RuntimeOptions {
    pub cache_directory: Option<PathBuf>,
    pub compiler_threads: usize,
    pub diagnostics: bool,
    pub resources: ResourceProfile,
}

impl Default for RuntimeOptions {
    fn default() -> Self {
        Self {
            cache_directory: None,
            compiler_threads: 16,
            diagnostics: false,
            resources: ResourceProfile::Standard,
        }
    }
}

pub fn cache(directory: Option<&Path>) -> wasmtime::Result<Option<Cache>> {
    let Some(directory) = directory else {
        return Ok(None);
    };
    wasmtime::error::ensure!(directory.is_absolute(), "Cache directory must be absolute");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    let metadata = std::fs::symlink_metadata(directory)?;
    wasmtime::error::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Cache must be a private directory, not a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Cache entries contain executable native code. Other users must not
        // control this directory; guests receive no filesystem access to it.
        wasmtime::error::ensure!(
            metadata.mode() & 0o077 == 0,
            "Cache directory must have mode 0700"
        );
        // SAFETY: geteuid has no preconditions and does not access Rust memory.
        wasmtime::error::ensure!(
            metadata.uid() == unsafe { libc::geteuid() },
            "Cache directory must belong to the current user"
        );
    }
    let mut config = CacheConfig::new();
    config
        .with_directory(directory.canonicalize()?)
        .with_files_total_size_soft_limit(256 * 1024 * 1024)
        .with_file_count_soft_limit(1024)
        .with_cleanup_interval(Duration::from_secs(60))
        .with_optimized_compression_level(3);
    Ok(Some(
        Cache::new(config).map_err(|e| wasmtime::Error::msg(e.to_string()))?,
    ))
}

/// A bounded temporary compiler pool shared by Component Model and WASI commands.
/// Joining is required before trimming: dropping Rayon alone does not wait for TLS destruction.
pub fn compile<T: Send>(
    threads: usize,
    work: impl FnOnce() -> wasmtime::Result<T> + Send,
) -> wasmtime::Result<T> {
    wasmtime::error::ensure!(
        (1..=16).contains(&threads),
        "Compiler threads must be between 1 and 16"
    );
    let threads = threads.min(std::thread::available_parallelism().map_or(1, usize::from));
    let mut workers = Vec::new();
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .spawn_handler(|thread| {
            workers.push(
                std::thread::Builder::new()
                    .name("maghemite-compiler".into())
                    .spawn(|| thread.run())?,
            );
            Ok(())
        })
        .build();
    let result = match pool {
        Ok(pool) => {
            let result = pool.install(work);
            drop(pool);
            result
        }
        Err(e) => Err(wasmtime::Error::msg(e.to_string())),
    };
    let mut panicked = false;
    for worker in workers {
        panicked |= worker.join().is_err();
    }
    release_compiler_memory();
    wasmtime::error::ensure!(!panicked, "Compiler worker panicked");
    // The app owns this environment flag. It is not inherited by WASI guests.
    // Notify only after all compilation workers join, before any guest code.
    if result.is_ok() && std::env::var_os("MAGHEMITE_COMPILE_NOTIFY").is_some() {
        use std::io::Write;
        std::io::stderr().write_all(b"\x1eMAGHEMITE_COMPILED_V1\n")?;
    }
    result
}

pub fn release_compiler_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: glibc malloc_trim is thread-safe; it releases only free pages.
        // Do this once after compilation, never on the command execution path.
        unsafe {
            libc::malloc_trim(0);
        }
    }
}

/// Native-owned marker emitted only after verified AOT bytes are deserialized
/// and their transient owned buffer has been released.
pub fn notify_loaded() -> wasmtime::Result<()> {
    if std::env::var_os("MAGHEMITE_LOAD_NOTIFY").is_some() {
        use std::io::Write;
        std::io::stderr().write_all(b"\x1eMAGHEMITE_LOADED_V1\n")?;
    }
    Ok(())
}

pub(crate) struct Diagnostics {
    enabled: bool,
    start: Instant,
}

impl Diagnostics {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            start: Instant::now(),
        }
    }

    pub fn record(&self, phase: &str, cache: Option<&Cache>) {
        if !self.enabled {
            return;
        }
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let field = |name: &str| -> Option<u64> {
            status
                .lines()
                .find_map(|line| line.strip_prefix(name))?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        };
        eprintln!(
            "{}",
            serde_json::json!({
                "maghemiteStartup": phase,
                "elapsedMs": self.start.elapsed().as_secs_f64() * 1000.0,
                "rssKiB": field("VmRSS:"), "anonKiB": field("RssAnon:"),
                "peakRssKiB": field("VmHWM:"), "threads": field("Threads:"),
                "cacheHits": cache.map(Cache::cache_hits), "cacheMisses": cache.map(Cache::cache_misses),
            })
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct OnDrop(Arc<AtomicUsize>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    thread_local! { static GUARD: std::cell::RefCell<Option<OnDrop>> = const { std::cell::RefCell::new(None) }; }
    #[test]
    fn compiler_workers_release_tls_before_success_and_error_return() {
        for fail in [false, true] {
            let dropped = Arc::new(AtomicUsize::new(0));
            let initialized = Arc::new(AtomicUsize::new(0));
            let result = compile(3, || {
                rayon::broadcast(|_| {
                    GUARD.with(|guard| *guard.borrow_mut() = Some(OnDrop(dropped.clone())));
                    initialized.fetch_add(1, Ordering::SeqCst);
                });
                if fail {
                    Err(wasmtime::Error::msg("compile failed"))
                } else {
                    Ok(42)
                }
            });
            assert_eq!(result.is_err(), fail);
            assert!(initialized.load(Ordering::SeqCst) > 0);
            assert_eq!(
                dropped.load(Ordering::SeqCst),
                initialized.load(Ordering::SeqCst)
            );
        }
    }
    #[test]
    fn compiler_threads_remain_bounded() {
        for threads in [0, 17] {
            assert!(compile(threads, || Ok(())).is_err());
        }
    }
}
