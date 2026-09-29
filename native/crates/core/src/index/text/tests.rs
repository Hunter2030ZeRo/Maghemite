use std::{path::Path, sync::atomic::AtomicBool};

use super::{Languages, MAX_ITEMS, ParsedText, TextParser, supports};
use crate::{CoreError, index::symbol::Symbol};

fn parse(path: &str, content: &str) -> ParsedText {
    let languages = Languages::new();
    TextParser::new(&languages)
        .parse(
            Path::new(path),
            content.as_bytes(),
            &AtomicBool::new(false),
            &AtomicBool::new(false),
        )
        .unwrap()
}

fn symbol<'a>(
    parsed: &'a ParsedText,
    name: &str,
    kind: &str,
    container: Option<&str>,
) -> &'a Symbol {
    parsed
        .symbols
        .iter()
        .find(|s| s.name == name && s.kind == kind && s.container.as_deref() == container)
        .unwrap_or_else(|| {
            panic!(
                "missing {name} ({kind}, {container:?}): {:#?}",
                parsed.symbols
            )
        })
}

fn assert_positions(parsed: &ParsedText, content: &str) {
    for symbol in &parsed.symbols {
        let source = symbol.source.as_ref().unwrap();
        assert_eq!(&content[source.start_byte..source.end_byte], symbol.name);
        assert!(source.declaration_start_byte <= source.start_byte);
        assert!(source.declaration_end_byte >= source.end_byte);
        assert!(source.declaration_end_byte <= content.len());
        let before = &content[..source.start_byte];
        assert_eq!(
            symbol.line as usize,
            before.bytes().filter(|b| *b == b'\n').count() + 1
        );
        assert_eq!(source.column, before.rsplit('\n').next().unwrap().len());
        let before_end = &content[..source.end_byte];
        assert_eq!(
            source.end_line,
            before_end.bytes().filter(|b| *b == b'\n').count() + 1
        );
        assert_eq!(
            source.end_column,
            before_end.rsplit('\n').next().unwrap().len()
        );
    }
}

#[test]
fn rust_multiline_scopes_patterns_and_comment_string_exclusion() {
    let content = r##"/* fn fake_comment() {} */
mod engine {
    pub struct Index { pub size: usize }
    pub enum State { Ready, Done }
    pub trait Scan { type Item; fn run(&self); }
    impl Index {
        pub(crate) async fn
        build<T>(&self, input: T) {
            let (first, second) = (1, 2);
            let Index { size: renamed } = input;
            let Index { size } = input;
            fn nested() {}
            let text = r#"
fn fake_string() {}
"#;
        }
    }
}
macro_rules! make { () => { fn not_expanded() {} } }
"##;
    let parsed = parse("index.rs", content);
    symbol(&parsed, "engine", "module", None);
    symbol(&parsed, "Index", "struct", Some("engine"));
    symbol(&parsed, "build", "method", Some("engine::Index"));
    symbol(&parsed, "run", "method", Some("engine::Scan"));
    symbol(&parsed, "Item", "type", Some("engine::Scan"));
    symbol(&parsed, "Ready", "enum_member", Some("engine::State"));
    for name in ["first", "second", "renamed", "size", "text"] {
        symbol(&parsed, name, "variable", Some("engine::Index::build"));
    }
    symbol(&parsed, "nested", "function", Some("engine::Index::build"));
    symbol(&parsed, "make", "macro", None);
    assert!(
        !parsed
            .symbols
            .iter()
            .any(|s| s.name.starts_with("fake") || s.name == "not_expanded")
    );
    assert_positions(&parsed, content);
}

