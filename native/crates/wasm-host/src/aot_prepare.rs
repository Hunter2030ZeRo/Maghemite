//! Trusted, non-executing producer modes of the existing native executable.
mod files;
mod protocol;

use maghemite_wasm_host::aot::{
    Abi, ArtifactFormat, CPU_POLICY, MAX_ARTIFACT_BYTES, MAX_GENERATION_BYTES,
    Producer, RECIPE_VERSION, Sha256Digest, TARGET, WASMTIME_VERSION,
    compilation_fingerprint, load_engine, preparation_engine,
};
use protocol::{Input, send};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::sync::mpsc::Receiver;
use wasmtime::{Engine, Result, error::ensure};

fn identity() -> Result<Sha256Digest> {
    let mut file = std::fs::File::open(std::env::current_exe()?)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Sha256Digest::try_from(format!("{:x}", hash.finalize()))
}

fn producer(engine: &Engine, identity: &Sha256Digest) -> Producer {
    Producer {
        identity: identity.clone(),
        wasmtime_version: WASMTIME_VERSION.into(),
        recipe_version: RECIPE_VERSION,
        target: TARGET.into(),
        cpu_policy: CPU_POLICY.into(),
        compilation_fingerprint: compilation_fingerprint(engine),
    }
}

pub(super) fn info() -> Result<()> {
    let identity = identity()?;
    let mut entries = Vec::new();
    for abi in [Abi::ComponentAsync, Abi::ComponentSync, Abi::WasiP1Blocking, Abi::WasiP1Cooperative] {
        let engine = preparation_engine(abi)?;
        entries.push(json!({"abi": abi, "producer": producer(&engine, &identity)}));
    }
    send(&json!({"type": "info", "schemaVersion": 1, "producers": entries}))
}

/// Deliberately exits inside the lease scope. Neither ready nor return drops it.
pub(super) fn run(directory: &Path) -> ! {
    let mut lease = None;
    let result = (|| -> Result<()> {
        let input = protocol::watchdog()?;
        let owner = files::open(&directory.join("owner.lock"), true)?;
        send(&json!({"type":"waiting"}))?;
        owner.lock()?;
        lease = Some(owner);
        send(&json!({"type":"locked"}))?;
        prepare(directory, &input)?;
        Ok(())
    })();
    if let Err(error) = &result {
        eprintln!("{error:#}");
    }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

fn prepare(directory: &Path, input: &Receiver<Input>) -> Result<()> {
    let Input::Begin { package_root, mut descriptor } = input.recv()? else {
        wasmtime::error::bail!("Expected preparation begin");
    };
    // Reuse the verified schema and generated filename/size/ABI constraints.
    descriptor.canonical_bytes()?;
    ensure!(!descriptor.targets.is_empty(), "No native targets");
    files::directory(&package_root)?;
    let manifest_path = package_root.join("maghemite.module.json");
    let manifest_size = std::fs::symlink_metadata(&manifest_path)?.len();
    ensure!(manifest_size <= 64 * 1024, "Manifest exceeds limit");
    ensure!(
        Sha256Digest::of(&files::read(&manifest_path, manifest_size)?) == descriptor.manifest_sha256,
        "Manifest digest mismatch"
    );
    let identity = identity()?;
    let mut total = 0_u64;
    for (index, target) in descriptor.targets.iter_mut().enumerate() {
        let engine = preparation_engine(target.abi)?;
        let actual = producer(&engine, &identity);
        ensure!(serde_json::to_value(&actual)? == serde_json::to_value(&target.producer)?, "Native producer changed");
        // Read/hash/precompile exactly the same owned source buffer.
        let source = files::read(&package_root.join(&target.source_path), target.source_size)?;
        ensure!(Sha256Digest::of(&source) == target.source_sha256, "Source digest mismatch");
        send(&json!({"type":"compiling", "index": index}))?;
        let bytes = maghemite_wasm_host::startup::compile(4, || match target.format {
            ArtifactFormat::Component => engine.precompile_component(&source),
            ArtifactFormat::CoreModule => engine.precompile_module(&source),
        })?;
        let size = u64::try_from(bytes.len())?;
        ensure!((1..=MAX_ARTIFACT_BYTES).contains(&size), "Artifact exceeds limit");
        total = total.checked_add(size).ok_or_else(|| wasmtime::Error::msg("Generation size overflow"))?;
        ensure!(total <= MAX_GENERATION_BYTES, "Generation exceeds limit");
        // Verify producer output with the very same compiler-disabled recipe
        // used by TrustedArtifactSet loads, retaining Wasmtime's compatibility checks.
        let engine = load_engine(target.abi)?;
        match target.format {
            ArtifactFormat::Component => {
                // SAFETY: bytes are the unchanged output of the producer's
                // precompile_component above, never caller-provided native code.
                let component = unsafe { wasmtime::component::Component::deserialize(&engine, &bytes)? };
                maghemite_wasm_host::validate_component_abi(&component, target.abi)?;
            }
            ArtifactFormat::CoreModule => {
                // SAFETY: same freshly-produced, owned-byte invariant as above.
                let module = unsafe { wasmtime::Module::deserialize(&engine, &bytes)? };
                crate::wasi_tool::validate_abi(&module, target.abi)?;
            }
        }
        target.artifact.size = size;
        target.artifact.sha256 = Sha256Digest::of(&bytes);
        files::write(&directory.join(&target.artifact.file), &bytes)?;
        send(&json!({"type":"target", "completed":index + 1}))?;
    }
    files::write(&directory.join("descriptor.json"), &descriptor.canonical_bytes()?)?;
    files::sync_directory(directory)?;
    send(&json!({"type":"ready", "total":descriptor.targets.len()}))?;
    ensure!(matches!(input.recv()?, Input::Finish), "Expected preparation finish");
    Ok(())
}
