// ───────────────────────────────────────────────────────────────
// Hypora Rust 内核（§1 内核最小信任面 / §5 进程契约 / §8 安全模型）
// 唯一跨边界通道：命令（invoke，Result）与事件（emit/listen）。
// 渲染层零 Node；外部 IO 全经内核；write_file 路径校验。
// ───────────────────────────────────────────────────────────────
mod ai;
mod sidecar;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

// ───────────── 应用状态（§5.3 长任务取消通道） ─────────────
#[derive(Default)]
pub struct AppState {
    /// AI 流式任务取消令牌（ai_cancel ↔ ai_stream）
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 本地 LLM sidecar 进程（§4 D4）
    pub sidecar: Mutex<Option<sidecar::SidecarProcess>>,
}

// ───────────── 契约类型（§5.1） ─────────────
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileResult {
    pub path: String,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub providers: Vec<String>,
    pub cloud_configured: bool,
    pub local_running: bool,
    pub local_model: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub tauri: bool,
    pub dev_mode: bool,
    pub ai: AiStatus,
}

pub(crate) fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn log_dir(app: &AppHandle) -> PathBuf {
    let dir = app_data_dir(app).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ───────────── 文件域（§5.1） ─────────────
fn validate_write_path(p: &Path) -> Result<(), String> {
    // §8 能力白名单：禁越权写系统目录
    let s = p.to_string_lossy().to_lowercase();
    let forbidden = ["/etc/", "/usr/", "/boot/", "/proc/", "/sys/", "/dev/", "/var/", "c:\\windows", "/bin/", "/sbin/", "/lib/"];
    if forbidden.iter().any(|f| s.starts_with(f)) {
        return Err(format!("路径被安全策略拒绝：{}", p.display()));
    }
    Ok(())
}

fn write_file_content(p: &Path, content: &str) -> Result<(), String> {
    validate_write_path(p)?;
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
        }
    }
    std::fs::write(p, content).map_err(|e| format!("写入失败：{}", e))
}

