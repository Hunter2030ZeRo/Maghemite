//! Shared linker and generated binding checks; no store or instance is created.
use crate::{State, aot::Abi, bindings, sync_bindings};
use wasmtime::component::{Component, Linker};
use wasmtime::{Engine, Result};

pub(crate) fn component_linker(engine: &Engine) -> Result<Linker<State>> {
    let mut linker = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
    wasmtime_wasi::p3::add_to_linker(&mut linker)?;
    bindings::Module::add_to_linker::<State, wasmtime::component::HasSelf<_>>(
        &mut linker,
        |state| state,
    )?;
    sync_bindings::ModuleSync::add_to_linker::<State, wasmtime::component::HasSelf<_>>(
        &mut linker,
        |state| state,
    )?;
    Ok(linker)
}

/// Resolves every import and checks lifecycle export types without instantiation.
pub fn validate_component_abi(component: &Component, abi: Abi) -> Result<()> {
    let pre = component_linker(component.engine())?.instantiate_pre(component)?;
    match abi {
        Abi::ComponentAsync => {
            bindings::ModulePre::new(pre)?;
        }
        Abi::ComponentSync => {
            sync_bindings::ModuleSyncPre::new(pre)?;
        }
        Abi::WasiP1Blocking | Abi::WasiP1Cooperative => {
            wasmtime::error::bail!("Expected component ABI");
        }
    }
    Ok(())
}
