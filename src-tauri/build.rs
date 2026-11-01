use std::path::PathBuf;

// Optional component embedded into the exe when CI provides it:
//   ENGINE_DIR       – Equalizer APO engine files (EqualizerAPO.dll and its runtime DLLs)
//   ENGINE_VERSION   – version string of those files
// Without it the app still builds; the EQ engine is then reported as unavailable.
// (The GoXLR engine is compiled in from goxlr-engine/, see Cargo.toml.)
fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_engine)");
    println!("cargo:rerun-if-env-changed=ENGINE_DIR");
    println!("cargo:rerun-if-env-changed=ENGINE_VERSION");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    if let Ok(dir) = std::env::var("ENGINE_DIR") {
        let dir = PathBuf::from(dir);
        let files = ["EqualizerAPO.dll", "fftw3f.dll", "sndfile.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
        if files.iter().all(|f| dir.join(f).is_file()) {
            let mut code = String::from("pub static ENGINE_FILES: &[(&str, &[u8])] = &[\n");
            for f in files {
                let p = dir.join(f);
                println!("cargo:rerun-if-changed={}", p.display());
                code.push_str(&format!("    ({f:?}, include_bytes!({:?})),\n", p.display().to_string()));
            }
            code.push_str("];\n");
            std::fs::write(out.join("engine_files.rs"), code).unwrap();
            println!("cargo:rustc-cfg=bundled_engine");
            println!("cargo:rustc-env=ENGINE_VERSION={}", std::env::var("ENGINE_VERSION").unwrap_or_else(|_| "?".into()));
        } else {
            println!("cargo:warning=ENGINE_DIR is missing engine files; building without the EQ engine");
        }
    }

    tauri_build::build()
}
