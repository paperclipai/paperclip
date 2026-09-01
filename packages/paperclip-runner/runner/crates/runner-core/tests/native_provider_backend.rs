use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use paperclip_runner_core::durable::{Command, CommandExecutor, DurableRunnerConfig};
use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
use paperclip_runner_core::provider_bridge::authorized_tool_catalog_digest;
use serde_json::{json, Value};

const CODEX_ACPX_DIGEST: &str =
    "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79";

fn temporary_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "paperclip-native-provider-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn config(state_dir: &Path) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".to_owned(),
        ca_bundle_path: None,
        state_dir: state_dir.to_owned(),
        runner_instance_id: "runner-1".to_owned(),
        environment_lease_id: "lease-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
        runner_version: "0.0.0".to_owned(),
        runner_digest: "sha256:test".to_owned(),
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(60),
    }
}

fn command(sequence: u64, command_type: &str, payload: Value) -> Command {
    Command {
        schema: "paperclip.prp.command.v1".to_owned(),
        command_id: format!("command-{sequence}"),
        controller_seq: sequence,
        command_type: command_type.to_owned(),
        issued_at: "2026-09-01T00:00:00.000Z".to_owned(),
        deadline_at: None,
        precondition: None,
        payload,
    }
}

fn prepare_payload(directory: &Path, agent: &str) -> Value {
    prepare_payload_with_mode(directory, agent, "turns-reserved-result-terminal")
}

fn prepare_payload_with_mode(directory: &Path, agent: &str, mode: &str) -> Value {
    let operations = Vec::new();
    json!({
        "authorizedTools": {
            "schema": "paperclip.runner.authorized-tools.v1",
            "schemaVersion": 1,
            "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
            "operations": operations,
        },
        "provider": {
            "kind": "acpx",
            "provider": "acpx",
            "driver": "acpx_runtime",
            "providerVersion": "0.13.1",
            "agent": agent,
            "model": "gpt-5.6-sol",
            "acpxVersion": "0.13.1",
            "agentServerPackage": "@agentclientprotocol/codex-acp",
            "agentServerVersion": "1.6.2",
            "agentRuntimePackage": null,
            "agentRuntimeVersion": null,
            "commandDigest": CODEX_ACPX_DIGEST,
            "sidecarCommand": env!("CARGO_BIN_EXE_fake-acpx-sidecar"),
            "sidecarArgs": [
                "--mode",
                mode,
                "--profile-digest",
                CODEX_ACPX_DIGEST,
            ],
            "runtimeDirectory": directory.join("acpx-runtime"),
            "normalizedSessionId": "session-1",
            "runId": "run-1",
            "cwd": directory,
            "instructions": "Complete the supplied task and report the semantic result.",
            "permissionMode": "approve-reads",
            "permissionModePinned": true,
            "runtimeContext": null,
        },
    })
}

#[test]
fn preserves_acpx_semantic_disposition_in_the_run_terminal() {
    let directory = temporary_directory("acpx-blocked");
    let config = config(&directory);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    executor
        .execute(&command(
            1,
            "run.prepare",
            prepare_payload_with_mode(&directory, "codex", "turns-reserved-block-terminal"),
        ))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(3, "turn.start", json!({"text": "Wait."})))
        .unwrap();

    let events = executor.poll_events().unwrap();
    let terminal = events
        .iter()
        .find(|event| event.event_type == "run.terminal")
        .expect("ACPX blocked result must become terminal");
    assert_eq!(terminal.payload["runTerminalState"], "succeeded");
    assert_eq!(terminal.payload["reportedWorkDisposition"], "blocked");

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

fn opencode_prepare_payload(directory: &Path) -> Value {
    let operations = Vec::new();
    json!({
        "authorizedTools": {
            "schema": "paperclip.runner.authorized-tools.v1",
            "schemaVersion": 1,
            "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
            "operations": operations,
        },
        "completionContract": {
            "revision": "revision-1",
            "criterionIds": ["criterion-1"],
        },
        "provider": {
            "kind": "opencode",
            "provider": "opencode",
            "driver": "opencode_server",
            "providerVersion": "1.18.17",
            "command": env!("CARGO_BIN_EXE_fake-codex-app-server"),
            "args": [
                "--state-file",
                directory.join("fake-opencode-state.json"),
                "--call-log",
                directory.join("fake-opencode-calls.log"),
            ],
            "cwd": directory,
            "model": "openrouter/model",
            "approvalPolicy": "never",
            "instructions": "Complete the supplied task.",
        },
    })
}

#[test]
fn executes_a_qualified_acpx_profile_through_the_native_selector() {
    let directory = temporary_directory("acpx");
    let config = config(&directory);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    let prepared = executor
        .execute(&command(
            1,
            "run.prepare",
            prepare_payload(&directory, "codex"),
        ))
        .unwrap();
    assert_eq!(prepared.result["provider"], "acpx");
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["driver"], "acpx_runtime");
    assert_eq!(opened.events[0].2["providerDescriptor"]["agent"], "codex");

    let started = executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text": "Finish the task."}),
        ))
        .unwrap();
    assert_eq!(started.events[0].0, "turn.started");

    let events = executor.poll_events().unwrap();
    assert!(events
        .iter()
        .any(|event| event.event_type == "run.result.proposed"));
    assert!(events
        .iter()
        .any(|event| event.event_type == "turn.completed"));
    assert!(events
        .iter()
        .any(|event| event.event_type == "run.terminal"));
    executor.acknowledge_events(events.len()).unwrap();
    executor
        .execute(&command(4, "session.close", json!({})))
        .unwrap();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn executes_opencode_through_the_local_facade_without_codex_event_labels() {
    let directory = temporary_directory("opencode");
    let config = config(&directory);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    let prepared = executor
        .execute(&command(
            1,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap();
    assert_eq!(prepared.result["provider"], "opencode");
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["provider"], "opencode");
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text": "Finish the task."}),
        ))
        .unwrap();

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut observed = Vec::new();
    while std::time::Instant::now() < deadline {
        let events = executor.poll_events().unwrap();
        let count = events.len();
        observed.extend(events);
        executor.acknowledge_events(count).unwrap();
        if observed
            .iter()
            .any(|event| event.event_type == "run.terminal")
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(observed
        .iter()
        .any(|event| event.event_type == "turn.completed"));
    let terminal = observed
        .iter()
        .find(|event| event.event_type == "run.terminal")
        .expect("OpenCode run must become terminal");
    assert_eq!(terminal.payload["provider"], "opencode");
    let result = observed
        .iter()
        .find(|event| event.event_type == "run.result.proposed")
        .expect("OpenCode terminal fallback must propose a result");
    assert_eq!(
        result.payload["evidence"][0]["ref"],
        "provider:opencode:agent-message"
    );
    assert!(observed.iter().any(|event| {
        event.event_type == "item.completed" && event.payload["provider"] == "opencode"
    }));

    executor
        .execute(&command(4, "session.close", json!({})))
        .unwrap();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_pi_before_starting_a_sidecar() {
    let directory = temporary_directory("pi");
    let config = config(&directory);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    let error = executor
        .execute(&command(
            1,
            "run.prepare",
            prepare_payload(&directory, "pi"),
        ))
        .unwrap_err();
    assert!(error.to_string().contains("agent pi is not executable"));
    assert!(!directory.join("acpx-runtime").exists());
    fs::remove_dir_all(directory).unwrap();
}
