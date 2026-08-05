// ───────────────────────────────────────────────────────────────
// 本地 LLM sidecar 管理（§4 D4 / §5.1 sidecar_*）
// llama-server 作为受控 sidecar：内核负责拉起/端口协商/健康检查/随应用退出；
// 渲染层仅面向 127.0.0.1 契约。仅 bind 127.0.0.1，随机端口，无孤儿进程。
// ───────────────────────────────────────────────────────────────
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::AppHandle;

use crate::{app_data_dir, AppState};

pub struct SidecarProcess {
    pub child: Child,
    pub port: u16,
    pub model: String,
    pub running: Arc<AtomicBool>,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub running: bool,
    pub model: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

impl SidecarProcess {
    fn status(&self) -> SidecarStatus {
        SidecarStatus {
            running: self.running.load(Ordering::Relaxed),
            model: Some(self.model.clone()),
            port: Some(self.port),
            pid: Some(self.child.id()),
        }
    }
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn resolve_llama_binary() -> Result<String, String> {
    if let Ok(p) = std::env::var("HYPORA_LLAMA_PATH") {
        if !p.is_empty() && Path::new(&p).exists() {
            return Ok(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join("llama-server");
            if cand.exists() {
                return Ok(cand.display().to_string());
            }
        }
    }
    Err("未找到本地引擎：请设置环境变量 HYPORA_LLAMA_PATH 指向 llama-server 可执行文件，或将 llama-server 加入 PATH。".into())
}

fn resolve_model(app: &AppHandle, model: &str) -> Result<String, String> {
    if Path::new(model).exists() {
        return Ok(model.into());
    }
    let dir = app_data_dir(app).join("models");
    for cand in [dir.join(format!("{model}.gguf")), dir.join(model)] {
        if cand.exists() {
            return Ok(cand.display().to_string());
        }
    }
    Err(format!(
        "未找到模型 {model}：请将 .gguf 文件放入 {} 目录，或提供绝对路径。",
        app_data_dir(app).join("models").display()
    ))
}

pub async fn start(app: AppHandle, model: Option<String>) -> Result<SidecarStatus, String> {
    let model_name = model.unwrap_or_else(|| "llama-3.2-1b-instruct".into());

    // 已运行则直接返回状态
    {
        let guard = app.state::<AppState>().sidecar.lock().unwrap();
        if let Some(sp) = guard.as_ref() {
            if sp.running.load(Ordering::Relaxed) {
                return Ok(sp.status());
            }
        }
    }

    let binary = resolve_llama_binary()?;
    let model_path = resolve_model(&app, &model_name)?;
    let port = free_port()?;

    let log_dir = app_data_dir(&app).join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let out = std::fs::File::create(log_dir.join("llama-server.log")).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;

    let child = std::process::Command::new(&binary)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--model")
        .arg(&model_path)
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("启动 llama-server 失败：{}", e))?;

    {
        let mut guard = app.state::<AppState>().sidecar.lock().unwrap();
        if let Some(prev) = guard.take() {
            let _ = prev.child.kill();
        }
        *guard = Some(SidecarProcess {
            child,
            port,
            model: model_name.clone(),
            running: Arc::new(AtomicBool::new(true)),
        });
    }

    // 健康检查（§4 D4：就绪探针，端口由内核协商）
    let health_url = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::new();
    for _ in 0..30 {
        let ok = client
            .get(&health_url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if ok {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    status(&app)
}

pub fn stop(app: AppHandle) -> Result<(), String> {
    let mut guard = app.state::<AppState>().sidecar.lock().unwrap();
    if let Some(mut sp) = guard.take() {
        sp.running.store(false, Ordering::Relaxed);
        let _ = sp.child.kill();
        let _ = sp.child.wait();
    }
    Ok(())
}

pub fn status(app: &AppHandle) -> Result<SidecarStatus, String> {
    let guard = app.state::<AppState>().sidecar.lock().unwrap();
    Ok(match guard.as_ref() {
        Some(sp) if sp.running.load(Ordering::Relaxed) => sp.status(),
        _ => SidecarStatus::default(),
    })
}

/// 随主进程退出终止（§4 D4 无孤儿进程）
pub fn kill_all(app: &AppHandle) {
    let mut guard = app.state::<AppState>().sidecar.lock().unwrap();
    if let Some(mut sp) = guard.take() {
        let _ = sp.child.kill();
    }
}
