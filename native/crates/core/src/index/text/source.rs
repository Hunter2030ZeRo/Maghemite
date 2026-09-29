use std::{
    ops::ControlFlow,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use tree_sitter::{
    Language, Node, ParseOptions, Parser, Query, QueryCursor, QueryCursorOptions, StreamingIterator,
};

use super::{MAX_ITEMS, ParsedText};
use crate::{
    CoreError,
    index::symbol::{SourceLocation, Symbol},
};

#[derive(Clone, Copy)]
pub(super) enum LanguageId {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
}

pub(super) fn language_id(extension: &str) -> Option<LanguageId> {
    Some(match extension {
        "rs" => LanguageId::Rust,
        "ts" | "mts" | "cts" => LanguageId::TypeScript,
        "tsx" => LanguageId::Tsx,
        "js" | "jsx" | "mjs" | "cjs" => LanguageId::JavaScript,
        "py" | "pyi" => LanguageId::Python,
        "go" => LanguageId::Go,
        _ => return None,
    })
}

struct Grammar {
    name: &'static str,
    language: Language,
    query: Query,
}

// Compile each language query once, when first needed by this index job.
// All caches are dropped after the scoped workers finish, before FFI unload.
pub(in crate::index) struct Languages {
    grammars: [OnceLock<Result<Grammar, String>>; 6],
}

impl Languages {
    pub fn new() -> Self {
        Self {
            grammars: std::array::from_fn(|_| OnceLock::new()),
        }
    }

    fn get(&self, id: LanguageId) -> Result<&Grammar, CoreError> {
        self.grammars[id as usize]
            .get_or_init(|| Grammar::load(id))
            .as_ref()
            .map_err(|error| CoreError::Internal(error.clone()))
    }
}

impl Grammar {
    fn load(id: LanguageId) -> Result<Self, String> {
        let (name, language, source): (&str, Language, &str) = match id {
            LanguageId::Rust => (
                "rust",
                tree_sitter_rust::LANGUAGE.into(),
                include_str!("queries/rust.scm"),
            ),
            LanguageId::TypeScript => (
                "typescript",
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
                include_str!("queries/javascript.scm"),
            ),
            LanguageId::Tsx => (
                "tsx",
                tree_sitter_typescript::LANGUAGE_TSX.into(),
                include_str!("queries/javascript.scm"),
            ),
            LanguageId::JavaScript => (
                "javascript",
                tree_sitter_javascript::LANGUAGE.into(),
                include_str!("queries/javascript.scm"),
            ),
            LanguageId::Python => (
                "python",
                tree_sitter_python::LANGUAGE.into(),
                include_str!("queries/python.scm"),
            ),
            LanguageId::Go => (
                "go",
                tree_sitter_go::LANGUAGE.into(),
                include_str!("queries/go.scm"),
            ),
        };
        let source = if matches!(id, LanguageId::TypeScript | LanguageId::Tsx) {
            format!("{source}\n{}", include_str!("queries/typescript.scm"))
        } else if matches!(id, LanguageId::JavaScript) {
            format!(
                "{source}\n{}",
                include_str!("queries/javascript-fields.scm")
            )
        } else {
            source.to_owned()
        };
        let query = Query::new(&language, &source)
            .map_err(|error| format!("{name} symbol query: {error}"))?;
        Ok(Self {
            name,
            language,
            query,
        })
    }
}

pub(super) struct SourceParser<'a> {
    parser: Parser,
    cursor: QueryCursor,
    languages: &'a Languages,
}

impl<'a> SourceParser<'a> {
    pub fn new(languages: &'a Languages) -> Self {
        Self {
            parser: Parser::new(),
            cursor: QueryCursor::new(),
            languages,
        }
    }

