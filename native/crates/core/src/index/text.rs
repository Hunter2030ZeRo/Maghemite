use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

use super::symbol::{Link, Symbol};
use crate::CoreError;

mod markdown;
mod source;
#[cfg(test)]
mod tests;

pub(super) use source::Languages;

// Bump whenever extraction rules or stored symbol semantics change.
pub(super) const ANALYSIS_VERSION: i64 = 2;
const MAX_ITEMS: usize = 4096;

#[derive(Default)]
pub(super) struct ParsedText {
    pub symbols: Vec<Symbol>,
    pub links: Vec<Link>,
}

pub(super) fn supports(path: &Path) -> bool {
    extension(path).is_some_and(|extension| {
        is_markdown(&extension) || source::language_id(&extension).is_some()
    })
}

fn extension(path: &Path) -> Option<String> {
    path.extension()?.to_str().map(str::to_ascii_lowercase)
}

fn is_markdown(extension: &str) -> bool {
    matches!(extension, "md" | "markdown" | "mdx")
}

// Owned by a Rayon consumer and reused for its files. No shared parser lock or
// process-global thread-local state that could outlive the FFI library.
pub(super) struct TextParser<'a> {
    source: source::SourceParser<'a>,
}

impl<'a> TextParser<'a> {
    pub fn new(languages: &'a Languages) -> Self {
        Self {
            source: source::SourceParser::new(languages),
        }
    }

    pub fn parse(
        &mut self,
        path: &Path,
        bytes: &[u8],
        cancel: &AtomicBool,
        abort: &AtomicBool,
    ) -> Result<ParsedText, CoreError> {
        if cancel.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed) {
            return Err(CoreError::Cancelled);
        }
        if bytes.contains(&0) {
            return Ok(ParsedText::default());
        }
        let Ok(content) = std::str::from_utf8(bytes) else {
            return Ok(ParsedText::default());
        };
        let Some(extension) = extension(path) else {
            return Ok(ParsedText::default());
        };
        if is_markdown(&extension) {
            return Ok(markdown::parse(content));
        }
        self.source.parse(&extension, content, cancel, abort)
    }
}
