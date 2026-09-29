//! Owned disk searches with bounded retention and condition-variable reads.
mod disk;
mod matching;
mod replace;
mod scan;
#[cfg(test)]
mod tests;
mod types;

use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use types::{Handle, Job, PAGE_BYTES, Replace, Start, State, lock};

#[derive(Default)]
struct Registry {
    next: u64,
    jobs: HashMap<String, Arc<Job>>,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub(crate) fn request(workspace: u64, method: &str, p: &Value) -> Result<Value, String> {
    if method == "search.start" {
        let options: Start = serde_json::from_value(p.clone()).map_err(|e| e.to_string())?;
        let pattern = options.compile()?;
        let filter = scan::Filter::new(&options)?;
        let mut registry = lock(registry());
        // Serialize registration with workspace removal/cleanup.
        let ws = crate::workspace::lookup(workspace).map_err(|e| e.to_string())?;
        if registry.jobs.len() >= 8
            || registry
                .jobs
                .values()
                .filter(|j| j.owner == options.owner)
                .count()
                >= 2
        {
            return Err("Search handle limit reached; release previous searches".into());
        }
        registry.next = registry.next.checked_add(1).ok_or("Search ID exhausted")?;
        let id = registry.next.to_string();
        let job = Arc::new(Job {
            workspace,
            owner: options.owner.clone(),
            options,
            pattern,
            root: cap_std::fs::Dir::open_ambient_dir(&ws.root, cap_std::ambient_authority())
                .map_err(|e| e.to_string())?,
            cancel: AtomicBool::new(false),
            state: Mutex::new(State::default()),
            changed: std::sync::Condvar::new(),
            operation: Mutex::new(()),
            worker: Mutex::new(None),
        });
        let worker_job = Arc::clone(&job);
        let worker = std::thread::Builder::new()
            .name(format!("search-{id}"))
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    scan::run(&ws.root, &worker_job, filter)
                }));
                let mut state = lock(&worker_job.state);
                state.error = match result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(_) => Some("Search worker failed".into()),
                };
                state.cancelled = worker_job.cancel.load(Ordering::Relaxed);
                state.done = true;
                worker_job.changed.notify_all();
            })
            .map_err(|e| e.to_string())?;
        *lock(&job.worker) = Some(worker);
        registry.jobs.insert(id.clone(), job);
        return Ok(json!({"search":id}));
    }
    if method == "search.replace" {
        let input: Replace = serde_json::from_value(p.clone()).map_err(|e| e.to_string())?;
        let job = owned(workspace, &input.search, &input.owner)?;
        return replace::apply(&job, input);
    }
    let input: Handle = serde_json::from_value(p.clone()).map_err(|e| e.to_string())?;
    let job = owned(workspace, &input.search, &input.owner)?;
    match method {
        "search.read" => read(&job, &input),
        "search.cancel" => {
            job.cancel.store(true, Ordering::Relaxed);
            lock(&job.state).cancelled = true;
            join(&job);
            Ok(Value::Null)
        }
        "search.release" => {
            let mut registry = lock(registry());
            registry.jobs.remove(&input.search);
            dispose(&job);
            Ok(Value::Null)
        }
        _ => Err("Unknown search method".into()),
    }
}

fn owned(workspace: u64, id: &str, owner: &str) -> Result<Arc<Job>, String> {
    lock(registry())
        .jobs
        .get(id)
        .filter(|j| j.workspace == workspace && j.owner == owner)
        .map(Arc::clone)
        .ok_or_else(|| "Unknown owned search".into())
}

fn read(job: &Job, input: &Handle) -> Result<Value, String> {
    let wait = input.wait_ms.unwrap_or(1000);
    if wait > 1000 {
        return Err("Search read wait exceeds 1000ms".into());
    }
    let state = lock(&job.state);
    if input.cursor > state.results.len() {
        return Err("Invalid search cursor".into());
    }
    let (state, _) = job
        .changed
        .wait_timeout_while(state, Duration::from_millis(wait), |s| {
            s.results.len() == input.cursor && !s.done && !s.released
        })
        .unwrap_or_else(|poison| poison.into_inner());
    if state.released {
        return Err("Search released".into());
    }
    let mut bytes = 1024;
    let mut matches = Vec::new();
    for item in state.results.iter().skip(input.cursor).take(100) {
        if bytes + item.bytes > PAGE_BYTES {
            break;
        }
        bytes += item.bytes;
        matches.push(&item.visible);
    }
    let cursor = input.cursor + matches.len();
    Ok(json!({
        "matches":matches,"cursor":cursor,"done":state.done && cursor == state.results.len(),
        "cancelled":state.cancelled,"truncated":state.truncated,
        "scannedFiles":state.scanned,"skippedFiles":state.skipped,"error":state.error,
    }))
}

fn join(job: &Job) {
    // Keep this guard through join so concurrent cancel/release also wait for exit.
    let mut worker = lock(&job.worker);
    if let Some(handle) = worker.take()
        && handle.join().is_err()
    {
        let mut state = lock(&job.state);
        state.error = Some("Search worker failed".into());
        state.done = true;
        job.changed.notify_all();
    }
}

fn dispose(job: &Job) {
    job.cancel.store(true, Ordering::Relaxed);
    {
        let mut state = lock(&job.state);
        state.released = true;
        job.changed.notify_all();
    }
    join(job);
    let _operation = lock(&job.operation);
    lock(&job.state).results.clear();
}

pub(crate) fn release_owner(owner: &str) {
    cleanup(|job| job.owner == owner);
}
pub(crate) fn close_workspace(workspace: u64) {
    cleanup(|job| job.workspace == workspace);
}
pub(crate) fn shutdown() {
    cleanup(|_| true);
}
fn cleanup(select: impl Fn(&Job) -> bool) {
    let mut registry = lock(registry());
    registry.jobs.retain(|_, job| {
        if select(job) {
            dispose(job);
            false
        } else {
            true
        }
    });
}
