use super::{Fixture, fs, json};

#[test]
fn capture_preview_and_selected_replace_when_unicode_and_crlf() {
    // Given two regex matches and a preview template.
    let f = Fixture::new();
    fs::write(f.root.join("values.txt"), "a=12\r\nb=34😀\r\n").unwrap();
    let search = f.start(json!({"query":"(?P<key>[ab])=(\\d+)","regex":true,
        "replacement":"${key}:$2/$$"}));
    let (matches, _) = f.drain(&search);
    assert_eq!(matches[0]["replacement"], "a:12/$");
    // When replacing only the first result.
    let result = f
        .call(
            "search.replace",
            json!({
                "search":search,"resultIds":[matches[0]["id"]],"skipPaths":[]
            }),
        )
        .unwrap();
    // Then CRLF, Unicode and the unselected match are preserved.
    assert_eq!(result["files"][0]["status"], "applied");
    assert_eq!(
        fs::read_to_string(f.root.join("values.txt")).unwrap(),
        "a:12/$\r\nb=34😀\r\n"
    );
}

#[test]
fn conflicts_and_drafts_preserved_when_other_files_apply() {
    // Given three files in the same original result set.
    let f = Fixture::new();
    for name in ["a.txt", "b.txt", "c.txt"] {
        fs::write(f.root.join(name), "needle").unwrap();
    }
    let search = f.start(json!({"query":"needle","replacement":"changed"}));
    let (matches, _) = f.drain(&search);
    fs::write(f.root.join("b.txt"), "external").unwrap();
    // When disk changed for one file and another became editor-dirty.
    let result = f
        .call(
            "search.replace",
            json!({"search":search,
        "resultIds":matches.iter().map(|m| &m["id"]).collect::<Vec<_>>(),"skipPaths":["c.txt"]}),
        )
        .unwrap();
    // Then per-file partial application is explicit and both protected files survive.
    assert_eq!(result["files"][0]["status"], "applied");
    assert_eq!(result["files"][1]["status"], "conflict");
    assert_eq!(result["files"][2]["status"], "excluded");
    assert_eq!(fs::read_to_string(f.root.join("a.txt")).unwrap(), "changed");
    assert_eq!(
        fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "external"
    );
    assert_eq!(fs::read_to_string(f.root.join("c.txt")).unwrap(), "needle");
    assert!(!fs::read_dir(&f.root).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".maghemite-write-")
    }));
}

#[test]
fn duplicate_and_unknown_selections_fail_before_writes() {
    // Given a completed search.
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), "needle needle").unwrap();
    let search = f.start(json!({"query":"needle","replacement":"changed"}));
    let (matches, _) = f.drain(&search);
    // When selected IDs are duplicated or unknown.
    for ids in [
        json!([matches[0]["id"], matches[0]["id"]]),
        json!([matches[0]["id"], "unknown"]),
    ] {
        assert!(
            f.call(
                "search.replace",
                json!({"search":search,"resultIds":ids,"skipPaths":[]})
            )
            .is_err()
        );
    }
    // Then no part of the request was written.
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "needle needle"
    );
}

#[test]
fn multiline_regex_and_zero_width_replace_when_expanding_captures() {
    // Given a multiline document and a zero-width regex.
    let f = Fixture::new();
    fs::write(f.root.join("a.txt"), "α\r\nβ\r\n").unwrap();
    let search = f.start(json!({"query":"^","regex":true,"replacement":"[$0]"}));
    let (matches, _) = f.drain(&search);
    // When inserting at all matched line starts.
    let result = f
        .call(
            "search.replace",
            json!({"search":search,
        "resultIds":matches.iter().map(|m| &m["id"]).collect::<Vec<_>>(),"skipPaths":[]}),
        )
        .unwrap();
    // Then UTF-8 boundaries and original line endings survive.
    assert_eq!(result["files"][0]["status"], "applied");
    assert_eq!(
        fs::read_to_string(f.root.join("a.txt")).unwrap(),
        "[]α\r\n[]β\r\n[]"
    );
}
