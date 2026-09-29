use anyhow::{Context, Result};
use maghemite_wasm_host::{
    HostEvent, ModuleRuntime, ResourceProfile, RuntimeOptions,
    aot::{Sha256Digest, TrustedArtifactSet},
};
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

mod aot_prepare;
mod wasi_tool;

const MAX_FRAME: usize = 64 * 1024;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // This is a dedicated module process. Bound glibc's per-thread arenas
        // before spawning compiler workers, so malloc_trim can reclaim their
        // working set. This is allocator tuning, not a guest memory limit.
        // SAFETY: mallopt is called before this process starts worker threads.
        unsafe {
            libc::mallopt(libc::M_ARENA_MAX, 2);
        }
    }
    let result = run().await;
    if let Err(error) = &result {
        eprintln!("{error:#}");
    }
    // Tokio stdin uses a blocking OS read. Exit on both success and failure so
    // runtime shutdown cannot wait for a parent that is waiting for our reply.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

async fn run() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("-h" | "--help") => {
            anyhow::ensure!(std::env::args_os().len() == 2, "Unexpected help argument");
            println!(
                "Usage: maghemite-wasm-host MODE\n\
                 \nInternal trusted modes:\n\
                 \x20 --aot-info\n\
                 \x20 --aot-prepare <staging-directory>\n\
                 \x20 --component-aot <generation-directory> <artifact-set-id> <profile> [options]\n\
                 \x20 --wasi-tool-aot <generation-directory> <artifact-set-id> <tool-id> <assets> <stdin-mode> -- <guest-arguments>"
            );
            return Ok(());
        }
        Some("--aot-info") => {
            anyhow::ensure!(
                std::env::args_os().len() == 2,
                "Unexpected AOT info argument"
            );
            return aot_prepare::info().map_err(|e| anyhow::anyhow!("{e:#}"));
        }
        Some("--aot-prepare") => {
            anyhow::ensure!(std::env::args_os().len() == 3, "Expected staging directory");
            let directory = std::env::args_os()
                .nth(2)
                .context("Missing staging directory")?;
            aot_prepare::run(std::path::Path::new(&directory));
        }
        _ => {}
    }
    if std::env::args().nth(1).as_deref() == Some("--wasi-tool-aot") {
        let directory = std::env::args_os()
            .nth(2)
            .context("Expected generation directory")?;
        let artifact_set_id = std::env::args()
            .nth(3)
            .context("Expected artifact-set ID")?
            .parse::<Sha256Digest>()
            .map_err(|error| anyhow::anyhow!("{error:#}"))?;
        let tool_id = std::env::args().nth(4).context("Expected tool ID")?;
        let assets = std::env::args_os().nth(5).context("Expected assets path")?;
        let stdin_mode = std::env::args().nth(6).context("Expected stdin mode")?;
        let mut guest_args = std::env::args().skip(7);
        anyhow::ensure!(
            guest_args.next().as_deref() == Some("--"),
            "Expected -- before guest arguments"
        );
        // SAFETY: [Category 13 — Library contract] This internal mode is spawned
        // only by ModuleHost from a pinned AotStore capability. The trusted parent
        // supplies the generation directory, committed descriptor ID and tool ID.
        let artifacts =
            unsafe { TrustedArtifactSet::open(std::path::Path::new(&directory), &artifact_set_id) }
                .map_err(|error| anyhow::anyhow!("{error:#}"))?;
        return wasi_tool::run(
            artifacts,
            &tool_id,
            std::path::Path::new(&assets),
            &stdin_mode,
            &guest_args.collect::<Vec<_>>(),
        )
        .await
        .map_err(|e| anyhow::anyhow!("{e:#}"));
    }
    anyhow::ensure!(
        std::env::args().nth(1).as_deref() == Some("--component-aot"),
        "Expected --component-aot prepared component mode"
    );
    let directory = std::env::args_os()
        .nth(2)
        .context("Expected generation directory")?;
    let artifact_set_id = std::env::args()
        .nth(3)
        .context("Expected artifact-set ID")?
        .parse::<Sha256Digest>()
        .map_err(|error| anyhow::anyhow!("{error:#}"))?;
    let profile = std::env::args()
        .nth(4)
        .context("Expected component profile")?;
    let mut options = RuntimeOptions::default();
    let mut args = std::env::args_os().skip(5);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--diagnostics") => options.diagnostics = true,
            Some("--resource-profile") => {
                options.resources = ResourceProfile::parse(
                    args.next()
                        .context("Missing resource profile")?
                        .to_str()
                        .context("Invalid resource profile")?,
                )
                .map_err(anyhow::Error::msg)?
            }
            _ => anyhow::bail!("Unknown host option"),
        }
    }
    // SAFETY: [Category 13 — Library contract] This internal mode is spawned
    // only by ModuleHost from a pinned AotStore capability. That trusted parent
    // supplies the app-owned generation directory and committed descriptor ID;
    // guest/package requests cannot choose either argument.
    let artifacts =
        unsafe { TrustedArtifactSet::open(std::path::Path::new(&directory), &artifact_set_id) }
            .map_err(|error| anyhow::anyhow!("{error:#}"))?;
    let (events, mut event_rx) = mpsc::channel::<HostEvent>(8);
    let (requests, mut request_rx) = mpsc::channel::<Value>(1);
    let (acks, mut ack_rx) = mpsc::channel::<Value>(8);
    let (output, mut output_rx) = mpsc::channel::<Value>(8);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = output_rx.recv().await {
            let mut bytes = serde_json::to_vec(&value)?;
            anyhow::ensure!(bytes.len() < MAX_FRAME, "Outbound frame exceeds limit");
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let reader = tokio::spawn(async move {
        let mut input = BufReader::new(tokio::io::stdin());
        loop {
            let mut bytes = Vec::new();
            let count = (&mut input)
                .take((MAX_FRAME + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await?;
            if count == 0 {
                break;
            }
            anyhow::ensure!(
                count <= MAX_FRAME && bytes.last() == Some(&b'\n'),
                "Invalid input frame"
            );
            let value: Value = serde_json::from_slice(&bytes)?;
            if value["type"] == "ack" {
                if acks.send(value).await.is_err() {
                    break;
                }
            } else if requests.send(value).await.is_err() {
                break;
            }
        }
        Ok::<_, anyhow::Error>(())
    });
    let event_output = output.clone();
    let event_loop = tokio::spawn(async move {
        let mut next = 1_u64;
        let mut pending: HashMap<u64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
        loop {
            tokio::select! {
                event = event_rx.recv(), if pending.len() < 8 => {
                    let Some(event) = event else { break; };
                    let id = next; next += 1;
                    pending.insert(id, event.reply);
                    event_output.send(json!({"type":"event", "id":id, "call":event.call, "method":event.method, "payload":event.payload})).await.ok();
                }
                ack = ack_rx.recv() => {
                    let Some(ack) = ack else { break; };
                    if let Some(reply) = ack["id"].as_u64().and_then(|id| pending.remove(&id)) {
                        let result = if ack["ok"] == true { Ok(ack["value"].clone()) } else { Err(ack["error"].as_str().unwrap_or("Host rejected event").to_owned()) };
                        let _ = reply.send(result);
                    }
                }
            }
        }
    });
    let mut runtime = ModuleRuntime::load_prepared(artifacts, &profile, events, &options)
        .await
        .map_err(|e| anyhow::anyhow!("{e:#}"))?;
    let mut active = false;
    while let Some(request) = request_rx.recv().await {
        let id = request["id"].as_u64().context("Missing request ID")?;
        let method = request["method"].as_str().context("Missing method")?;
        let allowed = match method {
            "activate" => !active,
            "execute" | "deactivate" => active,
            _ => false,
        };
        let input = serde_json::to_string(&request["input"])?;
        let result = if allowed {
            runtime
                .call(
                    id,
                    method,
                    request["command"].as_str().unwrap_or(""),
                    &input,
                )
                .await
                .map_err(|e| anyhow::anyhow!("{e:#}"))
        } else {
            Err(anyhow::anyhow!("Invalid module lifecycle state"))
        };
        if result.is_ok() {
            if method == "activate" {
                active = true;
            } else if method == "deactivate" {
                active = false;
            }
        }
        let failed = result.is_err();
        let response = match result {
            Ok(value) => json!({"type":"response", "id":id, "ok":true, "value":value}),
            Err(error) => {
                json!({"type":"response", "id":id, "ok":false, "error":format!("{error:#}")})
            }
        };
        output.send(response).await?;
        if method == "deactivate" || failed {
            break;
        }
    }
    drop(runtime);
    event_loop.abort();
    let _ = event_loop.await;
    reader.abort();
    drop(output);
    writer.await??;
    Ok(())
}