#[test]
fn typescript_declarations_arrow_functions_destructuring_and_unicode() {
    let content = r#"// function fakeComment() {}
export namespace Api {
    export interface Reader { read(): string; count: number }
    export type Id = string;
    export type Options = { enabled: boolean };
    export enum Mode { Fast, Slow = 2 }
    export abstract class Base { abstract load(): void; }
    export class Store {
        value = 1;
        async read(
            key: Id
        ) { const local = 1; return key; }
    }
    export const build =
        (key: Id) => { function nested() {} return key; };
    const { old: renamed = fallback(), plain, ...rest } = input;
    const [first, second = defaultValue] = input;
    export function café() {}
    const text = `
function fakeString() {}
`;
}
"#;
    let parsed = parse("source.ts", content);
    symbol(&parsed, "Api", "module", None);
    symbol(&parsed, "Reader", "interface", Some("Api"));
    symbol(&parsed, "read", "method", Some("Api::Reader"));
    symbol(&parsed, "Id", "type", Some("Api"));
    symbol(&parsed, "enabled", "field", Some("Api::Options"));
    symbol(&parsed, "Fast", "enum_member", Some("Api::Mode"));
    symbol(&parsed, "Slow", "enum_member", Some("Api::Mode"));
    symbol(&parsed, "load", "method", Some("Api::Base"));
    symbol(&parsed, "read", "method", Some("Api::Store"));
    symbol(&parsed, "value", "field", Some("Api::Store"));
    symbol(&parsed, "build", "function", Some("Api"));
    symbol(&parsed, "nested", "function", Some("Api::build"));
    symbol(&parsed, "café", "function", Some("Api"));
    for name in ["renamed", "plain", "rest", "first", "second"] {
        symbol(&parsed, name, "constant", Some("Api"));
    }
    assert!(!parsed.symbols.iter().any(|s| {
        [
            "fakeComment",
            "fakeString",
            "old",
            "fallback",
            "defaultValue",
        ]
        .contains(&s.name.as_str())
    }));
    assert_positions(&parsed, content);
}

#[test]
fn javascript_jsx_tsx_and_module_extensions() {
    for path in ["ui.jsx", "ui.tsx"] {
        let content = "export const View = () => <div>function fake() {}</div>;";
        let parsed = parse(path, content);
        assert_eq!(parsed.symbols.len(), 1);
        symbol(&parsed, "View", "function", None);
        assert_positions(&parsed, content);
    }
    for path in [
        "mod.js", "mod.mjs", "mod.cjs", "mod.ts", "mod.mts", "mod.cts", "mod.TS",
    ] {
        assert!(supports(Path::new(path)));
        let content = "export class Store { #read() {} }; export function* values() {} const make = function() {};";
        let parsed = parse(path, content);
        symbol(&parsed, "Store", "class", None);
        symbol(&parsed, "#read", "method", Some("Store"));
        symbol(&parsed, "values", "function", None);
        symbol(&parsed, "make", "function", None);
        assert_positions(&parsed, content);
    }
    for path in ["fields.js", "fields.ts"] {
        let content =
            "class Store { #data = 1; handle = () => { function inner() {} }; } const _ = 1;";
        let parsed = parse(path, content);
        symbol(&parsed, "#data", "field", Some("Store"));
        symbol(&parsed, "handle", "function", Some("Store"));
        symbol(&parsed, "inner", "function", Some("Store::handle"));
        symbol(&parsed, "_", "constant", None);
        assert_positions(&parsed, content);
    }
}

#[test]
fn python_decorated_async_methods_docstrings_and_bindings() {
    let content = "class Worker:\n    \"\"\"\ndef fake_docstring(): pass\n\"\"\"\n    @decorator\n    async def run(\n        self, value\n    ):\n        def nested(): pass\n        first, second = value\n        self.field = value\n        items[index] = value\n        return first\n\n# def fake_comment(): pass\nname: str = 'example'\n";
    let parsed = parse("worker.py", content);
    symbol(&parsed, "Worker", "class", None);
    symbol(&parsed, "run", "method", Some("Worker"));
    symbol(&parsed, "nested", "function", Some("Worker::run"));
    symbol(&parsed, "first", "variable", Some("Worker::run"));
    symbol(&parsed, "second", "variable", Some("Worker::run"));
    symbol(&parsed, "name", "variable", None);
    assert!(!parsed.symbols.iter().any(|s| s.name.starts_with("fake")
        || ["self", "field", "items", "index"].contains(&s.name.as_str())));
    assert_positions(&parsed, content);
}