#[tauri::command]
async fn open_file_dialog(app: AppHandle, filter: Option<Vec<FileFilter>>) -> Result<Option<OpenFileResult>, String> {
    let mut builder = app.dialog().file();
    for f in filter.unwrap_or_default() {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(f.name, &exts);
    }
    match builder.pick_file().await.map_err(|e| e.to_string())? {
        Some(tauri_plugin_dialog::FilePath::Path(p)) => {
            let content = std::fs::read_to_string(&p).map_err(|e| format!("读取失败：{}", e))?;
            Ok(Some(OpenFileResult { path: p.display().to_string(), content }))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
async fn save_dialog(app: AppHandle, default_name: String, content: String) -> Result<Option<String>, String> {
    let builder = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .set_file_name(&default_name);
    match builder.save_file().await.map_err(|e| e.to_string())? {
        Some(tauri_plugin_dialog::FilePath::Path(p)) => {
            write_file_content(&p, &content)?;
            Ok(Some(p.display().to_string()))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("无法读取文件：{}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    write_file_content(Path::new(&path), &content)
}

#[tauri::command]
fn write_binary_file(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入失败：{}", e))
}

// ───────────── 外壳域（§5.1） ─────────────
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.shell().open(&url, None).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<AppStatus, String> {
    let sidecar_guard = app.state::<AppState>().sidecar.lock().unwrap();
    let local = sidecar_guard.as_ref();
    Ok(AppStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        tauri: true,
        dev_mode: cfg!(debug_assertions),
        ai: AiStatus {
            providers: vec![
                "deepseek".into(),
                "openai".into(),
                "zhipu".into(),
                "custom".into(),
                "local".into(),
            ],
            cloud_configured: true,
            local_running: local.map(|s| s.running.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(false),
            local_model: local.map(|s| s.model.clone()),
        },
    })
}

#[tauri::command]
fn dev_log(level: String, message: String, data: Option<String>) -> Result<(), String> {
    let line = match data {
        Some(d) if !d.is_empty() => format!("[{}] {} {}", level, message, d),
        _ => format!("[{}] {}", level, message),
    };
    match level.as_str() {
        "error" => log::error!("{}", line),
        "warn" => log::warn!("{}", line),
        "debug" => log::debug!("{}", line),
        _ => log::info!("{}", line),
    }
    Ok(())
}

#[tauri::command]
fn export_diagnostics(app: AppHandle) -> Result<Option<String>, String> {
    let version = env!("CARGO_PKG_VERSION");
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let log = std::fs::read_to_string(log_dir(&app).join(format!("hypora-{}.log", Local::now().format("%Y-%m-%d"))))
        .unwrap_or_default();
    let tail: Vec<&str> = log.lines().rev().take(60).collect::<Vec<_>>();
    let mut report = String::new();
    report.push_str(&format!("# Hypora 诊断报告\n\n## 应用\n- **版本**: {version}\n- **平台**: {os}/{arch}\n- **桌面**: Tauri\n\n## 最近日志\n"));
    if tail.is_empty() {
        report.push_str("_（无日志）_\n");
    }
    for l in tail.iter().rev() {
        report.push_str(&format!("- `{l}`\n"));
    }
    let path = app_data_dir(&app).join("hypora-diagnostics.md");
    std::fs::write(&path, &report).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
fn show_log_file(app: AppHandle) -> Result<(), String> {
    let path = log_dir(&app).join(format!("hypora-{}.log", Local::now().format("%Y-%m-%d")));
    if path.exists() {
        app.shell()
            .open(path.to_string_lossy().to_string(), None)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ───────────── 启动域（§6.3 打开管线） ─────────────
#[tauri::command]
fn get_argv_md() -> Result<Option<String>, String> {
    let args: Vec<String> = std::env::args().collect();
    Ok(args
        .iter()
        .skip(1)
        .find(|a| a.ends_with(".md") || a.ends_with(".markdown") || a.ends_with(".txt"))
        .cloned())
}

// ───────────── 生命周期域（§10 零丢失） ─────────────
#[tauri::command]
fn save_before_close(window: Window) -> Result<(), String> {
    // 渲染层已 flush 落盘，这里真正关闭窗口
    window.destroy().map_err(|e| e.to_string())
}

// ───────────── 窗口域（§4 D7 frameless + 自绘装饰） ─────────────
#[tauri::command]
fn win_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_maximize(window: Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    let m = window.is_maximized().unwrap_or(false);
    let _ = window.emit("win-maximized", m);
    Ok(())
}

#[tauri::command]
fn win_close(window: Window) -> Result<(), String> {
    // 触发 CloseRequested → before-close 落盘流
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_is_maximized(window: Window) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_always_on_top(window: Window) -> Result<bool, String> {
    let next = !window.is_always_on_top().unwrap_or(false);
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    let _ = window.emit("win-always-on-top", next);
    Ok(next)
}

#[tauri::command]
fn win_is_always_on_top(window: Window) -> Result<bool, String> {
    window.is_always_on_top().map_err(|e| e.to_string())
}

// ───────────── AI / sidecar 域（§5.1，实现在 ai.rs / sidecar.rs） ─────────────
#[tauri::command]
fn ai_stream(app: AppHandle, req: ai::AIStreamRequest, id: String) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AppState>()
        .cancels
        .lock()
        .unwrap()
        .insert(id.clone(), cancel.clone());
    let app2 = app.clone();
    let id2 = id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ai::run_ai_stream(app2.clone(), req, id2.clone(), cancel.clone()).await {
            let _ = app2.emit("ai-error", json!({ "id": id2, "message": e }));
        }
        app2.state::<AppState>().cancels.lock().unwrap().remove(&id2);
    });
    Ok(())
}

#[tauri::command]
fn ai_cancel(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(cancel) = app.state::<AppState>().cancels.lock().unwrap().get(&id) {
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn sidecar_start(app: AppHandle, model: Option<String>) -> Result<sidecar::SidecarStatus, String> {
    sidecar::start(app, model).await
}

#[tauri::command]
async fn sidecar_stop(app: AppHandle) -> Result<(), String> {
    sidecar::stop(app)
}

#[tauri::command]
async fn sidecar_status(app: AppHandle) -> Result<sidecar::SidecarStatus, String> {
    sidecar::status(&app)
}

// ───────────── Builder 组装 ─────────────
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 二次启动：聚焦主窗口 + 转发 .md 打开事件（§6.3）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            if let Some(md) = args
                .iter()
                .skip(1)
                .find(|a| a.ends_with(".md") || a.ends_with(".markdown"))
            {
                if let Ok(content) = std::fs::read_to_string(md) {
                    let _ = app.emit("open-file", json!({ "path": md, "content": content }));
                }
            }
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            // 文件
            open_file_dialog,
            save_dialog,
            read_file,
            write_file,
            write_binary_file,
            // 外壳
            open_external,
            get_status,
            dev_log,
            export_diagnostics,
            show_log_file,
            // 启动 / 生命周期
            get_argv_md,
            save_before_close,
            // 窗口
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_is_maximized,
            win_toggle_always_on_top,
            win_is_always_on_top,
            // AI / sidecar
            ai_stream,
            ai_cancel,
            sidecar_start,
            sidecar_stop,
            sidecar_status,
        ])
        .setup(|app| {
            // 日志初始化（§7 日志 data_dir/logs 按日）
            let dir = log_dir(app.handle());
            let log_file = dir.join(format!("hypora-{}.log", Local::now().format("%Y-%m-%d")));
            let config = simplelog::ConfigBuilder::new()
                .set_time_format_str("%H:%M:%S")
                .build();
            let _ = simplelog::WriteLogger::init(
                log::LevelFilter::Info,
                config,
                std::fs::File::create(&log_file).map_err(|e| format!("创建日志失败：{}", e))?,
            );
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // §5.2 before-close：关闭前触发渲染层落盘（防抖 + 超时兜底）
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.emit("before-close", ());
                let win = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    let _ = win.destroy();
                });
            }
            // §5.2 win-maximized：状态同步 UI
            WindowEvent::Resized(_) | WindowEvent::Maximized(_) => {
                let m = window.is_maximized().unwrap_or(false);
                let _ = window.emit("win-maximized", m);
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building Hypora")
        .run(|app, event| {
            // 随主进程退出终止 sidecar（§4 D4 生命周期受控，无孤儿进程）
            if let tauri::RunEvent::Exit = event {
                sidecar::kill_all(app);
            }
        });
}
