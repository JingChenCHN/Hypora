// Hypora — Tauri 内核入口（§4 D1 唯一运行时：Rust 内核 + 系统 WebView）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hypora_lib::run()
}
