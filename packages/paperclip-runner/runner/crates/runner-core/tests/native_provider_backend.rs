use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use paperclip_runner_core::durable::{
    AcpxLaunchProfile, Command, CommandExecutor, DurableRunnerConfig, OpenCodeLaunchProfile,
    QualifiedLaunchArtifact,
};
use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
use paperclip_runner_core::provider_bridge::{authorized_tool_catalog_digest, AuthorizedTool};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CODEX_ACPX_DIGEST: &str =
    "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3";
const PI_ACPX_DIGEST: &str =
    "sha256:e92078bee3c23bec4100aa589013a44613d054cd686826534025d8019e9f39a9";

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
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(60),
    }
}

fn acpx_config(state_dir: &Path, mode: &str) -> DurableRunnerConfig {
    let mut config = config(state_dir);
    let command = PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar"));
    config.acpx_launch_profile = Some(AcpxLaunchProfile {
        authority_digest: format!("sha256:{}", "d".repeat(64)),
        command: command.clone(),
        args: vec![
            "--mode".to_owned(),
            mode.to_owned(),
            "--profile-digest".to_owned(),
            CODEX_ACPX_DIGEST.to_owned(),
        ],
        artifacts: vec![QualifiedLaunchArtifact {
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&command).unwrap())),
            path: command,
        }],
    });
    config
}

fn pi_acpx_config(state_dir: &Path, mode: &str) -> DurableRunnerConfig {
    let mut config = acpx_config(state_dir, mode);
    *config
        .acpx_launch_profile
        .as_mut()
        .unwrap()
        .args
        .last_mut()
        .unwrap() = PI_ACPX_DIGEST.to_owned();
    config
}

fn qualified_artifact(path: PathBuf) -> QualifiedLaunchArtifact {
    QualifiedLaunchArtifact {
        sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap())),
        path,
    }
}

fn opencode_config(state_dir: &Path) -> DurableRunnerConfig {
    let command = state_dir.join("qualified-opencode-proxy-command");
    let proxy_script = state_dir.join("qualified-opencode-proxy-script");
    let executable = state_dir.join("qualified-opencode-executable");
    fs::write(
        &command,
        "#!/bin/sh\nproxy=\"$1\"\nshift\nexec /bin/sh \"$proxy\" \"$@\"\n",
    )
    .unwrap();
    fs::write(
        &proxy_script,
        format!(
            "#!/bin/sh\nexec '{}' --state-file '{}' --call-log '{}' --require-completion-contract\n",
            env!("CARGO_BIN_EXE_fake-codex-app-server"),
            state_dir.join("fake-opencode-state.json").display(),
            state_dir.join("fake-opencode-calls.log").display(),
        ),
    )
    .unwrap();
    fs::write(&executable, "qualified OpenCode test executable\n").unwrap();
    #[cfg(unix)]
    for path in [&command, &proxy_script, &executable] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
    }
    let mut config = config(state_dir);
    config.opencode_launch_profile = Some(OpenCodeLaunchProfile {
        command: qualified_artifact(command),
        proxy_script: qualified_artifact(proxy_script),
        executable: qualified_artifact(executable),
    });
    config
}

fn opencode_call_count(state_dir: &Path, method: &str) -> usize {
    fs::read_to_string(state_dir.join("fake-opencode-calls.log"))
        .unwrap_or_default()
        .lines()
        .filter(|line| *line == method)
        .count()
}

fn assert_valid_terminal(payload: &Value) {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/terminal.schema.json"
    ))
    .unwrap();
    let stop_reason: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/stop-reason.schema.json"
    ))
    .unwrap();
    let registry = jsonschema::Registry::new()
        .add(
            "https://paperclip.dev/schemas/prp/v1/stop-reason.schema.json",
            stop_reason,
        )
        .unwrap()
        .prepare()
        .unwrap();
    let validator = jsonschema::options()
        .with_registry(&registry)
        .build(&schema)
        .unwrap();
    validator.validate(payload).unwrap();
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
    let (runtime_package, runtime_version) = if agent == "codex" {
        (json!("@openai/codex"), json!("0.160.0"))
    } else {
        (Value::Null, Value::Null)
    };
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
            "model": "explicit-test-model",
            "acpxVersion": "0.13.1",
            "agentServerPackage": "@agentclientprotocol/codex-acp",
            "agentServerVersion": "1.6.2",
            "agentRuntimePackage": runtime_package,
            "agentRuntimeVersion": runtime_version,
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

fn pi_prepare_payload(directory: &Path, mode: &str) -> Value {
    let mut payload = prepare_payload_with_mode(directory, "pi", mode);
    let provider = &mut payload["provider"];
    provider["agentServerPackage"] = json!("pi-acp");
    provider["agentServerVersion"] = json!("0.0.33");
    provider["agentRuntimePackage"] = json!("@earendil-works/pi-coding-agent");
    provider["agentRuntimeVersion"] = json!("1.0.0");
    provider["commandDigest"] = json!(PI_ACPX_DIGEST);
    provider["sidecarArgs"][3] = json!(PI_ACPX_DIGEST);
    provider["providerPolicy"] = json!({"readOnly":true});
    provider["piThinkingLevel"] = json!("low");
    payload
}

