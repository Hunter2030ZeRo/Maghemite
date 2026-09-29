use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex, MutexGuard, atomic::AtomicBool};

pub(super) const MAX_FILE: usize = 2 * 1024 * 1024;
pub(super) const MAX_RESULTS: usize = 10_000;
pub(super) const MAX_MEMORY: usize = 16 * 1024 * 1024;
pub(super) const PAGE_BYTES: usize = 40 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Start {
    pub owner: String,
    pub query: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub skip_paths: Vec<String>,
    pub replacement: Option<String>,
    pub max_results: Option<usize>,
}

impl Start {
    pub fn compile(&self) -> Result<Regex, String> {
        if self.owner.is_empty()
            || self.owner.len() > 512
            || self.query.is_empty()
            || self.query.len() > 4096
            || self.query.contains('\0')
            || self
                .replacement
                .as_ref()
                .is_some_and(|s| s.len() > 16_384 || s.contains('\0'))
            || !(1..=MAX_RESULTS).contains(&self.max_results.unwrap_or(2000))
        {
            return Err("Invalid search options".into());
        }
        validate_paths(&self.skip_paths)?;
        let pattern = if self.regex {
            self.query.clone()
        } else {
            regex::escape(&self.query)
        };
        RegexBuilder::new(&pattern)
            .case_insensitive(!self.case_sensitive)
            .multi_line(true)
            .size_limit(1024 * 1024)
            .dfa_size_limit(4 * 1024 * 1024)
            .build()
            .map_err(|e| format!("Invalid search regex: {e}"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Handle {
    pub owner: String,
    pub search: String,
    #[serde(default)]
    pub cursor: usize,
    pub wait_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Replace {
    pub owner: String,
    pub search: String,
    pub result_ids: Vec<String>,
    pub skip_paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Match {
    pub id: String,
    pub path: String,
    pub version: String,
    pub from: usize,
    pub to: usize,
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub text: String,
    pub text_truncated: bool,
    pub replacement: Option<String>,
    pub replacement_truncated: bool,
}

#[derive(Clone)]
pub(super) struct Stored {
    pub visible: Match,
    pub start: usize,
    pub end: usize,
    pub bytes: usize,
}

#[derive(Default)]
pub(super) struct State {
    pub results: Vec<Stored>,
    pub bytes: usize,
    pub done: bool,
    pub cancelled: bool,
    pub released: bool,
    pub truncated: bool,
    pub scanned: usize,
    pub skipped: usize,
    pub error: Option<String>,
}

pub(super) struct Job {
    pub workspace: u64,
    pub owner: String,
    pub root: cap_std::fs::Dir,
    pub options: Start,
    pub pattern: Regex,
    pub cancel: AtomicBool,
    pub state: Mutex<State>,
    pub changed: Condvar,
    pub operation: Mutex<()>,
    pub worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

pub(super) fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.len() > 256 {
        return Err("Too many search skip paths".into());
    }
    for path in paths {
        crate::services::path(path, false)?;
        if path.len() > 1024 {
            return Err("Search path exceeds limit".into());
        }
    }
    Ok(())
}

pub(super) fn clipped(text: &str) -> (String, bool) {
    let end = text.char_indices().nth(512).map_or(text.len(), |(i, _)| i);
    (text[..end].to_owned(), end < text.len())
}
