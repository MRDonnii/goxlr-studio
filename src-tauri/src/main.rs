#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated helper for the built-in EQ engine: runs one task and exits without any UI.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = goxlr_studio_lib::helper_main(&args) {
        std::process::exit(code);
    }
    goxlr_studio_lib::run();
}
