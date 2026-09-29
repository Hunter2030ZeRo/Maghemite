//! Isolated Wasmtime host for the Maghemite Modules SDK.
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
use wasmtime::component::{Accessor, ResourceTable};
use wasmtime::{Engine, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
pub mod aot;
mod preparation_validation;
pub use preparation_validation::validate_component_abi;
pub mod startup;
pub use startup::{ResourceProfile, RuntimeOptions};

// Managed guest runtimes initialize their allocator/GC on first entry. Give
// startup its own bounded allowance; normal commands retain the smaller budget.

pub mod bindings {
    wasmtime::component::bindgen!({
        path: "../../../modules-sdk/wit",
        world: "module",
    });
}

pub mod sync_bindings {
    wasmtime::component::bindgen!({
        path: "../../../modules-sdk/wit/compat",
        world: "module-sync",
        imports: { default: async },
        exports: { default: async },
    });
}

pub struct HostEvent {
    pub call: u64,
    pub method: &'static str,
    pub payload: serde_json::Value,
    pub reply: oneshot::Sender<Result<serde_json::Value, String>>,
}

struct State {
    wasi: WasiCtx,
    table: ResourceTable,
    limits: StoreLimits,
    events: mpsc::Sender<HostEvent>,
    call: u64,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl bindings::maghemite::modules::host::Host for State {}
impl bindings::maghemite::modules::host::HostWithStore<State>
    for wasmtime::component::HasSelf<State>
{
    async fn report_progress(
        accessor: &Accessor<State, Self>,
        value: bindings::maghemite::modules::host::Progress,
    ) -> Result<(), String> {
        emit(
            accessor,
            "tasks.progress",
            serde_json::json!({
                "message": value.message, "completed": value.completed, "total": value.total
            }),
        )
        .await
        .map(|_| ())
    }
    async fn log(accessor: &Accessor<State, Self>, message: String) -> Result<(), String> {
        emit(accessor, "log", serde_json::json!(message))
            .await
            .map(|_| ())
    }
}

impl bindings::maghemite::modules::tasks::Host for State {}
impl bindings::maghemite::modules::tasks::HostWithStore<State>
    for wasmtime::component::HasSelf<State>
{
    async fn delay(accessor: &Accessor<State, Self>, milliseconds: u32) -> Result<(), String> {
        emit(accessor, "tasks.delay", serde_json::json!(milliseconds))
            .await
            .map(|_| ())
    }
    async fn run_worker(
        accessor: &Accessor<State, Self>,
        command: String,
        input: String,
    ) -> Result<String, String> {
        let input: serde_json::Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        let value = emit(
            accessor,
            "tasks.run-worker",
            serde_json::json!({"command":command, "input":input}),
        )
        .await?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }
}

impl bindings::maghemite::modules::application::Host for State {}
impl bindings::maghemite::modules::application::HostWithStore<State>
    for wasmtime::component::HasSelf<State>
{
    async fn request(
        accessor: &Accessor<State, Self>,
        method: String,
        parameters: String,
    ) -> Result<String, String> {
        let parameters: serde_json::Value =
            serde_json::from_str(&parameters).map_err(|e| e.to_string())?;
        let value = emit(
            accessor,
            "app.request",
            serde_json::json!({"method":method, "parameters":parameters}),
        )
        .await?;
        serde_json::to_string(&value).map_err(|e| e.to_string())
    }
}

async fn emit(
    accessor: &Accessor<State>,
    method: &'static str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (events, call) = accessor.with(|mut access| {
        let state = access.get();
        (state.events.clone(), state.call)
    });
    send_event(&events, call, method, payload).await
}

async fn send_event(
    events: &mpsc::Sender<HostEvent>,
    call: u64,
    method: &'static str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (reply, wait) = oneshot::channel();
    events
        .send(HostEvent {
            call,
            method,
            payload,
            reply,
        })
        .await
        .map_err(|_| "Module host closed")?;
    wait.await.map_err(|_| "Module host closed")?
}

impl sync_bindings::maghemite::modules_sync::host::Host for State {
    async fn report_progress(
        &mut self,
        value: sync_bindings::maghemite::modules_sync::host::Progress,
    ) -> Result<(), String> {
        send_event(
            &self.events,
            self.call,
            "tasks.progress",
            serde_json::json!({
                "message": value.message, "completed": value.completed, "total": value.total
            }),
        )
        .await
        .map(|_| ())
    }

    async fn log(&mut self, message: String) -> Result<(), String> {
        send_event(&self.events, self.call, "log", serde_json::json!(message))
            .await
            .map(|_| ())
    }
}

enum Module {
    Async(bindings::Module),
    Sync(sync_bindings::ModuleSync),
}

pub struct ModuleRuntime {
    store: Store<State>,
    module: Module,
    // Explicit lifetime: compiled code remains owned for the instance lifetime.
    _engine: Arc<Engine>,
    diagnostics: startup::Diagnostics,
    fuel_per_call: u64,
    startup_fuel: u64,
}

