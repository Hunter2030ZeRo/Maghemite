//! Real public-boundary proof, not an execution-mode implementation.
use maghemite_wasm_host::aot;
#[path = "../src/aot/tests/fixtures.rs"]
mod fixtures;
use fixtures::*;
use wasmtime::{Module, Result, component::Component, error::ensure};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let identity = aot::Sha256Digest::of(&std::fs::read(std::env::current_exe()?)?);
    for abi in [
        aot::Abi::ComponentAsync,
        aot::Abi::ComponentSync,
        aot::Abi::WasiP1Blocking,
        aot::Abi::WasiP1Cooperative,
    ] {
        let directory = PrivateDirectory::new()?;
        let path = directory.path()?.to_owned();
        let mut descriptor = prepare(&path, abi)?;
        descriptor.targets[0].producer.identity = identity.clone();
        match abi.format() {
            aot::ArtifactFormat::Component => {}
            aot::ArtifactFormat::CoreModule => {
                let first = &mut descriptor.targets[0];
                first.tool_id = Some("first".to_owned());
                first.source_path = "engine.wasm".to_owned();
                let mut second = first.clone();
                second.tool_id = Some("second".to_owned());
                second.artifact.file = "tool-1.cwasm".to_owned();
                std::fs::copy(
                    path.join(&first.artifact.file),
                    path.join(&second.artifact.file),
                )?;
                descriptor.targets.push(second);
            }
        }
        let id = write_descriptor(&path, &descriptor)?;
        // SAFETY: this process compiled the object, created the trusted receipt,
        // and owns/pins this private directory outside all guest roots.
        let trusted = unsafe { aot::TrustedArtifactSet::open(&path, &id)? };
        let (answer, module_denied, component_denied, aliases) = match abi.format() {
            aot::ArtifactFormat::Component => {
                let (engine, component) = trusted.load_component(abi)?;
                drop(trusted);
                directory.close()?;
                (
                    run_component(&engine, &component).await?,
                    Module::new(&engine, CORE).is_err(),
                    Component::new(&engine, COMPONENT).is_err(),
                    None,
                )
            }
            aot::ArtifactFormat::CoreModule => {
                let (engine, module) = trusted.load_module("first", abi)?;
                let (second_engine, second_module) = trusted.load_module("second", abi)?;
                drop(trusted);
                directory.close()?;
                let first = u32::try_from(run_core(&engine, &module).await?)?;
                let second = u32::try_from(run_core(&second_engine, &second_module).await?)?;
                (
                    first,
                    Module::new(&engine, CORE).is_err(),
                    Component::new(&engine, COMPONENT).is_err(),
                    Some([first, second]),
                )
            }
        };
        ensure!(
            answer == 42
                && module_denied
                && component_denied
                && aliases.is_none_or(|answers| answers == [42, 42]),
            "AOT probe failed"
        );
        println!(
            "{}",
            serde_json::json!({
                "abi": abi, "answer": answer, "artifactSetId": id.as_str(),
                "moduleSourceRejected": module_denied, "componentSourceRejected": component_denied,
                "sharedSourceTools": aliases.map(|[first, second]| serde_json::json!({
                    "first": first, "second": second
                })),
                "cleanup": {"removed": path}, "executedAfterRemoval": true
            })
        );
    }
    Ok(())
}
