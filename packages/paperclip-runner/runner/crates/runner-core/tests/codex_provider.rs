use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use paperclip_runner_core::codex_provider::{
    CodexProvider, CodexProviderConfig, CodexProviderEvent,
};
use paperclip_runner_core::durable::{
    Command, CommandExecutor, DurableRunnerConfig, DurableRunnerError, PolledEvent,
};
use paperclip_runner_core::provider_backend::CodexCommandExecutor;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ProviderToolBridge,
    ToolResult, TOOL_SET_SCHEMA,
};
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

#[test]
fn provider_receives_the_isolated_codex_auth_home() {
    let directory = temporary_directory("isolated-auth-home");
    fs::write(directory.join("auth.json"), r#"{"auth_mode":"apikey"}"#)
        .expect("write isolated Codex auth fixture");

    // Run this assertion in a dedicated subprocess because environment
    // mutation is process-global and Rust executes tests concurrently.
    let test_binary = std::env::current_exe().expect("resolve current test binary");
    let status = std::process::Command::new(test_binary)
        .arg("provider_receives_isolated_codex_auth_home_subprocess")
        .arg("--exact")
        .arg("--ignored")
        .arg("--nocapture")
        .env("PAPERCLIP_CODEX_AUTH_TEST_HOME", &directory)
        .env("HOME", &directory)
        .env("CODEX_HOME", &directory)
        .status()
        .expect("run isolated auth-home assertion");
    assert!(status.success());
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
#[ignore = "subprocess helper for provider_receives_the_isolated_codex_auth_home"]
fn provider_receives_isolated_codex_auth_home_subprocess() {
    let Some(directory) = std::env::var_os("PAPERCLIP_CODEX_AUTH_TEST_HOME").map(PathBuf::from)
    else {
        return;
    };
    let config = provider_config(&directory, &["--require-codex-home-auth"]);
    let mut provider = CodexProvider::start(&config, None)
        .expect("Codex provider should read auth from the isolated CODEX_HOME");
    provider.shutdown().expect("stop fake Codex provider");
}

fn task_context_tool() -> AuthorizedTool {
    AuthorizedTool {
        operation_id: "get_task_context".to_owned(),
        version: 1,
        description: "Read task context.".to_owned(),
        input_schema: json!({"type": "object"}),
        response_schema: json!({"type": "object"}),
    }
}

fn task_context_tool_set() -> AuthorizedToolSet {
    let operations = vec![task_context_tool()];
    AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    }
}

fn durable_config(directory: &Path) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1:3000/runner".to_owned(),
        ca_bundle_path: None,
        state_dir: directory.to_path_buf(),
        runner_instance_id: "runner-1".to_owned(),
        environment_lease_id: "lease-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
        runner_version: "test-1".to_owned(),
        runner_digest: format!("sha256:{}", "a".repeat(64)),
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        max_outbox_bytes: 16 * 1024 * 1024,
        p0_reserve_bytes: 1024 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: std::time::Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: std::time::Duration::from_secs(5),
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

fn recorded_tool_responses(directory: &Path) -> Vec<String> {
    fs::read_to_string(directory.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.strip_prefix("tool-response:").map(str::to_owned))
        .collect()
}

fn poll_and_ack(
    executor: &mut CodexCommandExecutor,
) -> Result<Vec<PolledEvent>, DurableRunnerError> {
    let events = executor.poll_events()?;
    executor.acknowledge_events(events.len())?;
    Ok(events)
}

fn wait_for_notification(provider: &mut CodexProvider, expected_method: &str) -> Value {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match provider.poll().expect("poll provider notification") {
            Some(CodexProviderEvent::Notification { method, params }) => {
                if method == expected_method {
                    return params;
                }
            }
            Some(_) => {}
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    }
    panic!("did not observe Codex {expected_method} notification before the deadline");
}

fn wait_for_provider_error(provider: &mut CodexProvider) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match provider.poll() {
            Err(error) => return error.to_string(),
            Ok(Some(_)) => {}
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    }
    panic!("did not observe the expected Codex provider error before the deadline");
}

fn wait_for_executor_event(
    executor: &mut CodexCommandExecutor,
    expected_event_type: &str,
) -> PolledEvent {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let events = poll_and_ack(executor).expect("poll Codex executor event");
        if let Some(event) = events
            .into_iter()
            .find(|event| event.event_type == expected_event_type)
        {
            return event;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("did not observe Codex {expected_event_type} event before the deadline");
}

fn wait_for_provider_exit(provider: &mut CodexProvider) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if matches!(
            provider.poll().expect("poll terminated provider"),
            Some(CodexProviderEvent::Exited { .. })
        ) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("the provider accepted a reused turn identity but remained live");
}

fn wait_for_reused_identity_reap(provider: &mut CodexProvider) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match provider.poll() {
            Err(error) => assert!(
                error.to_string().contains("reused a settled"),
                "unexpected error while reaping reused provider identity: {error}"
            ),
            Ok(Some(CodexProviderEvent::Exited {
                completed_turn_authoritative,
                ..
            })) => {
                assert!(
                    !completed_turn_authoritative,
                    "accepted identity reuse must revoke prior completion authority"
                );
                return;
            }
            Ok(Some(_)) => {}
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    }
    panic!("the provider accepted a reused turn identity but was not reaped");
}

fn wait_for_fake_provider_idle(directory: &Path) {
    let state_path = directory.join("fake-state.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let active_turn_id = fs::read(&state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|state| state.get("activeTurnId").cloned());
        if active_turn_id == Some(Value::Null) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("the fake provider did not persist its idle turn state before the deadline");
}

fn saturate_provider_tool_receipts(directory: &Path) {
    let mut bridge = ProviderToolBridge::default();
    bridge.prepare(task_context_tool_set()).unwrap();
    for index in 0..4_096 {
        let call_id = format!("retained-call-{index}");
        bridge
            .begin_call(call_id.clone(), "get_task_context".into(), json!({}))
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".into(),
                result: json!({"ok": true}),
                is_error: false,
            })
            .unwrap();
    }
    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read provider state")).unwrap();
    persisted["toolBridge"] = serde_json::to_value(bridge).unwrap();
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write saturated provider state");
}

