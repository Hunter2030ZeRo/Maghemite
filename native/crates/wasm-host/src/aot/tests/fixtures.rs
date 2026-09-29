use super::aot;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use wasmtime::{Engine, Module, Result, Store};

// (module (func (export "answer") (result i32) i32.const 42))
pub const CORE: &[u8] = b"\0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7f\
    \x03\x02\x01\0\x07\x0a\x01\x06answer\0\0\x0a\x06\x01\x04\0\x41\x2a\x0b";

// A component instantiating CORE and lifting answer to (func (result u32)).
// Binary fixtures avoid adding a WAT parser to the production feature set.
pub const COMPONENT: &[u8] = b"\0asm\x0d\0\x01\0\x01\x27\
    \0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7f\
    \x03\x02\x01\0\x07\x0a\x01\x06answer\0\0\x0a\x06\x01\x04\0\x41\x2a\x0b\
    \x02\x04\x01\0\0\0\x06\x0c\x01\0\0\x01\0\x06answer\
    \x07\x05\x01\x40\0\0\x79\x08\x06\x01\0\0\0\0\0\
    \x0b\x0c\x01\0\x06answer\x01\0\0";

static DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct PrivateDirectory(Option<PathBuf>);

impl PrivateDirectory {
    pub fn new() -> Result<Self> {
        let sequence = DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .canonicalize()?
            .join(format!("maghemite-aot-{}-{sequence}", std::process::id()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Self(Some(path)))
    }

    pub fn path(&self) -> Result<&Path> {
        self.0
            .as_deref()
            .ok_or_else(|| wasmtime::Error::msg("Directory already closed"))
    }

    pub fn close(mut self) -> Result<()> {
        if let Some(path) = self.0.as_ref() {
            std::fs::remove_dir_all(path)?;
            self.0 = None;
        }
        Ok(())
    }
}

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        if let Some(path) = &self.0
            && let Err(error) = std::fs::remove_dir_all(path)
        {
            eprintln!("AOT fixture cleanup failed for {}: {error}", path.display());
        }
    }
}

pub fn target(abi: aot::Abi, bytes: &[u8], engine: &Engine) -> Result<aot::ArtifactTarget> {
    let (kind, tool_id, source, source_path, file) = match abi.format() {
        aot::ArtifactFormat::Component => (
            aot::TargetKind::ComponentEntry,
            None,
            COMPONENT,
            "dist/module.wasm",
            "component.cwasm",
        ),
        aot::ArtifactFormat::CoreModule => (
            aot::TargetKind::WasiTool,
            Some("engine".to_owned()),
            CORE,
            "tools/engine.wasm",
            "tool-0.cwasm",
        ),
    };
    Ok(aot::ArtifactTarget {
        kind,
        tool_id,
        source_path: source_path.to_owned(),
        source_size: u64::try_from(source.len())?,
        source_sha256: aot::Sha256Digest::of(source),
        format: abi.format(),
        abi,
        producer: aot::Producer {
            identity: aot::Sha256Digest::of(b"test producer"),
            wasmtime_version: aot::WASMTIME_VERSION.to_owned(),
            recipe_version: aot::RECIPE_VERSION,
            target: aot::TARGET.to_owned(),
            cpu_policy: aot::CPU_POLICY.to_owned(),
            compilation_fingerprint: aot::compilation_fingerprint(engine),
        },
        artifact: aot::Artifact {
            file: file.to_owned(),
            size: u64::try_from(bytes.len())?,
            sha256: aot::Sha256Digest::of(bytes),
        },
    })
}

pub fn descriptor(targets: Vec<aot::ArtifactTarget>) -> aot::ArtifactDescriptor {
    aot::ArtifactDescriptor {
        schema_version: 1,
        slot: "11111111-1111-4111-8111-111111111111".to_owned(),
        module_id: "test.aot".to_owned(),
        module_version: "1.0.0".to_owned(),
        manifest_sha256: aot::Sha256Digest::of(b"reviewed manifest"),
        targets,
    }
}

pub fn write_descriptor(
    path: &Path,
    descriptor: &aot::ArtifactDescriptor,
) -> Result<aot::Sha256Digest> {
    let bytes = descriptor.canonical_bytes()?;
    std::fs::write(path.join("descriptor.json"), &bytes)?;
    Ok(aot::Sha256Digest::of(&bytes))
}

pub fn prepare(path: &Path, abi: aot::Abi) -> Result<aot::ArtifactDescriptor> {
    let engine = aot::preparation_engine(abi)?;
    let bytes = match abi.format() {
        aot::ArtifactFormat::Component => engine.precompile_component(COMPONENT)?,
        aot::ArtifactFormat::CoreModule => engine.precompile_module(CORE)?,
    };
    let target = target(abi, &bytes, &engine)?;
    std::fs::write(path.join(&target.artifact.file), bytes)?;
    Ok(descriptor(vec![target]))
}

pub async fn run_core(engine: &Engine, module: &Module) -> Result<i32> {
    let mut store = Store::new(engine, ());
    let instance = wasmtime::Instance::new_async(&mut store, module, &[]).await?;
    instance
        .get_typed_func::<(), i32>(&mut store, "answer")?
        .call_async(&mut store, ())
        .await
}

pub async fn run_component(
    engine: &Engine,
    component: &wasmtime::component::Component,
) -> Result<u32> {
    let mut store = Store::new(engine, ());
    store.set_fuel(10_000)?;
    let linker = wasmtime::component::Linker::new(engine);
    let instance = linker.instantiate_async(&mut store, component).await?;
    let answer = instance.get_typed_func::<(), (u32,)>(&mut store, "answer")?;
    let (value,) = answer.call_async(&mut store, ()).await?;
    Ok(value)
}
