use serde::{Deserialize, Serialize};
use std::hash::{DefaultHasher, Hash, Hasher};
use wasmtime::{Config, Engine, Strategy};

pub const WASMTIME_VERSION: &str = "49.0.1";
pub const RECIPE_VERSION: u32 = 1;
pub const TARGET: &str = env!("MAGHEMITE_AOT_TARGET");
pub const CPU_POLICY: &str = "host-native";

/// These tags bind runtime calling conventions, not just the serialized format.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Abi {
    #[serde(rename = "component-async-v1")]
    ComponentAsync,
    #[serde(rename = "component-sync-v1")]
    ComponentSync,
    #[serde(rename = "wasi-p1-blocking-v1")]
    WasiP1Blocking,
    #[serde(rename = "wasi-p1-cooperative-v1")]
    WasiP1Cooperative,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactFormat {
    Component,
    CoreModule,
}

impl Abi {
    pub const fn format(self) -> ArtifactFormat {
        match self {
            Self::ComponentAsync | Self::ComponentSync => ArtifactFormat::Component,
            Self::WasiP1Blocking | Self::WasiP1Cooperative => ArtifactFormat::CoreModule,
        }
    }
}

fn config(abi: Abi) -> Config {
    // No explicit cross-target triple: Wasmtime infers this host's ISA features.
    // Keep tool defaults distinct from the fuel/async component recipe.
    let mut config = Config::new();
    match abi {
        Abi::ComponentAsync | Abi::ComponentSync => {
            config.strategy(Strategy::Cranelift);
            config.wasm_component_model_async(true);
            config.consume_fuel(true);
        }
        Abi::WasiP1Blocking | Abi::WasiP1Cooperative => {}
    }
    config.cache(None);
    config
}

/// The producer factory. It never executes or instantiates guest code.
pub fn preparation_engine(abi: Abi) -> wasmtime::Result<Engine> {
    Engine::new(&config(abi))
}

/// The production execution factory. There is no source-compilation fallback.
pub fn load_engine(abi: Abi) -> wasmtime::Result<Engine> {
    let mut config = config(abi);
    // All compiler/target options precede this call: disabling drops that state.
    config.enable_compiler(false);
    Engine::new(&config)
}

/// Build-scoped producer metadata, never compared against a load-engine hash.
pub fn compilation_fingerprint(producer: &Engine) -> String {
    let mut hash = DefaultHasher::new();
    producer.precompile_compatibility_hash().hash(&mut hash);
    format!("{:016x}", hash.finish())
}
