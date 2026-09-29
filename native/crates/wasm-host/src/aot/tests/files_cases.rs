use super::*;

#[test]
fn interrupted_or_corrupt_objects_never_deserialize() -> Result<()> {
    // Given a trusted generation whose receipt remains fixed.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let id = write_descriptor(directory.path()?, &descriptor)?;
    let path = directory.path()?.join("tool-0.cwasm");
    let original = std::fs::read(&path)?;
    // SAFETY: trusted receipt names our original Wasmtime output, not corrupt replacements.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let mut changed = original.clone();
    changed[0] ^= 1;
    let mut appended = original.clone();
    appended.push(0);
    let before = DESERIALIZATIONS.get();
    // When successive interrupted writes, digest changes, growth and deletion occur.
    for bytes in [
        &original[..0],
        &original[..1],
        &original[..original.len() - 1],
        changed.as_slice(),
        appended.as_slice(),
        CORE,
    ] {
        std::fs::write(&path, bytes)?;
        assert!(trusted.load_module("engine", Abi::WasiP1Blocking).is_err());
    }
    std::fs::remove_file(&path)?;
    assert!(trusted.load_module("engine", Abi::WasiP1Blocking).is_err());
    // Then not one unsafe deserialization was attempted.
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}

#[tokio::test]
async fn pathname_replacement_after_snapshot_cannot_change_executed_bytes() -> Result<()> {
    // Given verified, owned code bytes.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: generated locally and pinned in private fixture storage.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let snapshot = trusted.snapshot(TargetSelector::Tool {
        id: "engine",
        abi: Abi::WasiP1Blocking,
    })?;
    // When the pathname is repeatedly replaced after verification, then removed.
    let path = directory.path()?.join("tool-0.cwasm");
    for bytes in [b"interrupted".as_slice(), CORE, b""] {
        let replacement = directory.path()?.join("replacement");
        std::fs::write(&replacement, bytes)?;
        std::fs::rename(replacement, &path)?;
    }
    drop(trusted);
    directory.close()?;
    let (engine, module) = snapshot.into_module()?;
    // Then the verified export still runs; no filename was reopened.
    assert_eq!(run_core(&engine, &module).await?, 42);
    Ok(())
}

#[test]
fn forged_adjacent_receipt_cannot_replace_registry_authority() -> Result<()> {
    // Given a committed ID for our real artifact.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let committed = write_descriptor(directory.path()?, &descriptor)?;
    let mut forged = descriptor.clone();
    forged.targets[0].artifact.size = u64::try_from(CORE.len())?;
    forged.targets[0].artifact.sha256 = Sha256Digest::of(CORE);
    std::fs::write(directory.path()?.join("tool-0.cwasm"), CORE)?;
    write_descriptor(directory.path()?, &forged)?;
    let before = DESERIALIZATIONS.get();
    // When an adjacent matching receipt/object pair is substituted.
    // SAFETY: only the original host-owned registration is authority.
    let result = unsafe { TrustedArtifactSet::open(directory.path()?, &committed) };
    // Then the trusted ID rejects the forged descriptor before any native call.
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("digest mismatch")
    );
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}

#[cfg(unix)]
#[test]
fn symlinks_and_nonregular_objects_never_deserialize() -> Result<()> {
    use std::os::unix::fs::symlink;
    // Given a trusted generation with a replaced object path.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: ID comes from our private locally compiled fixture.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    let path = directory.path()?.join("tool-0.cwasm");
    let saved = directory.path()?.join("saved");
    std::fs::rename(&path, &saved)?;
    symlink(&saved, &path)?;
    let before = DESERIALIZATIONS.get();
    // When symlink and directory substitutions reach the loader.
    assert!(trusted.load_module("engine", Abi::WasiP1Blocking).is_err());
    std::fs::remove_file(&path)?;
    std::fs::create_dir(&path)?;
    assert!(trusted.load_module("engine", Abi::WasiP1Blocking).is_err());
    let receipt = directory.path()?.join("descriptor.json");
    std::fs::rename(&receipt, directory.path()?.join("receipt"))?;
    symlink("receipt", &receipt)?;
    // SAFETY: original registry authority is unchanged.
    assert!(unsafe { TrustedArtifactSet::open(directory.path()?, &id) }.is_err());
    // Then the no-follow regular-file gate stopped every native call.
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}

#[cfg(unix)]
#[tokio::test]
async fn retained_directory_handle_survives_generation_rename() -> Result<()> {
    // Given an opened generation directory handle.
    let parent = PrivateDirectory::new()?;
    let generation = parent.path()?.join("generation");
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(&generation)?;
    let descriptor = prepare(&generation, Abi::WasiP1Blocking)?;
    let id = write_descriptor(&generation, &descriptor)?;
    // SAFETY: our genuine output and private parent remain owned for this test.
    let trusted = unsafe { TrustedArtifactSet::open(&generation, &id)? };
    // When its path is renamed and replaced by an empty directory.
    std::fs::rename(&generation, parent.path()?.join("retained"))?;
    std::fs::create_dir(&generation)?;
    let (engine, module) = trusted.load_module("engine", Abi::WasiP1Blocking)?;
    // Then the open directory, not the replacement path, supplies code.
    assert_eq!(run_core(&engine, &module).await?, 42);
    drop(trusted);
    parent.close()
}

#[test]
fn oversized_files_are_rejected_before_allocation() -> Result<()> {
    // Given a sparse oversized artifact, then an oversized descriptor.
    let directory = PrivateDirectory::new()?;
    let descriptor = prepare(directory.path()?, Abi::WasiP1Blocking)?;
    let id = write_descriptor(directory.path()?, &descriptor)?;
    // SAFETY: original registration attests our locally generated artifact.
    let trusted = unsafe { TrustedArtifactSet::open(directory.path()?, &id)? };
    std::fs::OpenOptions::new()
        .write(true)
        .open(directory.path()?.join("tool-0.cwasm"))?
        .set_len(MAX_ARTIFACT_BYTES + 1)?;
    let before = DESERIALIZATIONS.get();
    // When file metadata exceeds the trusted allocation bounds.
    assert!(trusted.load_module("engine", Abi::WasiP1Blocking).is_err());
    std::fs::OpenOptions::new()
        .write(true)
        .open(directory.path()?.join("descriptor.json"))?
        .set_len(MAX_DESCRIPTOR_BYTES + 1)?;
    // SAFETY: unchanged registry authority; the file corruption is rejected.
    assert!(unsafe { TrustedArtifactSet::open(directory.path()?, &id) }.is_err());
    // Then unsafe code-image loading was never entered.
    assert_eq!(DESERIALIZATIONS.get(), before);
    directory.close()
}
