use std::path::{Path, PathBuf};

// Optional components embedded into the exe when CI provides them:
//   ENGINE_DIR       – Equalizer APO engine files (EqualizerAPO.dll and its runtime DLLs)
//   ENGINE_VERSION   – version string of those files
//   GOXLR_DAEMON_EXE – goxlr-daemon.exe built from GoXLR Utility
// Without them the app still builds; the built-in engine/daemon are then reported as unavailable.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(bundled_engine)");
    println!("cargo::rustc-check-cfg=cfg(bundled_daemon)");
    println!("cargo:rerun-if-env-changed=ENGINE_DIR");
    println!("cargo:rerun-if-env-changed=ENGINE_VERSION");
    println!("cargo:rerun-if-env-changed=GOXLR_DAEMON_EXE");
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

    if let Ok(exe) = std::env::var("GOXLR_DAEMON_EXE") {
        if Path::new(&exe).is_file() {
            println!("cargo:rerun-if-changed={exe}");
            println!("cargo:rustc-cfg=bundled_daemon");
            println!("cargo:rustc-env=GOXLR_DAEMON_PATH={exe}");
        } else {
            println!("cargo:warning=GOXLR_DAEMON_EXE not found; building without the GoXLR daemon");
        }
    }

    tauri_build::build()
}
