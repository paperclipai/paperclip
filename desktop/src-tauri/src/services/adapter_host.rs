use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::events;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdapterExecution {
    pub run_id: String,
    pub agent_id: String,
    pub company_id: String,
    pub adapter_type: String,
    pub adapter_config: serde_json::Value,
    pub prompt: String,
    pub cwd: String,
    pub timeout_sec: u64,
    pub session_id: Option<String>,
    pub instructions_path: Option<String>,
    pub skills_dir: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AdapterResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub session_id: Option<String>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_input_tokens: i64,
    pub cost_usd: f64,
    pub model: String,
}

fn build_command(exec: &AdapterExecution) -> (String, Vec<String>, Option<String>) {
    let config = &exec.adapter_config;
    match exec.adapter_type.as_str() {
        "claude_local" => {
            let mut args = vec![
                "--print".to_string(),
                "-".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
            ];
            if let Some(model) = config.get("model").and_then(|v| v.as_str()) {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            if let Some(turns) = config.get("maxTurnsPerRun").and_then(|v| v.as_i64()) {
                args.extend(["--max-turns".to_string(), turns.to_string()]);
            }
            if let Some(session) = &exec.session_id {
                args.extend(["--resume".to_string(), session.clone()]);
            }
            if config
                .get("dangerouslySkipPermissions")
                .and_then(|v| v.as_bool())
                .unwrap_or(true)
            {
                args.push("--dangerously-skip-permissions".to_string());
            }
            // Append instructions file for fresh sessions only
            if let Some(ref path) = exec.instructions_path {
                if exec.session_id.is_none() {
                    args.extend(["--append-system-prompt-file".to_string(), path.clone()]);
                }
            }
            // Add skills directory
            if let Some(ref path) = exec.skills_dir {
                args.extend(["--add-dir".to_string(), path.clone()]);
            }
            let cmd = config
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("claude")
                .to_string();
            (cmd, args, Some(exec.prompt.clone()))
        }
        "codex_local" => {
            let mut args = vec![];
            if let Some(model) = config.get("model").and_then(|v| v.as_str()) {
                args.extend(["--model".to_string(), model.to_string()]);
            }
            args.push(exec.prompt.clone());
            ("codex".to_string(), args, None)
        }
        "gemini_local" => ("gemini".to_string(), vec![exec.prompt.clone()], None),
        "cursor_local" => ("cursor".to_string(), vec![exec.prompt.clone()], None),
        "opencode_local" => ("opencode".to_string(), vec![exec.prompt.clone()], None),
        "ollama_local" => {
            let model = config.get("model").and_then(|v| v.as_str()).unwrap_or("gemma4:e4b");
            let args = vec!["run".to_string(), model.to_string(), exec.prompt.clone()];
            ("ollama".to_string(), args, None)
        }
        "process" => {
            let cmd = config
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("echo")
                .to_string();
            let args: Vec<String> = config
                .get("args")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            (cmd, args, Some(exec.prompt.clone()))
        }
        _ => (
            "echo".to_string(),
            vec!["Unknown adapter type".to_string()],
            None,
        ),
    }
}

fn build_env(
    exec: &AdapterExecution,
    secrets: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("PAPERCLIP_AGENT_ID".to_string(), exec.agent_id.clone());
    env.insert("PAPERCLIP_COMPANY_ID".to_string(), exec.company_id.clone());
    env.insert("PAPERCLIP_RUN_ID".to_string(), exec.run_id.clone());
    for (key, value) in secrets {
        env.insert(key.clone(), value.clone());
    }
    env
}

pub async fn execute(
    exec: AdapterExecution,
    app: tauri::AppHandle,
    secrets: HashMap<String, String>,
) -> Result<AdapterResult, String> {
    let (cmd, args, stdin_input) = build_command(&exec);
    let env = build_env(&exec, &secrets);

    // Check if CLI exists
    let which_result = tokio::process::Command::new("which")
        .arg(&cmd)
        .output()
        .await;
    if which_result
        .map(|o| !o.status.success())
        .unwrap_or(true)
    {
        return Err(format!(
            "CLI tool '{}' not found on PATH. Install it first.",
            cmd
        ));
    }

    let mut child = tokio::process::Command::new(&cmd)
        .args(&args)
        .current_dir(&exec.cwd)
        .envs(&env)
        .stdin(if stdin_input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", cmd, e))?;

    // Write stdin
    if let (Some(input), Some(mut stdin)) = (stdin_input, child.stdin.take()) {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    }

    // Stream stdout
    let run_id_stdout = exec.run_id.clone();
    let app_stdout = app.clone();
    let stdout = child.stdout.take().unwrap();
    let stdout_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        let mut full_output = String::new();
        while reader.read_line(&mut buf).await.unwrap_or(0) > 0 {
            full_output.push_str(&buf);
            events::emit(
                &app_stdout,
                events::AppEvent::AgentRunLog {
                    run_id: run_id_stdout.clone(),
                    stream: "stdout".to_string(),
                    chunk: buf.clone(),
                },
            );
            buf.clear();
        }
        full_output
    });

    // Stream stderr
    let run_id_stderr = exec.run_id.clone();
    let app_stderr = app.clone();
    let stderr = child.stderr.take().unwrap();
    let stderr_handle = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = String::new();
        let mut full_output = String::new();
        while reader.read_line(&mut buf).await.unwrap_or(0) > 0 {
            full_output.push_str(&buf);
            events::emit(
                &app_stderr,
                events::AppEvent::AgentRunLog {
                    run_id: run_id_stderr.clone(),
                    stream: "stderr".to_string(),
                    chunk: buf.clone(),
                },
            );
            buf.clear();
        }
        full_output
    });

    // Wait with timeout
    let timeout = Duration::from_secs(if exec.timeout_sec > 0 {
        exec.timeout_sec
    } else {
        300
    });
    let result = tokio::time::timeout(timeout, child.wait()).await;

    let (timed_out, exit_code, signal) = match result {
        Ok(Ok(status)) => (false, status.code().unwrap_or(-1), None),
        Ok(Err(e)) => return Err(format!("Process error: {}", e)),
        Err(_) => {
            let _ = child.kill().await;
            (true, -1, Some("SIGKILL".to_string()))
        }
    };

    let stdout_text = stdout_handle.await.unwrap_or_default();
    let stderr_text = stderr_handle.await.unwrap_or_default();

    Ok(AdapterResult {
        exit_code,
        stdout: stdout_text,
        stderr: stderr_text,
        signal,
        timed_out,
        session_id: None,
        usage: None,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptResult {
    pub session_id: Option<String>,
    pub model: String,
    pub cost_usd: Option<f64>,
    pub usage: Option<TokenUsage>,
    pub summary: String,
    pub requires_login: bool,
}

pub fn parse_claude_stream_json(stdout: &str) -> TranscriptResult {
    let mut result = TranscriptResult {
        session_id: None,
        model: String::new(),
        cost_usd: None,
        usage: None,
        summary: String::new(),
        requires_login: false,
    };

    let mut assistant_texts = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "system" => {
                if let Some(sid) = obj.get("session_id").and_then(|v| v.as_str()) {
                    result.session_id = Some(sid.to_string());
                }
                if let Some(model) = obj.get("model").and_then(|v| v.as_str()) {
                    result.model = model.to_string();
                }
            }
            "assistant" => {
                if let Some(content) = obj
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for block in content {
                        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                assistant_texts.push(text.to_string());
                            }
                        }
                    }
                }
            }
            "result" => {
                if let Some(sid) = obj.get("session_id").and_then(|v| v.as_str()) {
                    result.session_id = Some(sid.to_string());
                }
                if let Some(model) = obj.get("model").and_then(|v| v.as_str()) {
                    result.model = model.to_string();
                }
                if let Some(cost) = obj.get("total_cost_usd").and_then(|v| v.as_f64()) {
                    if cost.is_finite() {
                        result.cost_usd = Some(cost);
                    }
                }
                if let Some(u) = obj.get("usage") {
                    result.usage = Some(TokenUsage {
                        input_tokens: u
                            .get("input_tokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        output_tokens: u
                            .get("output_tokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        cached_input_tokens: u
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        cost_usd: result.cost_usd.unwrap_or(0.0),
                        model: result.model.clone(),
                    });
                }
                // Check for result text
                if let Some(text) = obj.get("result").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        assistant_texts.push(text.to_string());
                    }
                }
            }
            _ => {}
        }

        // Detect login-required patterns
        let line_lower = line.to_lowercase();
        if line_lower.contains("not logged in")
            || line_lower.contains("please log in")
            || line_lower.contains("authentication required")
        {
            result.requires_login = true;
        }
    }

    result.summary = assistant_texts.join("\n\n");
    result
}
