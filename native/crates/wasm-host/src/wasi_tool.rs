//! Portable package-owned WASI command. Its pipes and lifetime belong to ModuleHost.
use maghemite_wasm_host::{
    aot::{Abi, TrustedArtifactSet},
    startup,
};
use std::path::Path;
use wasmtime::{Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{
    FsPerms, WasiCtxBuilder,
    p1::{self, WasiP1Ctx},
};
struct State {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
    input: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    pending: Vec<u8>,
}
pub async fn run(
    artifacts: TrustedArtifactSet,
    tool_id: &str,
    assets: &Path,
    stdin_mode: &str,
    args: &[String],
) -> wasmtime::Result<()> {
    wasmtime::error::ensure!(
        stdin_mode == "blocking" || stdin_mode == "cooperative-v1",
        "Invalid stdin mode"
    );
    let abi = if stdin_mode == "cooperative-v1" {
        Abi::WasiP1Cooperative
    } else {
        Abi::WasiP1Blocking
    };
    let (engine, module) = artifacts.load_module(tool_id, abi)?;
    drop(artifacts);
    startup::notify_loaded()?;
    let cooperative = module
        .imports()
        .any(|i| i.module() == "maghemite_io" && i.name() == "stdin_read");
    wasmtime::error::ensure!(
        cooperative == (stdin_mode == "cooperative-v1"),
        "Undeclared cooperative stdin extension"
    );
    let input = if cooperative {
        let (tx, rx) = std::sync::mpsc::sync_channel(2);
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin().lock();
            loop {
                let mut bytes = vec![0; 24 * 1024];
                let count = match stdin.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                bytes.truncate(count);
                if tx.send(bytes).is_err() {
                    break;
                }
            }
        });
        Some(rx)
    } else {
        None
    };
    let mut wasi = WasiCtxBuilder::new();
    wasi.env("PWD", "/assets");
    if !cooperative {
        wasi.inherit_stdin();
    }
    wasi.inherit_stdout()
        .inherit_stderr()
        .arg("/tools/engine.wasm")
        .args(args);
    // No host environment, network, workspace, writes, or subprocess access.
    if !assets.as_os_str().is_empty() {
        wasi.preopened_dir(assets, "/assets", FsPerms::ReadOnly)?;
    }
    let mut store = Store::new(
        &engine,
        State {
            wasi: wasi.build_p1(),
            input,
            pending: Vec::new(),
            limits: StoreLimitsBuilder::new()
                .memory_size(512 * 1024 * 1024)
                .table_elements(1_000_000)
                .instances(1)
                .memories(1)
                .tables(2)
                .build(),
        },
    );
    store.limiter(|s| &mut s.limits);
    let linker = tool_linker(&engine, cooperative)?;
    let instance = linker.instantiate_async(&mut store, &module).await?;
    let result = instance
        .get_typed_func::<(), ()>(&mut store, "_start")?
        .call_async(&mut store, ())
        .await;
    match result {
        Err(e)
            if e.downcast_ref::<wasmtime_wasi::I32Exit>()
                .is_some_and(|e| e.0 == 0) =>
        {
            Ok(())
        }
        result => result,
    }
}

fn tool_linker(engine: &Engine, cooperative: bool) -> wasmtime::Result<Linker<State>> {
    let mut linker = Linker::new(engine);
    p1::add_to_linker_async(&mut linker, |s: &mut State| &mut s.wasi)?;
    if cooperative {
        linker.func_wrap(
            "maghemite_io",
            "stdin_read",
            |mut caller: wasmtime::Caller<'_, State>,
             ptr: u32,
             len: u32|
             -> wasmtime::Result<i32> {
                wasmtime::error::ensure!(len <= 64 * 1024, "stdin chunk exceeds limit");
                if len == 0 {
                    return Ok(0);
                }
                if caller.data().pending.is_empty() {
                    match caller.data_mut().input.as_mut().unwrap().try_recv() {
                        Ok(bytes) => caller.data_mut().pending = bytes,
                        Err(std::sync::mpsc::TryRecvError::Empty) => return Ok(-1),
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => return Ok(0),
                    }
                }
                let count = (len as usize).min(caller.data().pending.len());
                let bytes: Vec<u8> = caller.data_mut().pending.drain(..count).collect();
                let memory = caller
                    .get_export("memory")
                    .and_then(|e| e.into_memory())
                    .ok_or_else(|| wasmtime::Error::msg("Missing tool memory"))?;
                memory.write(&mut caller, ptr as usize, &bytes)?;
                Ok(count as i32)
            },
        )?;
    }
    Ok(linker)
}

pub(crate) fn validate_abi(module: &Module, abi: Abi) -> wasmtime::Result<()> {
    let cooperative = match abi {
        Abi::WasiP1Blocking => false,
        Abi::WasiP1Cooperative => true,
        Abi::ComponentAsync | Abi::ComponentSync => {
            wasmtime::error::bail!("Expected WASI ABI");
        }
    };
    let declared = module
        .imports()
        .any(|i| i.module() == "maghemite_io" && i.name() == "stdin_read");
    wasmtime::error::ensure!(
        declared == cooperative,
        "Undeclared cooperative stdin extension"
    );
    // This resolves real p1/cooperative imports and checks their exact types.
    tool_linker(module.engine(), cooperative)?.instantiate_pre(module)?;
    let start = module
        .get_export("_start")
        .and_then(|ty| ty.func().cloned())
        .ok_or_else(|| wasmtime::Error::msg("Missing tool _start function"))?;
    wasmtime::error::ensure!(
        start.params().len() == 0 && start.results().len() == 0,
        "Invalid tool _start signature"
    );
    if cooperative {
        let memory = module
            .get_export("memory")
            .and_then(|ty| ty.memory().cloned())
            .ok_or_else(|| wasmtime::Error::msg("Missing cooperative tool memory"))?;
        wasmtime::error::ensure!(!memory.is_64(), "Cooperative tool requires 32-bit memory");
    }
    Ok(())
}