    pub fn parse(
        &mut self,
        extension: &str,
        content: &str,
        cancel: &AtomicBool,
        abort: &AtomicBool,
    ) -> Result<ParsedText, CoreError> {
        let Some(id) = language_id(extension) else {
            return Ok(ParsedText::default());
        };
        let stopped = || cancel.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed);
        if stopped() {
            return Err(CoreError::Cancelled);
        }
        let grammar = self.languages.get(id)?;
        self.parser
            .set_language(&grammar.language)
            .map_err(|error| CoreError::Internal(format!("{} parser: {error}", grammar.name)))?;
        // A cancelled parse may be resumable. Each file must start a fresh parse.
        self.parser.reset();
        let bytes = content.as_bytes();
        let mut progress = |_: &tree_sitter::ParseState| {
            if stopped() {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let tree = self
            .parser
            .parse_with_options(
                &mut |offset, _| bytes.get(offset..).unwrap_or_default(),
                None,
                Some(ParseOptions::new().progress_callback(&mut progress)),
            )
            .ok_or_else(|| {
                if stopped() {
                    CoreError::Cancelled
                } else {
                    CoreError::Internal(format!("{} parsing failed", grammar.name))
                }
            })?;
        let mut parsed = ParsedText::default();
        let mut query_progress = |_: &tree_sitter::QueryCursorState| {
            if stopped() {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        {
            let mut matches = self.cursor.matches_with_options(
                &grammar.query,
                tree.root_node(),
                bytes,
                QueryCursorOptions::new().progress_callback(&mut query_progress),
            );
            while let Some(found) = matches.next() {
                if stopped() {
                    return Err(CoreError::Cancelled);
                }
                let mut definition = None;
                let mut names = Vec::new();
                for capture in found.captures() {
                    let label = grammar.query.capture_names()[capture.index as usize];
                    if let Some(kind) = symbol_kind(label) {
                        definition = Some((capture.node, kind));
                    } else if label == "name" {
                        names.push(capture.node);
                    } else if label == "binding" {
                        binding_names(capture.node, &mut names);
                    }
                }
                let Some((declaration, kind)) = definition else {
                    continue;
                };
                for name in names {
                    if parsed.symbols.len() >= MAX_ITEMS {
                        break;
                    }
                    let Some(value) = node_text(name, content) else {
                        continue;
                    };
                    if value == "_" && matches!(id, LanguageId::Rust | LanguageId::Go) {
                        continue;
                    }
                    let start = name.start_position();
                    let end = name.end_position();
                    parsed.symbols.push(Symbol {
                        name: value.to_owned(),
                        kind: refine_kind(declaration, kind, grammar.name),
                        line: u32::try_from(start.row + 1).unwrap_or(u32::MAX),
                        source: Some(SourceLocation {
                            language: grammar.name,
                            start_byte: name.start_byte(),
                            end_byte: name.end_byte(),
                            column: start.column,
                            end_line: end.row + 1,
                            end_column: end.column,
                            declaration_start_byte: declaration.start_byte(),
                            declaration_end_byte: declaration.end_byte(),
                        }),
                        container: container(declaration, content, grammar.name),
                    });
                }
                if parsed.symbols.len() >= MAX_ITEMS {
                    break;
                }
            }
        }
        if stopped() {
            return Err(CoreError::Cancelled);
        }
        if self.cursor.did_exceed_match_limit() {
            return Err(CoreError::Internal(format!(
                "{} symbol query exceeded match limit",
                grammar.name
            )));
        }
        parsed.symbols.sort_by_key(|symbol| {
            (
                symbol.source.as_ref().map(|source| source.start_byte),
                symbol.kind,
            )
        });
        parsed.symbols.dedup_by(|a, b| {
            a.name == b.name
                && a.kind == b.kind
                && a.source.as_ref().map(|s| s.start_byte)
                    == b.source.as_ref().map(|s| s.start_byte)
        });
        Ok(parsed)
    }
}

fn symbol_kind(capture: &str) -> Option<&'static str> {
    Some(match capture {
        "definition.function" => "function",
        "definition.method" => "method",
        "definition.class" => "class",
        "definition.struct" => "struct",
        "definition.enum" => "enum",
        "definition.enum_member" => "enum_member",
        "definition.union" => "union",
        "definition.trait" => "trait",
        "definition.interface" => "interface",
        "definition.type" => "type",
        "definition.module" => "module",
        "definition.macro" => "macro",
        "definition.constant" => "constant",
        "definition.variable" => "variable",
        "definition.field" => "field",
        _ => return None,
    })
}

fn node_text<'a>(node: Node<'_>, content: &'a str) -> Option<&'a str> {
    if node.is_missing() || node.has_error() {
        return None;
    }
    let text = content.get(node.byte_range())?;
    (!text.is_empty() && text.len() <= 256).then_some(text)
}

// Follow binding patterns only; property keys, type names, default expressions,
// attribute writes and subscript writes are not newly declared symbols.
fn binding_names<'tree>(node: Node<'tree>, names: &mut Vec<Node<'tree>>) {
    let mut pending = vec![node];
    while let Some(node) = pending.pop() {
        if names.len() >= MAX_ITEMS {
            break;
        }
        match node.kind() {
            "identifier"
            | "shorthand_property_identifier_pattern"
            | "shorthand_field_identifier" => names.push(node),
            "pair_pattern" => pending.extend(node.child_by_field_name("value")),
            "field_pattern" => pending.extend(
                node.child_by_field_name("pattern")
                    .or_else(|| node.child_by_field_name("name")),
            ),
            "assignment_pattern" | "object_assignment_pattern" => {
                pending.extend(node.child_by_field_name("left"))
            }
            "object_pattern"
            | "array_pattern"
            | "rest_pattern"
            | "tuple_pattern"
            | "list_pattern"
            | "pattern_list"
            | "list_splat_pattern"
            | "tuple_struct_pattern"
            | "struct_pattern"
            | "ref_pattern"
            | "mut_pattern"
            | "reference_pattern"
            | "slice_pattern"
            | "captured_pattern"
            | "expression_list" => {
                let type_node = node.child_by_field_name("type");
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if Some(child) != type_node {
                        pending.push(child);
                    }
                }
            }
            _ => {}
        }
    }
}

