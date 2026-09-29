use std::{
    collections::HashMap,
    fs, io,
    path::{Component, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
};

use crate::{CoreError, StatusCode, workspace};

mod pipeline;

const QUEUED: u64 = 0;
const RUNNING: u64 = 1;
const COMPLETED: u64 = 2;
const CANCELLED: u64 = 3;
const FAILED: u64 = 4;

enum JobKind {
    Full,
    Refresh(Vec<PathBuf>),
}

/// All fields are u64 so the Deno buffer has a stable, padding-free layout.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct IndexStatus {
    pub phase: u64,
    pub scanned: u64,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub bytes: u64,
    pub revision: u64,
    pub error_code: u64,
}

struct Job {
    workspace_id: u64,
    status: Mutex<IndexStatus>,
    error: Mutex<String>,
    cancel: AtomicBool,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Job {
    fn new(workspace_id: u64) -> Self {
        Self {
            workspace_id,
            status: Mutex::new(IndexStatus {
                phase: QUEUED,
                ..IndexStatus::default()
            }),
            error: Mutex::new(String::new()),
            cancel: AtomicBool::new(false),
            thread: Mutex::new(None),
        }
    }

    fn snapshot(&self) -> IndexStatus {
        *self
            .status
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn update(&self, f: impl FnOnce(&mut IndexStatus)) {
        f(&mut self
            .status
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()));
    }
}

static JOBS: OnceLock<Mutex<HashMap<u64, Arc<Job>>>> = OnceLock::new();
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Job>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn terminal(phase: u64) -> bool {
    matches!(phase, COMPLETED | CANCELLED | FAILED)
}

pub(crate) fn start(workspace_id: u64) -> Result<u64, CoreError> {
    start_job(workspace_id, JobKind::Full)
}

pub(crate) fn refresh(workspace_id: u64, paths: Vec<PathBuf>) -> Result<u64, CoreError> {
    if paths.is_empty() {
        return Err(CoreError::InvalidArgument("refresh path list is empty"));
    }
    start_job(workspace_id, JobKind::Refresh(paths))
}

fn start_job(workspace_id: u64, mut kind: JobKind) -> Result<u64, CoreError> {
    let mut guard = jobs().lock().unwrap_or_else(|poison| poison.into_inner());
    let workspace = workspace::lookup(workspace_id)?;
    if let JobKind::Refresh(paths) = &mut kind {
        for path in paths.iter() {
            if !path.is_absolute()
                || path.strip_prefix(&workspace.root).is_err()
                || path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
            {
                return Err(CoreError::InvalidArgument(
                    "refresh path is outside workspace",
                ));
            }
            let mut ancestor = path.parent();
            while let Some(parent) = ancestor {
                if parent == workspace.root {
                    break;
                }
                match fs::symlink_metadata(parent) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(CoreError::InvalidArgument(
                            "refresh path crosses a symbolic link",
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                ancestor = parent.parent();
            }
        }
        if paths.iter().any(|path| path == &workspace.root) {
            kind = JobKind::Full;
        } else {
            paths.sort();
            paths.dedup();
            let mut roots: Vec<PathBuf> = Vec::with_capacity(paths.len());
            for path in paths.drain(..) {
                if !roots.iter().any(|root| path.starts_with(root)) {
                    roots.push(path);
                }
            }
            *paths = roots;
        }
    }
    if guard
        .values()
        .any(|job| job.workspace_id == workspace_id && !terminal(job.snapshot().phase))
    {
        return Err(CoreError::AlreadyRunning);
    }

    let id = NEXT_JOB_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| CoreError::Busy)?;
    let job = Arc::new(Job::new(workspace_id));
    guard.insert(id, Arc::clone(&job));

    let worker_job = Arc::clone(&job);
    match thread::Builder::new()
        .name(format!("maghemite-index-{id}"))
        .spawn(move || run(workspace, worker_job, kind))
    {
        Ok(handle) => {
            *job.thread
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(handle);
            Ok(id)
        }
        Err(error) => {
            guard.remove(&id);
            Err(CoreError::Io(error))
        }
    }
}

fn run(workspace: workspace::Workspace, job: Arc<Job>, kind: JobKind) {
    job.update(|status| status.phase = RUNNING);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pipeline::scan(&workspace, &job, &kind)
    }));
    match result {
        Ok(Ok(revision)) => job.update(|status| {
            status.revision = revision;
            status.phase = COMPLETED;
        }),
        Ok(Err(CoreError::Cancelled)) => job.update(|status| {
            status.added = 0;
            status.updated = 0;
            status.removed = 0;
            status.phase = CANCELLED;
        }),
        Ok(Err(error)) => {
            *job.error
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = error.to_string();
            job.update(|status| {
                status.added = 0;
                status.updated = 0;
                status.removed = 0;
                status.error_code = error.code() as u64;
                status.phase = FAILED;
            });
        }
        Err(_) => {
            *job.error
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) =
                "native index worker panicked".to_owned();
            job.update(|status| {
                status.added = 0;
                status.updated = 0;
                status.removed = 0;
                status.error_code = StatusCode::Internal as u64;
                status.phase = FAILED;
            });
        }
    }
}

fn get(id: u64) -> Result<Arc<Job>, CoreError> {
    jobs()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(&id)
        .cloned()
        .ok_or(CoreError::UnknownJob)
}

pub(crate) fn status(id: u64) -> Result<IndexStatus, CoreError> {
    Ok(get(id)?.snapshot())
}

pub(crate) fn error_message(id: u64) -> Result<String, CoreError> {
    Ok(get(id)?
        .error
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone())
}

pub(crate) fn cancel(id: u64) -> Result<(), CoreError> {
    get(id)?.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

pub(crate) fn release(id: u64) -> Result<(), CoreError> {
    let job = {
        let mut guard = jobs().lock().unwrap_or_else(|poison| poison.into_inner());
        let job = guard.get(&id).ok_or(CoreError::UnknownJob)?;
        if !terminal(job.snapshot().phase) {
            return Err(CoreError::Busy);
        }
        guard.remove(&id).expect("job exists")
    };
    if let Some(handle) = job
        .thread
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take()
    {
        let _ = handle.join();
    }
    Ok(())
}

pub(crate) fn close_workspace(workspace_id: u64) -> Result<(), CoreError> {
    // The same lock protects start(), so close cannot race a new job being scheduled.
    let guard = jobs().lock().unwrap_or_else(|poison| poison.into_inner());
    if guard
        .values()
        .any(|job| job.workspace_id == workspace_id && !terminal(job.snapshot().phase))
    {
        return Err(CoreError::Busy);
    }
    workspace::close(workspace_id)
}

pub(crate) fn shutdown() {
    let all: Vec<_> = jobs()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .drain()
        .map(|(_, job)| job)
        .collect();
    for job in &all {
        job.cancel.store(true, Ordering::Relaxed);
    }
    for job in all {
        if let Some(handle) = job
            .thread
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
        {
            let _ = handle.join();
        }
    }
}
