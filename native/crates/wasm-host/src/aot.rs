//! Host-native recipes and trusted, exact-buffer artifact loading.
//! Receipt authority belongs to the installation store, not to a guest package.
mod descriptor;
mod files;
mod recipe;

pub use descriptor::{
    Artifact, ArtifactDescriptor, ArtifactTarget, MAX_ARTIFACT_BYTES, MAX_DESCRIPTOR_BYTES,
    MAX_GENERATION_BYTES, Producer, Sha256Digest, TargetKind,
};
pub use recipe::{
    Abi, ArtifactFormat, CPU_POLICY, RECIPE_VERSION, TARGET, WASMTIME_VERSION,
    compilation_fingerprint, load_engine, preparation_engine,
};

use files::GenerationDirectory;
use std::path::Path;
use wasmtime::component::Component;
use wasmtime::{Engine, Module, Precompiled, Result, error::ensure};

/// Opaque authority for an immutable application-owned generation.
pub struct TrustedArtifactSet {
    directory: GenerationDirectory,
    descriptor: ArtifactDescriptor,
}

/// Selectors come from trusted registration, never guest-supplied file paths.
pub enum TargetSelector<'a> {
    Component(Abi),
    Tool { id: &'a str, abi: Abi },
}

impl TrustedArtifactSet {
    /// Opens and binds the descriptor to the committed registry digest.
    ///
    /// # Safety
    /// `artifact_set_id` must come from the trusted installation publication
    /// path, which attests that each artifact digest names unmodified Wasmtime
    /// precompile/serialize output. Never accept a receipt supplied by a guest,
    /// even with matching checksums. `directory` and its namespace must be
    /// app-owned, outside guest-accessible roots, and pinned for this object's
    /// lifetime (including on platforms without directory-relative opens).
    /// Hashes and private permissions detect tampering; they do not grant trust.
    pub unsafe fn open(directory: &Path, artifact_set_id: &Sha256Digest) -> Result<Self> {
        let directory = GenerationDirectory::open(directory)?;
        let bytes = directory.read("descriptor.json", MAX_DESCRIPTOR_BYTES)?;
        ensure!(
            Sha256Digest::of(&bytes) == *artifact_set_id,
            "Artifact-set digest mismatch"
        );
        let descriptor = ArtifactDescriptor::parse(&bytes)?;
        Ok(Self {
            directory,
            descriptor,
        })
    }

    pub fn descriptor(&self) -> &ArtifactDescriptor {
        &self.descriptor
    }

    /// Verifies one bounded owned snapshot. No pathname is used after this call.
    pub fn snapshot(&self, selector: TargetSelector<'_>) -> Result<ArtifactSnapshot> {
        let (kind, id, abi) = match selector {
            TargetSelector::Component(abi) => (TargetKind::ComponentEntry, None, abi),
            TargetSelector::Tool { id, abi } => (TargetKind::WasiTool, Some(id), abi),
        };
        let target = self
            .descriptor
            .targets
            .iter()
            .find(|target| target.kind == kind && target.tool_id.as_deref() == id)
            .ok_or_else(|| wasmtime::Error::msg("Target absent from artifact set"))?;
        ensure!(target.abi == abi, "Artifact ABI mismatch");
        let producer = &target.producer;
        ensure!(
            producer.wasmtime_version == WASMTIME_VERSION
                && producer.recipe_version == RECIPE_VERSION
                && producer.target == TARGET
                && producer.cpu_policy == CPU_POLICY,
            "Incompatible artifact recipe"
        );
        // Do not compare producer fingerprints against compiler-disabled engines.
        let bytes = self
            .directory
            .read(&target.artifact.file, target.artifact.size)?;
        ensure!(
            u64::try_from(bytes.len())? == target.artifact.size,
            "Artifact length mismatch"
        );
        ensure!(
            Sha256Digest::of(&bytes) == target.artifact.sha256,
            "Artifact digest mismatch"
        );
        let expected = match target.format {
            ArtifactFormat::Component => Precompiled::Component,
            ArtifactFormat::CoreModule => Precompiled::Module,
        };
        ensure!(
            Engine::detect_precompiled(&bytes) == Some(expected),
            "Artifact kind mismatch"
        );
        Ok(ArtifactSnapshot { bytes, abi })
    }

    pub fn load_component(&self, abi: Abi) -> Result<(Engine, Component)> {
        self.snapshot(TargetSelector::Component(abi))?
            .into_component()
    }

    pub fn load_module(&self, id: &str, abi: Abi) -> Result<(Engine, Module)> {
        self.snapshot(TargetSelector::Tool { id, abi })?
            .into_module()
    }
}

/// Unforgeable verified native bytes. Deserialization consumes and releases the
/// snapshot; Wasmtime copies code into its own allocation and owns its lifetime.
pub struct ArtifactSnapshot {
    bytes: Vec<u8>,
    abi: Abi,
}

impl ArtifactSnapshot {
    pub fn into_component(self) -> Result<(Engine, Component)> {
        ensure!(
            self.abi.format() == ArtifactFormat::Component,
            "Expected component"
        );
        let engine = load_engine(self.abi)?;
        #[cfg(test)]
        DESERIALIZATIONS.with(|count| count.set(count.get() + 1));
        // SAFETY: [Library contract] TrustedArtifactSet attests Wasmtime output;
        // snapshot verified its digest/kind and owns exactly those immutable bytes.
        // deserialize copies them; version/configuration/ISA checks stay enabled.
        let component = unsafe { Component::deserialize(&engine, &self.bytes)? };
        Ok((engine, component))
    }

    pub fn into_module(self) -> Result<(Engine, Module)> {
        ensure!(
            self.abi.format() == ArtifactFormat::CoreModule,
            "Expected core module"
        );
        let engine = load_engine(self.abi)?;
        #[cfg(test)]
        DESERIALIZATIONS.with(|count| count.set(count.get() + 1));
        // SAFETY: [Library contract] Same provenance and owned-byte invariant as
        // into_component; no file-backed mapping or untrusted bytes enter here.
        let module = unsafe { Module::deserialize(&engine, &self.bytes)? };
        Ok((engine, module))
    }
}

#[cfg(test)]
thread_local! {
    static DESERIALIZATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
mod tests;
