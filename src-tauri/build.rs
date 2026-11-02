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
    // Signed updates (update.rs): the public key CI derives from its secret signing key.
    println!("cargo:rerun-if-env-changed=UPDATE_PUBKEY");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());

    if let Ok(dir) = std::env::var("ENGINE_DIR") {
        let dir = PathBuf::from(dir);
        let files = ["EqualizerAPO.dll", "fftw3f.dll", "sndfile.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
        if files.iter().all(|f| dir.join(f).is_file()) {
            let mut code = String::from("pub static ENGINE_FILES: &[(&str, &[u8])] = &[\n");
            // Optional: the noise-suppression VST plugin for the chat (only when CI fetched it).
            // … and GoXLR Studio's own limiter/compressor plugin (plugins/dynamics).
            let optional = ["rnnoise_stereo.dll", "goxlr_studio_dynamics.dll"];
            for f in files.iter().chain(optional.iter().filter(|f| dir.join(f).is_file())) {
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

    // The Stream Deck / StreamDock plugin (../streamdeck), so the app can install it for Streonor.
    let plugin = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..").join("streamdeck").join("com.goxlrstudio.sdPlugin");
    println!("cargo:rerun-if-changed={}", plugin.display());
    let mut files = Vec::new();
    collect(&plugin, &plugin, &mut files);
    files.sort();
    let mut code = String::from("pub static PLUGIN_FILES: &[(&str, &[u8])] = &[\n");
    for rel in &files {
        let abs = plugin.join(rel);
        println!("cargo:rerun-if-changed={}", abs.display());
        code.push_str(&format!("    ({:?}, include_bytes!({:?})),\n", rel.replace('\\', "/"), abs.display().to_string()));
    }
    code.push_str("];\n");
    std::fs::write(out.join("plugin_files.rs"), code).unwrap();

    tauri_build::build()
}

fn collect(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(root, &p, out);
        } else if let Ok(rel) = p.strip_prefix(root) {
            out.push(rel.display().to_string());
        }
    }
}
