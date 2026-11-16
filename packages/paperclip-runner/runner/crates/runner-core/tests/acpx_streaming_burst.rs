#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_backend::AcpxCommandExecutor;
use paperclip_runner_core::durable::{
    AcpxLaunchProfile, Command, CommandExecutor, DurableRunnerConfig, QualifiedLaunchArtifact,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PROFILE_DIGEST: &str =
    "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc";

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn command(sequence: u64, kind: &str, payload: Value) -> Command {
    Command {
        schema: "paperclip.prp.command.v1".to_owned(),
        command_id: format!("command-{sequence}"),
        controller_seq: sequence,
        command_type: kind.to_owned(),
        issued_at: "2026-09-21T00:00:00.000Z".to_owned(),
        deadline_at: None,
        precondition: None,
        payload,
    }
}

fn started(mode: &str) -> (Fixture, DurableRunnerConfig, AcpxCommandExecutor) {
    let fixture = Fixture(std::env::temp_dir().join(format!("acpx-warm-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let args = vec![
        "--mode".to_owned(),
        mode.to_owned(),
        "--profile-digest".to_owned(),
        PROFILE_DIGEST.to_owned(),
    ];
    let config = DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".to_owned(),
        ca_bundle_path: None,
        state_dir: fixture.0.clone(),
        runner_instance_id: "runner-1".to_owned(),
        environment_lease_id: "lease-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
        runner_version: "0.0.0".to_owned(),
        runner_digest: format!("sha256:{}", "a".repeat(64)),
        acpx_launch_profile: Some(AcpxLaunchProfile {
            candidate_admission: None,
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: sidecar.clone(),
            args: args.clone(),
            artifacts: vec![QualifiedLaunchArtifact {
                path: sidecar.clone(),
                sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&sidecar).unwrap())),
            }],
        }),
        opencode_launch_profile: None,
        cursor_cloud_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(30),
        turn_scoped: false,
    };
    let descriptor = json!({
        "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
        "providerVersion": "0.22.0", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.22.0", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.160.0", "commandDigest": PROFILE_DIGEST,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    use paperclip_runner_core::provider_bridge::{
        authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet,
    };
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".into(),
        version: 1,
        description: "Read".into(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    let tools = AuthorizedToolSet {
        schema: "paperclip.runner.authorized-tools.v1".into(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    };
    let mut executor = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    executor
        .execute(&command(
            1,
            "run.prepare",
            json!({"provider": descriptor, "authorizedTools": tools}),
        ))
        .unwrap();
    executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId":"turn-1","text":"Read the issue"}),
        ))
        .unwrap();
    (fixture, config, executor)
}

#[test]
fn streams_a_large_burst_before_dispatching_the_tool() {
    streaming_burst(false);
}

#[test]
fn streams_a_large_burst_while_disconnected() {
    streaming_burst(true);
}

fn streaming_burst(disconnected: bool) {
    let (_fixture, _config, mut executor) = started("resolutions-stream-burst");
    let started = std::time::Instant::now();
    let mut text = String::new();
    let mut emitted = 0;
    let mut tool_seen = false;
    while !tool_seen {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "tool stuck behind streaming output"
        );
        let batch = if disconnected {
            executor.poll_disconnected_events()
        } else {
            executor.poll_events()
        }
        .unwrap();
        if !batch.is_empty() {
            assert_eq!(executor.poll_events().unwrap(), batch);
        }
        for event in &batch {
            emitted += 1;
            if event.event_type == "item.delta" {
                text.push_str(event.payload["text"].as_str().unwrap());
            }
            tool_seen |= event.event_type == "semantic_tool.input";
        }
        executor.acknowledge_events(batch.len()).unwrap();
    }
    assert_eq!(text, "片".repeat(3135));
    eprintln!(
        "3,135 UTF-8 deltas: {emitted} durable events, tool available after {:?}",
        started.elapsed()
    );
    assert!(
        emitted < 70,
        "{emitted} token-sized durable events delay control tools"
    );
    let result = executor
        .execute(&command(
            4,
            "semantic_tool.result",
            json!({
                "callId":"call-1","operationId":"issues.read","result":{"ok":true},"isError":false
            }),
        ))
        .unwrap();
    assert_eq!(result.result["status"], "delivered");
    executor.shutdown().unwrap();
}

#[test]
fn persists_failed_poll_prefix_before_drain_and_recovery_without_ack() {
    let (fixture, config, mut executor) = started("stream-terminal-goal-error");
    let error = executor.poll_events().unwrap_err();
    assert!(
        error.to_string().contains("ACPX goal control failed"),
        "{error}"
    );
    let prefix = executor.retained_events().unwrap();
    assert!(prefix.iter().any(|event| event.event_type == "item.delta"));
    assert!(prefix
        .iter()
        .any(|event| event.event_type == "semantic_tool.input"));
    let saved: Value = serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
    assert_eq!(
        saved["pendingEvents"],
        serde_json::to_value(&prefix).unwrap()
    );
    let next_sequence = saved["nextEventSequence"].as_u64().unwrap();

    drop(executor);
    let mut recovered = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    let events = recovered.poll_events().unwrap();
    assert_eq!(&events[..prefix.len()], prefix.as_slice());
    assert!(events[prefix.len()..]
        .iter()
        .any(|event| event.event_type == "turn.failed"));
    for event in &events[prefix.len()..] {
        let sequence = event
            .executor_event_id
            .strip_prefix("acpx_provider_")
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!(sequence >= next_sequence);
    }
    recovered.acknowledge_events(events.len()).unwrap();
    assert!(recovered.retained_events().unwrap().is_empty());
    recovered.shutdown().unwrap();
}

#[test]
fn failed_prefix_save_blocks_error_path_drain() {
    let (_fixture, _config, mut executor) = started("stream-terminal-goal-error");
    fs::remove_file(executor.state_path()).unwrap();
    fs::create_dir(executor.state_path()).unwrap();
    let error = executor.poll_events().unwrap_err();
    assert!(error
        .to_string()
        .contains("failed to atomically replace ACPX provider state"));
    assert!(
        executor.retained_events().is_err(),
        "an uncommitted prefix must never reach the outbox"
    );
}

#[test]
fn buffered_park_drain_preserves_the_published_prefix() {
    let (_fixture, _config, mut executor) = started("resolutions-stream-buffered");
    let published = executor.poll_events().unwrap();
    assert_eq!(published.last().unwrap().event_type, "item.delta");
    executor
        .execute(&command(4, "session.goal.get", json!({})))
        .unwrap();
    executor
        .execute(&command(
            5,
            "session.snapshot",
            json!({"quiesceForWarmAttach": true}),
        ))
        .unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap();
    let pending = saved["pendingEvents"].as_array().unwrap();
    assert!(pending.len() > published.len());
    assert_eq!(
        serde_json::to_value(&pending[..published.len()]).unwrap(),
        serde_json::to_value(&published).unwrap()
    );
    executor.shutdown().unwrap();
}
