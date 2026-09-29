use super::types::{MAX_FILE, Match, Stored, clipped};
use regex::Captures;

/// Regex replacement grammar, with a bound checked before every append.
pub(super) fn expand(captures: &Captures<'_>, template: &str) -> Result<String, String> {
    let mut output = String::new();
    let mut remaining = template;
    while let Some(dollar) = remaining.find('$') {
        append(&mut output, &remaining[..dollar])?;
        remaining = &remaining[dollar + 1..];
        if let Some(rest) = remaining.strip_prefix('$') {
            append(&mut output, "$")?;
            remaining = rest;
            continue;
        }
        let reference = if let Some(braced) = remaining.strip_prefix('{') {
            braced.find('}').map(|end| (&braced[..end], end + 2))
        } else {
            let end = remaining
                .bytes()
                .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                .count();
            (end > 0).then_some((&remaining[..end], end))
        };
        if let Some((name, consumed)) = reference {
            let found = match name.parse::<usize>() {
                Ok(index) => captures.get(index),
                Err(_) => captures.name(name),
            };
            if let Some(found) = found {
                append(&mut output, found.as_str())?;
            }
            remaining = &remaining[consumed..];
        } else {
            append(&mut output, "$")?;
        }
    }
    append(&mut output, remaining)?;
    Ok(output)
}

pub(super) fn append(output: &mut String, text: &str) -> Result<(), String> {
    if output.len().saturating_add(text.len()) > MAX_FILE {
        return Err("Replacement exceeds 2 MiB file limit".into());
    }
    output.push_str(text);
    Ok(())
}

#[derive(Default)]
pub(super) struct Position {
    byte: usize,
    utf16: usize,
    line: usize,
    column: usize,
    line_start: usize,
    context_end: Option<usize>,
}
impl Position {
    fn advance(&mut self, text: &str, end: usize) {
        for (offset, ch) in text[self.byte..end].char_indices() {
            self.utf16 += ch.len_utf16();
            if ch == '\n' {
                self.line += 1;
                self.column = 0;
                self.line_start = self.byte + offset + 1;
            } else {
                self.column += ch.len_utf16();
            }
        }
        self.byte = end;
    }

    pub fn record(
        &mut self,
        text: &str,
        capture: &Captures<'_>,
        mut visible: Match,
    ) -> Result<Stored, String> {
        let found = capture.get(0).ok_or("Search match missing")?;
        self.advance(text, found.start());
        visible.from = self.utf16;
        visible.line = self.line + 1;
        visible.column = self.column;
        let line_start = self.line_start;
        let line_end = match self.context_end {
            Some(end) if end >= found.start() => end,
            _ => {
                let end = text[found.start()..]
                    .find('\n')
                    .map_or(text.len(), |i| found.start() + i);
                self.context_end = Some(end);
                end
            }
        };
        self.advance(text, found.end());
        visible.to = self.utf16;
        visible.end_line = self.line + 1;
        visible.end_column = self.column;
        // Include context around the beginning of the match, even on very long lines.
        let context_start = text[line_start..found.start()]
            .char_indices()
            .rev()
            .nth(80)
            .map_or(line_start, |(i, _)| line_start + i);
        let (preview, clipped) = clipped(text[context_start..line_end].trim_end_matches('\r'));
        visible.text = preview;
        visible.text_truncated = clipped || context_start != line_start || found.end() > line_end;
        let bytes = serde_json::to_vec(&visible)
            .map_err(|e| e.to_string())?
            .len();
        Ok(Stored {
            visible,
            start: found.start(),
            end: found.end(),
            bytes,
        })
    }
}
