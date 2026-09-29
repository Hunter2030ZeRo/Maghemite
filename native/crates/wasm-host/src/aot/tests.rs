use super::*;
use crate::aot;
mod descriptor_cases;
mod files_cases;
mod fixtures;
use fixtures::*;

#[tokio::test]
async fn prepared_objects_run() -> Result<()> {
    for abi in [
        Abi::ComponentAsync,
        Abi::ComponentSync,
        Abi::WasiP1Blocking,
        Abi::WasiP1Cooperative,
    ] {
        // Given genuine local producer output and its trusted receipt.
        let directory = PrivateDirectory::new()?;
        let descriptor = prepare(directory.path()?, abi)?;
        let id = write_descriptor(directory.path()?, &descriptor)?;
        // SAFETY: fixture generated every artifact with Wasmtime and owns receipt/storage.
        let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
        // When the actual public loader constructs a compiler-disabled engine.
        match abi.format() {
            ArtifactFormat::Component => {
                let (engine, component) = trusted.load_component(abi)?;
                drop(trusted);
                directory.close()?;
                // Then executable code remains owned after all source buffers/files die.
                assert_eq!(run_component(&engine, &component).await?, 42);
            }
            ArtifactFormat::CoreModule => {
                let (engine, module) = trusted.load_module("engine", abi)?;
                drop(trusted);
                directory.close()?;
                assert_eq!(run_core(&engine, &module).await?, 42);
            }
        }
    }
    Ok(())
}

#[test]
fn source_compilation_denied() -> Result<()> {
    for abi in [
        Abi::ComponentAsync,
        Abi::ComponentSync,
        Abi::WasiP1Blocking,
        Abi::WasiP1Cooperative,
    ] {
        // Given valid binary source, proven by the enabled producer below.
        let producer = preparation_engine(abi)?;
        producer.precompile_module(CORE)?;
        producer.precompile_component(COMPONENT)?;
        let engine = load_engine(abi)?;
        // When both source construction entry points are called on that exact factory.
        let module = Module::new(&engine, CORE);
        let component = Component::new(&engine, COMPONENT);
        // Then failure is compiler denial, not malformed input.
        assert!(module.unwrap_err().to_string().contains("compil"));
        assert!(component.unwrap_err().to_string().contains("compil"));
    }
    Ok(())
}

#[test]
fn wrong_abi_and_target_never_deserialize() -> Result<()> {
    // Given a valid blocking tool installation.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: locally generated output, trusted receipt and private fixture storage.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let before = DESERIALIZATIONS.get();
    // When callers select a different ABI, tool identity or object kind.
    let results = [
        trusted
            .load_module("engine", Abi::WasiP1Cooperative)
            .is_err(),
        trusted.load_module("other", Abi::WasiP1Blocking).is_err(),
        trusted.load_component(Abi::ComponentAsync).is_err(),
    ];
    // Then none crossed the unsafe code-image boundary.
    assert!(results.into_iter().all(|rejected| rejected));
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}

#[test]
fn incompatible_recipe_never_deserializes() -> Result<()> {
    // Given genuine code, but stale producer recipe, version, target or CPU policy.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    for field in ["recipe", "version", "target", "cpu"] {
        let mut stale = descriptor.clone();
        let producer = &mut stale.targets[0].producer;
        match field {
            "recipe" => producer.recipe_version += 1,
            "version" => producer.wasmtime_version = "48.0.0".to_owned(),
            "target" => producer.target = "not-this-machine".to_owned(),
            "cpu" => producer.cpu_policy = "portable".to_owned(),
            _ => unreachable!(),
        }
        let id = write_descriptor(directory.path()?, &stale)?;
        // SAFETY: only metadata changed; digests still attest genuine Wasmtime output.
        let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
        let before = DESERIALIZATIONS.get();
        // When the public loader is invoked.
        let result = trusted.load_module("engine", Abi::WasiP1Blocking);
        // Then recipe validation rejects before deserialization.
        assert!(result.unwrap_err().to_string().contains("recipe"));
        assert_eq!(DESERIALIZATIONS.get(), before);
    }
    directory.close()
}

#[test]
fn native_configuration_checks_remain_enabled() -> Result<()> {
    // Given genuine Wasmtime output built with incompatible fuel instrumentation.
    let directory = PrivateDirectory::new()?;
    let mut config = wasmtime::Config::new();
    config.consume_fuel(true);
    let producer = Engine::new(&config)?;
    let bytes = producer.precompile_module(CORE)?;
    std::fs::write(directory.path()?.join("tool-0.cwasm"), &bytes)?;
    let descriptor = descriptor(vec![target(Abi::WasiP1Blocking, &bytes, &producer)?]);
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: producer output is authentic; incompatibility must be checked by Wasmtime.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let before = DESERIALIZATIONS.get();
    // When native deserialization performs its normal compatibility checks.
    let result = trusted.load_module("engine", Abi::WasiP1Blocking);
    // Then it fails inside Wasmtime, not through producer/load hash equality.
    assert!(result.unwrap_err().to_string().contains("fuel"));
    assert_eq!(DESERIALIZATIONS.get(), before + 1);
    directory.close()
}

#[test]
fn wrong_serialized_kind_never_deserializes() -> Result<()> {
    // Given a genuine core object under a component receipt binding.
    let directory = PrivateDirectory::new()?;
    let producer = preparation_engine(Abi::ComponentAsync)?;
    let bytes = producer.precompile_module(CORE)?;
    std::fs::write(directory.path()?.join("component.cwasm"), &bytes)?;
    let descriptor = descriptor(vec![target(Abi::ComponentAsync, &bytes, &producer)?]);
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: digest names genuine precompile output, although the kind is wrong.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let before = DESERIALIZATIONS.get();
    // When the component loader sees the mismatched code image.
    let result = trusted.load_component(Abi::ComponentAsync);
    // Then it rejects before unsafe deserialization.
    assert!(result.unwrap_err().to_string().contains("kind"));
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}

#[tokio::test]
async fn shared_source_tool_aliases_run() -> Result<()> {
    // Given one reviewed source bound to two distinct tool IDs.
    let directory = PrivateDirectory::new()?;
    let producer = preparation_engine(Abi::WasiP1Blocking)?;
    let bytes = producer.precompile_module(CORE)?;
    let mut targets = Vec::new();
    for (ordinal, id) in ["first", "second"].into_iter().enumerate() {
        let mut tool = target(Abi::WasiP1Blocking, &bytes, &producer)?;
        tool.tool_id = Some(id.to_owned());
        tool.source_path = "engine.wasm".to_owned();
        tool.artifact.file = format!("tool-{ordinal}.cwasm");
        std::fs::write(directory.path()?.join(&tool.artifact.file), &bytes)?;
        targets.push(tool);
    }
    let descriptor = descriptor(targets);
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: both bindings attest locally generated Wasmtime output in owned storage.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    // When each alias is independently selected through the public load API.
    for id in ["first", "second"] {
        let (engine, module) = trusted.load_module(id, Abi::WasiP1Blocking)?;
        // Then both independently execute the expected source export.
        assert_eq!(run_core(&engine, &module).await?, 42);
    }
    drop(trusted);
    directory.close()
}