#[test]
fn codex_transport_buffers_notifications_while_waiting_for_responses() {
    let directory = temporary_directory("buffering");
    let config = provider_config(&directory, &["--notification-before-response"]);
    let mut provider = CodexProvider::start(&config, None).expect("start fake Codex provider");
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
    for _ in 0..16 {
        if let Some(CodexProviderEvent::Notification { method, params }) =
            provider.poll().expect("poll provider event")
        {
            event_types.extend(
                normalize_codex_notification(&method, &params)
                    .into_iter()
                    .map(|event| event.event_type),
            );
        }
        if event_types.iter().any(|event| event == "turn.completed") {
            break;
        }
    }
    assert!(event_types.iter().any(|event| event == "turn.started"));
    assert!(event_types.iter().any(|event| event == "item.completed"));
    assert!(event_types.iter().any(|event| event == "usage.reported"));
    assert!(event_types.iter().any(|event| event == "turn.completed"));
    provider.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_dynamic_tool_round_trips_through_the_provider_boundary() {
    let directory = temporary_directory("dynamic-tool");
    let config = provider_config(&directory, &["--require-dynamic-tool", "--emit-tool-call"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Inspect the fake task.", &config.cwd)
        .expect("start provider turn");

    let mut delivered = false;
    let mut completed = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match provider.poll().expect("poll semantic tool event") {
            Some(CodexProviderEvent::ToolCall {
                call_id,
                operation_id,
                input,
            }) => {
                assert_eq!(call_id, "semantic-call-1");
                assert_eq!(operation_id, "get_task_context");
                assert_eq!(input, json!({}));
                assert!(provider
                    .deliver_tool_result(&ToolResult {
                        call_id: call_id.clone(),
                        operation_id: "another_operation".to_owned(),
                        result: json!({"ok": true}),
                        is_error: false,
                    })
                    .is_err());
                assert!(provider
                    .deliver_tool_result(&ToolResult {
                        call_id: call_id.clone(),
                        operation_id: operation_id.clone(),
                        result: json!({"value": "x".repeat(1024 * 1024)}),
                        is_error: false,
                    })
                    .is_err());
                provider
                    .deliver_tool_result(&ToolResult {
                        call_id,
                        operation_id,
                        result: json!({"ok": true, "task": {"id": "task-1"}}),
                        is_error: false,
                    })
                    .expect("deliver correlated semantic result");
                delivered = true;
            }
            Some(CodexProviderEvent::Notification { method, .. }) if method == "turn/completed" => {
                completed = true;
                break;
            }
            _ => {}
        }
    }
    assert!(delivered, "Codex emitted its authorized tool call");
    assert!(completed, "Codex completed after the semantic result");
    provider.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_replay_of_a_completed_tool_call_id_in_the_same_turn() {
    let directory = temporary_directory("completed-tool-call-replay");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--replay-completed-tool-call",
        ],
    );
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Inspect the fake task once.", &config.cwd)
        .expect("start provider turn");

    let first_call = (0..32)
        .find_map(|_| match provider.poll().expect("poll first tool call") {
            Some(CodexProviderEvent::ToolCall {
                call_id,
                operation_id,
                ..
            }) => Some((call_id, operation_id)),
            _ => None,
        })
        .expect("observe the first semantic tool call");
    provider
        .deliver_tool_result(&ToolResult {
            call_id: first_call.0,
            operation_id: first_call.1,
            result: json!({"ok": true, "task": {"id": "task-1"}}),
            is_error: false,
        })
        .expect("deliver the first semantic result");

    let replay_error = (0..32)
        .find_map(|_| provider.poll().err())
        .expect("same-turn replay of the completed call id is rejected");
    assert!(
        replay_error
            .to_string()
            .contains("reused a completed tool call id"),
        "unexpected replay error: {replay_error}"
    );

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_completion_cancels_pending_tool_request_before_releasing_capacity() {
    let directory = temporary_directory("completed-tool-call");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--complete-after-tool-call",
        ],
    );
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Complete without waiting for the tool result.", &config.cwd)
        .expect("start provider turn");

    let first_call = (0..32)
        .find_map(
            |_| match provider.poll().expect("poll first provider turn") {
                Some(CodexProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    ..
                }) => Some((call_id, operation_id)),
                _ => None,
            },
        )
        .expect("observe the first semantic tool call");
    let completed = (0..32).any(|_| {
        matches!(
            provider.poll().expect("poll first completion"),
            Some(CodexProviderEvent::Notification { method, .. })
                if method == "turn/completed"
        )
    });
    assert!(completed, "Codex completed with a tool call still pending");
    for _ in 0..100 {
        if call_count(&directory, "tool-response:failure") == 1 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(
        call_count(&directory, "tool-response:failure"),
        1,
        "Paperclip explicitly resolves the provider RPC as cancelled",
    );
    assert!(provider
        .deliver_tool_result(&ToolResult {
            call_id: first_call.0,
            operation_id: first_call.1,
            result: json!({"ok": true}),
            is_error: false,
        })
        .is_err());

    provider
        .start_turn("Reuse the released provider identities.", &config.cwd)
        .expect("start another provider turn");
    let second_call = (0..32).any(|_| {
        matches!(
            provider.poll().expect("poll second provider turn"),
            Some(CodexProviderEvent::ToolCall { call_id, .. })
                if call_id == "semantic-call-1"
        )
    });
    assert!(second_call, "the next turn can reuse the released call id");

    provider.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_completion_survives_failed_pending_request_cancellation() {
    let directory = temporary_directory("completed-tool-call-provider-exit");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--complete-after-tool-call",
            "--exit-after-tool-call-completion",
        ],
    );
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Complete and exit with a tool call pending.", &config.cwd)
        .expect("start provider turn");

    let call = (0..32)
        .find_map(|_| match provider.poll().expect("poll pending tool call") {
            Some(CodexProviderEvent::ToolCall {
                call_id,
                operation_id,
                ..
            }) => Some((call_id, operation_id)),
            _ => None,
        })
        .expect("observe the pending semantic tool call");
    std::thread::sleep(std::time::Duration::from_millis(50));

    let completed = (0..32).any(|_| {
        matches!(
            provider
                .poll()
                .expect("the received completion survives closed provider stdin"),
            Some(CodexProviderEvent::Notification { method, .. })
                if method == "turn/completed"
        )
    });
    assert!(completed, "the terminal notification remains authoritative");
    assert!(provider
        .deliver_tool_result(&ToolResult {
            call_id: call.0,
            operation_id: call.1,
            result: json!({"ok": true}),
            is_error: false,
        })
        .is_err());

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn clean_idle_provider_exit_preserves_completed_turn_success() {
    let directory = temporary_directory("completion-output-clean-provider-exit");
    let config = provider_config(
        &directory,
        &[
            "--emit-post-completion-warning",
            "--exit-after-turn-completion",
        ],
    );
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Complete, produce idle output, then exit.", &config.cwd)
        .expect("start provider turn");

    let mut completion_seen = false;
    let mut post_completion_output_seen = false;
    let mut clean_exit = None;
    let exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < exit_deadline {
        match provider.poll().expect("poll completion and clean exit") {
            Some(CodexProviderEvent::Notification { method, .. }) => {
                completion_seen |= method == "turn/completed";
                post_completion_output_seen |= completion_seen && method == "warning";
            }
            Some(CodexProviderEvent::Exited {
                success,
                completed_turn_authoritative,
                completion_reconciles_exit,
                ..
            }) => {
                clean_exit = Some((
                    success,
                    completed_turn_authoritative,
                    completion_reconciles_exit,
                ));
                break;
            }
            Some(_) | None => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }

    assert!(completion_seen);
    assert!(post_completion_output_seen);
    assert_eq!(clean_exit, Some((true, true, false)));
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn clean_provider_exit_does_not_refail_a_completed_turn() {
    let directory = temporary_directory("completion-then-clean-exit");
    let config = provider_config(
        &directory,
        &[
            "--emit-post-completion-warning",
            "--exit-after-turn-completion",
            "--exit-after-thread-read",
        ],
    );
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
            json!({"text": "Complete before exiting cleanly."}),
        ))
        .expect("start provider turn");

    let mut event_types = Vec::new();
    let exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < exit_deadline {
        event_types.extend(
            poll_and_ack(&mut executor)
                .expect("poll completion and clean exit")
                .into_iter()
                .map(|event| event.event_type),
        );
        if event_types.iter().any(|event| event == "turn.completed")
            && event_types
                .iter()
                .any(|event| event == "provider.notice.recorded")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }

    // The warning is ordered after the terminal and before the clean exit, so
    // seeing it proves the completed process entered the idle/output path that
    // previously cleared expected shutdown authority.
    assert!(event_types.iter().any(|event| event == "turn.completed"));
    assert!(event_types
        .iter()
        .any(|event| event == "provider.notice.recorded"));
    for _ in 0..32 {
        event_types.extend(
            poll_and_ack(&mut executor)
                .expect("poll after provider exit")
                .into_iter()
                .map(|event| event.event_type),
        );
    }

    assert!(!event_types.iter().any(|event| event == "session.failed"));
    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after clean exit"),
    )
    .expect("parse provider state after clean exit");
    assert_eq!(persisted["lifecycle"], "session_open");
    assert!(persisted["activeProviderTurnId"].is_null());

    drop(executor);
    let mut recovered = CodexCommandExecutor::new(&directory);
    let recovered_events = poll_and_ack(&mut recovered)
        .expect("poll clean exit from a freshly resumed completed thread");
    assert!(!recovered_events
        .iter()
        .any(|event| event.event_type == "session.failed"));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_reaps_before_rotating_full_provider_identity_epochs() {
    let directory = temporary_directory("provider-identity-epoch-rollover");
    let config = provider_config(&directory, &["--require-dynamic-tool", "--emit-tool-call"]);
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("prepare Codex provider");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open Codex session");
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value = serde_json::from_slice(
        &fs::read(&state_path).expect("read provider state before epoch rollover"),
    )
    .expect("parse provider state before epoch rollover");
    let prior_generation = persisted["providerProcessGeneration"]
        .as_u64()
        .expect("provider generation is persisted");
    persisted["settledProviderTurnIds"] = Value::Array(
        (0..4_096)
            .map(|index| Value::String(format!("provider-turn-{index}")))
            .collect(),
    );
    persisted["completedTurnAuthoritative"] = Value::Bool(true);
    persisted["completedTurnProcessGeneration"] = json!(prior_generation);
    persisted["completedProviderTurnId"] = json!("provider-turn-4095");
    persisted["toolBridge"]["settledCallIds"] = Value::Array(
        (0..65_536)
            .map(|index| Value::String(format!("semantic-call-{index}")))
            .collect(),
    );
    persisted["toolBridge"]["durableRunReceiptLimitReached"] = Value::Bool(true);
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write full provider identity epochs");

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    recovered
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Start after a verified provider epoch rollover."}),
        ))
        .expect("roll over the idle provider generation and start fresh work");

    let rolled: Value = serde_json::from_slice(
        &fs::read(&state_path).expect("read provider state after epoch rollover"),
    )
    .expect("parse provider state after epoch rollover");
    assert!(rolled["providerProcessGeneration"].as_u64().unwrap() > prior_generation);
    assert_eq!(
        rolled["settledProviderTurnIds"],
        json!(["provider-turn-4095"])
    );
    assert_eq!(rolled["settledProviderTurnFilter"], json!({"words": []}));
    assert_eq!(rolled["toolBridge"]["settledCallIds"], json!([]));
    assert_eq!(
        rolled["toolBridge"]["settledCallFilter"],
        json!({"words": []})
    );
    assert!(rolled["toolBridge"]["durableRunReceiptLimitReached"].is_null());

    let mut event_types = Vec::new();
    let semantic_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < semantic_deadline {
        event_types.extend(
            poll_and_ack(&mut recovered)
                .expect("poll semantic work in the fresh provider epoch")
                .into_iter()
                .map(|event| event.event_type),
        );
        if event_types
            .iter()
            .any(|event| event == "semantic_tool.input")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(event_types
        .iter()
        .any(|event| event == "semantic_tool.input"));

    recovered.shutdown().expect("stop rolled provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_closes_when_identity_rollover_resumes_unowned_work() {
    let directory = temporary_directory("provider-identity-rollover-unowned-work");
    let config = provider_config(&directory, &["--resume-unowned-turn-when-marked"]);
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
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value = serde_json::from_slice(
        &fs::read(&state_path).expect("read provider state before unsafe rollover"),
    )
    .expect("parse provider state before unsafe rollover");
    persisted["settledProviderTurnIds"] = Value::Array(
        (0..4_096)
            .map(|index| Value::String(format!("provider-turn-{index}")))
            .collect(),
    );
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write full provider identity epoch");

    let mut recovered = CodexCommandExecutor::new(&directory);
    poll_and_ack(&mut recovered).expect("attach an idle provider before rollover");
    wait_for_fake_provider_idle(&directory);
    let attached: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read attached provider state"))
            .expect("parse attached provider state");
    let attached_generation = attached["providerProcessGeneration"]
        .as_u64()
        .expect("attached provider generation is persisted");

    // Race the provider's idle snapshot with work Paperclip never dispatched.
    // The replacement process observes this turn during thread/resume and must
    // close the durable run instead of leaving a quarantined session open.
    fs::write(directory.join("resume-unowned-turn"), b"armed")
        .expect("arm unowned provider work before rollover");
    let resumes_before_rollover = call_count(&directory, "thread/resume");
    let error = recovered
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Never overlap the unowned provider turn."}),
        ))
        .expect_err("identity rollover fails closed after resuming unowned work");
    assert!(error
        .to_string()
        .contains("identity epoch rollover failed closed after an invalid accepted identity"));
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_rollover + 1,
    );

    let closed: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read fail-closed provider state"))
            .expect("parse fail-closed provider state");
    assert_eq!(closed["lifecycle"], "closed");
    assert!(closed["activeProviderTurnId"].is_null());
    assert_eq!(closed["ambiguousTurnStartPending"], false);
    assert_eq!(closed["completedTurnAuthoritative"], false);
    assert!(closed["providerProcessGeneration"].as_u64().unwrap() > attached_generation);

    let events = poll_and_ack(&mut recovered).expect("read fail-closed rollover diagnostic");
    assert!(events.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "provider_turn_identity_invalid"
            && event.payload["paperclipAccepted"] == false
            && event.payload["providerAccepted"] == true
    }));

    let resumes_before_retry = call_count(&directory, "thread/resume");
    assert!(recovered
        .execute(&command(
            "turn-retry",
            4,
            "turn.start",
            json!({"text": "Do not resume the quarantined provider."}),
        ))
        .unwrap_err()
        .to_string()
        .contains("provider session is closed"));
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_retry,
        "closed rollover state must never resume the unowned provider turn",
    );

    recovered.shutdown().expect("close fail-closed executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn direct_provider_reaps_before_rotating_a_full_turn_identity_epoch() {
    let directory = temporary_directory("direct-turn-identity-epoch-rollover");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--resume-unowned-turn-when-marked",
        ],
    );
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex provider");
    let initial_process_id = provider.process_id();

    // Keep every identity exact until the process boundary makes it safe to
    // forget them. The next turn must transparently resume in a new process
    // generation instead of permanently rejecting this session.
    for index in 0..4_096 {
        provider
            .start_turn(&format!("Complete provider turn {index}."), &config.cwd)
            .expect("start provider turn before identity rollover");
        wait_for_notification(&mut provider, "turn/completed");
    }

    provider
        .start_turn(
            "Continue after the exact identity epoch fills.",
            &config.cwd,
        )
        .expect("roll over the provider process and start fresh work");
    assert_ne!(provider.process_id(), initial_process_id);
    assert_eq!(call_count(&directory, "thread/resume"), 1);
    wait_for_notification(&mut provider, "turn/completed");
    let rolled_process_id = provider.process_id();

    // Fill the next process epoch and force its resume probe to observe an
    // active turn. Rollover must retain that work instead of dispatching a
    // concurrent replacement after forgetting the old exact identities. The
    // prior generation's authoritative completion remains as one tombstone in
    // this epoch, so 4,094 additional completions fill the remaining slots.
    for index in 1..4_095 {
        provider
            .start_turn(
                &format!("Complete rolled provider turn {index}."),
                &config.cwd,
            )
            .expect("start provider turn in the rolled identity epoch");
        wait_for_notification(&mut provider, "turn/completed");
    }
    assert_eq!(provider.process_id(), rolled_process_id);
    // The terminal notification is flushed before the fake provider persists
    // its idle state. Wait for that write, then arm a one-shot resume race so
    // only the replacement generation reports unowned active work.
    wait_for_fake_provider_idle(&directory);
    fs::write(directory.join("resume-unowned-turn"), b"armed")
        .expect("arm unowned work for the replacement provider resume");
    let error = provider
        .start_turn(
            "Do not overlap the turn recovered during epoch rollover.",
            &config.cwd,
        )
        .expect_err("a resumed active turn is reaped before replacement work");
    assert!(error
        .to_string()
        .contains("resumed unowned active work; the provider was terminated"));
    assert_eq!(provider.active_provider_turn_id(), None);
    assert!(provider
        .start_turn(
            "Never admit replacement work after quarantine.",
            &config.cwd,
        )
        .unwrap_err()
        .to_string()
        .contains("quarantined after unsafe recovered work"));
    wait_for_provider_exit(&mut provider);

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn post_completion_observation_does_not_hide_same_or_resumed_process_failure() {
    let directory = temporary_directory("completion-then-nonzero-exit");
    let config = provider_config(
        &directory,
        &[
            "--emit-post-completion-warning",
            "--fail-after-turn-completion",
            "--fail-after-turn-completion-delay-ms",
            "250",
            "--fail-after-thread-read",
        ],
    );
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
            json!({"text": "Complete before exiting with an error."}),
        ))
        .expect("start provider turn");

    let mut event_types = Vec::new();
    let first_exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < first_exit_deadline {
        event_types.extend(
            poll_and_ack(&mut executor)
                .expect("poll completion and nonzero exit")
                .into_iter()
                .map(|event| event.event_type),
        );
        if event_types.iter().any(|event| event == "turn.completed")
            && event_types
                .iter()
                .any(|event| event == "provider.notice.recorded")
            && event_types.iter().any(|event| event == "session.failed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }

    assert!(event_types.iter().any(|event| event == "turn.completed"));
    assert!(event_types
        .iter()
        .any(|event| event == "provider.notice.recorded"));
    assert!(!event_types
        .iter()
        .any(|event| event == "session.reconciled"));
    assert!(event_types.iter().any(|event| event == "session.failed"));
    assert!(!event_types.iter().any(|event| event == "turn.failed"));
    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after nonzero exit"),
    )
    .expect("parse provider state after nonzero exit");
    assert_eq!(persisted["lifecycle"], "provider_exited");
    assert_eq!(persisted["completedTurnAuthoritative"], true);
    assert_eq!(persisted["providerProcessGeneration"], 1);
    assert_eq!(persisted["completedTurnProcessGeneration"], 1);

    // A fresh process restores the durable completed turn, probes it with
    // thread/read, and then exits nonzero. Recovery preserves the completed
    // run outcome, while the later idle provider failure remains visible.
    let mut recovered = CodexCommandExecutor::new(&directory);
    let mut recovered_events = Vec::new();
    let recovered_exit_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < recovered_exit_deadline {
        recovered_events
            .extend(poll_and_ack(&mut recovered).expect("poll restored provider after idle crash"));
        if recovered_events
            .iter()
            .any(|event| event.event_type == "session.failed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(recovered_events
        .iter()
        .any(|event| event.event_type == "session.failed"));
    let resumed_index = recovered_events
        .iter()
        .position(|event| event.event_type == "session.resumed")
        .expect("recovery identifies the replacement provider process");
    let resumed = &recovered_events[resumed_index];
    assert_eq!(resumed.payload["providerSessionId"], "codex-thread-1");
    assert_eq!(
        resumed.payload["providerAccountSessionId"],
        "codex-account-session"
    );
    assert!(resumed.payload["processId"]
        .as_u64()
        .is_some_and(|pid| pid > 0));
    assert_eq!(
        recovered_events
            .iter()
            .filter(|event| event.event_type == "session.resumed")
            .count(),
        1,
        "recovery identifies the replacement provider process exactly once"
    );
    assert!(!recovered_events
        .iter()
        .any(|event| event.event_type == "turn.failed"));
    let reconciled_index = recovered_events
        .iter()
        .position(|event| event.event_type == "session.reconciled")
        .expect("recovery reconciles the restored provider");
    let failed_index = recovered_events
        .iter()
        .position(|event| event.event_type == "session.failed")
        .expect("the resumed provider exit fails its session");
    assert!(resumed_index < reconciled_index);
    assert!(resumed_index < failed_index);
    assert_eq!(
        recovered_events
            .iter()
            .filter(|event| event.event_type == "session.reconciled")
            .count(),
        1,
        "recovery is reconciled once, but the resumed provider exit fails its session"
    );
    let recovered_persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after resumed exit"),
    )
    .expect("parse provider state after resumed exit");
    assert_eq!(recovered_persisted["lifecycle"], "provider_exited");
    assert_eq!(
        recovered_persisted["providerSessionId"],
        "codex-account-session"
    );
    assert_eq!(recovered_persisted["providerProcessGeneration"], 2);
    assert_eq!(recovered_persisted["completedTurnProcessGeneration"], 1);
    assert_eq!(call_count(&directory, "thread/read"), 1);

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn rejected_replacement_turn_start_preserves_result_and_exit_authority() {
    let directory = temporary_directory("completion-then-rejected-turn-start");
    let config = provider_config(&directory, &["--reject-second-turn-start"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    let first_completed = (0..32).any(|_| {
        matches!(
            provider.poll().expect("poll first turn"),
            Some(CodexProviderEvent::Notification { method, .. })
                if method == "turn/completed"
        )
    });
    assert!(
        first_completed,
        "observe the authoritative first completion"
    );

    provider
        .start_turn("Reject replacement work.", &config.cwd)
        .expect_err("the replacement turn/start returns a definite rejection");
    let mut buffered_notification_seen = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let rejected_start_exit = loop {
        if std::time::Instant::now() >= deadline {
            break None;
        }
        match provider
            .poll()
            .expect("poll exit after rejected replacement start")
        {
            Some(CodexProviderEvent::Notification { method, params })
                if method == "warning"
                    && params.get("message").and_then(Value::as_str)
                        == Some("buffered before replacement rejection") =>
            {
                buffered_notification_seen = true;
            }
            Some(CodexProviderEvent::Exited {
                success,
                completed_turn_authoritative,
                completion_reconciles_exit,
                ..
            }) => {
                break Some((
                    success,
                    completed_turn_authoritative,
                    completion_reconciles_exit,
                ));
            }
            _ => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert!(buffered_notification_seen);
    assert_eq!(rejected_start_exit, Some((false, true, false)));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn rejected_replacement_turn_start_does_not_hide_contradictory_turn_evidence() {
    let directory = temporary_directory("completion-then-contradictory-rejection");
    let config = provider_config(
        &directory,
        &[
            "--reject-second-turn-start",
            "--emit-turn-before-rejected-second-start",
        ],
    );
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    let first_completed = (0..32).any(|_| {
        matches!(
            provider.poll().expect("poll first turn"),
            Some(CodexProviderEvent::Notification { method, .. })
                if method == "turn/completed"
        )
    });
    assert!(
        first_completed,
        "observe the authoritative first completion"
    );

    provider
        .start_turn(
            "Reject replacement work after contradictory evidence.",
            &config.cwd,
        )
        .expect_err("the replacement turn/start returns a definite rejection");
    let duplicate_error = provider
        .start_turn(
            "Do not duplicate contradictory replacement work.",
            &config.cwd,
        )
        .expect_err("provider-work evidence makes the rejected response ambiguous");
    assert!(
        duplicate_error
            .to_string()
            .contains("unresolved ambiguous provider turn start"),
        "unexpected duplicate-start error: {duplicate_error}"
    );
    let mut contradictory_turn_seen = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let rejected_start_exit = loop {
        if std::time::Instant::now() >= deadline {
            break None;
        }
        match provider
            .poll()
            .expect("poll exit after contradictory replacement rejection")
        {
            Some(CodexProviderEvent::Notification { method, params })
                if method == "turn/started"
                    && params.pointer("/turn/id").and_then(Value::as_str)
                        == Some("provider-turn-contradiction") =>
            {
                contradictory_turn_seen = true;
            }
            Some(CodexProviderEvent::Exited {
                success,
                completed_turn_authoritative,
                completion_reconciles_exit,
                ..
            }) => {
                break Some((
                    success,
                    completed_turn_authoritative,
                    completion_reconciles_exit,
                ));
            }
            _ => {}
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert!(contradictory_turn_seen);
    assert_eq!(
        provider.active_provider_turn_id(),
        Some("provider-turn-contradiction")
    );
    assert_eq!(rejected_start_exit, Some((false, false, false)));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn ambiguous_or_dead_replacement_start_preserves_result_not_exit_authority() {
    for (label, switch) in [
        (
            "accepted-before-response",
            "--fail-after-accepting-second-turn-before-response",
        ),
        ("malformed-error", "--malformed-error-second-turn-start"),
    ] {
        let directory = temporary_directory(label);
        let config = provider_config(&directory, &[switch]);
        let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
        provider
            .start_turn("Complete the first turn.", &config.cwd)
            .expect("start first provider turn");
        let first_completed = (0..32).any(|_| {
            matches!(
                provider.poll().expect("poll first turn"),
                Some(CodexProviderEvent::Notification { method, .. })
                    if method == "turn/completed"
            )
        });
        assert!(
            first_completed,
            "observe the authoritative first completion for {label}"
        );

        provider
            .start_turn("Accept replacement work before failing.", &config.cwd)
            .expect_err("the accepted replacement turn has no valid response");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let ambiguous_start_exit = (0..)
            .take_while(|_| std::time::Instant::now() < deadline)
            .find_map(|_| {
                match provider
                    .poll()
                    .expect("poll exit after ambiguous replacement start")
                {
                    Some(CodexProviderEvent::Exited {
                        success,
                        completed_turn_authoritative,
                        completion_reconciles_exit,
                        ..
                    }) => Some((
                        success,
                        completed_turn_authoritative,
                        completion_reconciles_exit,
                    )),
                    Some(_) => None,
                    None => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        None
                    }
                }
            });
        assert_eq!(
            ambiguous_start_exit,
            Some((false, true, false)),
            "{label} must retain the completed result without hiding the provider failure"
        );

        fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
    }
}

#[test]
fn durable_backend_closes_after_accepted_turn_omits_its_identity() {
    let directory = temporary_directory("accepted-turn-missing-identity");
    let config = provider_config(&directory, &["--missing-id-live-turn-start"]);
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
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

    let error = executor
        .execute(&command(
            "turn-without-id",
            3,
            "turn.start",
            json!({"text": "Accept work but omit its durable identity."}),
        ))
        .expect_err("accepted work without a turn identity must fail closed");
    assert!(error.to_string().contains("omitted turn.id"));

    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read fail-closed provider state"),
    )
    .expect("parse fail-closed provider state");
    assert_eq!(persisted["lifecycle"], "closed");
    assert!(persisted["activeProviderTurnId"].is_null());

    drop(executor);
    let resumes_before_closed_restore = call_count(&directory, "thread/resume");
    let mut closed = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let events = closed
        .poll_events()
        .expect("closed invalid-identity state remains readable without resuming Codex");
    assert!(events.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "provider_turn_identity_invalid"
            && event.payload["providerTurnId"].is_null()
    }));
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_closed_restore,
        "recovery must not resume provider work accepted without a durable identity"
    );

    closed.shutdown().expect("close fail-closed executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn ambiguous_replacement_turn_adopts_one_later_completion_identity() {
    for (label, switch, omit_started) in [
        (
            "accepted-before-response-with-completion",
            "--fail-after-accepting-second-turn-before-response",
            false,
        ),
        (
            "malformed-error-with-completion",
            "--malformed-error-second-turn-start",
            false,
        ),
        (
            "missing-turn-id-with-completion",
            "--missing-id-second-turn-start",
            true,
        ),
    ] {
        let directory = temporary_directory(label);
        let mut switches = vec![switch, "--complete-ambiguous-second-turn"];
        if omit_started {
            switches.push("--omit-ambiguous-turn-started");
        }
        let config = provider_config(&directory, &switches);
        let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
        provider
            .start_turn("Complete the first turn.", &config.cwd)
            .expect("start first provider turn");
        let first_completed = (0..32).any(|_| {
            matches!(
                provider.poll().expect("poll first turn"),
                Some(CodexProviderEvent::Notification { method, .. })
                    if method == "turn/completed"
            )
        });
        assert!(
            first_completed,
            "observe the authoritative first completion for {label}"
        );

        provider
            .start_turn("Complete accepted replacement work.", &config.cwd)
            .expect_err("the accepted replacement turn has no valid response");
        let unresolved_error = provider
            .start_turn("Do not start duplicate replacement work.", &config.cwd)
            .expect_err("an unresolved ambiguous start bounds replacement work to one turn");
        assert!(
            unresolved_error
                .to_string()
                .contains("unresolved ambiguous provider turn start"),
            "unexpected unresolved-start error for {label}: {unresolved_error}"
        );

        let mut replacement_started = false;
        let mut replacement_completed = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let replacement_exit = (0..)
            .take_while(|_| std::time::Instant::now() < deadline)
            .find_map(|_| {
                match provider
                    .poll()
                    .expect("poll evidence for accepted replacement turn")
                {
                    Some(CodexProviderEvent::Notification { method, params })
                        if method == "turn/started" =>
                    {
                        assert_eq!(
                            params.pointer("/turn/id").and_then(Value::as_str),
                            Some("provider-turn-2")
                        );
                        replacement_started = true;
                        None
                    }
                    Some(CodexProviderEvent::Notification { method, params })
                        if method == "turn/completed" =>
                    {
                        assert_eq!(
                            params.pointer("/turn/id").and_then(Value::as_str),
                            Some("provider-turn-2")
                        );
                        replacement_completed = true;
                        None
                    }
                    Some(CodexProviderEvent::Exited {
                        success,
                        completed_turn_authoritative,
                        completion_reconciles_exit,
                        ..
                    }) => Some((
                        success,
                        completed_turn_authoritative,
                        completion_reconciles_exit,
                    )),
                    Some(_) => None,
                    None => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        None
                    }
                }
            });
        assert!(
            replacement_started,
            "the replacement identity should be established before replaying its output for {label}"
        );
        assert!(
            replacement_completed,
            "observe replacement completion for {label}"
        );
        assert_eq!(
            replacement_exit,
            Some((false, true, true)),
            "the replacement completion, not the old result, reconciles the provider exit for {label}"
        );

        fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
    }
}

#[test]
fn ambiguous_replacement_turn_rejects_conflicting_later_identity() {
    let directory = temporary_directory("conflicting-ambiguous-turn-identities");
    let config = provider_config(
        &directory,
        &[
            "--malformed-error-second-turn-start",
            "--conflicting-ambiguous-second-turn",
        ],
    );
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    wait_for_notification(&mut provider, "turn/completed");

    provider
        .start_turn("Accept replacement work ambiguously.", &config.cwd)
        .expect_err("the replacement response is transport-ambiguous");
    let replacement_started = wait_for_notification(&mut provider, "turn/started");
    assert_eq!(
        replacement_started
            .pointer("/turn/id")
            .and_then(Value::as_str),
        Some("provider-turn-2")
    );
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-2"));

    let conflicting_completion = wait_for_provider_error(&mut provider);
    assert!(
        conflicting_completion.contains("another active turn"),
        "unexpected conflicting-identity error: {conflicting_completion}"
    );
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-2"));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn ambiguous_replacement_turn_rejects_an_older_settled_identity() {
    let directory = temporary_directory("ambiguous-older-settled-turn-identity");
    let config = provider_config(&directory, &["--ambiguous-older-reused-turn"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    for message in ["Complete turn one.", "Complete turn two."] {
        provider
            .start_turn(message, &config.cwd)
            .expect("start completed provider turn");
        wait_for_notification(&mut provider, "turn/completed");
    }
    provider
        .start_turn("Ambiguously reuse the first turn identity.", &config.cwd)
        .expect_err("the replacement response is transport-ambiguous");
    let error = wait_for_provider_error(&mut provider);
    assert!(
        error.contains("reused a settled provider turn identity"),
        "unexpected older-identity error: {error}"
    );
    assert_eq!(provider.active_provider_turn_id(), None);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let completed_turn_authoritative = (0..)
        .take_while(|_| std::time::Instant::now() < deadline)
        .find_map(|_| {
            match provider
                .poll()
                .expect("poll provider after rejected identity")
            {
                Some(CodexProviderEvent::Exited {
                    completed_turn_authoritative,
                    ..
                }) => Some(completed_turn_authoritative),
                Some(_) => None,
                None => {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    None
                }
            }
        });
    assert!(
        completed_turn_authoritative == Some(false),
        "accepted work with an older settled identity must terminate the provider and revoke completion authority"
    );

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn clean_exit_after_ambiguous_replacement_start_fails_the_durable_session() {
    let directory = temporary_directory("durable-clean-exit-after-ambiguous-turn-start");
    let config = provider_config(
        &directory,
        &["--exit-after-accepting-second-turn-before-response"],
    );
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
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Complete the first turn."}),
        ))
        .expect("start first provider turn");

    let mut first_events = Vec::new();
    for _ in 0..32 {
        first_events.extend(
            poll_and_ack(&mut executor)
                .expect("poll first turn")
                .into_iter()
                .map(|event| event.event_type),
        );
        if first_events.iter().any(|event| event == "turn.completed") {
            break;
        }
    }
    assert!(first_events.iter().any(|event| event == "turn.completed"));

    executor
        .execute(&command(
            "ambiguous-turn",
            4,
            "turn.start",
            json!({"text": "Accept replacement work before exiting cleanly."}),
        ))
        .expect_err("accepted replacement start loses its response");
    let persisted_after_start: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after ambiguous start"),
    )
    .expect("parse provider state after ambiguous start");
    assert_eq!(persisted_after_start["completedTurnAuthoritative"], true);
    assert_eq!(persisted_after_start["completedTurnProcessGeneration"], 1);
    assert_eq!(
        persisted_after_start["completedProviderTurnId"],
        "provider-turn-1"
    );

    let mut exit_events = Vec::new();
    for _ in 0..64 {
        exit_events.extend(
            poll_and_ack(&mut executor)
                .expect("poll provider after ambiguous start")
                .into_iter()
                .map(|event| event.event_type),
        );
        if exit_events.iter().any(|event| event == "session.failed") {
            break;
        }
    }
    assert!(exit_events.iter().any(|event| event == "session.failed"));
    assert!(!exit_events
        .iter()
        .any(|event| event == "session.reconciled"));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_ambiguous_start_recovers_a_distinct_active_replacement_after_process_loss() {
    let directory = temporary_directory("durable-ambiguous-active-recovery");
    let config = provider_config(
        &directory,
        &[
            "--fail-after-accepting-second-turn-before-response",
            "--retain-ambiguous-second-turn-active",
        ],
    );
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
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Complete the first turn."}),
        ))
        .expect("start first provider turn");
    for _ in 0..32 {
        if poll_and_ack(&mut executor)
            .expect("poll first turn")
            .iter()
            .any(|event| event.event_type == "turn.completed")
        {
            break;
        }
    }

    executor
        .execute(&command(
            "ambiguous-turn",
            4,
            "turn.start",
            json!({"text": "Accept replacement work without returning its identity."}),
        ))
        .expect_err("replacement acceptance loses its response");
    let persisted_ambiguous: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after ambiguous start"),
    )
    .expect("parse provider state after ambiguous start");
    assert_eq!(persisted_ambiguous["ambiguousTurnStartPending"], true);
    assert_eq!(
        persisted_ambiguous["completedProviderTurnId"],
        "provider-turn-1"
    );

    executor.shutdown().expect("stop first provider process");
    drop(executor);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let snapshot = recovered
        .execute(&command("snapshot", 5, "session.snapshot", json!({})))
        .expect("reconcile active replacement turn");
    assert_eq!(snapshot.result["status"], "turn_active");
    assert_eq!(snapshot.result["activeProviderTurnId"], "provider-turn-2");
    assert_eq!(snapshot.result["cwd"], config.cwd);
    let persisted_recovered: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read recovered provider state"),
    )
    .expect("parse recovered provider state");
    assert_eq!(persisted_recovered["ambiguousTurnStartPending"], false);
    assert_eq!(persisted_recovered["completedTurnAuthoritative"], false);
    assert!(persisted_recovered["completedProviderTurnId"].is_null());

    recovered
        .shutdown()
        .expect("stop recovered provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn replacement_item_is_not_persisted_before_ambiguous_turn_identity() {
    let directory = temporary_directory("durable-ambiguous-item-recovery");
    let config = provider_config(
        &directory,
        &[
            "--malformed-error-second-turn-start",
            "--hold-ambiguous-second-turn-after-item",
        ],
    );
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
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Complete the first turn."}),
        ))
        .expect("start first provider turn");
    wait_for_executor_event(&mut executor, "turn.completed");

    executor
        .execute(&command(
            "ambiguous-turn",
            4,
            "turn.start",
            json!({"text": "Emit replacement output before terminal authority."}),
        ))
        .expect_err("replacement response is transport-ambiguous");
    assert!(
        poll_and_ack(&mut executor)
            .expect("defer identity-less replacement output")
            .is_empty(),
        "replacement output must not escape before its turn identity"
    );
    let persisted_before_loss: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state before process loss"),
    )
    .expect("parse provider state before process loss");
    assert_eq!(persisted_before_loss["ambiguousTurnStartPending"], true);
    assert_ne!(
        persisted_before_loss["lastAgentMessage"],
        "Replacement output before terminal authority."
    );

    executor.shutdown().expect("stop first provider process");
    drop(executor);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let snapshot = recovered
        .execute(&command("snapshot", 5, "session.snapshot", json!({})))
        .expect("reconcile the still-active replacement turn");
    assert_eq!(snapshot.result["status"], "turn_active");
    assert_eq!(snapshot.result["activeProviderTurnId"], "provider-turn-2");
    let persisted_recovered: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read recovered provider state"),
    )
    .expect("parse recovered provider state");
    assert_eq!(persisted_recovered["ambiguousTurnStartPending"], false);
    assert_ne!(
        persisted_recovered["lastAgentMessage"],
        "Replacement output before terminal authority."
    );

    recovered
        .shutdown()
        .expect("stop recovered provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn completed_ambiguous_replacement_fails_closed_after_process_loss() {
    let directory = temporary_directory("durable-ambiguous-completed-recovery");
    let config = provider_config(
        &directory,
        &[
            "--malformed-error-second-turn-start",
            "--complete-ambiguous-second-turn-before-response",
            "--omit-ambiguous-turn-started",
        ],
    );
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
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Complete the first turn."}),
        ))
        .expect("start first provider turn");
    wait_for_executor_event(&mut executor, "turn.completed");

    executor
        .execute(&command(
            "ambiguous-turn",
            4,
            "turn.start",
            json!({"text": "Complete replacement work before returning an invalid response."}),
        ))
        .expect_err("replacement response is transport-ambiguous");
    executor.shutdown().expect("stop first provider process");
    drop(executor);

    let mut recovered = CodexCommandExecutor::new(&directory);
    let recovery_error = recovered
        .execute(&command("snapshot", 5, "session.snapshot", json!({})))
        .expect_err("completed ambiguous work without durable identity must fail closed");
    assert!(
        recovery_error
            .to_string()
            .contains("cannot safely recover an ambiguous Codex turn start"),
        "unexpected ambiguous recovery error: {recovery_error}"
    );
    let repeated_poll_error = recovered
        .poll_events()
        .expect_err("a repeated poll must retain the fail-closed recovery state");
    assert!(
        repeated_poll_error
            .to_string()
            .contains("cannot safely recover an ambiguous Codex turn start"),
        "unexpected repeated ambiguous recovery error: {repeated_poll_error}"
    );
    assert_eq!(call_count(&directory, "turn/start"), 2);
    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read fail-closed provider state"),
    )
    .expect("parse fail-closed provider state");
    assert_eq!(persisted["ambiguousTurnStartPending"], true);
    assert_eq!(persisted["completedProviderTurnId"], "provider-turn-1");

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn ambiguous_replacement_completion_replaces_durable_turn_authority() {
    let directory = temporary_directory("durable-ambiguous-turn-completion");
    let config = provider_config(
        &directory,
        &[
            "--malformed-error-second-turn-start",
            "--complete-ambiguous-second-turn",
        ],
    );
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
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Complete the first turn."}),
        ))
        .expect("start first provider turn");

    wait_for_executor_event(&mut executor, "turn.completed");

    executor
        .execute(&command(
            "ambiguous-turn",
            4,
            "turn.start",
            json!({"text": "Complete replacement work after the malformed response."}),
        ))
        .expect_err("accepted replacement response is transport-ambiguous");

    let mut replacement_events = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        replacement_events.extend(
            poll_and_ack(&mut executor)
                .expect("poll accepted replacement evidence")
                .into_iter()
                .map(|event| event.event_type),
        );
        if replacement_events
            .iter()
            .any(|event| event == "session.reconciled")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(replacement_events
        .iter()
        .any(|event| event == "turn.started"));
    assert!(replacement_events
        .iter()
        .any(|event| event == "turn.completed"));
    assert!(replacement_events
        .iter()
        .any(|event| event == "session.reconciled"));

    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read provider state after replacement completion"),
    )
    .expect("parse provider state after replacement completion");
    assert_eq!(persisted["activeProviderTurnId"], Value::Null);
    assert_eq!(persisted["completedTurnAuthoritative"], true);
    assert_eq!(persisted["completedTurnProcessGeneration"], 1);
    assert_eq!(persisted["completedProviderTurnId"], "provider-turn-2");

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn accepted_replacement_turn_revokes_prior_authority_before_idle_crash() {
    let directory = temporary_directory("completion-then-new-turn-failure");
    let config = provider_config(&directory, &["--fail-after-second-turn-start"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    let first_completed = (0..32).any(|_| {
        matches!(
            provider.poll().expect("poll first turn"),
            Some(CodexProviderEvent::Notification { method, .. })
                if method == "turn/completed"
        )
    });
    assert!(
        first_completed,
        "observe the authoritative first completion"
    );

    provider
        .start_turn("Start genuinely new provider work.", &config.cwd)
        .expect("start second provider turn");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let second_exit = loop {
        if std::time::Instant::now() >= deadline {
            break None;
        }
        match provider.poll().expect("poll second turn") {
            Some(CodexProviderEvent::Exited {
                success,
                completed_turn_authoritative,
                completion_reconciles_exit,
                ..
            }) => {
                break Some((
                    success,
                    completed_turn_authoritative,
                    completion_reconciles_exit,
                ));
            }
            _ => std::thread::sleep(std::time::Duration::from_millis(1)),
        }
    };
    assert_eq!(second_exit, Some((false, false, false)));

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_a_tool_call_that_was_not_advertised() {
    let directory = temporary_directory("unauthorized-tool");
    let config = provider_config(&directory, &["--emit-tool-call"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex without tools");
    provider
        .start_turn("Attempt an unavailable tool.", &config.cwd)
        .expect("start provider turn");
    let error = (0..32)
        .find_map(|_| provider.poll().err())
        .expect("unauthorized provider tool call is rejected");
    assert!(error.to_string().contains("unauthorized tool"));
    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_delayed_calls_after_every_terminal_notification() {
    let directory = temporary_directory("delayed-tool-after-failure");
    let config = provider_config(&directory, &["--delayed-tool-after-failed-turn"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Fail before invoking a tool.", &config.cwd)
        .expect("start provider turn");

    wait_for_notification(&mut provider, "turn/failed");
    assert_eq!(provider.active_provider_turn_id(), None);
    let warning = wait_for_notification(&mut provider, "warning");
    assert!(warning["message"]
        .as_str()
        .is_some_and(|message| message.contains("after the Codex turn terminated")));

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_a_delayed_prior_turn_call_while_the_next_turn_is_active() {
    let directory = temporary_directory("delayed-tool-after-next-turn-start");
    let config = provider_config(&directory, &["--delayed-tool-after-next-turn-start"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    wait_for_notification(&mut provider, "turn/completed");

    provider
        .start_turn("Keep the second turn active.", &config.cwd)
        .expect("start second provider turn");
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-2"));
    let warning = wait_for_notification(&mut provider, "warning");
    assert!(warning["message"]
        .as_str()
        .is_some_and(|message| message.contains("after the Codex turn terminated")));
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-2"));

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_a_two_turn_old_call_while_fresh_work_is_active() {
    let directory = temporary_directory("delayed-tool-after-third-turn-start");
    let config = provider_config(&directory, &["--delayed-tool-after-third-turn-start"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");

    for message in ["Complete turn one.", "Complete turn two."] {
        provider
            .start_turn(message, &config.cwd)
            .expect("start completed provider turn");
        wait_for_notification(&mut provider, "turn/completed");
    }
    provider
        .start_turn("Keep turn three active.", &config.cwd)
        .expect("start third provider turn");
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-3"));

    let warning = wait_for_notification(&mut provider, "warning");
    assert_eq!(warning["providerMethod"], "item/tool/call");
    assert_eq!(provider.active_provider_turn_id(), Some("provider-turn-3"));

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_fails_closed_when_a_provider_reuses_a_settled_turn_id() {
    let directory = temporary_directory("tool-after-reused-turn-start");
    let config = provider_config(&directory, &["--tool-after-reused-turn-start"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    provider
        .start_turn("Complete the first turn.", &config.cwd)
        .expect("start first provider turn");
    wait_for_notification(&mut provider, "turn/completed");

    let error = provider
        .start_turn("Reuse the settled provider identity.", &config.cwd)
        .expect_err("reject a provider turn with a reused identity");
    assert!(error.to_string().contains("reused a settled"));
    assert_eq!(provider.active_provider_turn_id(), None);
    wait_for_reused_identity_reap(&mut provider);

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_fails_closed_when_a_provider_reuses_an_older_settled_turn_id() {
    let directory = temporary_directory("tool-after-older-reused-turn-start");
    let config = provider_config(&directory, &["--tool-after-older-reused-turn-start"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");
    for message in ["Complete turn one.", "Complete turn two."] {
        provider
            .start_turn(message, &config.cwd)
            .expect("start completed provider turn");
        wait_for_notification(&mut provider, "turn/completed");
    }

    let error = provider
        .start_turn("Reuse the older settled provider identity.", &config.cwd)
        .expect_err("reject a provider turn with an older reused identity");
    assert!(error.to_string().contains("reused a settled"));
    assert_eq!(provider.active_provider_turn_id(), None);
    wait_for_reused_identity_reap(&mut provider);

    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_rejects_an_older_provider_turn_id_after_restart() {
    let directory = temporary_directory("durable-older-reused-turn-after-restart");
    let config = provider_config(&directory, &[]);
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
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

    for (sequence, message) in [(3, "Complete turn one."), (4, "Complete turn two.")] {
        first
            .execute(&command(
                &format!("turn-{sequence}"),
                sequence,
                "turn.start",
                json!({"text": message}),
            ))
            .expect("start completed provider turn");
        let mut completed = false;
        for _ in 0..32 {
            completed |= poll_and_ack(&mut first)
                .expect("poll completed provider turn")
                .iter()
                .any(|event| event.event_type == "turn.completed");
            if completed {
                break;
            }
        }
        assert!(completed);
    }
    first.shutdown().expect("stop first provider process");
    drop(first);

    // The fake provider's process-local counter restarts at provider-turn-1.
    // Durable state must still remember that older identity, not only the most
    // recent provider-turn-2 completion authority.
    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let error = recovered
        .execute(&command(
            "turn-reused",
            5,
            "turn.start",
            json!({"text": "Do not accept an older provider turn identity."}),
        ))
        .expect_err("reject a provider turn identity retained before restart");
    assert!(error.to_string().contains("reused a settled"));

    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read fail-closed provider state"),
    )
    .expect("parse fail-closed provider state");
    assert_eq!(persisted["lifecycle"], "closed");
    assert!(persisted["activeProviderTurnId"].is_null());

    drop(recovered);
    let resumes_before_closed_restore = call_count(&directory, "thread/resume");
    let mut closed = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let events = closed
        .poll_events()
        .expect("closed reused-identity state remains readable without resuming Codex");
    assert!(events.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "provider_turn_identity_reused"
    }));
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_closed_restore,
        "recovery must not resume provider work accepted under a reused identity"
    );

    closed.shutdown().expect("close fail-closed executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_recovery_closes_a_provider_that_reopens_a_settled_turn() {
    let directory = temporary_directory("durable-settled-turn-active-on-recovery");
    let config = provider_config(&directory, &[]);
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
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
            json!({"text": "Complete the durable turn."}),
        ))
        .expect("start provider turn");
    let mut completed = false;
    for _ in 0..32 {
        completed |= poll_and_ack(&mut first)
            .expect("poll completed provider turn")
            .iter()
            .any(|event| event.event_type == "turn.completed");
        if completed {
            break;
        }
    }
    assert!(completed);
    first.shutdown().expect("stop first provider process");
    drop(first);

    // Contradict the durable terminal ledger with a resumed provider snapshot
    // that reports the exact settled identity as active again.
    fs::write(
        directory.join("fake-state.json"),
        serde_json::to_vec_pretty(&json!({
            "threadId": "codex-thread-1",
            "activeTurnId": "provider-turn-1",
        }))
        .unwrap(),
    )
    .expect("write contradictory fake provider state");

    let resumes_before_recovery = call_count(&directory, "thread/resume");
    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let events = recovered
        .poll_events()
        .expect("fail-closed recovery remains observable");
    assert!(events.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "provider_turn_identity_reused"
            && event.payload["providerTurnId"] == "provider-turn-1"
    }));
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_recovery + 1,
    );
    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read fail-closed provider state"),
    )
    .expect("parse fail-closed provider state");
    assert_eq!(persisted["lifecycle"], "closed");
    assert!(persisted["activeProviderTurnId"].is_null());
    assert_eq!(persisted["completedTurnAuthoritative"], false);

    drop(recovered);
    let resumes_before_closed_restore = call_count(&directory, "thread/resume");
    let mut closed = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    closed
        .poll_events()
        .expect("closed recovery state remains readable");
    assert_eq!(
        call_count(&directory, "thread/resume"),
        resumes_before_closed_restore,
        "closed recovery must not resume the contradictory provider turn again",
    );

    closed.shutdown().expect("close fail-closed executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_rejects_a_two_turn_old_call_while_idle() {
    let directory = temporary_directory("delayed-tool-after-second-turn-completion");
    let config = provider_config(&directory, &["--delayed-tool-after-second-turn-completion"]);
    let mut provider = CodexProvider::start_with_tools(&config, [task_context_tool()], None)
        .expect("start Codex with an authorized tool");

    for message in ["Complete turn one.", "Complete turn two."] {
        provider
            .start_turn(message, &config.cwd)
            .expect("start completed provider turn");
        wait_for_notification(&mut provider, "turn/completed");
    }
    assert_eq!(provider.active_provider_turn_id(), None);

    let warning = wait_for_notification(&mut provider, "warning");
    assert_eq!(warning["providerMethod"], "item/tool/call");
    assert_eq!(provider.active_provider_turn_id(), None);

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_delivers_a_terminal_before_rejecting_a_delayed_tool_call() {
    let directory = temporary_directory("durable-delayed-tool-after-terminal");
    let config = provider_config(&directory, &["--delayed-tool-after-failed-turn"]);
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
                "completionContract": {
                    "revision": "sha256:delayed-tool-contract",
                    "criterionIds": ["criterion_delayed_tool"]
                },
            }),
        ))
        .unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Fail before invoking a delayed tool."}),
        ))
        .unwrap();

    let mut observed = Vec::new();
    for _ in 0..32 {
        observed.extend(poll_and_ack(&mut executor).expect("poll durable provider events"));
        if observed
            .iter()
            .any(|event| event.event_type == "provider.notice.recorded")
        {
            break;
        }
    }
    let terminal = observed
        .iter()
        .position(|event| event.event_type == "run.terminal")
        .expect("the durable terminal is delivered");
    let rejection = observed
        .iter()
        .position(|event| event.event_type == "provider.notice.recorded")
        .expect("the delayed request is rejected non-fatally");
    assert!(terminal < rejection);

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn codex_rejects_a_runtime_response_after_its_turn_terminates() {
    let directory = temporary_directory("delayed-question-response");
    let config = provider_config(&directory, &["--question-before-failed-turn"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Ask and then fail.", &config.cwd)
        .expect("start provider turn");

    let mut request_id = None;
    let mut terminal_seen = false;
    for _ in 0..16 {
        match provider.poll().expect("poll question and terminal") {
            Some(CodexProviderEvent::RuntimeRequest {
                request_id: observed,
                ..
            }) => request_id = Some(observed),
            Some(CodexProviderEvent::Notification { method, .. }) if method == "turn/completed" => {
                terminal_seen = true;
            }
            _ => {}
        }
        if request_id.is_some() && terminal_seen {
            break;
        }
    }
    let request_id = request_id.expect("observe the runtime request before termination");
    assert!(terminal_seen);
    let error = provider
        .resolve_runtime_request(
            &request_id,
            &json!({
                "schema": "paperclip.question_response.v1",
                "answers": {"environment": {"selectedOptionIds": ["option-1"]}}
            }),
        )
        .expect_err("terminal requests must not remain resolvable");
    assert!(error.to_string().contains("no pending Codex request"));

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn reused_provider_question_ids_get_unique_controller_identities() {
    let directory = temporary_directory("reused-question-id");
    let config = provider_config(&directory, &["--emit-question", "--reuse-question-id"]);
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Ask twice with one provider request id.", &config.cwd)
        .expect("start provider turn");

    let first_request_id = (0..16)
        .find_map(|_| match provider.poll().expect("poll first question") {
            Some(CodexProviderEvent::RuntimeRequest { request_id, .. }) => Some(request_id),
            _ => None,
        })
        .expect("observe first runtime request");
    let response = json!({
        "schema": "paperclip.question_response.v1",
        "answers": {"environment": {"selectedOptionIds": ["option-1"]}}
    });
    provider
        .resolve_runtime_request(&first_request_id, &response)
        .expect("resolve first runtime request");
    let second_request_id = (0..16)
        .find_map(|_| match provider.poll().expect("poll second question") {
            Some(CodexProviderEvent::RuntimeRequest { request_id, .. }) => Some(request_id),
            _ => None,
        })
        .expect("observe second runtime request");

    assert_ne!(first_request_id, second_request_id);
    let stale = provider
        .resolve_runtime_request(&first_request_id, &response)
        .expect_err("the first controller identity cannot resolve the second question");
    assert!(stale.to_string().contains("no pending Codex request"));
    provider
        .resolve_runtime_request(&second_request_id, &response)
        .expect("resolve second runtime request");

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_facade_bridges_opencode_native_questions_instead_of_rejecting_the_method() {
    let directory = temporary_directory("opencode-proxy-runtime-question");
    let config = provider_config(&directory, &["--opencode-proxy-runtime-question"]);
    let mut provider = CodexProvider::start(&config, None).expect("start facade provider");
    provider
        .start_turn("Ask through the OpenCode proxy.", &config.cwd)
        .expect("start provider turn");

    let (request_id, question_set) = (0..16)
        .find_map(
            |_| match provider.poll().expect("poll proxy runtime question") {
                Some(CodexProviderEvent::RuntimeRequest {
                    request_id,
                    question_set,
                }) => Some((request_id, question_set)),
                _ => None,
            },
        )
        .expect("the provider-native paperclip/runtimeRequest reaches runnerd");
    assert_eq!(question_set["schema"], "paperclip.question_set.v1");
    assert_eq!(question_set["questions"][0]["id"], "environment");

    provider
        .resolve_runtime_request(
            &request_id,
            &json!({
                "schema": "paperclip.question_response.v1",
                "answers": {
                    "environment": {"selectedOptionIds": ["staging"]}
                }
            }),
        )
        .expect("return a canonical resolution to the OpenCode proxy");
    wait_for_notification(&mut provider, "turn/completed");
    assert_eq!(
        call_count(&directory, "opencode-runtime-response:submitted"),
        1
    );

    let _ = provider.shutdown();
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_resume_advertises_the_same_authorized_tools() {
    let directory = temporary_directory("dynamic-tool-resume");
    let config = provider_config(&directory, &["--require-dynamic-tool"]);
    let mut provider =
        CodexProvider::start_with_tools(&config, [task_context_tool()], Some("codex-thread-1"))
            .expect("resume Codex with the run-scoped tool set");
    assert_eq!(provider.thread_id(), "codex-thread-1");
    provider.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_routes_a_semantic_tool_result_back_to_codex() {
    let directory = temporary_directory("durable-dynamic-tool");
    let config = provider_config(&directory, &["--require-dynamic-tool", "--emit-tool-call"]);
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("prepare the durable Codex tool set");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the Codex session");
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Inspect the durable fake task."}),
        ))
        .expect("start the Codex turn");

    let mut semantic_input = None;
    for _ in 0..32 {
        let events = poll_and_ack(&mut executor).expect("poll semantic input");
        semantic_input = events
            .iter()
            .find(|event| event.event_type == "semantic_tool.input")
            .cloned()
            .or(semantic_input);
        if semantic_input.is_some() {
            break;
        }
    }
    let semantic_input = semantic_input.expect("durable semantic input is emitted");
    assert_eq!(
        semantic_input.payload["semantic_tool"]["correlation"]["runId"],
        "run-1"
    );
    assert_eq!(
        semantic_input.payload["semantic_tool"]["operationId"],
        "get_task_context"
    );

    let delivered = executor
        .execute(&command(
            "tool-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true, "task": {"id": "task-1"}},
                "isError": false,
            }),
        ))
        .expect("deliver the durable semantic result");
    assert_eq!(delivered.result["status"], "delivered");

    let mut result_seen = false;
    let mut terminal_seen = false;
    for _ in 0..32 {
        let events = poll_and_ack(&mut executor).expect("poll result and completion");
        result_seen |= events
            .iter()
            .any(|event| event.event_type == "semantic_tool.result");
        terminal_seen |= events
            .iter()
            .any(|event| event.event_type == "turn.completed");
        if result_seen && terminal_seen {
            break;
        }
    }
    assert!(result_seen);
    assert!(terminal_seen);
    executor.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_replays_completed_results_without_mutating_the_event_queue() {
    let directory = temporary_directory("durable-completed-tool-replay");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--hold-turn",
            "--replay-completed-tool-call-count",
            "4",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("prepare the durable Codex tool set");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the Codex session");
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Replay the completed fake tool call."}),
        ))
        .expect("start the Codex turn");

    let mut input_seen = false;
    for _ in 0..32 {
        input_seen |= poll_and_ack(&mut executor)
            .expect("poll semantic input")
            .iter()
            .any(|event| event.event_type == "semantic_tool.input");
        if input_seen {
            break;
        }
    }
    assert!(input_seen, "durable semantic input is emitted");

    executor
        .execute(&command(
            "tool-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true, "task": {"id": "task-1"}},
                "isError": false,
            }),
        ))
        .expect("deliver the original durable semantic result");
    let result_events = poll_and_ack(&mut executor).expect("acknowledge semantic result");
    assert_eq!(
        result_events
            .iter()
            .filter(|event| event.event_type == "semantic_tool.result")
            .count(),
        1
    );

    let state_path = directory.join("codex-provider-state.json");
    let state_before_replays = fs::read(&state_path).expect("read state before exact replays");
    let expected_response = r#"{"ok":true,"task":{"id":"task-1"}}"#;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while recorded_tool_responses(&directory).len() < 5 && std::time::Instant::now() < deadline {
        let events = poll_and_ack(&mut executor).expect("service completed tool replay");
        assert!(
            events.iter().all(|event| {
                event.event_type != "semantic_tool.input"
                    && event.event_type != "semantic_tool.reconciled"
                    && event.event_type != "semantic_tool.result"
            }),
            "an exact completed replay must not add semantic reconciliation events"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
    }

    let responses = recorded_tool_responses(&directory);
    assert_eq!(
        responses.len(),
        5,
        "the original result and four replays return"
    );
    assert!(responses
        .iter()
        .all(|response| response == expected_response));
    assert_eq!(
        fs::read(&state_path).expect("read state after exact replays"),
        state_before_replays,
        "exact completed replays must not consume durable event capacity"
    );

    executor.shutdown().expect("stop provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_replays_pending_tool_calls_without_mutating_the_event_queue() {
    let directory = temporary_directory("durable-tool-recovery");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--emit-tool-call-on-resume",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("prepare the recoverable tool bridge");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the first provider");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Hold the tool call across recovery."}),
        ))
        .expect("start the first turn");
    let mut input_seen = false;
    for _ in 0..32 {
        input_seen |= poll_and_ack(&mut first)
            .expect("poll first tool input")
            .iter()
            .any(|event| event.event_type == "semantic_tool.input");
        if input_seen {
            break;
        }
    }
    assert!(input_seen);
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut recovered = None;
    for replay in 0..4 {
        let before: Value = serde_json::from_slice(
            &fs::read(&state_path).expect("read state before provider recovery"),
        )
        .expect("parse state before provider recovery");
        let resume_count = call_count(&directory, "thread/resume");
        let mut next = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
        let mut session_resumed_events = 0;
        for _ in 0..32 {
            let events = poll_and_ack(&mut next).expect("poll exact pending replay");
            session_resumed_events += events
                .iter()
                .filter(|event| event.event_type == "session.resumed")
                .count();
            assert!(events.iter().all(|event| {
                event.event_type != "semantic_tool.input"
                    && event.event_type != "semantic_tool.reconciled"
                    && event.event_type != "semantic_tool.result"
            }));
            if call_count(&directory, "thread/resume") > resume_count {
                break;
            }
        }
        assert!(
            call_count(&directory, "thread/resume") > resume_count,
            "recovery {replay} resumes the active provider turn"
        );
        for _ in 0..4 {
            let events = poll_and_ack(&mut next).expect("poll exact pending replay");
            session_resumed_events += events
                .iter()
                .filter(|event| event.event_type == "session.resumed")
                .count();
            assert!(events.iter().all(|event| {
                event.event_type != "semantic_tool.input"
                    && event.event_type != "semantic_tool.reconciled"
                    && event.event_type != "semantic_tool.result"
            }));
        }
        let after: Value = serde_json::from_slice(
            &fs::read(&state_path).expect("read state after pending replay"),
        )
        .expect("parse state after pending replay");
        assert_eq!(
            after["pendingEvents"], before["pendingEvents"],
            "exact pending replay {replay} must not append pending events"
        );
        assert_eq!(
            after["queuedEvents"], before["queuedEvents"],
            "exact pending replay {replay} must not append queued events"
        );
        assert_eq!(
            session_resumed_events, 1,
            "recovery {replay} publishes exactly one provider lifecycle event"
        );
        assert_eq!(
            after["nextProviderEventSeq"].as_u64(),
            before["nextProviderEventSeq"].as_u64().map(|sequence| sequence + 1),
            "only session.resumed may consume durable event capacity during exact pending replay {replay}"
        );
        recovered = Some(next);
        if replay < 3 {
            drop(recovered.take());
        }
    }
    let mut recovered = recovered.expect("retain the final recovered provider");
    recovered
        .execute(&command(
            "tool-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true, "task": {"id": "task-1"}},
                "isError": false,
            }),
        ))
        .expect("complete the replayed tool call");
    let events = poll_and_ack(&mut recovered).expect("poll the completed pending call");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "semantic_tool.result")
            .count(),
        1
    );
    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_settles_pending_tools_when_recovery_finds_the_turn_ended() {
    let directory = temporary_directory("durable-tool-ended-offline");
    let config = provider_config(&directory, &["--require-dynamic-tool", "--emit-tool-call"]);
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
                "completionContract": {
                    "revision": "sha256:offline-recovery-contract",
                    "criterionIds": ["criterion_offline_recovery"]
                },
            }),
        ))
        .expect("prepare the recoverable tool bridge");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the first provider");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "End while the runner is offline."}),
        ))
        .expect("start the first turn");
    let mut input_seen = false;
    for _ in 0..32 {
        input_seen |= poll_and_ack(&mut first)
            .expect("poll first tool input")
            .iter()
            .any(|event| event.event_type == "semantic_tool.input");
        if input_seen {
            break;
        }
    }
    assert!(input_seen);
    drop(first);

    fs::write(
        directory.join("fake-state.json"),
        serde_json::to_vec_pretty(&json!({
            "threadId": "codex-thread-1",
            "activeTurnId": null,
        }))
        .unwrap(),
    )
    .expect("record that the provider turn ended while offline");

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    recovered
        .execute(&command("snapshot", 4, "session.snapshot", json!({})))
        .expect("restore the provider session");
    let mut observed = Vec::new();
    for _ in 0..32 {
        observed.extend(
            poll_and_ack(&mut recovered)
                .expect("poll recovered settlement")
                .into_iter()
                .map(|event| event.event_type),
        );
        if observed.iter().any(|event| event == "run.terminal") {
            break;
        }
    }
    let semantic_result = observed
        .iter()
        .position(|event| event == "semantic_tool.result")
        .expect("recovery settles the pending semantic tool");
    let reconciled = observed
        .iter()
        .position(|event| event == "session.reconciled")
        .expect("recovery emits a reconciliation event");
    let terminal = observed
        .iter()
        .position(|event| event == "run.terminal")
        .expect("offline turn recovery terminates the run");
    assert!(semantic_result < reconciled);
    assert!(reconciled < terminal);
    assert!(recovered
        .execute(&command(
            "late-result",
            5,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true},
                "isError": false,
            }),
        ))
        .is_err());

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_rotates_tool_authority_for_fresh_run_attach() {
    let directory = temporary_directory("durable-tool-attach-rotation");
    let config = provider_config(&directory, &["--durable-turn-ids", "--emit-tool-call"]);
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("prepare the durable tool catalog");
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the first provider session");
    executor
        .execute(&command(
            "first-turn",
            3,
            "turn.start",
            json!({"text": "Use the first run's tool authority."}),
        ))
        .expect("start the first provider turn");

    let mut input_seen = false;
    for _ in 0..32 {
        input_seen |= poll_and_ack(&mut executor)
            .expect("poll the first semantic input")
            .iter()
            .any(|event| event.event_type == "semantic_tool.input");
        if input_seen {
            break;
        }
    }
    assert!(
        input_seen,
        "the first run receives its authorized tool call"
    );
    executor
        .execute(&command(
            "first-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true, "task": {"id": "task-1"}},
                "isError": false,
            }),
        ))
        .expect("settle the first run's semantic tool call");

    let mut turn_completed = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let events = poll_and_ack(&mut executor).expect("drain the first run");
        turn_completed |= events
            .iter()
            .any(|event| event.event_type == "turn.completed");
        if turn_completed && events.is_empty() {
            break;
        }
        if events.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    assert!(turn_completed, "the first run settles before attachment");

    let mut changed = task_context_tool_set();
    changed.operations[0].operation_id = "write_document".to_owned();
    changed.operations[0].description = "Write a document during the new run.".to_owned();
    changed.catalog_digest = authorized_tool_catalog_digest(&changed.operations).unwrap();

    let mut invalid_digest = changed.clone();
    invalid_digest.catalog_digest = format!("sha256:{}", "0".repeat(64));
    let digest_error = executor
        .execute(&command(
            "invalid-attach",
            5,
            "run.attach",
            json!({"authorizedTools": invalid_digest}),
        ))
        .expect_err("attach must reject an invalid catalog digest");
    assert!(
        digest_error
            .to_string()
            .contains("catalog digest does not match its operations"),
        "unexpected attach error: {digest_error}"
    );

    let attached = executor
        .execute(&command(
            "attach",
            6,
            "run.attach",
            json!({"authorizedTools": changed}),
        ))
        .expect("a fresh run may bind a different valid catalog");
    assert!(attached
        .events
        .iter()
        .any(|(event_type, _, _)| event_type == "run.attached"));

    let stale_result_error = executor
        .execute(&command(
            "stale-result",
            7,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true, "task": {"id": "task-1"}},
                "isError": false,
            }),
        ))
        .expect_err("a prior run's result authority must not cross attachment");
    assert!(
        stale_result_error
            .to_string()
            .contains("does not match a pending provider call"),
        "unexpected stale result error: {stale_result_error}"
    );

    executor
        .execute(&command(
            "second-turn",
            8,
            "turn.start",
            json!({"text": "Attempt to replay the old tool call."}),
        ))
        .expect("start the second provider turn");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let rejection = loop {
        assert!(
            std::time::Instant::now() < deadline,
            "the prior run's operation must be rejected before the deadline"
        );
        match executor.poll_events() {
            Ok(events) => {
                assert!(
                    events
                        .iter()
                        .all(|event| event.event_type != "semantic_tool.input"),
                    "the prior run's operation must not be dispatched under new authority"
                );
                executor
                    .acknowledge_events(events.len())
                    .expect("acknowledge events before the rejected replay");
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(error) => break error,
        }
    };
    assert!(
        rejection.to_string().contains("unauthorized tool"),
        "unexpected replay rejection: {rejection}"
    );

    executor
        .shutdown()
        .expect("stop provider after tool authority rotation");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_attaches_after_a_settled_restore_notice() {
    let directory = temporary_directory("durable-settled-attach");
    let config = provider_config(&directory, &["--durable-turn-ids"]);
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
                "completionContract": {
                    "revision": "sha256:settled-attach-contract",
                    "criterionIds": ["criterion_settled_attach"]
                },
            }),
        ))
        .expect("prepare the durable provider");
    first
        .execute(&command("open", 2, "session.open", json!({})))
        .expect("open the durable provider session");
    first
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Settle before rotating run authority."}),
        ))
        .expect("start the provider turn");

    let mut saw_terminal = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let events = poll_and_ack(&mut first).expect("drain the settled provider turn");
        saw_terminal |= events
            .iter()
            .any(|event| event.event_type == "run.terminal");
        if saw_terminal && events.is_empty() {
            break;
        }
        if events.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    assert!(saw_terminal, "the first run must settle before attachment");
    first.shutdown().expect("stop the first provider process");
    drop(first);

    let mut rotated = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let attached = rotated
        .execute(&command(
            "attach",
            4,
            "run.attach",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .expect("discard only the restore notice and attach the settled session");
    assert!(attached
        .events
        .iter()
        .any(|(event_type, _, _)| event_type == "run.attached"));
    assert!(
        rotated
            .poll_events()
            .expect("inspect the provider queue after attachment")
            .is_empty(),
        "attachment must not replay the prior recovery notice"
    );

    rotated.shutdown().expect("stop the rotated provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn durable_backend_settles_tools_before_a_natural_terminal_event() {
    let directory = temporary_directory("durable-tool-terminal");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--emit-tool-call",
            "--finish-turn-with-pending-tool",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut executor = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    executor
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
        ))
        .unwrap();
    executor
        .execute(&command("open", 2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Terminate with a pending tool."}),
        ))
        .unwrap();

    let mut observed = Vec::new();
    for _ in 0..32 {
        let events = poll_and_ack(&mut executor).unwrap();
        observed.extend(events.into_iter().map(|event| event.event_type));
        if observed.iter().any(|event| event == "turn.completed") {
            break;
        }
    }
    let semantic_result = observed
        .iter()
        .position(|event| event == "semantic_tool.result")
        .expect("terminal settlement emits a failed semantic result");
    let terminal = observed
        .iter()
        .position(|event| event == "turn.completed")
        .expect("provider terminal event is emitted");
    assert!(semantic_result < terminal);
    assert!(executor
        .execute(&command(
            "late-result",
            4,
            "semantic_tool.result",
            json!({
                "callId": "semantic-call-1",
                "operationId": "get_task_context",
                "result": {"ok": true},
                "isError": false,
            }),
        ))
        .is_err());

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
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
fn legacy_full_active_epoch_is_closed_on_recovery() {
    let directory = temporary_directory("legacy-full-active-recovery");
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
            json!({"text": "Hold the legacy full-epoch turn."}),
        ))
        .expect("start held provider turn");
    first.shutdown().expect("stop first provider process");
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read active provider state"))
            .expect("parse active provider state");
    let prior_generation = persisted["providerProcessGeneration"]
        .as_u64()
        .expect("provider generation is persisted");
    persisted["settledProviderTurnIds"] = Value::Array(
        (0..4_096)
            .map(|index| Value::String(format!("legacy-provider-turn-{index}")))
            .collect(),
    );
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write legacy full active state");

    let mut recovered = CodexCommandExecutor::new(&directory);
    let events = recovered
        .poll_events()
        .expect("legacy full-epoch recovery remains observable");
    assert!(events.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "legacy_provider_turn_epoch_ambiguous"
    }));
    let closed: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read closed legacy full state"))
            .expect("parse closed legacy full state");
    assert_eq!(closed["lifecycle"], "closed");
    assert!(closed["activeProviderTurnId"].is_null());
    assert_eq!(closed["ambiguousTurnStartPending"], false);
    assert_eq!(closed["completedTurnAuthoritative"], false);
    assert!(closed["settledProviderTurnFilter"]["words"]
        .as_array()
        .expect("legacy filter shape remains valid")
        .is_empty());
    assert_eq!(
        closed["settledProviderTurnIds"].as_array().unwrap().len(),
        4_096
    );
    assert!(closed["providerProcessGeneration"].as_u64().unwrap() > prior_generation);
    assert!(recovered
        .execute(&command(
            "replacement-turn",
            4,
            "turn.start",
            json!({"text": "Do not reopen closed legacy work."}),
        ))
        .expect_err("closed legacy full-epoch state rejects replacement work")
        .to_string()
        .contains("closed"));
    assert_eq!(call_count(&directory, "turn/start"), 1);

    recovered.shutdown().expect("close recovered executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn legacy_filtered_ambiguous_epoch_is_closed_on_recovery() {
    let directory = temporary_directory("legacy-filtered-ambiguous-recovery");
    let config = provider_config(&directory, &[]);
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
    first.shutdown().expect("stop first provider process");
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read idle provider state"))
            .expect("parse idle provider state");
    let mut legacy_words = vec![0_u64; 32_768];
    legacy_words[0] = 1;
    persisted["settledProviderTurnFilter"] = json!({"words": legacy_words});
    persisted["ambiguousTurnStartPending"] = Value::Bool(true);
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write legacy-filtered ambiguous state");

    let mut recovered = CodexCommandExecutor::new(&directory);
    let events = recovered
        .poll_events()
        .expect("legacy ambiguous recovery remains observable");
    let diagnostic = events
        .iter()
        .find(|event| {
            event.event_type == "harness.diagnostic"
                && event.payload["code"] == "legacy_provider_turn_epoch_ambiguous"
        })
        .expect("legacy ambiguous recovery emits a terminal diagnostic");
    assert_eq!(diagnostic.payload["ambiguousStartPending"], true);
    assert_eq!(diagnostic.payload["providerReportedActive"], false);
    let closed: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read closed legacy ambiguous state"))
            .expect("parse closed legacy ambiguous state");
    assert_eq!(closed["lifecycle"], "closed");
    assert!(closed["activeProviderTurnId"].is_null());
    assert_eq!(closed["ambiguousTurnStartPending"], false);
    assert!(!closed["settledProviderTurnFilter"]["words"]
        .as_array()
        .expect("legacy filter remains durable evidence")
        .is_empty());
    assert_eq!(call_count(&directory, "turn/start"), 0);

    recovered.shutdown().expect("close recovered executor");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn legacy_full_ended_epoch_reconciles_before_idle_rollover() {
    let directory = temporary_directory("legacy-full-ended-recovery");
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
            json!({"text": "Let this legacy turn end while runnerd is away."}),
        ))
        .expect("start held provider turn");
    first.shutdown().expect("stop first provider process");
    drop(first);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read active provider state"))
            .expect("parse active provider state");
    persisted["settledProviderTurnIds"] = Value::Array(
        (0..4_096)
            .map(|index| Value::String(format!("legacy-provider-turn-{index}")))
            .collect(),
    );
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("write full legacy provider epoch");
    fs::write(
        directory.join("fake-state.json"),
        serde_json::to_vec_pretty(&json!({"threadId": "codex-thread-1"})).unwrap(),
    )
    .expect("mark the provider turn ended while runnerd was away");

    let mut recovered = CodexCommandExecutor::new(&directory);
    let events = recovered
        .poll_events()
        .expect("reconcile an ended turn from a full legacy epoch");
    assert!(events.iter().any(|event| event.event_type == "turn.failed"));
    let reconciled: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read reconciled legacy state"))
            .expect("parse reconciled legacy state");
    assert_eq!(reconciled["lifecycle"], "session_open");
    assert!(reconciled["activeProviderTurnId"].is_null());
    assert_eq!(
        reconciled["settledProviderTurnIds"]
            .as_array()
            .unwrap()
            .len(),
        4_096
    );

    recovered
        .execute(&command(
            "replacement-turn",
            4,
            "turn.start",
            json!({"text": "Start only after the idle epoch rolls over."}),
        ))
        .expect("roll over the idle full epoch and start replacement work");
    let rolled: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read rolled legacy state"))
            .expect("parse rolled legacy state");
    assert!(rolled["settledProviderTurnIds"]
        .as_array()
        .expect("rolled exact identities remain an array")
        .is_empty());
    assert!(rolled["settledProviderTurnFilter"]["words"]
        .as_array()
        .expect("rolled filter remains valid")
        .is_empty());
    assert_eq!(call_count(&directory, "turn/start"), 2);

    recovered.shutdown().expect("stop rolled provider process");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn codex_resume_rejects_an_oversized_active_turn_identity() {
    let directory = temporary_directory("resume-oversized-active-turn-id");
    let config = provider_config(&directory, &[]);
    fs::write(
        directory.join("fake-state.json"),
        serde_json::to_vec_pretty(&json!({
            "threadId": "codex-thread-1",
            "activeTurnId": "x".repeat(241),
        }))
        .unwrap(),
    )
    .expect("write fake provider state with an oversized active identity");

    let error = CodexProvider::start(&config, Some("codex-thread-1"))
        .err()
        .expect("reject an oversized recovered provider turn identity");
    assert!(error.to_string().contains("invalid turn.id"));

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
fn receipt_limit_rejects_the_call_and_keeps_polling_when_interrupt_fails() {
    let directory = temporary_directory("receipt-limit-interrupt-failure");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--fail-first-interrupt",
            "--accept-interrupt-without-terminal-once",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Hold this saturated turn for recovery."}),
        ))
        .expect("start held provider turn");
    drop(first);

    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let resumed = wait_for_executor_event(&mut recovered, "session.resumed");
    assert_eq!(resumed.payload["provider"], "codex");
    let diagnostic = wait_for_executor_event(&mut recovered, "harness.diagnostic");
    assert_eq!(
        diagnostic.payload["code"],
        "semantic_tool_turn_receipt_limit"
    );
    assert_eq!(call_count(&directory, "tool-response:failure"), 1);
    assert_eq!(call_count(&directory, "turn/interrupt"), 1);

    let mut settled = Vec::new();
    for _ in 0..4 {
        settled.extend(
            poll_and_ack(&mut recovered)
                .expect("polling must autonomously retry the durable receipt-limit interrupt"),
        );
        if settled
            .iter()
            .any(|event| event.event_type == "turn.interrupted")
        {
            break;
        }
    }
    assert!(
        settled
            .iter()
            .any(|event| event.event_type == "turn.interrupted"),
        "the retry must settle the receipt-exhausted turn"
    );
    assert_eq!(call_count(&directory, "turn/interrupt"), 3);

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn receipt_limit_retry_preserves_a_turn_settled_during_provider_recovery() {
    let directory = temporary_directory("receipt-limit-recovered-settlement");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--fail-first-interrupt",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Recover a provider-settled receipt-limited turn."}),
        ))
        .expect("start held provider turn");
    drop(first);

    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let resumed = wait_for_executor_event(&mut recovered, "session.resumed");
    assert_eq!(resumed.payload["provider"], "codex");
    let diagnostic = wait_for_executor_event(&mut recovered, "harness.diagnostic");
    assert_eq!(
        diagnostic.payload["code"],
        "semantic_tool_turn_receipt_limit"
    );
    assert_eq!(call_count(&directory, "turn/interrupt"), 1);

    // Lose the live transport while retaining its durable interruption retry,
    // then model the provider settling the turn before runnerd reconnects.
    recovered
        .shutdown()
        .expect("stop the provider before retry recovery");
    let fake_state_path = directory.join("fake-state.json");
    let mut fake_state: Value =
        serde_json::from_slice(&fs::read(&fake_state_path).expect("read fake provider state"))
            .expect("parse fake provider state");
    fake_state["activeTurnId"] = Value::Null;
    fs::write(
        &fake_state_path,
        serde_json::to_vec_pretty(&fake_state).unwrap(),
    )
    .expect("settle the fake provider turn before recovery");

    let events = poll_and_ack(&mut recovered)
        .expect("an already-settled retry must preserve the recovered terminal state");
    assert!(events.iter().any(|event| {
        event.event_type == "session.reconciled" && event.payload["activeProviderTurnId"].is_null()
    }));
    assert_eq!(
        call_count(&directory, "turn/interrupt"),
        1,
        "an already-settled recovered turn must not receive another interrupt RPC"
    );

    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read reconciled provider state"),
    )
    .expect("parse reconciled provider state");
    assert!(persisted["activeProviderTurnId"].is_null());
    assert_eq!(persisted["receiptLimitInterruptPending"], false);
    assert_eq!(persisted["receiptLimitInterruptAccepted"], false);
    assert_eq!(persisted["receiptLimitInterruptAttempts"], 0);
    assert!(persisted["receiptLimitInterruptDeadlineUnixMs"].is_null());

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn receipt_limit_accepts_a_terminal_after_the_initial_interrupt_deadline() {
    let directory = temporary_directory("receipt-limit-delayed-terminal");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--interrupt-terminal-delay-ms",
            "2100",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Accept a delayed authoritative interruption."}),
        ))
        .expect("start held provider turn");
    drop(first);
    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let mut emitted = Vec::new();
    for _ in 0..4_096 {
        emitted.extend(
            poll_and_ack(&mut recovered)
                .expect("a delayed accepted interrupt must remain durably pollable"),
        );
        if emitted
            .iter()
            .any(|event| event.event_type == "turn.interrupted")
        {
            break;
        }
    }
    assert!(
        emitted
            .iter()
            .any(|event| event.event_type == "turn.interrupted"),
        "the delayed provider terminal must remain authoritative after two seconds"
    );
    assert!(!emitted.iter().any(|event| {
        event.event_type == "turn.interrupted"
            && event.payload["code"] == "semantic_tool_turn_receipt_limit_interrupt_deadline"
    }));
    assert!(
        !emitted.iter().any(|event| {
            event.event_type == "turn.failed"
                && event.payload["code"] == "semantic_tool_turn_receipt_limit_interrupt_unconfirmed"
        }),
        "fast provider polls must not replace a delayed terminal with fallback failure"
    );

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn receipt_limit_polls_an_authoritative_terminal_with_unacknowledged_events() {
    let directory = temporary_directory("receipt-limit-terminal-with-unacked-events");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--accept-interrupt-without-terminal-once",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Retain the receipt-limit diagnostic until terminal polling."}),
        ))
        .expect("start held provider turn");
    drop(first);
    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let pending = loop {
        let events = recovered
            .poll_events()
            .expect("begin the durable receipt-limit stop");
        if events.iter().any(|event| {
            event.event_type == "harness.diagnostic"
                && event.payload["code"] == "semantic_tool_turn_receipt_limit"
        }) {
            break events;
        }
        assert!(
            events.is_empty()
                || events
                    .iter()
                    .all(|event| event.event_type == "session.resumed"),
            "only recovery lifecycle events may precede the receipt-limit diagnostic"
        );
        recovered
            .acknowledge_events(events.len())
            .expect("acknowledge recovery lifecycle events before receipt-limit polling");
        assert!(
            std::time::Instant::now() < deadline,
            "the durable receipt-limit diagnostic must become observable"
        );
        if events.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    };
    assert!(pending.iter().any(|event| {
        event.event_type == "harness.diagnostic"
            && event.payload["code"] == "semantic_tool_turn_receipt_limit"
    }));
    assert!(!pending
        .iter()
        .any(|event| event.event_type == "turn.interrupted"));

    let terminal = recovered
        .poll_events()
        .expect("poll the provider terminal before old events are acknowledged");
    assert!(terminal.iter().any(|event| {
        event.event_type == "turn.interrupted" && event.payload.get("code").is_none()
    }));
    assert!(!terminal.iter().any(|event| {
        event.event_type == "turn.interrupted"
            && event.payload["code"] == "semantic_tool_turn_receipt_limit_interrupt_deadline"
    }));
    recovered
        .acknowledge_events(terminal.len())
        .expect("acknowledge the diagnostic and authoritative terminal together");

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn pending_runtime_request_count_limit_rejects_the_overflowing_request() {
    let directory = temporary_directory("runtime-request-count-limit");
    let config = provider_config(
        &directory,
        &[
            "--hold-turn",
            "--accept-interrupt-without-terminal",
            "--flood-runtime-requests-on-interrupt",
        ],
    );
    let mut provider = CodexProvider::start(&config, None).expect("start Codex provider");
    provider
        .start_turn("Bound pending runtime requests by count.", &config.cwd)
        .expect("start held provider turn");
    provider
        .interrupt_turn()
        .expect("request the runtime-request flood");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut accepted = 0;
    let mut rejected_at_capacity = false;
    while !rejected_at_capacity && std::time::Instant::now() < deadline {
        match provider
            .poll()
            .expect("the pending runtime-request count remains pollable")
        {
            Some(CodexProviderEvent::RuntimeRequest { .. }) => accepted += 1,
            Some(CodexProviderEvent::Notification { method, params })
                if method == "warning"
                    && params["message"]
                        == "rejected a Codex runtime request at the bounded pending-input limit" =>
            {
                rejected_at_capacity = true;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(1)),
            _ => {}
        }
    }
    assert_eq!(accepted, 128);
    assert!(
        rejected_at_capacity,
        "production rejects the 129th pending runtime request"
    );

    provider.shutdown().expect("stop Codex provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn receipt_limit_polling_bounds_and_rejects_runtime_request_floods() {
    let directory = temporary_directory("receipt-limit-runtime-request-flood");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--accept-interrupt-without-terminal",
            "--flood-large-runtime-requests-on-interrupt",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Bound runtime requests while stopping this turn."}),
        ))
        .expect("start held provider turn");
    drop(first);
    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut rejected_at_capacity = false;
    while !rejected_at_capacity && std::time::Instant::now() < deadline {
        let events = recovered
            .poll_events()
            .expect("runtime-request cleanup remains bounded across repeated polls");
        assert!(events.len() <= 128);
        rejected_at_capacity = events.iter().any(|event| {
            event.event_type == "provider.notice.recorded"
                && event.payload["summary"]
                    == "rejected a Codex runtime request at the bounded pending-input limit"
        });
        recovered
            .acknowledge_events(events.len())
            .expect("advance the bounded durable event prefix");
        if events.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    assert!(
        rejected_at_capacity,
        "production records that requests above the pending count/byte envelope were rejected"
    );

    recovered.shutdown().expect("stop recovered provider");
    fs::remove_dir_all(directory).expect("remove Codex integration-test directory");
}

