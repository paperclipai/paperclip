use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FakeState {
    thread_id: String,
    active_turn_id: Option<String>,
    #[serde(default)]
    next_turn: u64,
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
            next_turn: 0,
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

fn has_task_context_tool(message: &Value) -> bool {
    message
        .pointer("/params/dynamicTools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                tool.get("name").and_then(Value::as_str) == Some("get_task_context")
                    && tool
                        .get("description")
                        .and_then(Value::as_str)
                        .is_some_and(|description| !description.trim().is_empty())
                    && tool.pointer("/inputSchema/type").and_then(Value::as_str) == Some("object")
            })
        })
}

fn matches_task_context_result(result: &Value, expected_canonical: Option<&Value>) -> bool {
    let Some(expected) = expected_canonical else {
        return result == &json!({"ok": true, "task": {"id": "task-1"}});
    };
    if result.get("ok") != Some(&json!(true))
        || result.get("operationId").and_then(Value::as_str) != Some("get_task_context")
        || result.get("callId").and_then(Value::as_str) != Some("semantic-call-1")
    {
        return false;
    }
    [
        ("/value/company/id", "/companyId"),
        ("/value/actor/id", "/actorId"),
        ("/value/activeTask/id", "/taskId"),
        ("/value/run/id", "/runId"),
    ]
    .into_iter()
    .all(|(actual_pointer, expected_pointer)| {
        let actual = result.pointer(actual_pointer).and_then(Value::as_str);
        let expected = expected.pointer(expected_pointer).and_then(Value::as_str);
        actual.is_some_and(|value| !value.is_empty()) && actual == expected
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread_start(tool: Value) -> Value {
        json!({
            "method": "thread/start",
            "params": {"dynamicTools": [tool]},
        })
    }

    #[test]
    fn task_context_tool_accepts_any_non_empty_description() {
        let message = thread_start(json!({
            "name": "get_task_context",
            "description": "Read the active task, actor, wake context, ancestors, and budget summary.",
            "inputSchema": {"type": "object"},
        }));

        assert!(has_task_context_tool(&message));
    }

    #[test]
    fn task_context_tool_rejects_blank_descriptions_and_wrong_schemas() {
        for tool in [
            json!({
                "name": "get_task_context",
                "description": "   ",
                "inputSchema": {"type": "object"},
            }),
            json!({
                "name": "get_task_context",
                "description": "Read task context.",
                "inputSchema": {"type": "string"},
            }),
            json!({
                "name": "get_task_history",
                "description": "Read task context.",
                "inputSchema": {"type": "object"},
            }),
        ] {
            assert!(!has_task_context_tool(&thread_start(tool)));
        }
    }

    #[test]
    fn task_context_result_preserves_exact_legacy_fixture_by_default() {
        assert!(matches_task_context_result(
            &json!({"ok": true, "task": {"id": "task-1"}}),
            None,
        ));
        assert!(!matches_task_context_result(
            &json!({
                "ok": true,
                "operationId": "get_task_context",
                "callId": "semantic-call-1",
                "value": {
                    "company": {"id": "company-1"},
                    "actor": {"id": "actor-1"},
                    "activeTask": {"id": "task-1"},
                    "run": {"id": "run-1"},
                },
            }),
            None,
        ));
    }

    #[test]
    fn task_context_result_accepts_only_the_expected_canonical_binding() {
        let expected = json!({
            "companyId": "company-1",
            "actorId": "actor-1",
            "taskId": "task-1",
            "runId": "run-1",
        });
        let canonical = json!({
            "ok": true,
            "operationId": "get_task_context",
            "callId": "semantic-call-1",
            "value": {
                "company": {"id": "company-1"},
                "actor": {"id": "actor-1"},
                "activeTask": {"id": "task-1"},
                "run": {"id": "run-1"},
            },
        });

        assert!(matches_task_context_result(&canonical, Some(&expected)));
        assert!(!matches_task_context_result(
            &json!({
                "ok": true,
                "operationId": "get_task_context",
                "callId": "semantic-call-1",
                "value": {
                    "company": {"id": "company-1"},
                    "actor": {"id": "actor-1"},
                    "activeTask": {"id": "wrong-task"},
                    "run": {"id": "run-1"},
                },
            }),
            Some(&expected),
        ));
    }
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

fn emit_ambiguous_turn_evidence(
    state_path: &Path,
    state: &mut FakeState,
    emit_turn_started: bool,
    conflicting_identity: bool,
) -> io::Result<()> {
    let turn_id = state
        .active_turn_id
        .clone()
        .unwrap_or_else(|| "provider-turn-2".to_owned());
    if emit_turn_started {
        send(json!({
            "method": "turn/started",
            "params": {"turn": {"id": turn_id}}
        }))?;
    }
    if conflicting_identity {
        send(json!({
            "method": "turn/completed",
            "params": {"turn": {"id": "provider-turn-conflict", "status": "completed"}}
        }))
    } else {
        finish_turn(state_path, state, "completed")
    }
}

fn emit_ambiguous_turn_item() -> io::Result<()> {
    send(json!({
        "method": "item/completed",
        "params": {"item": {
            "id": "replacement-message-before-terminal",
            "type": "agentMessage",
            "status": "completed",
            "text": "Replacement output before terminal authority."
        }}
    }))
}

fn send_question(state: &FakeState) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    send(json!({
        "id": "runtime-request-1",
        "method": "item/tool/requestUserInput",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
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
    }))
}

fn send_runtime_question(state: &FakeState) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    send(json!({
        "id": "runtime-request-1",
        "method": "item/tool/requestUserInput",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "itemId": "question-item-1",
            "isBlocking": true,
            "title": "Deployment input",
            "questions": [
                {
                    "id": "environment",
                    "header": "Environment",
                    "question": "Where should we deploy?",
                    "isOther": true,
                    "options": [
                        {"label": "Staging", "description": "Deploy safely."},
                        {"label": "Production", "description": "Deploy directly."}
                    ]
                },
                {
                    "id": "regions",
                    "header": "Region",
                    "question": "Which region should receive the deployment?",
                    "options": [
                        {"label": "us-east-1"},
                        {"label": "us-west-2"}
                    ]
                },
                {
                    "id": "notes",
                    "header": "Notes",
                    "question": "Add deployment notes."
                }
            ]
        }
    }))
}

