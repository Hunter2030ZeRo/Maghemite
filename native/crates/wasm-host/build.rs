fn main() -> Result<(), std::env::VarError> {
    println!(
        "cargo:rustc-env=MAGHEMITE_AOT_TARGET={}",
        std::env::var("TARGET")?
    );
    Ok(())
}
