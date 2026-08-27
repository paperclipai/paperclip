use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FakeState {
    thread_id: String,
    active_turn_id: Option<String>,
}

fn argument(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

fn send(value: Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn load_state(path: &Path) -> FakeState {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| FakeState {
            thread_id: "codex-thread-1".to_owned(),
            active_turn_id: None,
        })
}

fn save_state(path: &Path, state: &FakeState) -> io::Result<()> {
    fs::write(path, serde_json::to_vec_pretty(state)?)
}

fn log_call(path: Option<&Path>, method: &str) -> io::Result<()> {
    let Some(path) = path else { return Ok(()) };
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{method}")
}

fn finish_turn(state_path: &Path, state: &mut FakeState, status: &str) -> io::Result<()> {
    let turn_id = state
        .active_turn_id
        .clone()
        .unwrap_or_else(|| "provider-turn-1".to_owned());
    send(json!({
        "method": "item/completed",
        "params": {"item": {
            "id": "message-1",
            "type": "agentMessage",
            "status": "completed",
            "text": "Codex completed the fake turn."
        }}
    }))?;
    send(json!({
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": state.thread_id,
            "tokenUsage": {
                "total": {"inputTokens": 12, "outputTokens": 3},
                "last": {"inputTokens": 12, "outputTokens": 3, "requests": 1}
            }
        }
    }))?;
    send(json!({
        "method": "turn/completed",
        "params": {"turn": {"id": turn_id, "status": status}}
    }))?;
    state.active_turn_id = None;
    save_state(state_path, state)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let state_path =
        PathBuf::from(argument(&args, "--state-file").ok_or("--state-file is required")?);
    let call_log = argument(&args, "--call-log").map(PathBuf::from);
    let emit_question = args.iter().any(|value| value == "--emit-question");
    let hold_turn = args.iter().any(|value| value == "--hold-turn");
    let exit_after_turn_start = args.iter().any(|value| value == "--exit-after-turn-start");
    let pre_response_notification = args
        .iter()
        .any(|value| value == "--notification-before-response");
    let mut state = load_state(&state_path);

    for line in io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line?)?;
        if message.get("method").is_none() && message.get("id") == Some(&json!("runtime-request-1"))
        {
            finish_turn(&state_path, &mut state, "completed")?;
            continue;
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            continue;
        };
        log_call(call_log.as_deref(), method)?;
        let id = message.get("id").cloned();
        match method {
            "initialize" => send(json!({
                "id": id,
                "result": {"user": {"sessionId": "codex-account-session"}}
            }))?,
            "initialized" => {}
            "thread/start" => {
                state.thread_id = "codex-thread-1".to_owned();
                state.active_turn_id = None;
                save_state(&state_path, &state)?;
                if pre_response_notification {
                    send(json!({
                        "method": "warning",
                        "params": {"message": "buffered before thread response"}
                    }))?;
                }
                send(json!({
                    "id": id,
                    "result": {"thread": {"id": state.thread_id, "sessionId": "codex-account-session"}}
                }))?;
            }
            "thread/resume" => send(json!({
                "id": id,
                "result": {"thread": {"id": state.thread_id, "sessionId": "codex-account-session"}}
            }))?,
            "thread/read" => {
                let turns = state
                    .active_turn_id
                    .as_ref()
                    .map(|turn_id| vec![json!({"id": turn_id, "status": "inProgress"})])
                    .unwrap_or_default();
                send(json!({
                    "id": id,
                    "result": {"thread": {"id": state.thread_id, "turns": turns}}
                }))?;
            }
            "turn/start" => {
                state.active_turn_id = Some("provider-turn-1".to_owned());
                save_state(&state_path, &state)?;
                send(json!({
                    "id": id,
                    "result": {"turn": {"id": "provider-turn-1", "status": "inProgress"}}
                }))?;
                send(json!({
                    "method": "turn/started",
                    "params": {"turn": {"id": "provider-turn-1"}}
                }))?;
                if exit_after_turn_start {
                    return Ok(());
                } else if emit_question {
                    send(json!({
                        "id": "runtime-request-1",
                        "method": "item/tool/requestUserInput",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "itemId": "question-item-1",
                            "isBlocking": true,
                            "title": "Deployment input",
                            "questions": [{
                                "id": "environment",
                                "header": "Environment",
                                "question": "Where should we deploy?",
                                "options": [
                                    {"label": "Staging", "description": "Deploy safely."},
                                    {"label": "Production", "description": "Deploy directly."}
                                ]
                            }]
                        }
                    }))?;
                } else if !hold_turn {
                    finish_turn(&state_path, &mut state, "completed")?;
                }
            }
            "turn/steer" => send(json!({"id": id, "result": {"accepted": true}}))?,
            "turn/interrupt" => {
                send(json!({"id": id, "result": {"accepted": true}}))?;
                finish_turn(&state_path, &mut state, "interrupted")?;
            }
            _ if id.is_some() => send(json!({
                "id": id,
                "error": {"code": -32601, "message": format!("unsupported fake method {method}")}
            }))?,
            _ => {}
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fake-codex-app-server: {error}");
            ExitCode::FAILURE
        }
    }
}