fn refine_kind(node: Node<'_>, kind: &'static str, language: &str) -> &'static str {
    if kind == "function"
        && language == "rust"
        && node
            .parent()
            .filter(|parent| parent.kind() == "declaration_list")
            .and_then(|parent| parent.parent())
            .is_some_and(|parent| matches!(parent.kind(), "impl_item" | "trait_item"))
    {
        return "method";
    }
    if kind == "function" && language == "python" {
        let mut ancestor = node.parent();
        while let Some(parent) = ancestor {
            if matches!(
                parent.kind(),
                "impl_item" | "trait_item" | "class_definition"
            ) {
                return "method";
            }
            if is_scope(parent) {
                break;
            }
            ancestor = parent.parent();
        }
    }
    if node.kind() == "type_spec" {
        return match node.child_by_field_name("type").map(|t| t.kind()) {
            Some("struct_type") => "struct",
            Some("interface_type") => "interface",
            _ => kind,
        };
    }
    if matches!(
        node.kind(),
        "variable_declarator" | "public_field_definition" | "field_definition" | "assignment"
    ) {
        let value = node
            .child_by_field_name("value")
            .or_else(|| node.child_by_field_name("right"));
        match value.map(|value| value.kind()) {
            Some("arrow_function" | "function_expression" | "generator_function" | "lambda") => {
                return "function";
            }
            Some("class") => return "class",
            _ => {}
        }
        if node
            .parent()
            .and_then(|parent| parent.child_by_field_name("kind"))
            .is_some_and(|kind| kind.kind() == "const")
        {
            return "constant";
        }
    }
    kind
}

fn is_scope(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "function_item"
            | "function_signature_item"
            | "impl_item"
            | "trait_item"
            | "struct_item"
            | "enum_item"
            | "enum_variant"
            | "union_item"
            | "mod_item"
            | "type_item"
            | "function_declaration"
            | "function_expression"
            | "generator_function"
            | "generator_function_declaration"
            | "arrow_function"
            | "method_definition"
            | "class_declaration"
            | "class"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "internal_module"
            | "module"
            | "class_definition"
            | "function_definition"
            | "lambda"
            | "method_declaration"
            | "type_spec"
            | "type_alias"
    )
}

fn receiver_type<'a>(node: Node<'_>, content: &'a str) -> Option<&'a str> {
    let receiver = node.child_by_field_name("receiver")?.named_child(0)?;
    let mut ty = receiver.child_by_field_name("type")?;
    while ty.kind() == "pointer_type" {
        ty = ty.named_child(0)?;
    }
    node_text(ty, content)
}

fn container(node: Node<'_>, content: &str, language: &str) -> Option<String> {
    let mut parts = Vec::new();
    if language == "go" && node.kind() == "method_declaration" {
        parts.extend(receiver_type(node, content));
    }
    let mut ancestor = node.parent();
    while let Some(parent) = ancestor {
        let name = if parent.kind() == "impl_item" {
            parent.child_by_field_name("type")
        } else if is_scope(parent)
            || matches!(
                parent.kind(),
                "variable_declarator" | "pair" | "public_field_definition" | "field_definition"
            )
        {
            parent
                .child_by_field_name("name")
                .or_else(|| parent.child_by_field_name("key"))
                .or_else(|| parent.child_by_field_name("property"))
        } else {
            None
        };
        if let Some(name) = name.and_then(|name| node_text(name, content)) {
            parts.push(name);
        }
        if language == "go" && parent.kind() == "method_declaration" {
            parts.extend(receiver_type(parent, content));
        }
        if parts.len() >= 32 {
            break;
        }
        ancestor = parent.parent();
    }
    parts.reverse();
    (!parts.is_empty()).then(|| parts.join("::"))
}
