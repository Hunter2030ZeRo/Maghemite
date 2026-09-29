use super::recipe::{Abi, ArtifactFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::str::FromStr;
use wasmtime::{Result, error::ensure};

pub const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
pub const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_GENERATION_BYTES: u64 = 3 * MAX_ARTIFACT_BYTES;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn of(bytes: &[u8]) -> Self {
        Self(format!("{:x}", Sha256::digest(bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Sha256Digest {
    type Error = wasmtime::Error;

    fn try_from(value: String) -> Result<Self> {
        ensure!(
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "Invalid SHA-256 digest"
        );
        Ok(Self(value))
    }
}

impl FromStr for Sha256Digest {
    type Err = wasmtime::Error;

    fn from_str(value: &str) -> Result<Self> {
        Self::try_from(value.to_owned())
    }
}

impl From<Sha256Digest> for String {
    fn from(value: Sha256Digest) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum TargetKind {
    ComponentEntry,
    WasiTool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Producer {
    pub identity: Sha256Digest,
    pub wasmtime_version: String,
    pub recipe_version: u32,
    pub target: String,
    pub cpu_policy: String,
    pub compilation_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub file: String,
    pub size: u64,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactTarget {
    pub kind: TargetKind,
    pub tool_id: Option<String>,
    pub source_path: String,
    pub source_size: u64,
    pub source_sha256: Sha256Digest,
    pub format: ArtifactFormat,
    pub abi: Abi,
    pub producer: Producer,
    pub artifact: Artifact,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDescriptor {
    pub schema_version: u32,
    pub slot: String,
    pub module_id: String,
    pub module_version: String,
    pub manifest_sha256: Sha256Digest,
    pub targets: Vec<ArtifactTarget>,
}

impl ArtifactDescriptor {
    /// Parses only the canonical schema, rejecting unknown/duplicate fields.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(
            u64::try_from(bytes.len())? <= MAX_DESCRIPTOR_BYTES,
            "Descriptor exceeds 64 KiB"
        );
        let descriptor: Self = serde_json::from_slice(bytes)?;
        ensure!(
            descriptor.canonical_bytes()? == bytes,
            "Noncanonical descriptor"
        );
        Ok(descriptor)
    }

    /// Produces the schema-1 UTF-8 bytes shared with the trusted TypeScript store.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        let mut descriptor = self.clone();
        descriptor.targets.sort_by(|a, b| {
            (&a.kind, &a.tool_id, &a.source_path).cmp(&(&b.kind, &b.tool_id, &b.source_path))
        });
        descriptor.validate()?;
        let mut value = serde_json::to_value(descriptor)?;
        value.sort_all_objects();
        let bytes = serde_json::to_vec(&value)?;
        ensure!(
            u64::try_from(bytes.len())? <= MAX_DESCRIPTOR_BYTES,
            "Descriptor exceeds 64 KiB"
        );
        Ok(bytes)
    }

    fn validate(&self) -> Result<()> {
        ensure!(self.schema_version == 1, "Unsupported descriptor schema");
        ensure!(
            !self.slot.is_empty() && !self.module_id.is_empty() && !self.module_version.is_empty(),
            "Missing installation identity"
        );
        ensure!(self.targets.len() <= 3, "Too many artifact targets");
        let mut components = 0;
        let mut tools = BTreeSet::new();
        let mut total = 0_u64;
        for target in &self.targets {
            ensure!(
                safe_relative_path(&target.source_path),
                "Invalid source path"
            );
            ensure!(
                target.format == target.abi.format(),
                "Artifact ABI/format mismatch"
            );
            let source_limit = match target.kind {
                TargetKind::ComponentEntry => {
                    components += 1;
                    ensure!(
                        components == 1
                            && target.tool_id.is_none()
                            && target.format == ArtifactFormat::Component
                            && target.artifact.file == "component.cwasm",
                        "Invalid component binding"
                    );
                    64 * 1024 * 1024
                }
                TargetKind::WasiTool => {
                    let id = target.tool_id.as_deref().unwrap_or("");
                    ensure!(
                        valid_tool_id(id) && tools.insert(id),
                        "Invalid or duplicate tool ID"
                    );
                    ensure!(
                        tools.len() <= 2
                            && target.format == ArtifactFormat::CoreModule
                            && target.artifact.file == format!("tool-{}.cwasm", tools.len() - 1),
                        "Invalid tool binding"
                    );
                    128 * 1024 * 1024
                }
            };
            ensure!(
                (8..=source_limit).contains(&target.source_size),
                "Invalid source size"
            );
            ensure!(
                (1..=MAX_ARTIFACT_BYTES).contains(&target.artifact.size),
                "Invalid artifact size"
            );
            total = total
                .checked_add(target.artifact.size)
                .ok_or_else(|| wasmtime::Error::msg("Size overflow"))?;
            ensure!(total <= MAX_GENERATION_BYTES, "Generation exceeds 3 GiB");
            ensure!(
                !target.producer.target.is_empty()
                    && !target.producer.compilation_fingerprint.is_empty(),
                "Missing producer information"
            );
        }
        Ok(())
    }
}

fn valid_tool_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
