use super::{
    disk, matching,
    types::{Job, PAGE_BYTES, Replace, Stored, lock, validate_paths},
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileResult {
    path: String,
    status: &'static str,
    version: Option<String>,
    replacements: usize,
    error: Option<String>,
}

pub(super) fn apply(job: &Job, input: Replace) -> Result<Value, String> {
    validate_paths(&input.skip_paths)?;
    if input.result_ids.is_empty() || input.result_ids.len() > 256 {
        return Err("Select between 1 and 256 search results".into());
    }
    let template = job
        .options
        .replacement
        .as_deref()
        .ok_or("Search has no replacement preview")?;
    let _operation = lock(&job.operation);
    let selected = {
        let state = lock(&job.state);
        if state.released {
            return Err("Search released".into());
        }
        if !state.done {
            return Err("Finish or cancel search before replacement".into());
        }
        let mut ids = HashSet::new();
        let mut selected: BTreeMap<String, Vec<Stored>> = BTreeMap::new();
        for id in &input.result_ids {
            if !ids.insert(id) {
                return Err("Duplicate or overlapping result IDs".into());
            }
            let item = id
                .parse::<usize>()
                .ok()
                .and_then(|i| state.results.get(i))
                .filter(|item| item.visible.id == *id)
                .ok_or("Unknown search result ID")?;
            selected
                .entry(item.visible.path.clone())
                .or_default()
                .push(item.clone());
        }
        let mut budget = 1024;
        for (path, items) in &mut selected {
            items.sort_by_key(|item| item.start);
            if items
                .windows(2)
                .any(|pair| pair[0].end > pair[1].start || pair[0].start == pair[1].start)
            {
                return Err("Overlapping search results".into());
            }
            // Bound the response before ANY write, including worst-case escaped errors.
            budget += serde_json::to_vec(path).map_err(|e| e.to_string())?.len() + 2048;
            if budget > PAGE_BYTES {
                return Err("Replacement reply would exceed page limit; select fewer files".into());
            }
        }
        selected
    };
    let mut files = Vec::new();
    for (path, items) in selected {
        let mut result = FileResult {
            path,
            status: "excluded",
            version: None,
            replacements: 0,
            error: None,
        };
        if input.skip_paths.contains(&result.path) {
            files.push(result);
            continue;
        }
        let work = (|| {
            if lock(&job.state).released {
                return Err("Search released".into());
            }
            let (dir, name) = disk::parent(&job.root, &result.path)?;
            let original = disk::read(&dir, &name)?;
            let expected = &items[0].visible.version;
            if items.iter().any(|item| &item.visible.version != expected)
                || blake3::hash(original.as_bytes()).to_hex().as_str() != expected
            {
                return Err("File version conflict".into());
            }
            let mut output = String::new();
            let mut last = 0;
            for item in &items {
                if !original.is_char_boundary(item.start)
                    || !original.is_char_boundary(item.end)
                    || item.start < last
                    || item.end > original.len()
                {
                    return Err("Invalid or overlapping search offsets".into());
                }
                matching::append(&mut output, &original[last..item.start])?;
                if job.options.regex {
                    // Keep full original context for anchors and capture groups.
                    let capture = job
                        .pattern
                        .captures_at(&original, item.start)
                        .filter(|c| {
                            c.get(0)
                                .is_some_and(|m| m.start() == item.start && m.end() == item.end)
                        })
                        .ok_or("Search result no longer matches")?;
                    matching::append(&mut output, &matching::expand(&capture, template)?)?;
                } else {
                    matching::append(&mut output, template)?;
                }
                last = item.end;
            }
            matching::append(&mut output, &original[last..])?;
            // Holding operation ensures release cannot finish before this commit finishes.
            if lock(&job.state).released {
                return Err("Search released".into());
            }
            disk::commit(&dir, &name, expected, &output)
        })();
        match work {
            Ok(version) => {
                result.status = "applied";
                result.version = Some(version);
                result.replacements = items.len();
            }
            Err(error) => {
                result.status = if error == "File version conflict" {
                    "conflict"
                } else {
                    "error"
                };
                result.error = Some(error.chars().take(256).collect());
            }
        }
        files.push(result);
    }
    Ok(serde_json::json!({"files":files}))
}