fn pending_acpx_runtime_request(
    directory: &Path,
    mode: &str,
) -> (
    NativeProviderCommandExecutor,
    DurableRunnerConfig,
    String,
    u32,
) {
    let mut config = acpx_config(directory, mode);
    let mut payload = prepare_payload_with_mode(directory, "codex", mode);
    if mode.starts_with("permissions-") {
        // Codex's pinned runner policy does not allow interactive ACP permissions.
        let digest = "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a";
        *config
            .acpx_launch_profile
            .as_mut()
            .unwrap()
            .args
            .last_mut()
            .unwrap() = digest.into();
        let provider = &mut payload["provider"];
        provider["agent"] = json!("claude");
        provider["agentServerPackage"] = json!("@agentclientprotocol/claude-agent-acp");
        provider["agentServerVersion"] = json!("0.73.0");
        provider["agentRuntimePackage"] = json!("@anthropic-ai/claude-agent-sdk");
        provider["agentRuntimeVersion"] = json!("0.3.286");
        provider["commandDigest"] = json!(digest);
        provider["sidecarArgs"][3] = json!(digest);
    } else {
        let operations = vec![AuthorizedTool {
            operation_id: "issues.read".into(),
            version: 1,
            description: "Read an issue.".into(),
            input_schema: json!({"type":"object"}),
            response_schema: json!({"type":"object"}),
        }];
        payload["authorizedTools"]["catalogDigest"] =
            json!(authorized_tool_catalog_digest(&operations).unwrap());
        payload["authorizedTools"]["operations"] = json!(operations);
    }
    let mut executor = NativeProviderCommandExecutor::with_runner_config(directory, &config);
    executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap();
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let process_id = opened.result["processId"].as_u64().unwrap() as u32;
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text":"Ask before continuing", "turnId":"turn-1"}),
        ))
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let events = executor.poll_events().unwrap();
        let request_id = events
            .iter()
            .find(|event| event.event_type == "runtime_request.created")
            .and_then(|event| event.payload.pointer("/request/requestId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        executor.acknowledge_events(events.len()).unwrap();
        if let Some(request_id) = request_id {
            return (executor, config, request_id, process_id);
        }
        assert!(
            std::time::Instant::now() < deadline,
            "request was not presented"
        );
    }
}

fn acpx_runtime_resolution(mode: &str, request_id: &str) -> Value {
    json!({"requestId":request_id, "turnId":"turn-1", "resolution":
        if mode.starts_with("permissions-") { json!({"action":"accept"}) }
        else { json!({"action":"submit", "response":{"schema":"paperclip.question_response.v1",
            "answers":{"target":{"selectedOptionIds":["first"]}}}}) }
    })
}

