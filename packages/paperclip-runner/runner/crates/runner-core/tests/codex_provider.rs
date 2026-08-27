use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use paperclip_runner_core::codex_provider::{
    CodexDynamicTool, CodexProvider, CodexProviderConfig, CodexProviderEvent,
};
use paperclip_runner_core::durable::{Command, CommandExecutor, DurableRunnerError, PolledEvent};
use paperclip_runner_core::provider_backend::CodexCommandExecutor;
use paperclip_runner_core::provider_events::normalize_codex_notification;
use serde_json::{json, Value};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

fn temporary_directory(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-runner-codex-{label}-{}-{}",
        std::process::id(),
        NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).expect("create Codex integration-test directory");
    directory
}

fn provider_config(directory: &Path, switches: &[&str]) -> CodexProviderConfig {
    let mut args = vec![
        "--state-file".to_owned(),
        directory
            .join("fake-state.json")
            .to_string_lossy()
            .into_owned(),
        "--call-log".to_owned(),
        directory.join("calls.log").to_string_lossy().into_owned(),
    ];
    args.extend(switches.iter().map(|value| (*value).to_owned()));
    CodexProviderConfig {
        provider: "codex".to_owned(),
        driver: "codex_app_server".to_owned(),
        provider_version: "fake-1".to_owned(),
        command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
        args,
        cwd: std::env::current_dir()
            .expect("resolve test cwd")
            .to_string_lossy()
            .into_owned(),
        model: Some("test-model".to_owned()),
        provider_session_id: None,
        instructions: "Stay inside the test workspace.".to_owned(),
        approval_policy: "never".to_owned(),
    }
}

fn semantic_tool() -> CodexDynamicTool {
    CodexDynamicTool {
        name: "report_progress".to_owned(),
        description: "Append one durable progress update.".to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "idempotencyKey": {"type": "string"},
                "body": {"type": "string"}
            },
            "required": ["idempotencyKey", "body"],
            "additionalProperties": false,
        }),
    }
}

fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Command {
    Command {
        schema: "paperclip.prp.command.v1".to_owned(),
        command_id: id.to_owned(),
        controller_seq: sequence,
        command_type: command_type.to_owned(),
        issued_at: "2026-08-24T00:00:00.000Z".to_owned(),
        deadline_at: None,
        precondition: None,
        payload,
    }
}

fn call_count(directory: &Path, method: &str) -> usize {
    fs::read_to_string(directory.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == method)
        .count()
}

fn poll_and_ack(
    executor: &mut CodexCommandExecutor,
) -> Result<Vec<PolledEvent>, DurableRunnerError> {
    let events = executor.poll_events()?;
    executor.acknowledge_events(events.len())?;
    Ok(events)
}

