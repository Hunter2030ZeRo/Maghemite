use super::{MAX_ITEMS, ParsedText};
use crate::index::symbol::{Link, Symbol};

pub(super) fn parse(content: &str) -> ParsedText {
    let mut parsed = ParsedText::default();
    let mut fence: Option<char> = None;
    for (index, line) in content.lines().enumerate() {
        let line_number = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(marker) = marker {
            if fence.is_none() {
                fence = Some(marker);
            } else if fence == Some(marker) {
                fence = None;
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if parsed.symbols.len() < MAX_ITEMS {
            let level = trimmed.bytes().take_while(|byte| *byte == b'#').count();
            if (1..=6).contains(&level) && trimmed.as_bytes().get(level) == Some(&b' ') {
                let name = trimmed[level..].trim().trim_end_matches('#').trim();
                if !name.is_empty() && name.len() <= 256 {
                    parsed.symbols.push(Symbol {
                        name: name.to_owned(),
                        kind: "heading",
                        line: line_number,
                        source: None,
                        container: None,
                    });
                }
            }
        }
        extract_wikilinks(line, line_number, &mut parsed.links);
        extract_markdown_links(line, line_number, &mut parsed.links);
    }
    parsed
}

fn extract_wikilinks(line: &str, line_number: u32, links: &mut Vec<Link>) {
    let mut rest = line;
    while links.len() < MAX_ITEMS {
        let Some(start) = rest.find("[[") else { break };
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let target = rest[..end].split('|').next().unwrap_or("").trim();
        if !target.is_empty() && target.len() <= 1024 {
            links.push(Link {
                target: target.to_owned(),
                line: line_number,
            });
        }
        rest = &rest[end + 2..];
    }
}

fn extract_markdown_links(line: &str, line_number: u32, links: &mut Vec<Link>) {
    let mut rest = line;
    while links.len() < MAX_ITEMS {
        let Some(start) = rest.find("](") else { break };
        let before = &rest[..start];
        rest = &rest[start + 2..];
        let Some(end) = rest.find(')') else { break };
        if before.rfind('[').is_some() {
            let target = rest[..end].trim().trim_matches('<').trim_matches('>');
            if !target.is_empty() && target.len() <= 1024 {
                links.push(Link {
                    target: target.to_owned(),
                    line: line_number,
                });
            }
        }
        rest = &rest[end + 1..];
    }
}
