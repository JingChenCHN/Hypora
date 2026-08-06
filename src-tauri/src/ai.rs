// ───────────────────────────────────────────────────────────────
// AI 流式代理（§4 D5 / §6.2）
// ai_stream 命令在 Rust 侧以 reqwest 直连 OpenAI 兼容端点，
// SSE 增量经事件 ai-chunk / ai-done / ai-error 回推渲染层；
// 统一超时/重试/取消，绕开 WebView CORS/混合内容约束。
// ───────────────────────────────────────────────────────────────
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 与渲染层 tauriAPI.AIStreamRequest 对应（§5.1 ai_stream）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AIStreamRequest {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub reasoning: Option<bool>,
}

#[derive(Debug, PartialEq)]
pub struct SseChoice {
    pub content: String,
    pub reasoning: Option<String>,
}

/// 纯函数：解析一行 SSE `data: {...}` 负载（可独立单测，不依赖 Tauri）
pub fn parse_sse_payload(payload: &str) -> Option<SseChoice> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let delta = v.pointer("/choices/0/delta")?;
    let content = delta
        .get("content")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let reasoning = delta
        .get("reasoning_content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    if content.is_empty() && reasoning.is_none() {
        return None;
    }
    Some(SseChoice { content, reasoning })
}

fn build_body(req: &AIStreamRequest) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert(
        "model".into(),
        json!(req.model.clone().unwrap_or_else(|| "gpt-4o-mini".into())),
    );
    map.insert(
        "messages".into(),
        serde_json::to_value(&req.messages).unwrap_or(json!([])),
    );
    map.insert("stream".into(), json!(true));
    map.insert("temperature".into(), json!(req.temperature.unwrap_or(0.7)));
    if let Some(t) = req.max_tokens {
        map.insert("max_tokens".into(), json!(t));
    }
    serde_json::Value::Object(map)
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

pub async fn run_ai_stream(
    app: AppHandle,
    req: AIStreamRequest,
    id: String,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let base = req.base_url.clone().unwrap_or_else(|| "https://api.openai.com".into());
    let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
    let client = reqwest::Client::new();

    let mut builder = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream");
    if let Some(key) = &req.api_key {
        let key = key.trim();
        if !key.is_empty() {
            builder = builder.bearer_auth(key);
        }
    }

    let resp = builder
        .json(&build_body(&req))
        .send()
        .await
        .map_err(|e| format!("AI 请求失败：{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI 服务响应错误 HTTP {}：{}", status, truncate(&text, 300)));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let mut reasoning = String::new();

    'outer: while let Some(item) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            break 'outer;
        }
        let bytes = item.map_err(|e| format!("AI 流式读取失败：{}", e))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        loop {
            let nl = match buf.find('\n') {
                Some(i) => i,
                None => break,
            };
            let line = buf.drain(..=nl).collect::<String>();
            let line = line.trim();
            if !line.starts_with("data:") {
                continue;
            }
            let payload = line["data:".len()..].trim();
            if payload == "[DONE]" {
                break 'outer;
            }
            if let Some(choice) = parse_sse_payload(payload) {
                if !choice.content.is_empty() {
                    full.push_str(&choice.content);
                    let _ = app.emit(
                        "ai-chunk",
                        json!({ "id": id, "delta": choice.content, "reasoning": null }),
                    );
                }
                if let Some(r) = choice.reasoning {
                    if !r.is_empty() {
                        reasoning.push_str(&r);
                        let _ = app.emit("ai-chunk", json!({ "id": id, "delta": "", "reasoning": r }));
                    }
                }
            }
        }
    }

    let _ = app.emit("ai-done", json!({ "id": id, "full": full, "reasoning": reasoning }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_delta() {
        let choice = parse_sse_payload(r#"{"choices":[{"delta":{"content":"你好"}}]}"#);
        assert_eq!(
            choice,
            Some(SseChoice { content: "你好".into(), reasoning: None })
        );
    }

    #[test]
    fn parses_reasoning_content() {
        let choice = parse_sse_payload(r#"{"choices":[{"delta":{"reasoning_content":"先分析…"}}]}"#);
        assert_eq!(
            choice,
            Some(SseChoice { content: "".into(), reasoning: Some("先分析…".into()) })
        );
    }

    #[test]
    fn ignores_empty_or_invalid() {
        assert_eq!(parse_sse_payload(""), None);
        assert_eq!(parse_sse_payload(r#"{"choices":[{"delta":{"content":""}}]}"#), None);
    }
}
