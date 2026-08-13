use std::fs;
use std::path::PathBuf;
// Tauri 2 中 emit 在 Emitter trait 上（不再属于 Manager），缺少此导入会导致编译失败
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct OpenFileResult {
    title: String,
    content: String,
    file_path: String,
}

#[derive(Serialize, Deserialize)]
struct WriteResult {
    success: bool,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct DevStatus {
    app_version: String,
    is_dev: bool,
    log_file: String,
}

// 获取日志目录
fn log_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hypora.app")
        .join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn log_file_path() -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d");
    log_dir().join(format!("app-{}.log", date))
}

// 写日志
fn write_log(level: &str, source: &str, msg: &str) {
    let time = chrono::Local::now().to_rfc3339();
    let line = format!("[{}] [{}] [{}] {}\n", time, level, source, msg);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path())
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

// === Tauri 命令（对应前端 electronAPI）===

#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle) -> Result<Option<OpenFileResult>, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    match path {
        Some(p) => {
            let fp = p.into_path().map_err(|e| e.to_string())?;
            let content = fs::read_to_string(&fp).map_err(|e| e.to_string())?;
            let title = fp
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("document")
                .to_string();
            let file_path = fp.to_string_lossy().to_string();
            write_log("INFO", "main", &format!("打开文件: {}", file_path));
            Ok(Some(OpenFileResult { title, content, file_path }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn save_dialog(app: tauri::AppHandle, filename: String) -> Result<Option<String>, String> {
    let path = app
        .dialog()
        .file()
        .set_file_name(&filename)
        .add_filter("Markdown", &["md"])
        .blocking_save_file();
    match path {
        Some(p) => Ok(Some(p.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
fn write_file(file_path: String, content: String) -> WriteResult {
    match fs::write(&file_path, content) {
        Ok(_) => WriteResult { success: true, error: None },
        Err(e) => WriteResult { success: false, error: Some(e.to_string()) },
    }
}

#[tauri::command]
fn write_binary_file(file_path: String, base64: String) -> WriteResult {
    use base64::{Engine, engine::general_purpose};
    match general_purpose::STANDARD.decode(&base64) {
        Ok(data) => match fs::write(&file_path, data) {
            Ok(_) => WriteResult { success: true, error: None },
            Err(e) => WriteResult { success: false, error: Some(e.to_string()) },
        },
        Err(e) => WriteResult { success: false, error: Some(e.to_string()) },
    }
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) {
    let _ = app.shell().open(url, None);
}

#[tauri::command]
fn get_status() -> DevStatus {
    DevStatus {
        app_version: "1.0.0".to_string(),
        is_dev: cfg!(debug_assertions),
        log_file: log_file_path().to_string_lossy().to_string(),
    }
}

#[tauri::command]
fn dev_log(level: String, message: String) {
    write_log(&level, "renderer", &message);
}

#[tauri::command]
async fn export_diagnostics(window: WebviewWindow) -> Result<Option<String>, String> {
    let logs = fs::read_to_string(log_file_path()).unwrap_or_default();
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let report = format!(
        "# Hypora 诊断报告\n\n> 生成时间: {}\n\n## 运行环境\n- 应用: Hypora 1.0.0\n- Tauri 版本: 2.x\n- 日志文件: {}\n\n## 最近日志\n```\n{}\n```\n",
        now,
        log_file_path().to_string_lossy(),
        logs.lines().rev().take(500).collect::<Vec<_>>().iter().rev().collect::<Vec<_>>().join("\n")
    );
    let path = window
        .app_handle()
        .dialog()
        .file()
        .set_file_name("Hypora-诊断报告.md")
        .blocking_save_file();
    match path {
        Some(p) => {
            let fp = p.into_path().map_err(|e| e.to_string())?;
            fs::write(&fp, report).map_err(|e| e.to_string())?;
            Ok(Some(fp.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn show_log_file() {
    let p = log_file_path();
    if p.exists() {
        let _ = open::that(p);
    }
}

#[tauri::command]
fn get_argv_md() -> Option<String> {
    // 从命令行参数提取 .md 文件路径（双击文件打开）
    std::env::args()
        .skip(1)
        .find(|a| a.ends_with(".md") || a.ends_with(".markdown"))
}

// 前端调用：保存前 flush（Tauri 直接在前端 flush，此命令仅触发文件写入）
#[tauri::command]
async fn save_before_close(file_path: String, content: String) -> WriteResult {
    write_file(file_path, content)
}

// === 窗口置顶（always-on-top，对应前端 electronAPI.winToggleAlwaysOnTop）===

#[tauri::command]
fn toggle_always_on_top(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_always_on_top().map_err(|e| e.to_string())?;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    // 通知前端同步按钮高亮状态（快捷键与按钮两个入口共用）
    let _ = window.emit("always-on-top-changed", next);
    write_log("INFO", "main", &format!("窗口置顶: {}", next));
    Ok(next)
}

#[tauri::command]
fn is_always_on_top(window: WebviewWindow) -> Result<bool, String> {
    window.is_always_on_top().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_title("Hypora - Markdown编辑器");
            write_log("INFO", "main", "Hypora 启动");
            // 检查命令行 .md 文件（双击文件打开），emit open-file 事件
            if let Some(md_path) = std::env::args().skip(1).find(|a| a.ends_with(".md") || a.ends_with(".markdown")) {
                if let Ok(content) = fs::read_to_string(&md_path) {
                    let title = PathBuf::from(&md_path)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("document")
                        .to_string();
                    let _ = app.emit("open-file", serde_json::json!({
                        "title": title,
                        "content": content,
                        "filePath": md_path
                    }));
                    write_log("INFO", "main", &format!("通过参数打开文件: {}", md_path));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 通知前端保存（前端会调 save_before_close）
                let _ = window.emit("before-close", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            save_dialog,
            write_file,
            write_binary_file,
            open_external,
            get_status,
            dev_log,
            export_diagnostics,
            show_log_file,
            get_argv_md,
            save_before_close,
            toggle_always_on_top,
            is_always_on_top,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}