fn shutdown_recovered_acpx_fixture(executor: &mut NativeProviderCommandExecutor, directory: &Path) {
    // The fake sidecar advertises the same three lifetime-fence ports for all
    // fixtures. Parallel recovered shutdowns hold a quorum through state fsync,
    // temporarily preventing another fixture from proving cleanup. Retry only
    // that rejection, using the real production quorum proof on every attempt.
    // This is fixture synchronization, not a production cleanup workaround.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut blocked_attempts = 0;
    loop {
        match executor.shutdown() {
            Ok(()) => break,
            Err(error) => {
                assert_eq!(
                    error.to_string(),
                    "ACPX original provider lifetime remains active; cleanup is not yet proven",
                    "unexpected recovered fixture shutdown failure"
                );
                let persisted: Value = serde_json::from_slice(
                    &fs::read(directory.join("acpx-provider-state.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(persisted["providerExitUnconfirmed"], true);
                blocked_attempts += 1;
                if blocked_attempts == 1 {
                    eprintln!("recovered fixture cleanup waiting for the shared lifetime quorum");
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "recovered fixture cleanup never acquired the lifetime quorum"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
    if blocked_attempts > 0 {
        eprintln!("recovered fixture cleanup proved after {blocked_attempts} quorum rejections");
    }
    let persisted: Value =
        serde_json::from_slice(&fs::read(directory.join("acpx-provider-state.json")).unwrap())
            .unwrap();
    assert_eq!(persisted["providerExitUnconfirmed"], false);
}

#[test]
fn acpx_response_delivery_survives_crash_before_journaling_without_replaying_the_response() {
    for mode in [
        "permissions-interactive",
        "resolutions",
        "resolutions-projected-id",
    ] {
        let directory = temporary_directory(mode);
        let (mut executor, config, request_id, _) = pending_acpx_runtime_request(&directory, mode);
        let resolve = command(
            4,
            "request.resolve",
            acpx_runtime_resolution(mode, &request_id),
        );
        let delivered = executor.execute(&resolve).unwrap();
        assert_eq!(delivered.result["status"], "delivered");
        assert!(
            delivered.events.is_empty(),
            "settlement must use the durable provider outbox"
        );
        let persisted: Value =
            serde_json::from_slice(&fs::read(directory.join("acpx-provider-state.json")).unwrap())
                .unwrap();
        assert!(persisted["pendingRuntimeRequests"]
            .get(&request_id)
            .is_none());
        let retained = executor.retained_events().unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].event_type, "runtime_request.resolved");
        assert_eq!(retained[0].payload["requestId"], request_id);
        assert_eq!(
            persisted["pendingEvents"][0]["executorEventId"],
            retained[0].executor_event_id
        );
        assert!(executor
            .execute(&command(5, "request.resolve", resolve.payload.clone()))
            .is_err());
        assert_eq!(executor.retained_events().unwrap(), retained);

        // Simulate death after the sidecar ACK/state fsync, before the runner
        // journals this event or acknowledges the provider's retained prefix.
        drop(executor);
        let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        let events = recovered.poll_events().unwrap();
        assert_eq!(events[0], retained[0]);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type.starts_with("runtime_request."))
                .count(),
            1
        );
        assert!(recovered
            .execute(&command(6, "request.resolve", resolve.payload))
            .is_err());
        assert_eq!(recovered.poll_events().unwrap(), events);
        assert_eq!(
            recovered
                .execute(&command(7, "session.snapshot", json!({})))
                .unwrap()
                .result["status"],
            "closed"
        );
        // Polling is not an ACK; only the journal's ACK retires the event.
        recovered.acknowledge_events(events.len()).unwrap();
        assert!(recovered.poll_events().unwrap().is_empty());
        drop(recovered);
        let mut recovered_again =
            NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        assert!(recovered_again.poll_events().unwrap().is_empty());
        shutdown_recovered_acpx_fixture(&mut recovered_again, &directory);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn acpx_delivered_response_is_acknowledged_once_before_session_close() {
    for mode in ["permissions-interactive", "resolutions"] {
        let directory = temporary_directory("response-ack");
        let (mut executor, _, request_id, _) = pending_acpx_runtime_request(&directory, mode);
        let response = acpx_runtime_resolution(mode, &request_id);
        executor
            .execute(&command(4, "request.resolve", response.clone()))
            .unwrap();
        let events = executor.poll_events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "runtime_request.resolved");
        assert_eq!(executor.poll_events().unwrap(), events);
        executor.acknowledge_events(1).unwrap();
        assert!(executor
            .execute(&command(5, "request.resolve", response))
            .is_err());
        executor
            .execute(&command(6, "session.close", json!({})))
            .unwrap();
        assert!(
            executor.poll_events().unwrap().is_empty(),
            "close must not expire a delivered request"
        );
        executor.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn acpx_uncommitted_delivery_expires_after_failed_state_write_without_replay() {
    for mode in ["permissions-interactive", "resolutions"] {
        let directory = temporary_directory("response-save-failure");
        let (mut executor, config, request_id, process_id) =
            pending_acpx_runtime_request(&directory, mode);
        let state_path = directory.join("acpx-provider-state.json");
        let previous_path = directory.join("previous-state.json");
        let previous = fs::read(&state_path).unwrap();
        fs::rename(&state_path, &previous_path).unwrap();
        // Force the atomic state replacement to fail after the real sidecar
        // has acknowledged delivery, without adding production fault hooks.
        fs::create_dir(&state_path).unwrap();
        let response = acpx_runtime_resolution(mode, &request_id);
        let error = executor
            .execute(&command(4, "request.resolve", response.clone()))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("atomically replace ACPX provider state"));
        assert_eq!(fs::read(&previous_path).unwrap(), previous);
        // Neither ordinary polling nor the explicit drain/ACK path may publish
        // a delivered response whose settlement failed to persist.
        for result in [
            executor.retained_events().map(|_| ()),
            executor.poll_events().map(|_| ()),
            executor.acknowledge_events(0),
            executor.acknowledge_events(1),
            executor
                .execute(&command(5, "runner.drain", json!({})))
                .map(|_| ()),
            executor
                .execute(&command(6, "request.resolve", response.clone()))
                .map(|_| ()),
            executor.shutdown(),
        ] {
            assert_eq!(result.unwrap_err().to_string(), error.to_string());
        }
        #[cfg(unix)]
        assert!(
            !std::process::Command::new("kill")
                .args(["-0", &process_id.to_string()])
                .env_clear()
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success(),
            "failed durable cleanup must still reap the owned sidecar"
        );
        assert_eq!(fs::read(&previous_path).unwrap(), previous);
        fs::remove_dir(&state_path).unwrap();
        fs::rename(&previous_path, &state_path).unwrap();
        // Repairing the file path does not authorize this uncertain executor
        // to resume, retry an approval, or overwrite the recovery snapshot.
        assert!(executor.poll_events().is_err());
        assert!(executor.retained_events().is_err());
        assert!(executor.shutdown().is_err());
        assert_eq!(fs::read(&state_path).unwrap(), previous);
        drop(executor);

        let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        let events = recovered.poll_events().unwrap();
        let requests: Vec<_> = events
            .iter()
            .filter(|event| event.event_type.starts_with("runtime_request."))
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].event_type, "runtime_request.expired");
        assert_eq!(requests[0].payload["requestId"], request_id);
        assert_eq!(requests[0].payload["replayAllowed"], false);
        assert!(recovered
            .execute(&command(5, "request.resolve", response))
            .is_err());
        assert_eq!(recovered.poll_events().unwrap(), events);
        recovered.acknowledge_events(events.len()).unwrap();
        shutdown_recovered_acpx_fixture(&mut recovered, &directory);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn acpx_failed_settlement_ack_replays_the_same_delivered_event_without_expiry() {
    for mode in ["permissions-interactive", "resolutions"] {
        let directory = temporary_directory("response-ack-save-failure");
        let (mut executor, config, request_id, _) = pending_acpx_runtime_request(&directory, mode);
        let response = acpx_runtime_resolution(mode, &request_id);
        executor
            .execute(&command(4, "request.resolve", response.clone()))
            .unwrap();
        let committed = executor.poll_events().unwrap();
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].event_type, "runtime_request.resolved");
        let state_path = directory.join("acpx-provider-state.json");
        let previous_path = directory.join("previous-state.json");
        let previous = fs::read(&state_path).unwrap();
        fs::rename(&state_path, &previous_path).unwrap();
        fs::create_dir(&state_path).unwrap();
        // The journal has committed this executorEventId, but retiring the
        // provider's retained prefix must not escape a failed state write.
        let error = executor.acknowledge_events(1).unwrap_err();
        assert!(error
            .to_string()
            .contains("atomically replace ACPX provider state"));
        for result in [
            executor.retained_events().map(|_| ()),
            executor.poll_events().map(|_| ()),
            executor.acknowledge_events(0),
            executor
                .execute(&command(5, "request.resolve", response.clone()))
                .map(|_| ()),
            executor.shutdown(),
        ] {
            assert_eq!(result.unwrap_err().to_string(), error.to_string());
        }
        assert_eq!(fs::read(&previous_path).unwrap(), previous);
        fs::remove_dir(&state_path).unwrap();
        fs::rename(&previous_path, &state_path).unwrap();
        drop(executor);

        let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        let events = recovered.poll_events().unwrap();
        assert_eq!(events[0], committed[0]);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.event_type.starts_with("runtime_request."))
                .count(),
            1
        );
        assert!(recovered
            .execute(&command(6, "request.resolve", response))
            .is_err());
        assert_eq!(recovered.poll_events().unwrap(), events);
        recovered.acknowledge_events(events.len()).unwrap();
        assert!(recovered.poll_events().unwrap().is_empty());
        shutdown_recovered_acpx_fixture(&mut recovered, &directory);
        drop(recovered);
        let mut recovered_again =
            NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        assert!(recovered_again.poll_events().unwrap().is_empty());
        recovered_again.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn acpx_uncommitted_expiry_and_cancellation_cannot_escape_through_poll_or_drain() {
    for (mode, close) in [
        ("permissions-wrong-ack", false),
        ("permissions-interactive", true),
        ("resolutions", true),
    ] {
        let directory = temporary_directory("expiry-save-failure");
        let (mut executor, config, request_id, _) = pending_acpx_runtime_request(&directory, mode);
        let state_path = directory.join("acpx-provider-state.json");
        let previous_path = directory.join("previous-state.json");
        let previous = fs::read(&state_path).unwrap();
        fs::rename(&state_path, &previous_path).unwrap();
        fs::create_dir(&state_path).unwrap();
        let response = acpx_runtime_resolution(mode, &request_id);
        let error = if close {
            executor
                .execute(&command(4, "session.close", json!({})))
                .unwrap_err()
        } else {
            assert!(executor
                .execute(&command(4, "request.resolve", response.clone()))
                .unwrap_err()
                .to_string()
                .contains("did not confirm permission resolution"));
            executor.poll_events().unwrap_err()
        };
        assert!(error
            .to_string()
            .contains("atomically replace ACPX provider state"));
        for result in [
            executor.retained_events().map(|_| ()),
            executor.poll_events().map(|_| ()),
            executor.acknowledge_events(1),
            executor
                .execute(&command(5, "runner.drain", json!({})))
                .map(|_| ()),
            executor
                .execute(&command(6, "request.resolve", response.clone()))
                .map(|_| ()),
            executor.shutdown(),
        ] {
            assert_eq!(result.unwrap_err().to_string(), error.to_string());
        }
        assert_eq!(fs::read(&previous_path).unwrap(), previous);
        fs::remove_dir(&state_path).unwrap();
        fs::rename(&previous_path, &state_path).unwrap();
        assert!(executor.shutdown().is_err());
        assert_eq!(fs::read(&state_path).unwrap(), previous);
        drop(executor);

        let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        let events = recovered.poll_events().unwrap();
        let settlements: Vec<_> = events
            .iter()
            .filter(|event| event.event_type.starts_with("runtime_request."))
            .collect();
        assert_eq!(settlements.len(), 1);
        assert_eq!(settlements[0].event_type, "runtime_request.expired");
        assert_eq!(settlements[0].payload["requestId"], request_id);
        assert_eq!(settlements[0].payload["replayAllowed"], false);
        assert!(recovered
            .execute(&command(7, "request.resolve", response))
            .is_err());
        assert_eq!(recovered.poll_events().unwrap(), events);
        recovered.acknowledge_events(events.len()).unwrap();
        shutdown_recovered_acpx_fixture(&mut recovered, &directory);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn acpx_failed_or_cancelled_responses_retain_one_durable_settlement() {
    for (mode, close) in [
        ("permissions-wrong-ack", false),
        ("permissions-interactive", true),
        ("resolutions", true),
    ] {
        let directory = temporary_directory("response-expiry");
        let (mut executor, config, request_id, _) = pending_acpx_runtime_request(&directory, mode);
        if close {
            executor
                .execute(&command(4, "session.close", json!({})))
                .unwrap();
        } else {
            let error = executor
                .execute(&command(
                    4,
                    "request.resolve",
                    acpx_runtime_resolution(mode, &request_id),
                ))
                .unwrap_err();
            assert!(error
                .to_string()
                .contains("did not confirm permission resolution"));
        }
        let events = executor.poll_events().unwrap();
        let requests: Vec<_> = events
            .iter()
            .filter(|event| event.event_type.starts_with("runtime_request."))
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].event_type,
            if close {
                "runtime_request.cancelled"
            } else {
                "runtime_request.expired"
            }
        );
        assert_eq!(requests[0].payload["requestId"], request_id);
        assert_eq!(requests[0].payload["replayAllowed"], false);
        drop(executor);
        let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        assert_eq!(recovered.poll_events().unwrap(), events);
        assert!(recovered
            .execute(&command(
                5,
                "request.resolve",
                acpx_runtime_resolution(mode, &request_id)
            ))
            .is_err());
        recovered.acknowledge_events(events.len()).unwrap();
        assert!(recovered.poll_events().unwrap().is_empty());
        shutdown_recovered_acpx_fixture(&mut recovered, &directory);
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn preserves_acpx_semantic_disposition_in_the_run_terminal() {
    let directory = temporary_directory("acpx-blocked");
    let config = acpx_config(&directory, "turns-reserved-block-terminal");
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
        .execute(&command(
            3,
            "turn.start",
            json!({"text": "Wait.", "turnId": "provider-turn-blocked"}),
        ))
        .unwrap();

    let events = executor.poll_events().unwrap();
    let terminal = events
        .iter()
        .find(|event| event.event_type == "run.terminal")
        .expect("ACPX blocked result must become terminal");
    assert_valid_terminal(&terminal.payload);
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
            "providerVersion": "1.18.34",
            "command": directory.join("qualified-opencode-proxy-command"),
            "args": [directory.join("qualified-opencode-proxy-script")],
            "cwd": directory,
            "model": "openrouter/model",
            "approvalPolicy": "never",
            "instructions": "Complete the supplied task.",
        },
    })
}

fn managed_prepare_payload(kind: &str) -> Value {
    let operations = Vec::new();
    let provider = match kind {
        "claude_managed" => json!({
            "kind": "claude_managed",
            "model": "claude-sonnet-5",
            "profileId": "profile-1",
            "anthropicAgentId": "agent-1",
            "agentVersion": "1",
            "environmentId": "environment-1",
            "betaVersion": "managed-agents-2026-04-01",
            "maxSessionListCostUsd": 1.0,
            "instructions": "Complete the supplied task.",
            "runtimeContext": null,
        }),
        "aws_agentcore" => json!({
            "kind": "aws_agentcore",
            "model": "global.anthropic.claude-sonnet-4-6",
            "profileId": "profile-1",
            "region": "us-east-1",
            "accountId": "123456789012",
            "harnessArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test",
            "harnessVersion": "1",
            "endpointArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/test",
            "endpointQualifier": "1",
            "agentRuntimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test",
            "memoryArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test",
            "memoryId": "memory-1",
            "invocationRoleArn": "arn:aws:iam::123456789012:role/runner",
            "contextBucket": "context-bucket",
            "contextPrefix": "companies/company/profiles/profile",
            "contextKmsKeyArn": "arn:aws:kms:us-east-1:123456789012:key/test",
            "qualificationRevision": "aws-agentcore-harness-context-v2",
            "eventExpiryDays": 90,
            "maxEstimatedSessionCostUsd": 1.0,
            "maxIterations": 8,
            "maxOutputTokens": 4096,
            "timeoutSeconds": 300,
            "instructions": "Complete the supplied task.",
            "runtimeContext": null,
        }),
        _ => panic!("unsupported fixture"),
    };
    json!({
        "authorizedTools": {
            "schema": "paperclip.runner.authorized-tools.v1",
            "schemaVersion": 1,
            "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
            "operations": operations,
        },
        "provider": provider,
    })
}

#[test]
fn preserves_managed_provider_descriptors_through_the_native_selector() {
    for kind in ["claude_managed", "aws_agentcore"] {
        let directory = temporary_directory(kind);
        let config = config(&directory);
        let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        let prepared = executor
            .execute(&command(1, "run.prepare", managed_prepare_payload(kind)))
            .unwrap();
        assert_eq!(prepared.result["provider"], kind);
        assert!(directory.join("managed-provider-state.json").exists());
        executor.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn executes_a_qualified_acpx_profile_through_the_native_selector() {
    let directory = temporary_directory("acpx");
    let config = acpx_config(&directory, "turns-reserved-result-terminal");
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
            json!({"text": "Finish the task.", "turnId": "provider-turn-first"}),
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
    assert_valid_terminal(
        &events
            .iter()
            .find(|event| event.event_type == "run.terminal")
            .unwrap()
            .payload,
    );
    // runner.drain must see this exact terminal suffix without polling the
    // provider again. An empty default implementation strands the suffix and
    // makes shared native transport closure fail after a successful reply.
    assert_eq!(executor.retained_events().unwrap(), events);
    executor.acknowledge_events(events.len()).unwrap();
    assert!(executor.retained_events().unwrap().is_empty());
    executor
        .execute(&command(4, "session.close", json!({})))
        .unwrap();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn routes_reserved_completion_feedback_with_the_full_controller_catalog() {
    let directory = temporary_directory("acpx-controller-completion");
    let mode = "turns-reserved-feedback-roundtrip";
    let config = acpx_config(&directory, mode);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    let operations = ["paperclip_block", "paperclip_finish"]
        .map(|name| AuthorizedTool {
            operation_id: name.to_owned(),
            version: 1,
            description: "Report task completion to the server.".to_owned(),
            input_schema: json!({"type":"object"}),
            response_schema: json!({}),
        })
        .to_vec();
    let mut prepare = prepare_payload_with_mode(&directory, "codex", mode);
    prepare["authorizedTools"] = json!({
        "schema":"paperclip.runner.authorized-tools.v1", "schemaVersion":1,
        "catalogDigest":authorized_tool_catalog_digest(&operations).unwrap(),
        "operations":operations,
    });
    executor
        .execute(&command(1, "run.prepare", prepare))
        .unwrap();
    // The controller authorizes the built-ins, but cannot replace their fixed
    // provider schemas. Opening the real sidecar exercises that catalog split.
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text":"Finish", "turnId":"provider-turn-review"}),
        ))
        .unwrap();
    let events = executor.poll_events().unwrap();
    let first = events
        .iter()
        .find(|event| event.event_type == "semantic_tool.input")
        .unwrap();
    assert_eq!(first.payload["semantic_tool"]["callId"], "call-finish");
    assert!(!events
        .iter()
        .any(|event| event.event_type == "turn.completed"));
    executor.acknowledge_events(events.len()).unwrap();
    executor.execute(&command(4, "semantic_tool.result", json!({
        "callId":"call-finish", "operationId":"paperclip_finish", "isError":true,
        "result":{"success":false,"contentItems":[{"type":"inputText","text":"Name the reviewer and decision."}]},
    }))).unwrap();
    // The sidecar emits this correction only after receiving the exact reason.
    let events = executor.poll_events().unwrap();
    let corrected = events
        .iter()
        .find(|event| event.event_type == "semantic_tool.input")
        .unwrap();
    assert_eq!(
        corrected.payload["semantic_tool"]["callId"],
        "call-finish-2"
    );
    assert!(!events
        .iter()
        .any(|event| event.event_type == "turn.completed"));
    executor.acknowledge_events(events.len()).unwrap();
    assert!(executor.execute(&command(5, "semantic_tool.result", json!({
        "callId":"call-finish-2", "operationId":"paperclip_finish", "isError":false,
        "result":{"success":true,"contentItems":[{"type":"inputText","text":"Accepted"}],"unchecked":true},
    }))).is_err(), "Unexpected fields must not weaken the acknowledgement contract");
    executor.execute(&command(6, "semantic_tool.result", json!({
        "callId":"call-finish-2", "operationId":"paperclip_finish", "isError":false,
        "result":{"success":true,"contentItems":[{"type":"inputText","text":"Completion report accepted."}]},
    }))).unwrap();
    let events = executor.poll_events().unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "turn.completed")
            .count(),
        1
    );
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn provider_death_expires_input_and_commits_failure_without_querying_the_dead_provider() {
    let directory = temporary_directory("acpx-provider-death");
    let mode = "turns-provider-death";
    let mut config = acpx_config(&directory, mode);
    let mut payload = prepare_payload_with_mode(&directory, "codex", mode);
    let identity: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/copilot-profile-v37-identity.json"
    ))
    .unwrap();
    let digest = identity["commandDigest"].as_str().unwrap();
    *config
        .acpx_launch_profile
        .as_mut()
        .unwrap()
        .args
        .last_mut()
        .unwrap() = digest.to_owned();
    let provider = &mut payload["provider"];
    provider["agent"] = json!("copilot");
    provider["model"] = json!("gpt-5.6-luna");
    provider["permissionMode"] = json!("approve-paperclip");
    provider["agentServerPackage"] = json!("@github/copilot");
    provider["agentServerVersion"] = json!("1.0.88");
    provider["agentRuntimePackage"] = Value::Null;
    provider["agentRuntimeVersion"] = Value::Null;
    provider["providerPolicy"] = json!({"readOnly":false});
    provider["commandDigest"] = json!(digest);
    provider["sidecarArgs"][3] = json!(digest);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text":"Write", "turnId":"provider-turn-dead"}),
        ))
        .unwrap();
    let mut events = Vec::new();
    for _ in 0..20 {
        let batch = executor.poll_events().unwrap();
        executor.acknowledge_events(batch.len()).unwrap();
        events.extend(batch);
        if events
            .iter()
            .any(|event| event.event_type == "run.terminal")
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let expired = events
        .iter()
        .position(|event| event.event_type == "runtime_request.expired")
        .unwrap_or_else(|| panic!("provider death did not expire input: {events:?}"));
    let failed = events
        .iter()
        .position(|event| event.event_type == "turn.failed")
        .unwrap();
    assert!(expired < failed);
    assert_eq!(events[expired].payload["reason"], "provider_process_lost");
    assert_eq!(events[expired].payload["replayAllowed"], false);
    assert_eq!(
        events[failed].payload["providerTurnId"],
        "provider-turn-dead"
    );
    assert_eq!(
        events[failed].payload["error"]["code"],
        "ACPX_PROVIDER_PROCESS_LOST"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "turn.failed")
            .count(),
        1
    );
    let snapshot = executor
        .execute(&command(4, "session.snapshot", json!({})))
        .unwrap()
        .result;
    assert_eq!(snapshot["status"], "closed");
    assert_eq!(snapshot["activeProviderTurnId"], Value::Null);
    assert_eq!(snapshot["warmAttachReady"], false);
    assert!(executor
        .execute(&command(
            5,
            "turn.start",
            json!({"text":"Replay", "turnId":"replay-turn"})
        ))
        .is_err());
    executor
        .execute(&command(6, "session.close", json!({})))
        .unwrap();
    shutdown_recovered_acpx_fixture(&mut executor, &directory);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn resumes_an_idle_acpx_session_in_a_cold_replacement_runner() {
    let directory = temporary_directory("acpx-cold-idle-recovery");
    let config = acpx_config(&directory, "turns-reserved-result-terminal");
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(
            1,
            "run.prepare",
            prepare_payload(&directory, "codex"),
        ))
        .unwrap();
    let original = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text":"Acknowledge.", "turnId":"provider-turn-first"}),
        ))
        .unwrap();
    let events = executor.poll_events().unwrap();
    executor.acknowledge_events(events.len()).unwrap();
    executor
        .execute(&command(4, "runner.suspend", json!({})))
        .unwrap();
    executor.shutdown().unwrap();
    drop(executor);

    let mut replacement_config = config.clone();
    replacement_config.run_id = "run-2".to_owned();
    replacement_config.turn_id = "turn-2".to_owned();
    let mut replacement =
        NativeProviderCommandExecutor::with_runner_config(&directory, &replacement_config);
    let mut payload = prepare_payload(&directory, "codex");
    payload["provider"]["runId"] = json!("run-2");
    let resumed = replacement
        .execute(&command(1, "run.attach", payload))
        .unwrap();
    assert_eq!(resumed.result["status"], "resumed");
    assert_eq!(
        resumed.result["providerSessionId"],
        original.result["providerSessionId"]
    );
    // Admission itself must preserve the provider identity before any new
    // model turn. The fixture's scripted terminal events belong to run-1.
    replacement.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn keeps_native_acpx_semantic_events_on_the_durable_controller_turn() {
    let directory = temporary_directory("acpx-durable-turn-correlation");
    let config = acpx_config(&directory, "turns-tool");
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    let mut prepare = prepare_payload_with_mode(&directory, "codex", "turns-tool");
    prepare["authorizedTools"] = json!({
        "schema": "paperclip.runner.authorized-tools.v1",
        "schemaVersion": 1,
        "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
        "operations": operations,
    });

    executor
        .execute(&command(1, "run.prepare", prepare))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let started = executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text": "Read the issue.", "turnId": "provider-turn-fresh"}),
        ))
        .unwrap();
    assert_eq!(started.result["providerTurnId"], "provider-turn-fresh");

    let events = executor.poll_events().unwrap();
    let semantic = events
        .iter()
        .find(|event| event.event_type == "semantic_tool.input")
        .expect("ACPX tool call must cross the native provider boundary");
    assert_eq!(
        semantic.payload["semantic_tool"]["correlation"]["turnId"],
        "turn-1"
    );

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn starts_a_distinct_acpx_provider_turn_for_same_run_recovery() {
    let directory = temporary_directory("acpx-same-run-recovery");
    let config = acpx_config(&directory, "turns-reserved-result-terminal");
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    executor
        .execute(&command(
            1,
            "run.prepare",
            prepare_payload(&directory, "codex"),
        ))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let first = executor
        .execute(&command(
            3,
            "turn.start",
            json!({"text": "First attempt.", "turnId": "provider-turn-first"}),
        ))
        .unwrap();
    assert_eq!(first.result["providerTurnId"], "provider-turn-first");

    let first_events = executor.poll_events().unwrap();
    assert!(first_events
        .iter()
        .any(|event| event.event_type == "turn.completed"));
    executor.acknowledge_events(first_events.len()).unwrap();

    let recovered = executor
        .execute(&command(
            4,
            "turn.start",
            json!({
                "text": "Recover the missing disposition.",
                "turnId": "provider-turn-recovery",
            }),
        ))
        .unwrap();
    assert_eq!(recovered.result["providerTurnId"], "provider-turn-recovery");
    assert!(recovered.events.iter().any(|(event_type, _, payload)| {
        event_type == "turn.started" && payload["providerTurnId"] == "provider-turn-recovery"
    }));
    let recovered_events = executor.poll_events().unwrap();
    assert!(recovered_events.iter().any(|event| {
        event.event_type == "turn.completed"
            && event.payload["providerTurnId"] == "provider-turn-recovery"
    }));
    executor.acknowledge_events(recovered_events.len()).unwrap();

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn executes_opencode_through_the_local_facade_without_codex_event_labels() {
    let directory = temporary_directory("opencode");
    let config = opencode_config(&directory);
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
fn replacement_shutdown_restores_the_persisted_provider_before_cleanup() {
    let directory = temporary_directory("opencode-replacement-shutdown");
    let config = opencode_config(&directory);
    let mut first = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    first
        .execute(&command(
            1,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap();
    first
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    first.shutdown().unwrap();
    drop(first);

    let resumes_before_cleanup = opencode_call_count(&directory, "thread/resume");
    let mut replacement = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    replacement.shutdown().unwrap();

    assert_eq!(
        opencode_call_count(&directory, "thread/resume"),
        resumes_before_cleanup + 1,
        "a replacement executor must restore the persisted provider before terminal cleanup",
    );
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_a_mutable_opencode_command_outside_the_runner_launch_profile() {
    let directory = temporary_directory("opencode-command-override");
    let config = opencode_config(&directory);
    let mut payload = opencode_prepare_payload(&directory);
    payload["provider"]["command"] = json!(env!("CARGO_BIN_EXE_fake-codex-app-server"));
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);

    let error = executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("does not match the runner-owned qualified profile"));

    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_opencode_launch_profile_drift_across_fresh_recovery() {
    let directory = temporary_directory("opencode-profile-recovery");
    let config = opencode_config(&directory);
    let mut first = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    first
        .execute(&command(
            1,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap();
    first.shutdown().unwrap();
    drop(first);

    let mut changed = config.clone();
    changed
        .opencode_launch_profile
        .as_mut()
        .unwrap()
        .executable
        .sha256 = format!("sha256:{}", "a".repeat(64));
    let mut recovered = NativeProviderCommandExecutor::with_runner_config(&directory, &changed);
    let state_path = directory.join("codex-provider-state.json");
    let state_before_recovery = fs::read(&state_path).unwrap();
    let error = recovered
        .execute(&command(
            2,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("launch profile changed across durable recovery"));
    let second_error = recovered
        .execute(&command(
            3,
            "run.prepare",
            opencode_prepare_payload(&directory),
        ))
        .unwrap_err();
    assert!(second_error
        .to_string()
        .contains("launch profile changed across durable recovery"));
    assert_eq!(fs::read(&state_path).unwrap(), state_before_recovery);

    let shutdown_error = recovered
        .shutdown()
        .expect_err("invalid recovered launch authority also blocks cleanup");
    assert!(shutdown_error
        .to_string()
        .contains("launch profile changed across durable recovery"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_pi_without_an_explicit_model_before_starting_a_sidecar() {
    let directory = temporary_directory("pi-model");
    let config = pi_acpx_config(&directory, "bootstrap");
    let mut payload = pi_prepare_payload(&directory, "bootstrap");
    // Distribution and policy are valid, but model selection is still required.
    payload["provider"]["model"] = json!(" ");
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    let error = executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("does not match a qualified immutable profile"));
    assert!(!directory.join("acpx-runtime").exists());
    assert!(!directory.join("acpx-provider-state.json").exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pi_thinking_change_cannot_attach_to_an_existing_provider_identity() {
    let directory = temporary_directory("pi-thinking-attach");
    let config = pi_acpx_config(&directory, "bootstrap");
    let payload = pi_prepare_payload(&directory, "bootstrap");
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(1, "run.prepare", payload.clone()))
        .unwrap();
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["piThinkingLevel"], json!("low"));
    assert_eq!(
        opened.events[0].2["providerDescriptor"]["piThinkingLevel"],
        json!("low")
    );
    let state_path = directory.join("acpx-provider-state.json");
    let prior = fs::read(&state_path).unwrap();
    for (index, mode) in ["off", "high", "max"].into_iter().enumerate() {
        let mut changed = payload.clone();
        changed["provider"]["piThinkingLevel"] = json!(mode);
        let error = executor
            .execute(&command(3 + index as u64, "run.attach", changed))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("requires the same settled ACPX provider profile and session"),
            "unexpected thinking identity rejection: {error}"
        );
        assert_eq!(fs::read(&state_path).unwrap(), prior);
    }
    executor
        .execute(&command(6, "run.attach", payload))
        .unwrap();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stops_an_idle_pi_provider_before_suspension_without_waiting_for_its_close_rpc() {
    let directory = temporary_directory("pi-idle-suspension");
    let mut config = pi_acpx_config(&directory, "bootstrap");
    config
        .acpx_launch_profile
        .as_mut()
        .unwrap()
        .args
        .extend(["--suspend-delay-ms".to_owned(), "8000".to_owned()]);
    let mut payload = pi_prepare_payload(&directory, "bootstrap");
    payload["provider"]["sidecarArgs"] = json!(config.acpx_launch_profile.as_ref().unwrap().args);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let state_path = directory.join("acpx-provider-state.json");
    let opened: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let started = std::time::Instant::now();
    let stopped = executor
        .execute(&command(3, "turn.stop", json!({})))
        .unwrap();
    executor
        .execute(&command(4, "runner.drain", json!({})))
        .unwrap();
    executor
        .execute(&command(5, "runner.suspend", json!({})))
        .unwrap();
    let suspended: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let elapsed = started.elapsed();
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();

    assert_eq!(stopped.result["status"], "stopped");
    assert_eq!(stopped.result["providerExitConfirmed"], true);
    assert!(
        elapsed < Duration::from_secs(3),
        "idle close took {elapsed:?}"
    );
    assert_eq!(suspended["lifecycle"], "suspended");
    assert_eq!(suspended["providerExitUnconfirmed"], false);
    assert_eq!(suspended["identity"], opened["identity"]);
    assert_eq!(suspended["activeProviderTurnId"], Value::Null);
}

#[test]
fn idle_pi_stop_cannot_publish_a_reusable_identity_while_its_lifetime_fence_is_held() {
    let directory = temporary_directory("pi-idle-held-lifetime");
    // Linux can assign port 0 below the identity contract's dynamic-port range.
    // Keep this fixture distinct from the fake sidecar's default fence ports.
    let fence = (61_000..=u16::MAX)
        .filter_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
        .take(3)
        .collect::<Vec<_>>();
    assert_eq!(
        fence.len(),
        3,
        "three valid lifetime fence ports are required"
    );
    let ports = fence
        .iter()
        .map(|listener| listener.local_addr().unwrap().port().to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut config = pi_acpx_config(&directory, "bootstrap");
    config
        .acpx_launch_profile
        .as_mut()
        .unwrap()
        .args
        .extend(["--lifetime-fence-ports".to_owned(), ports]);
    let mut payload = pi_prepare_payload(&directory, "bootstrap");
    payload["provider"]["sidecarArgs"] = json!(config.acpx_launch_profile.as_ref().unwrap().args);
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
    executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let state_path = directory.join("acpx-provider-state.json");
    let opened: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let error = executor
        .execute(&command(3, "turn.stop", json!({})))
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("original provider lifetime remains active"));
    let stopped: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert_eq!(stopped["lifecycle"], "prepared");
    assert_eq!(stopped["providerExitUnconfirmed"], true);
    assert_eq!(stopped["identity"], opened["identity"]);
    assert!(
        executor
            .execute(&command(4, "runner.suspend", json!({})))
            .is_err(),
        "unconfirmed lifetime cannot produce a suspension receipt"
    );
    let before_poll = fs::read(&state_path).unwrap();
    assert!(
        executor.poll_events().unwrap().is_empty(),
        "held lifetime cannot publish a resumed provider"
    );
    assert_eq!(
        fs::read(&state_path).unwrap(),
        before_poll,
        "polling cannot erase the unconfirmed lifetime boundary"
    );
    drop(fence);
    executor.shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn publishes_only_changed_pi_controls_before_the_new_turn() {
    for (mode, initially_available, turn_available) in [
        ("controls-lazy", false, true),
        ("controls-downgrade", true, false),
        ("controls", true, true),
    ] {
        let directory = temporary_directory(mode);
        let config = pi_acpx_config(&directory, mode);
        let mut executor = NativeProviderCommandExecutor::with_runner_config(&directory, &config);
        executor
            .execute(&command(
                1,
                "run.prepare",
                pi_prepare_payload(&directory, mode),
            ))
            .unwrap();
        let opened = executor
            .execute(&command(2, "session.open", json!({})))
            .unwrap();
        assert_eq!(
            opened.events[0].2["providerDescriptor"]["turnControls"],
            json!({"steering":initially_available, "queuedFollowUp":initially_available})
        );

        let started = executor
            .execute(&command(
                3,
                "turn.start",
                json!({
                    "text":"Work", "turnId":"provider-turn-controls"
                }),
            ))
            .unwrap();
        assert_eq!(started.result["providerTurnId"], "provider-turn-controls");
        let expected_types = if initially_available != turn_available {
            vec!["session.capabilities.updated", "turn.started"]
        } else {
            vec!["turn.started"]
        };
        assert_eq!(
            started
                .events
                .iter()
                .map(|event| event.0.as_str())
                .collect::<Vec<_>>(),
            expected_types
        );
        if initially_available != turn_available {
            assert_eq!(
                started.events[0].2["turnControls"],
                json!({"steering":turn_available, "queuedFollowUp":turn_available})
            );
        }
        let turn = &started.events.last().unwrap().2;
        assert_eq!(turn["providerTurnId"], "provider-turn-controls");
        assert_eq!(turn["turn"]["id"], "provider-turn-controls");
        executor.shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
}