impl ModuleRuntime {
    pub async fn load_prepared(
        artifacts: aot::TrustedArtifactSet,
        profile: &str,
        events: mpsc::Sender<HostEvent>,
        options: &RuntimeOptions,
    ) -> wasmtime::Result<Self> {
        wasmtime::error::ensure!(matches!(profile, "async" | "sync"), "Unknown Wasm profile");
        let diagnostics = startup::Diagnostics::new(options.diagnostics);
        diagnostics.record("before-load", None);
        let abi = match profile {
            "async" => aot::Abi::ComponentAsync,
            "sync" => aot::Abi::ComponentSync,
            _ => unreachable!(),
        };
        // `load_component` consumes its verified owned snapshot. The temporary
        // serialized buffer is gone before native load completion is signalled.
        let (engine, component) = artifacts.load_component(abi)?;
        startup::notify_loaded()?;
        diagnostics.record("loaded", None);
        let engine = Arc::new(engine);
        let linker = preparation_validation::component_linker(&engine)?;
        let state = State {
            wasi: WasiCtx::builder().build(), // No inherited env, stdio, directories or network.
            table: ResourceTable::new(),
            limits: StoreLimitsBuilder::new()
                .memory_size(options.resources.memory_bytes())
                .instances(64)
                .tables(64)
                .memories(16)
                .table_elements(100_000)
                .trap_on_grow_failure(true)
                .build(),
            events,
            call: 0,
        };
        let mut store = Store::new(&engine, state);
        store.limiter(|state| &mut state.limits);
        store.set_fuel(options.resources.startup_fuel())?;
        // Yield less often for compute workloads; fuel totals and host deadlines
        // remain unchanged. Standard interactive modules retain the short interval.
        store.fuel_async_yield_interval(Some(match options.resources {
            startup::ResourceProfile::Standard => 10_000,
            startup::ResourceProfile::Compute => 100_000,
        }))?;
        let module = match profile {
            "async" => Module::Async(
                bindings::Module::instantiate_async(&mut store, &component, &linker).await?,
            ),
            "sync" => Module::Sync(
                sync_bindings::ModuleSync::instantiate_async(&mut store, &component, &linker)
                    .await?,
            ),
            _ => unreachable!(),
        };
        diagnostics.record("instantiated", None);
        Ok(Self {
            store,
            module,
            _engine: engine,
            diagnostics,
            fuel_per_call: options.resources.call_fuel(),
            startup_fuel: options.resources.startup_fuel(),
        })
    }

    pub async fn call(
        &mut self,
        id: u64,
        method: &str,
        command: &str,
        input: &str,
    ) -> wasmtime::Result<serde_json::Value> {
        self.store.data_mut().call = id;
        self.store.set_fuel(if method == "activate" {
            self.startup_fuel
        } else {
            self.fuel_per_call
        })?;
        let result = self.call_inner(method, command, input).await;
        if method == "activate" {
            self.diagnostics.record("activated", None);
        }
        result
    }

    async fn call_inner(
        &mut self,
        method: &str,
        command: &str,
        input: &str,
    ) -> wasmtime::Result<serde_json::Value> {
        let module = match &self.module {
            Module::Sync(module) => {
                let lifecycle = module.maghemite_modules_sync_lifecycle();
                return match method {
                    "activate" => Ok(serde_json::json!(
                        lifecycle
                            .call_activate(&mut self.store)
                            .await?
                            .map_err(wasmtime::Error::msg)?
                    )),
                    "execute" => {
                        let output = lifecycle
                            .call_execute(&mut self.store, command, input)
                            .await?
                            .map_err(wasmtime::Error::msg)?;
                        Ok(serde_json::from_str(&output)?)
                    }
                    "deactivate" => {
                        lifecycle
                            .call_deactivate(&mut self.store)
                            .await?
                            .map_err(wasmtime::Error::msg)?;
                        Ok(serde_json::Value::Null)
                    }
                    _ => wasmtime::error::bail!("Unknown lifecycle operation"),
                };
            }
            Module::Async(module) => module,
        };
        let lifecycle = module.maghemite_modules_lifecycle();
        let value = self
            .store
            .run_concurrent(async |accessor| -> wasmtime::Result<serde_json::Value> {
                match method {
                    "activate" => {
                        let commands = lifecycle
                            .call_activate(accessor)
                            .await?
                            .map_err(wasmtime::Error::msg)?;
                        Ok(serde_json::json!(commands))
                    }
                    "execute" => {
                        let output = lifecycle
                            .call_execute(accessor, command.to_owned(), input.to_owned())
                            .await?
                            .map_err(wasmtime::Error::msg)?;
                        Ok(serde_json::from_str(&output)?)
                    }
                    "deactivate" => {
                        lifecycle
                            .call_deactivate(accessor)
                            .await?
                            .map_err(wasmtime::Error::msg)?;
                        Ok(serde_json::Value::Null)
                    }
                    _ => wasmtime::error::bail!("Unknown lifecycle operation"),
                }
            })
            .await??;
        Ok(value)
    }
}
