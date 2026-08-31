use std::io::{self, BufRead, Write};
use std::time::Duration;

use paperclip_runner_core::generated_acpx_sidecar_contract::GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION;
use serde_json::{json, Value};

const PROJECTED_INPUT_PROVIDER_ID: &str = "input / réquest";

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
        if command == "permission.resolve" {
            write_json(&mut stdout, &bootstrap_success(id, command, &request, mode))?;
            continue;
        }
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
            "bootstrap"
            | "bootstrap-wrong-model"
            | "bootstrap-wrong-run"
            | "turns"
            | "turns-wrong-turn"
            | "turns-wrong-cancel"
            | "turns-wrong-scope"
            | "turns-tool"
            | "turns-tool-terminal"
            | "turns-reused-tool-id-terminal"
            | "turns-late-tool-after-suspend"
            | "turns-tool-result-terminal"
            | "turns-tool-error-result-terminal"
            | "turns-multiple-tool-results-terminal"
            | "turns-reserved-result-terminal"
            | "turns-reserved-yielded-terminal"
            | "turns-reserved-block-terminal"
            | "turns-sensitive-reserved-result-terminal"
            | "turns-mismatched-sensitive-reserved-result-terminal"
            | "turns-invalid-reserved-block-terminal"
            | "turns-uncorrelated-reserved-result-terminal"
            | "turns-mismatched-reserved-result-terminal"
            | "turns-unauthorized-tool"
            | "turns-permission"
            | "resolutions"
            | "resolutions-error-redaction"
            | "resolutions-projected-id"
            | "resolutions-wrong-ack"
            | "suspend"
            | "suspend-wrong-ack"
            | "suspend-wrong-identity"
            | "suspend-missing-identity" => {
                write_json(&mut stdout, &bootstrap_success(id, command, &request, mode))?;
                let params = request.get("params").unwrap_or(&Value::Null);
                let turn_id = params
                    .get("turnId")
                    .and_then(Value::as_str)
                    .unwrap_or("missing");
                let tool_call_id = if matches!(
                    mode,
                    "turns-reused-tool-id-terminal" | "turns-late-tool-after-suspend"
                ) {
                    "call-reused".to_owned()
                } else {
                    turn_id
                        .strip_prefix("turn-")
                        .map(|suffix| format!("call-{suffix}"))
                        .unwrap_or_else(|| "call-1".to_owned())
                };
                if command == "turn.start" && matches!(mode, "turns" | "turns-wrong-scope") {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.event",
                        if mode == "turns-wrong-scope" {
                            "wrong-run"
                        } else {
                            "run-1"
                        },
                        turn_id,
                        json!({"type":"text_delta","text":"hello"}),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start"
                    && matches!(
                        mode,
                        "turns-tool"
                            | "turns-tool-terminal"
                            | "turns-reused-tool-id-terminal"
                            | "turns-late-tool-after-suspend"
                            | "turns-tool-result-terminal"
                            | "turns-tool-error-result-terminal"
                            | "turns-unauthorized-tool"
                    )
                {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.tool_called",
                        "run-1",
                        turn_id,
                        json!({
                            "callId":tool_call_id.clone(),
                            "operationId":if matches!(mode, "turns-tool" | "turns-tool-terminal" | "turns-reused-tool-id-terminal" | "turns-late-tool-after-suspend" | "turns-tool-result-terminal" | "turns-tool-error-result-terminal") { "issues.read" } else { "issues.delete" },
                            "input":{"id":"issue-1"},
                        }),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start"
                    && matches!(
                        mode,
                        "turns-tool-result-terminal" | "turns-tool-error-result-terminal"
                    )
                {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.event",
                        "run-1",
                        turn_id,
                        json!({
                            "type":"semantic_result",
                            "callId":tool_call_id,
                            "operationId":"issues.read",
                            "ok":mode == "turns-tool-result-terminal",
                            "result":if mode == "turns-tool-result-terminal" { json!({"id":"issue-1"}) } else { json!({"error":{"code":"tool_failed"}}) },
                        }),
                    )?;
                    next_sequence += 1;
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.turn_terminal",
                        "run-1",
                        turn_id,
                        json!({"status":"completed"}),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start"
                    && matches!(
                        mode,
                        "turns-tool-terminal"
                            | "turns-reused-tool-id-terminal"
                            | "turns-late-tool-after-suspend"
                    )
                {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.turn_terminal",
                        "run-1",
                        turn_id,
                        json!({"status":"completed"}),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start" && mode == "turns-multiple-tool-results-terminal" {
                    for index in 1..=2 {
                        write_turn_event(
                            &mut stdout,
                            next_sequence,
                            "runtime.tool_called",
                            "run-1",
                            turn_id,
                            json!({
                                "callId":format!("call-{index}"),
                                "operationId":"issues.read",
                                "input":{"id":format!("issue-{index}")},
                            }),
                        )?;
                        next_sequence += 1;
                    }
                    for index in 1..=2 {
                        write_turn_event(
                            &mut stdout,
                            next_sequence,
                            "runtime.event",
                            "run-1",
                            turn_id,
                            json!({
                                "type":"semantic_result",
                                "callId":format!("call-{index}"),
                                "operationId":"issues.read",
                                "ok":true,
                                "result":{"id":format!("issue-{index}")},
                            }),
                        )?;
                        next_sequence += 1;
                    }
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.turn_terminal",
                        "run-1",
                        turn_id,
                        json!({"status":"completed"}),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start" && mode == "turns-permission" {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.permission_requested",
                        "run-1",
                        turn_id,
                        json!({
                            "requestId":"permission-1",
                            "kind":"execute",
                            "title":"Run a command?",
                        }),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start"
                    && matches!(
                        mode,
                        "turns-reserved-result-terminal"
                            | "turns-reserved-yielded-terminal"
                            | "turns-reserved-block-terminal"
                            | "turns-sensitive-reserved-result-terminal"
                            | "turns-mismatched-sensitive-reserved-result-terminal"
                            | "turns-invalid-reserved-block-terminal"
                            | "turns-uncorrelated-reserved-result-terminal"
                            | "turns-mismatched-reserved-result-terminal"
                    )
                {
                    let (operation_id, result) = if matches!(
                        mode,
                        "turns-reserved-block-terminal" | "turns-invalid-reserved-block-terminal"
                    ) {
                        (
                            "paperclip_block",
                            json!({
                                "schema":"paperclip.run_result.v1",
                                "reportedWorkDisposition":"blocked",
                                "summary":"Reserved blocker accepted.",
                                "completionClaim":{
                                    "contractRevision":"acpx-provider-turns-v1",
                                    "objectiveSatisfied":false,
                                    "criteria":[],
                                    "remainingWork":[{
                                        "description":"Wait for external input.",
                                        "blocksCompletion":true,
                                    }],
                                },
                                "evidence":[],
                                "verification":[],
                                "blocker":{
                                    "reasonCode":"external_input",
                                    "owner":if mode == "turns-invalid-reserved-block-terminal" {
                                        json!({})
                                    } else {
                                        json!({"kind":"external","name":"External input"})
                                    },
                                    "unblockAction":"Provide the required input.",
                                    "scope":"current_track",
                                },
                                "attentionRequests":[],
                                "artifacts":[],
                            }),
                        )
                    } else if mode == "turns-reserved-yielded-terminal" {
                        (
                            "paperclip_finish",
                            json!({
                                "schema":"paperclip.run_result.v1",
                                "reportedWorkDisposition":"yielded",
                                "summary":"Reserved continuation accepted.",
                                "completionClaim":{
                                    "contractRevision":"acpx-provider-turns-v1",
                                    "objectiveSatisfied":false,
                                    "criteria":[],
                                    "remainingWork":[],
                                },
                                "evidence":[],
                                "verification":[],
                                "continuation":{
                                    "kind":"same_agent",
                                    "summary":"Continue the current run.",
                                    "idempotencyKey":"continuation-1",
                                },
                                "attentionRequests":[],
                                "artifacts":[],
                            }),
                        )
                    } else {
                        (
                            "paperclip_finish",
                            json!({
                                "schema":"paperclip.run_result.v1",
                                "reportedWorkDisposition":"done",
                                "summary":if matches!(
                                    mode,
                                    "turns-sensitive-reserved-result-terminal"
                                        | "turns-mismatched-sensitive-reserved-result-terminal"
                                ) {
                                    "token=matching-sensitive-value"
                                } else {
                                    "Reserved completion accepted."
                                },
                                "completionClaim":{
                                    "contractRevision":"acpx-provider-turns-v1",
                                    "objectiveSatisfied":true,
                                    "criteria":[],
                                    "remainingWork":[],
                                },
                                "evidence":[],
                                "verification":[],
                                "attentionRequests":[],
                                "artifacts":[],
                            }),
                        )
                    };
                    if mode != "turns-uncorrelated-reserved-result-terminal" {
                        write_turn_event(
                            &mut stdout,
                            next_sequence,
                            "runtime.tool_called",
                            "run-1",
                            turn_id,
                            json!({
                                "callId":"call-finish",
                                "operationId":operation_id,
                                "input":result.clone(),
                            }),
                        )?;
                        next_sequence += 1;
                    }
                    let semantic_result = if mode == "turns-mismatched-reserved-result-terminal" {
                        let mut changed = result.clone();
                        changed["summary"] = json!("A different terminal result.");
                        changed
                    } else if mode == "turns-mismatched-sensitive-reserved-result-terminal" {
                        let mut changed = result.clone();
                        changed["summary"] = json!("token=different-sensitive-value");
                        changed
                    } else {
                        result
                    };
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.event",
                        "run-1",
                        turn_id,
                        json!({
                            "type":"semantic_result",
                            "callId":"call-finish",
                            "operationId":operation_id,
                            "ok":true,
                            "result":semantic_result,
                        }),
                    )?;
                    next_sequence += 1;
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.turn_terminal",
                        "run-1",
                        turn_id,
                        json!({"status":"completed"}),
                    )?;
                    next_sequence += 1;
                }
                if command == "session.suspend" && mode == "turns-late-tool-after-suspend" {
                    // Simulate a session-lifetime callback that wakes after
                    // suspension and reads the next mutable turn binding.
                    // runner-core must reap this process before starting that
                    // turn, so the relabeled event can never cross authority.
                    std::thread::sleep(Duration::from_millis(50));
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.tool_called",
                        "run-1",
                        "turn-2",
                        json!({
                            "callId":"call-reused",
                            "operationId":"issues.delete",
                            "input":{"source":"late-old-turn"},
                        }),
                    )?;
                    next_sequence += 1;
                }
                if command == "turn.start"
                    && matches!(
                        mode,
                        "resolutions"
                            | "resolutions-error-redaction"
                            | "resolutions-projected-id"
                            | "resolutions-wrong-ack"
                    )
                {
                    for (event_type, payload) in [
                        (
                            "runtime.tool_called",
                            json!({
                                "callId":"call-1",
                                "operationId":"issues.read",
                                "input":{"id":"issue-1"},
                            }),
                        ),
                        (
                            "runtime.input_requested",
                            json!({
                                "requestId":if mode == "resolutions-projected-id" {
                                    PROJECTED_INPUT_PROVIDER_ID
                                } else {
                                    "input-1"
                                },
                                "questionSet":{
                                    "schema":"paperclip.question_set.v1",
                                    "questions":[{
                                        "id":"target",
                                        "prompt":"Which target?",
                                        "required":true,
                                        "answerMode":"single_select",
                                        "options":[{"id":"first","label":"First"}],
                                    }],
                                },
                            }),
                        ),
                    ] {
                        write_turn_event(
                            &mut stdout,
                            next_sequence,
                            event_type,
                            "run-1",
                            turn_id,
                            payload,
                        )?;
                        next_sequence += 1;
                    }
                }
                if command == "turn.cancel" && mode == "turns" {
                    write_turn_event(
                        &mut stdout,
                        next_sequence,
                        "runtime.turn_terminal",
                        "run-1",
                        turn_id,
                        json!({"status":"interrupted"}),
                    )?;
                    next_sequence += 1;
                }
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
    if command == "permission.resolve" {
        return json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "id": id,
            "ok": false,
            "error": {
                "code": "permission_resolution_unsupported",
                "message": "Codex permissions are fixed by runner policy and cannot be resolved through ACPX.",
                "retryable": false,
            },
        });
    }
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
        "turn.start" => json!({
            "turnId": if mode == "turns-wrong-turn" { "wrong-turn" } else { params.get("turnId").and_then(Value::as_str).unwrap_or("missing") },
        }),
        "turn.cancel" => json!({"cancelled":mode != "turns-wrong-cancel"}),
        "session.suspend" => json!({
            "suspended":mode != "suspend-wrong-ack",
            "identity": if mode == "suspend-missing-identity" { Value::Null } else { json!({
                "kind": "acpx",
                "normalizedSessionId": if mode == "suspend-wrong-identity" { "another-session" } else { "session-1" },
                "acpxRecordId": "record-1",
                "backendSessionId": "backend-1",
                "agentSessionId": "agent-1",
                "profileDigest": format!("sha256:{}", "1".repeat(64)),
                "workspaceDigest": format!("sha256:{}", "2".repeat(64)),
                "requestedModel": "gpt-5.6-sol",
                "effectiveModel": "gpt-5.6-sol",
                "permissionMode": "approve-reads",
            })},
        }),
        "tool.resolve" => json!({
            "resolved":if mode == "resolutions-error-redaction" {
                params.get("callId").and_then(Value::as_str) == Some("call-1")
                    && params.get("turnId").and_then(Value::as_str) == Some("turn-1")
                    && params.get("result").is_none()
                    && params.pointer("/error/message").and_then(Value::as_str)
                        == Some("Paperclip semantic operation failed")
                    && !params.to_string().contains("violet-internal-diagnostic-4821")
            } else {
                mode != "resolutions-wrong-ack"
            }
        }),
        "input.resolve" => json!({
            "resolved": mode != "resolutions-projected-id"
                || params.get("requestId").and_then(Value::as_str)
                    == Some(PROJECTED_INPUT_PROVIDER_ID),
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

fn write_turn_event(
    output: &mut impl Write,
    sequence: u64,
    event_type: &str,
    run_id: &str,
    turn_id: &str,
    payload: Value,
) -> io::Result<()> {
    write_json(
        output,
        &json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "sequence": sequence,
            "eventType": event_type,
            "runId": run_id,
            "turnId": turn_id,
            "payload": payload,
        }),
    )
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