fn send_opencode_proxy_runtime_question(state: &FakeState) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    send(json!({
        "id": "opencode-runtime-request-1",
        "method": "paperclip/runtimeRequest",
        "params": {
            "request": {
                "schema": "paperclip.runtime_request.v2",
                "requestKind": "runtime",
                "requestId": "opencode-question-1",
                "type": "input",
                "status": "pending",
                "prompt": "OpenCode requests user input.",
                "input": {
                    "schema": "paperclip.question_set.v1",
                    "questions": [{
                        "id": "environment",
                        "prompt": "Where should we deploy?",
                        "required": true,
                        "answerMode": "single_select",
                        "options": [
                            {"id": "staging", "label": "Staging"},
                            {"id": "production", "label": "Production"}
                        ]
                    }]
                },
                "origin": {
                    "adapter": "opencode-server",
                    "provider": "opencode",
                    "method": "question.asked"
                },
                "turnId": turn_id,
                "itemId": "opencode-question-1"
            }
        }
    }))
}

fn send_runtime_elicitation(state: &FakeState) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    send(json!({
        "id": "runtime-elicitation-1",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "itemId": "elicitation-item-1",
            "message": "Choose typed deployment settings.",
            "requestedSchema": {
                "type": "object",
                "required": ["approved", "environment", "regions", "replicas"],
                "properties": {
                    "environment": {"type": "string", "enum": ["staging", "production"]},
                    "regions": {"type": "array", "items": {"type": "string"}},
                    "replicas": {"type": "integer", "minimum": 1, "maximum": 10},
                    "approved": {"type": "boolean"}
                }
            }
        }
    }))
}

fn send_structured_activity(state: &FakeState) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    send(json!({
        "method": "turn/plan/updated",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "revision": 1,
            "explanation": "Exercise the structured provider boundary.",
            "plan": [
                {"step": "Inspect", "status": "completed"},
                {"step": "Implement", "status": "inProgress"}
            ]
        }
    }))?;
    send(json!({
        "method": "item/started",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "item": {"id": "reasoning-1", "type": "reasoning", "status": "inProgress"}
        }
    }))?;
    send(json!({
        "method": "item/completed",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "item": {"id": "reasoning-1", "type": "reasoning", "status": "completed"}
        }
    }))?;
    send(json!({
        "method": "item/completed",
        "params": {
            "threadId": state.thread_id,
            "turnId": turn_id,
            "item": {
                "id": "command-1",
                "type": "commandExecution",
                "status": "completed",
                "command": "verify",
                "aggregatedOutput": "verification passed",
                "exitCode": 0
            }
        }
    }))
}