#[test]
fn receipt_limit_synthesizes_interrupted_after_an_accepted_terminal_deadline() {
    let directory = temporary_directory("receipt-limit-missing-terminal");
    let config = provider_config(
        &directory,
        &[
            "--require-dynamic-tool",
            "--hold-turn",
            "--emit-tool-call-on-resume",
            "--accept-interrupt-without-terminal",
        ],
    );
    let runner_config = durable_config(&directory);
    let mut first = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    first
        .execute(&command(
            "prepare",
            1,
            "run.prepare",
            json!({
                "provider": config,
                "authorizedTools": task_context_tool_set(),
            }),
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
            json!({"text": "Bound a missing interrupt terminal."}),
        ))
        .expect("start held provider turn");
    drop(first);
    saturate_provider_tool_receipts(&directory);

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    let mut emitted = Vec::new();
    for _ in 0..8 {
        emitted.extend(
            poll_and_ack(&mut recovered)
                .expect("receipt-limit fallback must remain durably pollable"),
        );
        if call_count(&directory, "turn/interrupt") == 3 {
            break;
        }
    }
    assert!(!emitted
        .iter()
        .any(|event| event.event_type == "turn.failed"));
    recovered
        .shutdown()
        .expect("pause the provider before expiring its durable deadline");
    drop(recovered);

    let state_path = directory.join("codex-provider-state.json");
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(&state_path).expect("read pending receipt-limit state"))
            .expect("parse pending receipt-limit state");
    persisted["receiptLimitInterruptDeadlineUnixMs"] = json!(1);
    fs::write(&state_path, serde_json::to_vec_pretty(&persisted).unwrap())
        .expect("expire the durable receipt-limit deadline");

    let mut recovered = CodexCommandExecutor::with_runner_config(&directory, &runner_config);
    for _ in 0..4 {
        emitted.extend(
            poll_and_ack(&mut recovered)
                .expect("expired receipt-limit fallback must remain durably pollable"),
        );
        if emitted
            .iter()
            .any(|event| event.event_type == "turn.interrupted")
        {
            break;
        }
    }
    let interrupted = emitted
        .iter()
        .find(|event| event.event_type == "turn.interrupted")
        .expect("the bounded accepted path must synthesize an interrupted turn");
    assert_eq!(
        interrupted.payload["code"],
        "semantic_tool_turn_receipt_limit_interrupt_deadline"
    );
    assert_eq!(interrupted.payload["interruptAccepted"], true);
    assert_eq!(interrupted.payload["providerTerminalObserved"], false);
    assert!(!emitted
        .iter()
        .any(|event| event.event_type == "turn.failed"));
    assert_eq!(call_count(&directory, "turn/interrupt"), 3);

    let persisted: Value = serde_json::from_slice(
        &fs::read(directory.join("codex-provider-state.json"))
            .expect("read bounded receipt-limit state"),
    )
    .expect("parse bounded receipt-limit state");
    assert_eq!(persisted["lifecycle"], "provider_exited");
    assert!(persisted["activeProviderTurnId"].is_null());
    assert_eq!(persisted["receiptLimitInterruptPending"], false);
    assert_eq!(persisted["receiptLimitInterruptAttempts"], 0);
    assert!(persisted["receiptLimitInterruptDeadlineUnixMs"].is_null());

    recovered
        .shutdown()
        .expect("bounded fallback stopped provider");
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
fn durable_backend_rejects_a_runtime_response_after_terminal_settlement() {
    let directory = temporary_directory("durable-delayed-question-response");
    let config = provider_config(&directory, &["--question-before-failed-turn"]);
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
    executor
        .execute(&command(
            "turn",
            3,
            "turn.start",
            json!({"text": "Ask and then fail."}),
        ))
        .expect("start provider turn");

    let mut request_id = None;
    let mut terminal_seen = false;
    for _ in 0..16 {
        for event in poll_and_ack(&mut executor).expect("poll question and terminal") {
            if event.event_type == "runtime_request.created" {
                request_id = event
                    .payload
                    .pointer("/request/requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            terminal_seen |= event.event_type == "turn.failed";
        }
        if request_id.is_some() && terminal_seen {
            break;
        }
    }
    let request_id = request_id.expect("observe the durable runtime request id");
    assert!(terminal_seen);
    let error = executor
        .execute(&command(
            "resolve",
            4,
            "request.resolve",
            json!({
                "requestId": request_id,
                "response": {
                    "schema": "paperclip.question_response.v1",
                    "answers": {"environment": {"selectedOptionIds": ["option-1"]}}
                }
            }),
        ))
        .expect_err("terminal runtime requests must fail closed");
    assert!(error.to_string().contains("outside an active turn"));

    executor.shutdown().expect("stop provider process");
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
    let mut request_id = None;
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
                request_id = event
                    .payload
                    .pointer("/request/requestId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
        }
        if question_set.is_some() {
            break;
        }
    }
    let question_set = question_set.expect("normalized question set is emitted");
    let request_id = request_id.expect("normalized request id is emitted");
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
                "requestId": request_id,
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
