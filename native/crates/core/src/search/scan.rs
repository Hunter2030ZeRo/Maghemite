use super::{
    disk,
    matching::{self, Position},
    types::{Job, MAX_MEMORY, Match, Start, clipped, lock},
};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use std::{
    path::{Path, PathBuf},
    sync::atomic::Ordering,
};

pub(super) struct Filter {
    include: GlobSet,
    exclude: GlobSet,
}
impl Filter {
    pub fn new(options: &Start) -> Result<Self, String> {
        let compile = |patterns: &[String]| -> Result<GlobSet, String> {
            if patterns.len() > 32 {
                return Err("Too many search globs".into());
            }
            let mut builder = GlobSetBuilder::new();
            for pattern in patterns {
                if pattern.is_empty() || pattern.len() > 1024 || pattern.contains(['\0', '\\']) {
                    return Err("Invalid search glob".into());
                }
                builder.add(Glob::new(pattern).map_err(|e| format!("Invalid search glob: {e}"))?);
            }
            builder.build().map_err(|e| e.to_string())
        };
        Ok(Self {
            include: compile(&options.include)?,
            exclude: compile(&options.exclude)?,
        })
    }
}

pub(super) fn run(root: &Path, job: &Job, filter: Filter) -> Result<(), String> {
    let root_path = root.to_path_buf();
    let excluded = filter.exclude.clone();
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_global(false)
        .max_depth(Some(128))
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_str().unwrap_or("");
            !matches!(
                name,
                ".git" | ".hg" | ".svn" | "node_modules" | "target" | ".venv" | "__pycache__"
            ) && !name.starts_with(".maghemite-write-")
                && name != crate::file_operations::TRASH
                && !excluded.is_match(
                    entry
                        .path()
                        .strip_prefix(&root_path)
                        .unwrap_or(entry.path()),
                )
        });
    let mut visited = 0;
    for entry in builder.build() {
        if job.cancel.load(Ordering::Relaxed) {
            break;
        }
        visited += 1;
        if visited > 1_000_000 {
            lock(&job.state).truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                lock(&job.state).skipped += 1;
                continue;
            }
        };
        if entry.depth() == 128 && entry.file_type().is_some_and(|t| t.is_dir()) {
            lock(&job.state).truncated = true;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let relative: PathBuf = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .into();
        let Some(path) = relative
            .to_str()
            .map(|p| p.replace(std::path::MAIN_SEPARATOR, "/"))
        else {
            lock(&job.state).skipped += 1;
            continue;
        };
        if path.len() > 1024
            || job.options.skip_paths.contains(&path)
            || (!filter.include.is_empty() && !filter.include.is_match(&relative))
        {
            continue;
        }
        let text =
            match disk::parent(&job.root, &path).and_then(|(dir, name)| disk::read(&dir, &name)) {
                Ok(text) => text,
                Err(_) => {
                    lock(&job.state).skipped += 1;
                    continue;
                }
            };
        lock(&job.state).scanned += 1;
        let version = blake3::hash(text.as_bytes()).to_hex().to_string();
        let mut position = Position::default();
        for capture in job.pattern.captures_iter(&text) {
            if job.cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            let replacement = job
                .options
                .replacement
                .as_ref()
                .map(|template| {
                    if job.options.regex {
                        matching::expand(&capture, template)
                    } else {
                        Ok(template.clone())
                    }
                })
                .transpose()?;
            let (replacement, replacement_truncated) = match replacement {
                Some(text) => {
                    let (text, clipped) = clipped(&text);
                    (Some(text), clipped)
                }
                None => (None, false),
            };
            let id = lock(&job.state).results.len().to_string();
            let item = position.record(
                &text,
                &capture,
                Match {
                    id,
                    path: path.clone(),
                    version: version.clone(),
                    from: 0,
                    to: 0,
                    line: 0,
                    column: 0,
                    end_line: 0,
                    end_column: 0,
                    text: String::new(),
                    text_truncated: false,
                    replacement,
                    replacement_truncated,
                },
            )?;
            let mut state = lock(&job.state);
            if state.results.len() >= job.options.max_results.unwrap_or(2000)
                || state.bytes + item.bytes > MAX_MEMORY
            {
                state.truncated = true;
                return Ok(());
            }
            state.bytes += item.bytes;
            state.results.push(item);
            job.changed.notify_all();
        }
    }
    Ok(())
}