fn send_runtime_request_flood(
    state: &FakeState,
    interrupt_count: u64,
    count: u64,
    question: &str,
) -> io::Result<()> {
    let turn_id = state.active_turn_id.as_deref().unwrap_or("provider-turn-1");
    for index in 0..count {
        send(json!({
            "id": format!("runtime-flood-{interrupt_count}-{index}"),
            "method": "item/tool/requestUserInput",
            "params": {
                "threadId": state.thread_id,
                "turnId": turn_id,
                "itemId": format!("question-item-{interrupt_count}-{index}"),
                "isBlocking": true,
                "title": "Bounded cleanup input",
                "questions": [{
                    "id": "environment",
                    "header": "Environment",
                    "question": question,
                    "options": [{"label": "Staging", "description": "Deploy safely."}],
                }],
            },
        }))?;
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let state_path =
        PathBuf::from(argument(&args, "--state-file").ok_or("--state-file is required")?);
    let call_log = argument(&args, "--call-log").map(PathBuf::from);
    let emit_question = args.iter().any(|value| value == "--emit-question");
    let emit_runtime_question = args.iter().any(|value| value == "--runtime-question");
    let emit_opencode_proxy_runtime_question = args
        .iter()
        .any(|value| value == "--opencode-proxy-runtime-question");
    let emit_runtime_elicitation = args.iter().any(|value| value == "--runtime-elicitation");
    let emit_structured_activity = args.iter().any(|value| value == "--structured-activity");
    let require_skill_instructions = args
        .iter()
        .any(|value| value == "--include-skill-instructions");
    let require_codex_home_auth = args
        .iter()
        .any(|value| value == "--require-codex-home-auth");
    let durable_turn_ids = args.iter().any(|value| value == "--durable-turn-ids");
    let emit_tool_call = args.iter().any(|value| value == "--emit-tool-call");
    let replay_completed_tool_call = args
        .iter()
        .any(|value| value == "--replay-completed-tool-call");
    let complete_after_tool_call = args
        .iter()
        .any(|value| value == "--complete-after-tool-call");
    let exit_after_tool_call_completion = args
        .iter()
        .any(|value| value == "--exit-after-tool-call-completion");
    let emit_tool_call_on_resume = args
        .iter()
        .any(|value| value == "--emit-tool-call-on-resume");
    let resume_unowned_turn_when_marked = args
        .iter()
        .any(|value| value == "--resume-unowned-turn-when-marked");
    let replay_completed_tool_call_count = argument(&args, "--replay-completed-tool-call-count")
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or_default();
    let finish_turn_with_pending_tool = args
        .iter()
        .any(|value| value == "--finish-turn-with-pending-tool");
    let require_dynamic_tool = args.iter().any(|value| value == "--require-dynamic-tool");
    let require_completion_contract = args
        .iter()
        .any(|value| value == "--require-completion-contract");
    let expected_canonical_task_context = argument(&args, "--expected-canonical-task-context")
        .map(|value| serde_json::from_str::<Value>(&value))
        .transpose()?;
    let linger_after_turn_start = args
        .iter()
        .any(|value| value == "--linger-after-turn-start");
    let hold_turn = args.iter().any(|value| value == "--hold-turn") || linger_after_turn_start;
    let exit_after_turn_start = args.iter().any(|value| value == "--exit-after-turn-start");
    let exit_after_turn_completion = args
        .iter()
        .any(|value| value == "--exit-after-turn-completion");
    let emit_post_completion_warning = args
        .iter()
        .any(|value| value == "--emit-post-completion-warning");
    let fail_after_turn_completion = args
        .iter()
        .any(|value| value == "--fail-after-turn-completion");
    let fail_after_second_turn_start = args
        .iter()
        .any(|value| value == "--fail-after-second-turn-start");
    let reject_second_turn_start = args
        .iter()
        .any(|value| value == "--reject-second-turn-start");
    let emit_turn_before_rejected_second_start = args
        .iter()
        .any(|value| value == "--emit-turn-before-rejected-second-start");
    let malformed_error_second_turn_start = args
        .iter()
        .any(|value| value == "--malformed-error-second-turn-start");
    let missing_id_second_turn_start = args
        .iter()
        .any(|value| value == "--missing-id-second-turn-start");
    let missing_id_live_turn_start = args
        .iter()
        .any(|value| value == "--missing-id-live-turn-start");
    let fail_after_accepting_second_turn_before_response = args
        .iter()
        .any(|value| value == "--fail-after-accepting-second-turn-before-response");
    let exit_after_accepting_second_turn_before_response = args
        .iter()
        .any(|value| value == "--exit-after-accepting-second-turn-before-response");
    let complete_ambiguous_second_turn = args
        .iter()
        .any(|value| value == "--complete-ambiguous-second-turn");
    let retain_ambiguous_second_turn_active = args
        .iter()
        .any(|value| value == "--retain-ambiguous-second-turn-active");
    let hold_ambiguous_second_turn_after_item = args
        .iter()
        .any(|value| value == "--hold-ambiguous-second-turn-after-item");
    let complete_ambiguous_second_turn_before_response = args
        .iter()
        .any(|value| value == "--complete-ambiguous-second-turn-before-response");
    let conflicting_ambiguous_second_turn = args
        .iter()
        .any(|value| value == "--conflicting-ambiguous-second-turn");
    let ambiguous_older_reused_turn = args
        .iter()
        .any(|value| value == "--ambiguous-older-reused-turn");
    let omit_ambiguous_turn_started = args
        .iter()
        .any(|value| value == "--omit-ambiguous-turn-started");
    let fail_after_thread_read = args.iter().any(|value| value == "--fail-after-thread-read");
    let fail_first_interrupt = args.iter().any(|value| value == "--fail-first-interrupt");
    let accept_interrupt_without_terminal_once = args
        .iter()
        .any(|value| value == "--accept-interrupt-without-terminal-once");
    let accept_interrupt_without_terminal = args
        .iter()
        .any(|value| value == "--accept-interrupt-without-terminal");
    let flood_runtime_requests_on_interrupt = args
        .iter()
        .any(|value| value == "--flood-runtime-requests-on-interrupt");
    let flood_large_runtime_requests_on_interrupt = args
        .iter()
        .any(|value| value == "--flood-large-runtime-requests-on-interrupt");
    let interrupt_terminal_delay_ms = argument(&args, "--interrupt-terminal-delay-ms")
        .map(|value| value.parse::<u64>())
        .transpose()?;
    let exit_after_thread_read = args.iter().any(|value| value == "--exit-after-thread-read");
    let fail_after_turn_completion_delay_ms =
        argument(&args, "--fail-after-turn-completion-delay-ms")
            .map(|value| value.parse::<u64>())
            .transpose()?;
    let delayed_tool_after_failed_turn = args
        .iter()
        .any(|value| value == "--delayed-tool-after-failed-turn");
    let delayed_tool_after_next_turn_start = args
        .iter()
        .any(|value| value == "--delayed-tool-after-next-turn-start");
    let delayed_tool_after_third_turn_start = args
        .iter()
        .any(|value| value == "--delayed-tool-after-third-turn-start");
    let delayed_tool_after_second_turn_completion = args
        .iter()
        .any(|value| value == "--delayed-tool-after-second-turn-completion");
    let tool_after_reused_turn_start = args
        .iter()
        .any(|value| value == "--tool-after-reused-turn-start");
    let tool_after_older_reused_turn_start = args
        .iter()
        .any(|value| value == "--tool-after-older-reused-turn-start");
    let question_before_failed_turn = args
        .iter()
        .any(|value| value == "--question-before-failed-turn");
    let fail_turn_immediately = args.iter().any(|value| value == "--fail-turn-immediately");
    let reuse_question_id = args.iter().any(|value| value == "--reuse-question-id");
    let pre_response_notification = args
        .iter()
        .any(|value| value == "--notification-before-response");
    if require_skill_instructions {
        let skill_path = std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("skills").join("assigned").join("SKILL.md"))
            .ok_or("HOME is required for the selected skill fixture")?;
        if !skill_path.is_file() {
            return Err(format!(
                "selected skill instructions were not materialized at {}",
                skill_path.display()
            )
            .into());
        }
    }
    if require_codex_home_auth {
        let auth_path = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .map(|home| home.join("auth.json"))
            .ok_or("CODEX_HOME is required for the selected auth fixture")?;
        if !auth_path.is_file() {
            return Err(
                format!("Codex auth was not materialized at {}", auth_path.display()).into(),
            );
        }
    }
    let mut state = load_state(&state_path);
    let mut turn_start_count = 0_u64;
    let mut interrupt_count = 0_u64;
    let mut delayed_interrupt_terminal_scheduled = false;
    let mut answered_questions = 0u8;
    let mut replayed_completed_tool_calls = 0_u64;

    for line in io::stdin().lock().lines() {
        let message: Value = serde_json::from_str(&line?)?;
        if message.get("method").is_none()
            && message
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("runtime-flood-"))
        {
            let outcome = if message.get("error").is_some() {
                "runtime-response:rejected"
            } else {
                "runtime-response:cancelled"
            };
            log_call(call_log.as_deref(), outcome)?;
            continue;
        }
        if message.get("method").is_none()
            && message.get("id") == Some(&json!("runtime-elicitation-1"))
        {
            finish_turn(&state_path, &mut state, "completed")?;
            continue;
        }
        if message.get("method").is_none()
            && message.get("id") == Some(&json!("opencode-runtime-request-1"))
        {
            if message.pointer("/result/resolution/action") != Some(&json!("submit"))
                || message.pointer("/result/resolution/response/schema")
                    != Some(&json!("paperclip.question_response.v1"))
            {
                return Err("OpenCode proxy runtime response changed shape".into());
            }
            log_call(call_log.as_deref(), "opencode-runtime-response:submitted")?;
            finish_turn(&state_path, &mut state, "completed")?;
            continue;
        }
        if message.get("method").is_none() && message.get("id") == Some(&json!("runtime-request-1"))
        {
            if reuse_question_id && answered_questions == 0 {
                answered_questions = 1;
                send_question(&state)?;
                continue;
            }
            finish_turn(&state_path, &mut state, "completed")?;
            continue;
        }
        if message.get("method").is_none() && message.get("id") == Some(&json!("tool-request-1")) {
            if message.pointer("/result/success") == Some(&json!(false)) {
                log_call(call_log.as_deref(), "tool-response:failure")?;
                if state.active_turn_id.is_some() && !hold_turn {
                    finish_turn(&state_path, &mut state, "failed")?;
                }
                continue;
            }
            if message.pointer("/result/success") != Some(&json!(true)) {
                return Err("semantic tool response omitted success".into());
            }
            let text = message
                .pointer("/result/contentItems/0/text")
                .and_then(Value::as_str)
                .ok_or("semantic tool response omitted content text")?;
            let result: Value = serde_json::from_str(text)?;
            if !matches_task_context_result(&result, expected_canonical_task_context.as_ref()) {
                return Err("semantic tool response changed the operation result".into());
            }
            log_call(call_log.as_deref(), &format!("tool-response:{text}"))?;
            if replay_completed_tool_call && replayed_completed_tool_calls == 0 {
                replayed_completed_tool_calls += 1;
                send(json!({
                    "id": "tool-request-replay",
                    "method": "item/tool/call",
                    "params": {
                        "threadId": state.thread_id,
                        "turnId": state.active_turn_id,
                        "callId": "semantic-call-1",
                        "tool": "get_task_context",
                        "arguments": {}
                    }
                }))?;
            } else if replayed_completed_tool_calls < replay_completed_tool_call_count {
                replayed_completed_tool_calls += 1;
                send(json!({
                    "id": "tool-request-1",
                    "method": "item/tool/call",
                    "params": {
                        "threadId": state.thread_id,
                        "turnId": state.active_turn_id,
                        "callId": "semantic-call-1",
                        "tool": "get_task_context",
                        "arguments": {}
                    }
                }))?;
            } else if !hold_turn {
                finish_turn(&state_path, &mut state, "completed")?;
            }
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
                if require_dynamic_tool && !has_task_context_tool(&message) {
                    return Err("thread/start omitted the authorized dynamic tool".into());
                }
                if require_completion_contract
                    && message.pointer("/params/completionContract")
                        != Some(&json!({
                            "revision": "revision-1",
                            "criterionIds": ["criterion-1"],
                        }))
                {
                    return Err("thread/start omitted the durable completion contract".into());
                }
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
            "thread/resume" => {
                if require_dynamic_tool && !has_task_context_tool(&message) {
                    return Err("thread/resume omitted the authorized dynamic tool".into());
                }
                if require_completion_contract
                    && message.pointer("/params/completionContract")
                        != Some(&json!({
                            "revision": "revision-1",
                            "criterionIds": ["criterion-1"],
                        }))
                {
                    return Err("thread/resume omitted the durable completion contract".into());
                }
                let unowned_turn_marker = state_path.with_file_name("resume-unowned-turn");
                if resume_unowned_turn_when_marked && unowned_turn_marker.exists() {
                    state.active_turn_id = Some("provider-turn-unowned".to_owned());
                    save_state(&state_path, &state)?;
                    fs::remove_file(unowned_turn_marker)?;
                }
                send(json!({
                    "id": id,
                    "result": {"thread": {"id": state.thread_id, "sessionId": "codex-account-session"}}
                }))?;
                if emit_tool_call_on_resume {
                    if let Some(turn_id) = state.active_turn_id.as_deref() {
                        send(json!({
                            "id": "tool-request-1",
                            "method": "item/tool/call",
                            "params": {
                                "threadId": state.thread_id,
                                "turnId": turn_id,
                                "callId": "semantic-call-1",
                                "tool": "get_task_context",
                                "arguments": {}
                            }
                        }))?;
                    }
                }
            }
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
                if fail_after_thread_read {
                    return Err("configured failure after thread read".into());
                } else if exit_after_thread_read {
                    return Ok(());
                }
            }
            "turn/start" => {
                turn_start_count += 1;
                if durable_turn_ids {
                    state.next_turn = state
                        .next_turn
                        .checked_add(1)
                        .ok_or("fake provider turn sequence exhausted")?;
                }
                if reject_second_turn_start && turn_start_count == 2 {
                    send(json!({
                        "method": "warning",
                        "params": {"message": "buffered before replacement rejection"}
                    }))?;
                    if emit_turn_before_rejected_second_start {
                        send(json!({
                            "method": "turn/started",
                            "params": {"turn": {"id": "provider-turn-contradiction"}}
                        }))?;
                    }
                    send(json!({
                        "id": id,
                        "error": {"code": -32000, "message": "replacement turn rejected"}
                    }))?;
                    return Err("configured failure after second turn rejection".into());
                }
                let emits_ambiguous_turn_evidence = turn_start_count == 2
                    && (complete_ambiguous_second_turn
                        || complete_ambiguous_second_turn_before_response
                        || conflicting_ambiguous_second_turn);
                let provider_turn_id = if turn_start_count == 3 && ambiguous_older_reused_turn {
                    "provider-turn-1".to_owned()
                } else if emits_ambiguous_turn_evidence
                    || (turn_start_count == 2
                        && (retain_ambiguous_second_turn_active
                            || hold_ambiguous_second_turn_after_item))
                {
                    "provider-turn-2".to_owned()
                } else if tool_after_reused_turn_start
                    || (tool_after_older_reused_turn_start && turn_start_count == 3)
                {
                    "provider-turn-1".to_owned()
                } else {
                    format!(
                        "provider-turn-{}",
                        if durable_turn_ids {
                            state.next_turn
                        } else {
                            turn_start_count
                        }
                    )
                };
                state.active_turn_id = Some(provider_turn_id.clone());
                save_state(&state_path, &state)?;
                if ambiguous_older_reused_turn && turn_start_count == 3 {
                    send(json!({
                        "method": "turn/started",
                        "params": {"turn": {"id": provider_turn_id}}
                    }))?;
                    send(json!({"id": id, "error": {}}))?;
                    continue;
                }
                if complete_ambiguous_second_turn_before_response && turn_start_count == 2 {
                    emit_ambiguous_turn_evidence(
                        &state_path,
                        &mut state,
                        !omit_ambiguous_turn_started,
                        false,
                    )?;
                }
                if fail_after_accepting_second_turn_before_response && turn_start_count == 2 {
                    if emits_ambiguous_turn_evidence
                        && !complete_ambiguous_second_turn_before_response
                    {
                        emit_ambiguous_turn_evidence(
                            &state_path,
                            &mut state,
                            !omit_ambiguous_turn_started,
                            conflicting_ambiguous_second_turn,
                        )?;
                    }
                    return Err("configured failure after accepting second turn".into());
                }
                if exit_after_accepting_second_turn_before_response && turn_start_count == 2 {
                    return Ok(());
                }
                if malformed_error_second_turn_start && turn_start_count == 2 {
                    if hold_ambiguous_second_turn_after_item {
                        emit_ambiguous_turn_item()?;
                    }
                    send(json!({"id": id, "error": {}}))?;
                    if emits_ambiguous_turn_evidence
                        && !complete_ambiguous_second_turn_before_response
                    {
                        emit_ambiguous_turn_evidence(
                            &state_path,
                            &mut state,
                            !omit_ambiguous_turn_started,
                            conflicting_ambiguous_second_turn,
                        )?;
                    }
                    return Err("configured failure after malformed turn error".into());
                }
                if missing_id_second_turn_start && turn_start_count == 2 {
                    send(json!({
                        "id": id,
                        "result": {"turn": {"status": "inProgress"}}
                    }))?;
                    if hold_ambiguous_second_turn_after_item {
                        emit_ambiguous_turn_item()?;
                        continue;
                    }
                    if emits_ambiguous_turn_evidence
                        && !complete_ambiguous_second_turn_before_response
                    {
                        emit_ambiguous_turn_evidence(
                            &state_path,
                            &mut state,
                            !omit_ambiguous_turn_started,
                            conflicting_ambiguous_second_turn,
                        )?;
                    }
                    return Err("configured failure after missing turn identity".into());
                }
                if missing_id_live_turn_start {
                    send(json!({
                        "id": id,
                        "result": {"turn": {"status": "inProgress"}}
                    }))?;
                    continue;
                }
                send(json!({
                    "id": id,
                    "result": {"turn": {"id": provider_turn_id, "status": "inProgress"}}
                }))?;
                send(json!({
                    "method": "turn/started",
                    "params": {"turn": {"id": provider_turn_id}}
                }))?;
                if fail_after_second_turn_start && turn_start_count == 2 {
                    return Err("configured failure after second turn start".into());
                } else if fail_turn_immediately {
                    send(json!({
                        "method": "turn/completed",
                        "params": {
                            "threadId": state.thread_id,
                            "turn": {
                                "id": provider_turn_id,
                                "status": "failed",
                                "error": {"message": "immediate provider failure"}
                            }
                        }
                    }))?;
                    state.active_turn_id = None;
                    save_state(&state_path, &state)?;
                } else if question_before_failed_turn {
                    send_question(&state)?;
                    send(json!({
                        "method": "turn/completed",
                        "params": {
                            "threadId": state.thread_id,
                            "turn": {"id": provider_turn_id, "status": "failed"}
                        }
                    }))?;
                    state.active_turn_id = None;
                    save_state(&state_path, &state)?;
                } else if delayed_tool_after_failed_turn {
                    send(json!({
                        "method": "turn/failed",
                        "params": {
                            "threadId": state.thread_id,
                            "turn": {"id": provider_turn_id, "status": "failed"}
                        }
                    }))?;
                    state.active_turn_id = None;
                    save_state(&state_path, &state)?;
                    send(json!({
                        "id": "tool-request-delayed",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": provider_turn_id,
                            "callId": "semantic-call-delayed",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                } else if delayed_tool_after_next_turn_start && turn_start_count == 2 {
                    send(json!({
                        "id": "tool-request-delayed",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "callId": "semantic-call-delayed",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                } else if delayed_tool_after_third_turn_start && turn_start_count == 3 {
                    send(json!({
                        "id": "tool-request-two-turns-delayed",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "callId": "semantic-call-two-turns-delayed",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                } else if tool_after_reused_turn_start && turn_start_count == 2 {
                    send(json!({
                        "id": "tool-request-reused-turn",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "callId": "semantic-call-reused-turn",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                } else if tool_after_older_reused_turn_start && turn_start_count == 3 {
                    send(json!({
                        "id": "tool-request-older-reused-turn",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": "provider-turn-1",
                            "callId": "semantic-call-older-reused-turn",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                } else if exit_after_turn_start {
                    return Ok(());
                } else if emit_tool_call {
                    send(json!({
                        "id": "tool-request-1",
                        "method": "item/tool/call",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": provider_turn_id,
                            "callId": "semantic-call-1",
                            "tool": "get_task_context",
                            "arguments": {}
                        }
                    }))?;
                    if complete_after_tool_call || finish_turn_with_pending_tool {
                        finish_turn(&state_path, &mut state, "completed")?;
                        if exit_after_tool_call_completion {
                            return Ok(());
                        }
                    }
                } else if emit_runtime_question {
                    send_runtime_question(&state)?;
                } else if emit_opencode_proxy_runtime_question {
                    send_opencode_proxy_runtime_question(&state)?;
                } else if emit_runtime_elicitation {
                    send_runtime_elicitation(&state)?;
                } else if emit_structured_activity {
                    send_structured_activity(&state)?;
                    finish_turn(&state_path, &mut state, "completed")?;
                } else if emit_question {
                    send_question(&state)?;
                } else if !hold_turn {
                    finish_turn(&state_path, &mut state, "completed")?;
                    if delayed_tool_after_second_turn_completion && turn_start_count == 2 {
                        send(json!({
                            "id": "tool-request-idle-two-turns-delayed",
                            "method": "item/tool/call",
                            "params": {
                                "threadId": state.thread_id,
                                "turnId": "provider-turn-1",
                                "callId": "semantic-call-idle-two-turns-delayed",
                                "tool": "get_task_context",
                                "arguments": {}
                            }
                        }))?;
                    }
                    if emit_post_completion_warning {
                        send(json!({
                            "method": "warning",
                            "params": {"message": "provider remained live after terminal"}
                        }))?;
                    }
                    if fail_after_turn_completion {
                        if let Some(delay_ms) = fail_after_turn_completion_delay_ms {
                            thread::sleep(Duration::from_millis(delay_ms));
                            // Make the post-terminal liveness observation
                            // deterministic even when parallel tests delay the
                            // controller's next poll until after this process
                            // exits.
                            send(json!({
                                "method": "warning",
                                "params": {"message": "provider remained live after terminal"}
                            }))?;
                        }
                        return Err("configured failure after turn completion".into());
                    }
                    if exit_after_turn_completion {
                        return Ok(());
                    }
                }
            }
            "turn/steer" => {
                send(json!({"id": id, "result": {"accepted": true}}))?;
                if linger_after_turn_start {
                    send(json!({
                        "method": "item/completed",
                        "params": {
                            "threadId": state.thread_id,
                            "turnId": state.active_turn_id,
                            "item": {
                                "id": "steering-acknowledgement-1",
                                "type": "steering_acknowledgement",
                                "status": "completed"
                            }
                        }
                    }))?;
                }
            }
            "turn/interrupt" => {
                interrupt_count += 1;
                if fail_first_interrupt && interrupt_count == 1 {
                    send(json!({
                        "id": id,
                        "error": {"code": -32001, "message": "configured interrupt failure"}
                    }))?;
                } else {
                    send(json!({"id": id, "result": {"accepted": true}}))?;
                    if flood_runtime_requests_on_interrupt {
                        send_runtime_request_flood(
                            &state,
                            interrupt_count,
                            160,
                            "Where should we deploy?",
                        )?;
                    }
                    if flood_large_runtime_requests_on_interrupt {
                        let question = "x".repeat(2 * 1024 * 1024);
                        send_runtime_request_flood(&state, interrupt_count, 3, &question)?;
                    }
                    if !accept_interrupt_without_terminal
                        && !(accept_interrupt_without_terminal_once
                            && interrupt_count == if fail_first_interrupt { 2 } else { 1 })
                    {
                        if let Some(delay_ms) = interrupt_terminal_delay_ms {
                            if !delayed_interrupt_terminal_scheduled {
                                delayed_interrupt_terminal_scheduled = true;
                                let delayed_state_path = state_path.clone();
                                let mut delayed_state = state.clone();
                                thread::spawn(move || {
                                    thread::sleep(Duration::from_millis(delay_ms));
                                    if let Err(error) = finish_turn(
                                        &delayed_state_path,
                                        &mut delayed_state,
                                        "interrupted",
                                    ) {
                                        eprintln!(
                                            "failed to emit delayed interrupt terminal: {error}"
                                        );
                                    }
                                });
                            }
                        } else {
                            finish_turn(&state_path, &mut state, "interrupted")?;
                        }
                    }
                }
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
