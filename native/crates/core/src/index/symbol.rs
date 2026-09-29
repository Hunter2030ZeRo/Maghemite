#[derive(Debug)]
pub(super) struct Symbol {
    pub name: String,
    pub kind: &'static str,
    pub line: u32,
    pub source: Option<SourceLocation>,
    pub container: Option<String>,
}

/// UTF-8 byte offsets/columns; lines are one-based, end positions are exclusive.
/// The selection covers the name; the declaration covers its syntactic owner.
#[derive(Debug)]
pub(super) struct SourceLocation {
    pub language: &'static str,
    pub start_byte: usize,
    pub end_byte: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub declaration_start_byte: usize,
    pub declaration_end_byte: usize,
}

#[derive(Debug)]
pub(super) struct Link {
    pub target: String,
    pub line: u32,
}