#[test]
fn codex_transport_buffers_notifications_while_waiting_for_responses() {
    let directory = temporary_directory("buffering");
    let config = provider_config(&directory, &["--notification-before-response"]);
    let mut provider = CodexProvider::start(&config, None, &[]).expect("start fake Codex provider");
    let event = provider
        .poll()
        .expect("poll buffered notification")
        .expect("buffered notification is available");
    let CodexProviderEvent::Notification { method, params } = event else {
        panic!("expected the pre-response warning notification");
    };
    assert_eq!(method, "warning");
    let normalized = normalize_codex_notification(&method, &params);
    assert_eq!(normalized[0].event_type, "provider.notice.recorded");

    provider
        .start_turn("Complete the fake task.", &config.cwd)
        .expect("start provider turn");
    let mut event_types = Vec::new();
    let mut usage_provider_turn_id = None;
    for _ in 0..16 {
        if let Some(CodexProviderEvent::Notification { method, params }) =
            provider.poll().expect("poll provider event")
        {
            for event in normalize_codex_notification(&method, &params) {
                if event.event_type == "usage.reported" {
                    usage_provider_turn_id =
                        event.payload["providerTurnId"].as_str().map(str::to_owned);
                }
                event_types.push(event.event_type);
            }
        }
        if event_types.iter().any(|event| event == "turn.completed") {
            break;
        }
    }
    assert!(event_types.iter().any(|event| event == "turn.started"));
    assert!(event_types.iter().any(|event| event == "item.completed"));
    assert!(event_types.iter().any(|event| event == "usage.reported"));
    assert!(event_types.iter().any(|event| event == "turn.completed"));
    assert_eq!(usage_provider_turn_id.as_deref(), Some("provider-turn-1"));
    provider.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_resumes_the_active_thread_without_restarting_the_turn() {
    let directory = temporary_directory("resume");
    let config = provider_config(&directory, &["--hold-turn"]);
    let mut first = CodexCommandExecutor::new(&directory);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config}),
        ))
        .expect("prepare Codex provider");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open Codex session");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Hold this turn for recovery."}),
        ))
        .expect("start held provider turn");
    assert_eq!(call_count(&directory, "turn/start"), 1);
    first.shutdown().expect("stop first provider process");
    drop(first);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let snapshot = recovered
        .execute(&command("snapshot", 4, "session.snapshot", json!({})))
        .expect("restore provider session");
    assert_eq!(snapshot.result["status"], "turn_active");
    assert_eq!(snapshot.result["activeProviderTurnId"], "provider-turn-1");
    assert_eq!(call_count(&directory, "turn/start"), 1);
    assert_eq!(call_count(&directory, "thread/resume"), 1);
    assert_eq!(call_count(&directory, "thread/read"), 1);

    recovered
        .execute(&command("interrupt", 5, "turn.interrupt", json!({})))
        .expect("interrupt recovered provider turn");
    let mut terminal_seen = false;
    for _ in 0..16 {
        let events = poll_and_ack(&mut recovered).expect("poll interrupted turn");
        terminal_seen |= events
            .iter()
            .any(|event| event.event_type == "turn.interrupted");
        if terminal_seen {
            break;
        }
    }
    assert!(terminal_seen);
    recovered
        .shutdown()
        .expect("stop recovered provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_resumes_one_pending_native_tool_call_with_the_same_identity() {
    let directory = temporary_directory("semantic-resume");
    let config = provider_config(&directory, &["--emit-semantic-tool"]);
    let tools = vec![semantic_tool()];
    let mut first = CodexCommandExecutor::new(&directory);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config, "semanticTools": tools}),
        ))
        .expect("prepare Codex provider with its authorized tool inventory");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open Codex session");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Read the active task once."}),
        ))
        .expect("start provider turn");

    let mut first_input = None;
    for _ in 0..32 {
        let events = first.poll_events().expect("poll semantic tool input");
        if let Some(event) = events
            .iter()
            .find(|event| event.event_type == "semantic_tool.input")
        {
            first_input = Some(event.clone());
            first
                .acknowledge_events(events.len())
                .expect("acknowledge semantic tool input");
            break;
        }
        first
            .acknowledge_events(events.len())
            .expect("acknowledge events before semantic input");
    }
    let first_input = first_input.expect("observe semantic tool input");
    assert_eq!(first_input.payload["callId"], "semantic-call-1");
    assert_eq!(first_input.payload["operationId"], "report_progress");
    assert_eq!(call_count(&directory, "turn/start"), 1);
    first.shutdown().expect("stop first provider process");
    drop(first);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let result = recovered
        .execute(&command(
            "semantic-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "result": {
                    "ok": true,
                    "value": {"task": "NCV-1"},
                    "resultReceipt": {
                        "schema": "paperclip.prp.semantic_tool.v1",
                        "schemaVersion": 1,
                        "phase": "result",
                        "operationId": "report_progress",
                        "callId": "semantic-call-1",
                        "correlation": {
                            "runId": "run-1",
                            "normalizedSessionId": "session-1",
                            "turnId": "turn-1",
                            "itemId": "item-1"
                        },
                        "idempotencyKey": "native-resume-proof-1",
                        "content": {
                            "digest": format!("sha256:{}", "a".repeat(64)),
                            "redactionDisposition": "digest_only",
                            "references": []
                        },
                        "outcome": "succeeded",
                        "code": "ok",
                        "retryable": false,
                        "authorizationBoundary": "active_task",
                        "operationReceiptId": "receipt-1"
                    }
                },
                "isError": false,
            }),
        ))
        .expect("persist semantic tool result before Codex reissues its request");
    assert_eq!(result.result["status"], "deferred");
    let mut reconciled = None;
    let mut completed = false;
    for _ in 0..32 {
        let events = recovered
            .poll_events()
            .expect("poll reconciled semantic call");
        completed |= events
            .iter()
            .any(|event| event.event_type == "turn.completed");
        if let Some(event) = events
            .iter()
            .find(|event| event.event_type == "semantic_tool.reconciled")
        {
            reconciled = Some(event.clone());
            recovered
                .acknowledge_events(events.len())
                .expect("acknowledge reconciliation");
            break;
        }
        recovered
            .acknowledge_events(events.len())
            .expect("acknowledge events before reconciliation");
    }
    let reconciled = reconciled.expect("observe native tool-call reconciliation");
    assert_eq!(reconciled.payload["callId"], first_input.payload["callId"]);
    assert_eq!(
        reconciled.payload["outcome"],
        "completed_result_redelivered"
    );
    assert_eq!(call_count(&directory, "thread/resume"), 1);
    assert_eq!(call_count(&directory, "turn/start"), 1);

    if !completed {
        for _ in 0..256 {
            let events = poll_and_ack(&mut recovered).expect("poll completed resumed turn");
            completed |= events
                .iter()
                .any(|event| event.event_type == "turn.completed");
            if completed {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    assert!(completed);
    assert_eq!(call_count(&directory, "semantic_tool/result"), 1);
    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn provider_exit_preserves_and_reconciles_the_active_turn() {
    let directory = temporary_directory("exit-active-turn");
    let config = provider_config(&directory, &["--exit-after-turn-start"]);
    let mut executor = CodexCommandExecutor::new(&directory);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config}),
        ))
        .expect("prepare Codex provider");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open Codex session");
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Keep the native turn active while the provider exits."}),
        ))
        .expect("start provider turn");

    let mut provider_exit_seen = false;
    for _ in 0..32 {
        provider_exit_seen |= poll_and_ack(&mut executor)
            .expect("poll provider exit")
            .iter()
            .any(|event| event.event_type == "session.failed");
        if provider_exit_seen {
            break;
        }
    }
    assert!(provider_exit_seen);
    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after exit"),
    )
    .expect("parse provider state after exit");
    assert_eq!(persisted["lifecycle"], "provider_exited");
    assert_eq!(persisted["activeProviderTurnId"], "provider-turn-1");

    let interrupted = executor
        .execute(&command("interrupt", 4, "turn.interrupt", json!({})))
        .expect("interrupt reconciled provider turn");
    assert_eq!(interrupted.result["status"], "interrupt_requested");
    assert_eq!(call_count(&directory, "thread/resume"), 1);
    assert_eq!(call_count(&directory, "thread/read"), 1);
    assert_eq!(call_count(&directory, "turn/interrupt"), 1);

    let mut terminal_seen = false;
    for _ in 0..32 {
        terminal_seen |= poll_and_ack(&mut executor)
            .expect("poll reconciled interruption")
            .iter()
            .any(|event| event.event_type == "turn.interrupted");
        if terminal_seen {
            break;
        }
    }
    assert!(terminal_seen);
    executor.shutdown().expect("stop resumed provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn unacknowledged_provider_events_survive_executor_restart() {
    let directory = temporary_directory("pending-event-recovery");
    let config = provider_config(&directory, &["--emit-question"]);
    let mut first = CodexCommandExecutor::new(&directory);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config}),
        ))
        .expect("prepare Codex provider");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open Codex session");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Emit a durable question."}),
        ))
        .expect("start provider turn");

    let mut retained = None;
    for _ in 0..32 {
        let events = first.poll_events().expect("poll provider events");
        if events
            .iter()
            .any(|event| event.event_type == "runtime_request.created")
        {
            retained = Some(events);
            break;
        }
        first
            .acknowledge_events(events.len())
            .expect("acknowledge events before the question");
    }
    let retained = retained.expect("observe a durable runtime request");
    first.shutdown().expect("stop first provider process");
    drop(first);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let replayed = recovered
        .poll_events()
        .expect("reload unacknowledged provider events");
    assert_eq!(&replayed[..retained.len()], retained.as_slice());
    recovered
        .acknowledge_events(replayed.len())
        .expect("acknowledge reloaded provider events");
    recovered
        .shutdown()
        .expect("stop recovered provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn structured_question_round_trips_through_the_normalized_backend() {
    let directory = temporary_directory("questions");
    let config = provider_config(&directory, &["--emit-question"]);
    let mut executor = CodexCommandExecutor::new(&directory);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({"provider": config}),
        ))
        .expect("prepare provider");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open provider session");
    let started = executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Ask for deployment input."}),
        ))
        .expect("start provider turn");
    assert_eq!(started.events.len(), 1);
    assert_eq!(started.events[0].0, "turn.accepted");

    let mut question_set = None;
    let mut provider_started_events = 0;
    for _ in 0..16 {
        for event in poll_and_ack(&mut executor).expect("poll question") {
            provider_started_events += usize::from(event.event_type == "turn.started");
            if event.event_type == "runtime_request.created" {
                assert_eq!(
                    event.payload["request"]["schema"],
                    "paperclip.runtime_request.v2"
                );
                question_set = event.payload.pointer("/request/input").cloned();
            }
        }
        if question_set.is_some() {
            break;
        }
    }
    let question_set = question_set.expect("normalized question set is emitted");
    assert_eq!(provider_started_events, 1);
    assert_eq!(question_set["schema"], "paperclip.question_set.v1");
    assert_eq!(
        question_set["questions"][0]["options"][0]["label"],
        "Staging"
    );

    executor
        .execute(&command(
            "resolve",
            4,
            "request.resolve",
            json!({
                "requestId": "runtime-request-1",
                "response": {
                    "schema": "paperclip.question_response.v1",
                    "answers": {"environment": {"selectedOptionIds": ["option-1"]}}
                }
            }),
        ))
        .expect("deliver normalized response");
    let mut completed = false;
    for _ in 0..16 {
        completed |= poll_and_ack(&mut executor)
            .expect("poll completed question turn")
            .iter()
            .any(|event| event.event_type == "turn.completed");
        if completed {
            break;
        }
    }
    assert!(completed);
    executor.shutdown().expect("stop provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_completion_emits_the_bound_result_before_the_terminal_event() {
    let directory = temporary_directory("completion-contract");
    let config = provider_config(&directory, &[]);
    let mut executor = CodexCommandExecutor::new(&directory);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "completionContract": {
                    "revision": "sha256:test-contract",
                    "criterionIds": ["criterion_test_task"]
                }
            }),
        ))
        .expect("prepare provider with completion contract");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open provider session");
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Complete the fake native run."}),
        ))
        .expect("start provider turn");

    let mut emitted = Vec::new();
    for _ in 0..32 {
        emitted.extend(poll_and_ack(&mut executor).expect("poll terminal events"));
        if emitted
            .iter()
            .any(|event| event.event_type == "run.terminal")
        {
            break;
        }
    }
    let result_index = emitted
        .iter()
        .position(|event| event.event_type == "run.result.proposed")
        .expect("result proposal is emitted");
    let terminal_index = emitted
        .iter()
        .position(|event| event.event_type == "run.terminal")
        .expect("terminal event is emitted");
    assert!(result_index < terminal_index);
    assert_eq!(
        emitted[result_index].payload["summary"],
        "Codex completed the fake turn."
    );
    assert_eq!(
        emitted[result_index].payload["completionClaim"]["contractRevision"],
        "sha256:test-contract"
    );
    assert_eq!(
        emitted[terminal_index].payload["runTerminalState"],
        "succeeded"
    );

    executor.shutdown().expect("stop provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}
