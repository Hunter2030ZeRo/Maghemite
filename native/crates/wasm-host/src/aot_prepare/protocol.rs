use maghemite_wasm_host::aot::{ArtifactDescriptor, MAX_DESCRIPTOR_BYTES};
use serde::Deserialize;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, channel};
use wasmtime::{Result, error::ensure};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub(super) enum Input {
    Begin {
        #[serde(rename = "packageRoot")]
        package_root: PathBuf,
        descriptor: ArtifactDescriptor,
    },
    Finish,
}

pub(super) fn send(value: &serde_json::Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(u64::try_from(bytes.len())? < MAX_DESCRIPTOR_BYTES, "Oversize protocol frame");
    bytes.push(b'\n');
    let mut out = std::io::stdout().lock();
    out.write_all(&bytes)?;
    out.flush()?;
    Ok(())
}

/// The only stdin reader. EOF exits the *process*, even in lock/Cranelift work.
/// At most two bounded frames can be queued; there is no unbounded input channel.
pub(super) fn watchdog() -> Result<Receiver<Input>> {
    let (tx, rx) = channel();
    std::thread::Builder::new().name("aot-parent-watchdog".into()).spawn(move || {
        let result = (|| -> Result<()> {
            let mut input = std::io::stdin().lock();
            for _ in 0..2 {
                let mut bytes = Vec::new();
                let count = (&mut input).take(MAX_DESCRIPTOR_BYTES + 1).read_until(b'\n', &mut bytes)?;
                ensure!(count > 0, "Preparation parent closed stdin");
                ensure!(u64::try_from(count)? <= MAX_DESCRIPTOR_BYTES && bytes.last() == Some(&b'\n'), "Invalid preparation frame");
                tx.send(serde_json::from_slice(&bytes)?)?;
            }
            let mut byte = [0];
            input.read_exact(&mut byte)?;
            wasmtime::error::bail!("Unexpected preparation input");
        })();
        if let Err(error) = result {
            eprintln!("{error:#}");
        }
        std::process::exit(70);
    })?;
    Ok(rx)
}
