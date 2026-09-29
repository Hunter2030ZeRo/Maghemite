use super::*;

const GOLDEN: &str = r#"{"manifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","moduleId":"test.aot","moduleVersion":"1.0.0","schemaVersion":1,"slot":"11111111-1111-4111-8111-111111111111","targets":[{"abi":"component-async-v1","artifact":{"file":"component.cwasm","sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","size":16},"format":"component","kind":"component-entry","producer":{"compilationFingerprint":"0123456789abcdef","cpuPolicy":"host-native","identity":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","recipeVersion":1,"target":"x86_64-unknown-linux-gnu","wasmtimeVersion":"49.0.1"},"sourcePath":"dist/module.wasm","sourceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sourceSize":8,"toolId":null}]}"#;

#[test]
fn canonical_descriptor_matches_shared_golden() -> Result<()> {
    // Given the exact machine-consumed fixture shared with the TypeScript store.
    let descriptor = ArtifactDescriptor::parse(GOLDEN.as_bytes())?;
    // When it is encoded independently.
    let bytes = descriptor.canonical_bytes()?;
    // Then both exact bytes and independently fixed digest agree.
    assert_eq!(bytes, GOLDEN.as_bytes());
    assert_eq!(
        Sha256Digest::of(&bytes).as_str(),
        "adf730ec565881caebc0162ad55c4d69e1f374f1142fbca78a641502adc02a5f"
    );
    Ok(())
}

#[test]
fn malformed_descriptors_are_rejected() -> Result<()> {
    // Given malformed, ambiguous, missing-field, invalid-digest and oversized inputs.
    let inputs = [
        b"{}".to_vec(),
        b"{".to_vec(),
        vec![b' '; 65_537],
        GOLDEN
            .replace(
                "\"schemaVersion\":1",
                "\"schemaVersion\":1,\"schemaVersion\":1",
            )
            .into_bytes(),
        GOLDEN
            .replace("\"schemaVersion\":1", "\"schemaVersion\":2")
            .into_bytes(),
        GOLDEN
            .replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"unknown\":0")
            .into_bytes(),
        GOLDEN.replace(",\"toolId\":null", "").into_bytes(),
        GOLDEN.replace("\"size\":16", "\"size\":16.5").into_bytes(),
        GOLDEN
            .replace("\"size\":16", "\"size\":9007199254740992")
            .into_bytes(),
        GOLDEN.replace("\"size\":16", "\"size\":-1").into_bytes(),
        GOLDEN
            .replace(&"a".repeat(64), &"A".repeat(64))
            .into_bytes(),
        GOLDEN
            .replace("dist/module.wasm", "dist/../module.wasm")
            .into_bytes(),
        GOLDEN
            .replace("dist/module.wasm", "/module.wasm")
            .into_bytes(),
        GOLDEN
            .replace("dist/module.wasm", "dist/\\uD800.wasm")
            .into_bytes(),
        GOLDEN
            .replace("component.cwasm", "../component.cwasm")
            .into_bytes(),
        GOLDEN
            .replace("component-async-v1", "wasi-p1-blocking-v1")
            .into_bytes(),
        format!("{GOLDEN}\n").into_bytes(),
    ];
    let before = DESERIALIZATIONS.get();
    // When each descriptor crosses the parser boundary.
    for (index, input) in inputs.iter().enumerate() {
        assert!(ArtifactDescriptor::parse(input).is_err(), "input {index}");
    }
    // Then no native deserialization occurred.
    assert_eq!(DESERIALIZATIONS.get(), before);
    Ok(())
}

#[test]
fn complete_target_binding_and_limits_are_enforced() -> Result<()> {
    // Given a component descriptor and invalid target-count/size/binding variants.
    let original = ArtifactDescriptor::parse(GOLDEN.as_bytes())?;
    let mut variants = Vec::new();
    let mut duplicate = original.clone();
    duplicate.targets.push(duplicate.targets[0].clone());
    variants.push(duplicate);
    for size in [0, MAX_ARTIFACT_BYTES + 1] {
        let mut descriptor = original.clone();
        descriptor.targets[0].artifact.size = size;
        variants.push(descriptor);
    }
    for size in [0, 64 * 1024 * 1024 + 1] {
        let mut descriptor = original.clone();
        descriptor.targets[0].source_size = size;
        variants.push(descriptor);
    }
    // When canonicalization is requested.
    let results: Vec<_> = variants
        .iter()
        .map(ArtifactDescriptor::canonical_bytes)
        .collect();
    // Then invalid generations cannot even receive an artifact-set ID.
    assert!(results.into_iter().all(|result| result.is_err()));
    Ok(())
}

