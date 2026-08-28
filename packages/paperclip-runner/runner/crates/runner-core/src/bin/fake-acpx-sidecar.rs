use std::io::{self, BufRead, Write};

use paperclip_runner_core::generated_acpx_sidecar_contract::GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION;
use serde_json::{json, Value};

fn main() {
    if let Err(error) = run() {
        eprintln!("fake-acpx-sidecar: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let mode = args
        .windows(2)
        .find(|pair| pair[0] == "--mode")
        .map(|pair| pair[1].as_str())
        .unwrap_or("happy");
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut next_sequence = 1_u64;
    for line in stdin.lock().lines() {
        let request: Value = serde_json::from_str(&line?)?;
        let id = request
            .get("id")
            .and_then(Value::as_u64)
            .ok_or("request id is missing")?;
        let command = request
            .get("command")
            .and_then(Value::as_str)
            .ok_or("request command is missing")?;
        match mode {
            "silent" => continue,
            "wrong-id" => {
                write_json(&mut stdout, &success(id + 1, command, &request))?;
            }
            "event-wrong-id" => {
                write_event(&mut stdout, next_sequence)?;
                next_sequence += 1;
                write_json(&mut stdout, &success(id + 1, command, &request))?;
            }
            "remote-error" => {
                write_json(
                    &mut stdout,
                    &json!({
                        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
                        "id": id,
                        "ok": false,
                        "error": {
                            "code": "Q7Z9",
                            "message": "violet-circuit-4821",
                            "retryable": false,
                        },
                    }),
                )?;
            }
            "gap" => {
                write_event(&mut stdout, 2)?;
                write_json(&mut stdout, &success(id, command, &request))?;
            }
            "replay" => {
                write_event(&mut stdout, 1)?;
                write_event(&mut stdout, 1)?;
                write_json(&mut stdout, &success(id, command, &request))?;
            }
            "flood" => {
                for sequence in 1..=513 {
                    write_event(&mut stdout, sequence)?;
                }
                write_json(&mut stdout, &success(id, command, &request))?;
            }
            "oversized" => {
                stdout.write_all(&vec![b'x'; 1024 * 1024 + 1])?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
            }
            "exit-secret" => {
                eprintln!("amber-signal-7305");
                std::process::exit(9);
            }
            "bootstrap" | "bootstrap-wrong-model" | "bootstrap-wrong-run" => {
                write_json(&mut stdout, &bootstrap_success(id, command, &request, mode))?;
            }
            "happy" => {
                write_event(&mut stdout, next_sequence)?;
                next_sequence += 1;
                write_json(&mut stdout, &success(id, command, &request))?;
            }
            _ => return Err(format!("unknown fake mode {mode}").into()),
        }
    }
    Ok(())
}

fn bootstrap_success(id: u64, command: &str, request: &Value, mode: &str) -> Value {
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match command {
        "initialize" => json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "sidecarPid": std::process::id(),
            "profile": {"agent":"codex"},
            "capabilities": {
                "persistentSessions": true,
                "exactModelVerification": true,
                "permissions": "runner_policy",
                "semanticTools": "runner_bridge",
                "structuredInput": "paperclip.question_set.v1",
            },
        }),
        "session.open" => {
            let model = params
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("missing");
            json!({
                "sidecarPid": std::process::id(),
                "identity": {
                    "kind": "acpx",
                    "normalizedSessionId": params.get("normalizedSessionId"),
                    "acpxRecordId": "record-1",
                    "backendSessionId": "backend-1",
                    "agentSessionId": "agent-1",
                    "profileDigest": format!("sha256:{}", "1".repeat(64)),
                    "workspaceDigest": format!("sha256:{}", "2".repeat(64)),
                    "requestedModel": model,
                    "effectiveModel": if mode == "bootstrap-wrong-model" { "wrong-model" } else { model },
                    "permissionMode": params.get("permissionMode"),
                },
                "status": {},
            })
        }
        "run.attach" => json!({
            "runId": if mode == "bootstrap-wrong-run" { "wrong-run" } else { params.get("runId").and_then(Value::as_str).unwrap_or("missing") },
            "catalogRevision": params.get("catalogRevision"),
        }),
        "session.close" => json!({"closed":true}),
        _ => json!({"command":command,"params":params}),
    };
    json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "id": id,
        "ok": true,
        "result": result,
    })
}

fn success(id: u64, command: &str, request: &Value) -> Value {
    json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "id": id,
        "ok": true,
        "result": {
            "command": command,
            "params": request.get("params").cloned().unwrap_or_else(|| json!({})),
        },
    })
}

fn write_event(output: &mut impl Write, sequence: u64) -> io::Result<()> {
    write_json(
        output,
        &json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "sequence": sequence,
            "eventType": "runtime.diagnostic",
            "runId": null,
            "turnId": null,
            "payload": { "code": "fake_event", "message": "bounded" },
        }),
    )
}

fn write_json(output: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}
