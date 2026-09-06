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
    "sha256:7a923b3829884d3cabcc9659d22cace3f86813e7bfffc90974b10140a45bc400";

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
        (json!("@openai/codex"), json!("0.148.0"))
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
            "model": "gpt-5.6-sol",
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
            "qualificationRevision": "aws-agentcore-harness-v1",
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
    executor.acknowledge_events(events.len()).unwrap();
    executor
        .execute(&command(4, "session.close", json!({})))
        .unwrap();
    executor.shutdown().unwrap();
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