#[test]
fn go_functions_receivers_types_fields_and_bindings() {
    let content = "package main\n// func fakeComment() {}\ntype Index struct { Size int }\ntype Reader interface { Read() string }\ntype Alias = string\nconst A, B = 1, 2\nvar first, second int\nfunc (i *Index) Read() string {\n    local, other := 1, 2\n    return `\nfunc fakeString() {}\n`\n}\nfunc build(\n input string,\n) {}\n";
    let parsed = parse("index.go", content);
    symbol(&parsed, "Index", "struct", None);
    symbol(&parsed, "Size", "field", Some("Index"));
    symbol(&parsed, "Reader", "interface", None);
    symbol(&parsed, "Read", "method", Some("Reader"));
    symbol(&parsed, "Read", "method", Some("Index"));
    symbol(&parsed, "Alias", "type", None);
    for name in ["A", "B"] {
        symbol(&parsed, name, "constant", None);
    }
    for name in ["first", "second"] {
        symbol(&parsed, name, "variable", None);
    }
    for name in ["local", "other"] {
        symbol(&parsed, name, "variable", Some("Index::Read"));
    }
    symbol(&parsed, "build", "function", None);
    assert!(!parsed.symbols.iter().any(|s| s.name.starts_with("fake")));
    assert_positions(&parsed, content);
}

#[test]
fn invalid_source_keeps_recoverable_declarations_and_precise_utf8_positions() {
    let content = "const label = '한글'; function café() {}\nfunction incomplete( {\n";
    let parsed = parse("source.ts", content);
    let found = symbol(&parsed, "café", "function", None);
    assert_eq!(
        found.source.as_ref().unwrap().column,
        content.find("café").unwrap()
    );
    assert_positions(&parsed, content);
}

#[test]
fn reusable_parser_handles_switches_binary_unsupported_and_cancellation() {
    let languages = Languages::new();
    let mut parser = TextParser::new(&languages);
    let no = AtomicBool::new(false);
    let yes = AtomicBool::new(true);
    for (cancel, abort) in [(&yes, &no), (&no, &yes)] {
        assert!(matches!(
            parser.parse(Path::new("source.rs"), b"fn cancelled() {}", cancel, abort),
            Err(CoreError::Cancelled)
        ));
    }
    for (path, bytes, name) in [
        ("source.rs", b"fn rust() {}".as_slice(), "rust"),
        ("source.py", b"def python(): pass".as_slice(), "python"),
        (
            "source.tsx",
            b"const view = () => <div />".as_slice(),
            "view",
        ),
        ("source.rs", b"fn again() {}".as_slice(), "again"),
    ] {
        let parsed = parser.parse(Path::new(path), bytes, &no, &no).unwrap();
        symbol(&parsed, name, "function", None);
    }
    for (path, bytes) in [
        ("file.rs", b"fn bad() {}\0".as_slice()),
        ("file.rs", &[255_u8][..]),
        ("file.txt", b"fn fake() {}".as_slice()),
    ] {
        assert!(
            parser
                .parse(Path::new(path), bytes, &no, &no)
                .unwrap()
                .symbols
                .is_empty()
        );
    }
    assert!(!supports(Path::new("no-extension")));
}

#[test]
fn symbol_limit_bounds_output() {
    let content: String = (0..MAX_ITEMS + 10)
        .map(|i| format!("fn f{i}() {{}}\n"))
        .collect();
    let parsed = parse("many.rs", &content);
    assert_eq!(parsed.symbols.len(), MAX_ITEMS);
    assert_positions(&parsed, &content);
}

#[test]
fn markdown_headings_and_links_are_preserved() {
    let parsed = parse(
        "note.md",
        "# Design\nSee [[Architecture]] and [API](api.md).\n```rust\n# Fake\n[[Fake]]\n```\n",
    );
    assert_eq!(parsed.symbols.len(), 1);
    symbol(&parsed, "Design", "heading", None);
    assert!(parsed.symbols[0].source.is_none());
    assert_eq!(
        parsed
            .links
            .iter()
            .map(|link| link.target.as_str())
            .collect::<Vec<_>>(),
        ["Architecture", "api.md"]
    );
}
