//! Stemmeisolering: with the "deepfilter" feature the DeepFilterNet 3 model files are put into
//! the DLL from DF_MODEL_DIR (the folder with enc.onnx, erb_dec.onnx, df_dec.onnx and config.ini
//! from DeepFilterNet3_onnx.tar.gz; CI downloads it and checks its SHA-256). The model's settings
//! are compiled into deepfilter.rs, so they are checked here against its config.ini.
use std::path::PathBuf;

const EXPECTED: [(&str, &str); 10] = [
    ("sr", "48000"),
    ("fft_size", "960"),
    ("hop_size", "480"),
    ("nb_erb", "32"),
    ("nb_df", "96"),
    ("df_order", "5"),
    ("df_lookahead", "2"),
    ("min_nb_erb_freqs", "2"),
    ("norm_tau", "1"),
    ("conv_ch", "64"),
];

fn main() {
    println!("cargo:rerun-if-env-changed=DF_MODEL_DIR");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("CARGO_FEATURE_DEEPFILTER").is_none() {
        return;
    }
    let dir = PathBuf::from(std::env::var("DF_MODEL_DIR").expect("the deepfilter feature needs DF_MODEL_DIR (the unpacked DeepFilterNet3_onnx.tar.gz)"));
    let dir = dir.canonicalize().expect("DF_MODEL_DIR does not exist");
    for f in ["enc.onnx", "erb_dec.onnx", "df_dec.onnx", "config.ini"] {
        let p = dir.join(f);
        assert!(p.is_file(), "{} is missing", p.display());
        println!("cargo:rerun-if-changed={}", p.display());
    }
    let ini = std::fs::read_to_string(dir.join("config.ini")).expect("config.ini");
    assert!(ini.lines().any(|l| l.replace(' ', "") == "model=deepfilternet3"), "not a DeepFilterNet 3 model");
    assert!(ini.lines().any(|l| l.replace(' ', "") == "conv_lookahead=2"), "conv_lookahead must be 2");
    for (key, want) in EXPECTED {
        let found = ini.lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            (k.trim() == key).then(|| v.trim().to_string())
        });
        assert_eq!(found.as_deref(), Some(want), "config.ini: {key}");
    }
    println!("cargo:rustc-env=DF_MODEL_DIR={}", dir.display());
}