#[test]
fn tools_sort_by_identity_and_use_generated_ordinals() -> Result<()> {
    // Given two distinct tools supplied in reverse order and a component.
    let mut descriptor = ArtifactDescriptor::parse(GOLDEN.as_bytes())?;
    for (id, ordinal) in [("zulu", 1), ("alpha", 0)] {
        let mut tool = descriptor.targets[0].clone();
        tool.kind = TargetKind::WasiTool;
        tool.tool_id = Some(id.to_owned());
        tool.format = ArtifactFormat::CoreModule;
        tool.abi = Abi::WasiP1Blocking;
        tool.source_path = format!("tools/{id}.wasm");
        tool.artifact.file = format!("tool-{ordinal}.cwasm");
        tool.artifact.size = MAX_ARTIFACT_BYTES;
        descriptor.targets.push(tool);
    }
    descriptor.targets[0].artifact.size = MAX_ARTIFACT_BYTES;
    // When encoded and parsed at exactly the three-object/3 GiB bound.
    let bytes = descriptor.canonical_bytes()?;
    let parsed = ArtifactDescriptor::parse(&bytes)?;
    // Then ordinals bind the sorted tool IDs.
    assert_eq!(parsed.targets[1].tool_id.as_deref(), Some("alpha"));
    assert_eq!(parsed.targets[2].tool_id.as_deref(), Some("zulu"));
    assert_eq!(
        parsed.targets.iter().map(|t| t.artifact.size).sum::<u64>(),
        MAX_GENERATION_BYTES
    );
    Ok(())
}

fn shared_source_tools() -> Result<ArtifactDescriptor> {
    let mut descriptor = ArtifactDescriptor::parse(GOLDEN.as_bytes())?;
    let component = descriptor.targets.remove(0);
    for (ordinal, id) in ["first", "second"].into_iter().enumerate() {
        let mut tool = component.clone();
        tool.kind = TargetKind::WasiTool;
        tool.tool_id = Some(id.to_owned());
        tool.format = ArtifactFormat::CoreModule;
        tool.abi = Abi::WasiP1Blocking;
        tool.source_path = "engine.wasm".to_owned();
        tool.artifact.file = format!("tool-{ordinal}.cwasm");
        descriptor.targets.push(tool);
    }
    Ok(descriptor)
}

#[test]
fn shared_source_tool_aliases_are_canonical() -> Result<()> {
    // Given manifest-valid aliases with separate generated artifact bindings.
    let descriptor = shared_source_tools()?;
    // When the native schema serializes and parses the complete target set.
    let parsed = ArtifactDescriptor::parse(&descriptor.canonical_bytes()?)?;
    // Then both identities retain the same source and their own object paths.
    let bindings: Vec<_> = parsed
        .targets
        .iter()
        .map(|target| {
            (
                target.tool_id.as_deref(),
                target.source_path.as_str(),
                target.artifact.file.as_str(),
            )
        })
        .collect();
    assert_eq!(
        bindings,
        [
            (Some("first"), "engine.wasm", "tool-0.cwasm"),
            (Some("second"), "engine.wasm", "tool-1.cwasm"),
        ]
    );
    Ok(())
}

#[test]
fn duplicate_tool_identity_is_rejected() -> Result<()> {
    // Given two targets with the same identity, not two distinct aliases.
    let mut descriptor = shared_source_tools()?;
    descriptor.targets[1].tool_id = Some("first".to_owned());
    // When canonicalization validates the target set.
    let result = descriptor.canonical_bytes();
    // Then duplicate identity is rejected independently of source path reuse.
    assert!(result.is_err());
    Ok(())
}

#[test]
fn duplicate_artifact_binding_is_rejected() -> Result<()> {
    // Given distinct aliases incorrectly pointing to the same native object path.
    let mut descriptor = shared_source_tools()?;
    descriptor.targets[1].artifact.file = "tool-0.cwasm".to_owned();
    // When canonicalization validates the target set.
    let result = descriptor.canonical_bytes();
    // Then generated per-target artifact bindings remain distinct.
    assert!(result.is_err());
    Ok(())
}
