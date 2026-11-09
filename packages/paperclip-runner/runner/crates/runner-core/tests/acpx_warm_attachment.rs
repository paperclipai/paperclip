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

#[test]
fn checkpoints_the_sidecar_and_rebinds_consecutive_warm_runs_before_accepting_work() {
    let fixture = Fixture(std::env::temp_dir().join(format!("acpx-warm-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let args = vec![
        "--mode".to_owned(),
        "suspend".to_owned(),
        "--profile-digest".to_owned(),
        PROFILE_DIGEST.to_owned(),
    ];
    let mut config = DurableRunnerConfig {
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
    let mut descriptor = json!({
        "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
        "providerVersion": "0.13.1", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.13.1", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.160.0", "commandDigest": PROFILE_DIGEST,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    let mut executor = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    executor
        .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
        .unwrap();
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let provider_id = opened.result["providerSessionId"].clone();
    let mut previous_pid = opened.result["processId"].clone();
    assert!(previous_pid.is_number());

    for run in 2..=3 {
        let ready = executor
            .execute(&command(
                run * 10,
                "session.snapshot",
                json!({"quiesceForWarmAttach": true}),
            ))
            .unwrap();
        assert_eq!(ready.result["warmAttachReady"], true);
        config.run_id = format!("run-{run}");
        config.turn_id = format!("turn-{run}");
        config.item_id = format!("item-{run}");
        descriptor["runId"] = json!(config.run_id);
        let attached = executor
            .execute(&command(
                run * 10 + 1,
                "run.attach",
                json!({
                    "provider": descriptor,
                    "paperclipNextAuthority": {
                        "identity": {
                            "runnerInstanceId": config.runner_instance_id,
                            "environmentLeaseId": config.environment_lease_id,
                            "runId": config.run_id,
                            "normalizedSessionId": config.normalized_session_id,
                            "turnId": config.turn_id,
                            "itemId": config.item_id,
                        },
                        "connection": {"mode": "connect", "connectUrl": config.connect_url},
                    },
                }),
            ))
            .unwrap();
        assert_eq!(attached.result["status"], "resumed");
        assert_eq!(attached.result["providerSessionId"], provider_id);
        assert_ne!(attached.result["processId"], previous_pid);
        previous_pid = attached.result["processId"].clone();
        assert!(attached
            .events
            .iter()
            .any(|event| event.0 == "run.attached"));
        // Provider preparation cannot grant the new run authority by itself.
        assert!(executor
            .execute(&command(run * 10 + 2, "session.snapshot", json!({})))
            .is_err());
        executor.rotate_authority(&config);
        let active = executor
            .execute(&command(run * 10 + 3, "session.snapshot", json!({})))
            .unwrap();
        assert_eq!(active.result["warmAttachReady"], true);
        assert_eq!(active.result["providerSessionId"], provider_id);
    }
    let started = executor
        .execute(&command(
            40,
            "turn.start",
            json!({
                "turnId": "provider-turn-3", "text": "Perform work under run-3.",
            }),
        ))
        .unwrap();
    assert_eq!(started.result["status"], "accepted");
    executor.shutdown().unwrap();
}

fn unused_fence_ports() -> [u16; 3] {
    // Lifetime fence candidates must be dynamic ports (49152 and above). An
    // OS-assigned port can be lower, for example on Linux.
    let mut listeners = Vec::new();
    for port in (49_152..=u16::MAX).rev() {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            listeners.push(listener);
            if listeners.len() == 3 {
                break;
            }
        }
    }
    let ports = listeners
        .iter()
        .map(|listener| listener.local_addr().unwrap().port())
        .collect::<Vec<_>>();
    [ports[0], ports[1], ports[2]]
}

/// A runner that dies during an active ACPX turn (for example, when the
/// control plane restarts) must restore the same conversation once the old
/// provider lifetime is proven gone. It records a recoverable restart-loss
/// cause instead of a terminal provider failure.
#[test]
fn reopens_the_conversation_for_a_turn_after_a_suspension_stop() {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("acpx-repeat-restore-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let ports = unused_fence_ports();
    let args = vec![
        "--mode".to_owned(),
        "suspend".to_owned(),
        "--profile-digest".to_owned(),
        PROFILE_DIGEST.to_owned(),
        "--lifetime-fence-ports".to_owned(),
        format!("{},{},{}", ports[0], ports[1], ports[2]),
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
        "providerVersion": "0.13.1", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.13.1", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.160.0", "commandDigest": PROFILE_DIGEST,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    let mut original = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    original
        .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
        .unwrap();
    original
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    original
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId": "provider-turn-0", "text": "Do the work."}),
        ))
        .unwrap();
    original
        .execute(&command(4, "turn.stop", json!({})))
        .unwrap();
    assert!(original
        .execute(&command(
            5,
            "turn.start",
            json!({"turnId": "provider-turn-1"})
        ))
        .is_err());
    assert!(!original
        .poll_events()
        .unwrap()
        .iter()
        .any(|event| event.event_type == "session.resumed"));
    let started = original
        .execute(&command(
            5,
            "turn.start",
            json!({"turnId": "provider-turn-1", "text": "Continue."}),
        ))
        .unwrap();
    assert_eq!(started.result["status"], "accepted");
    assert!(started
        .events
        .iter()
        .any(|event| event.0 == "session.resumed"));
    original
        .execute(&command(6, "turn.stop", json!({})))
        .unwrap();
    original
        .execute(&command(7, "session.close", json!({})))
        .unwrap();
    assert!(original
        .execute(&command(
            8,
            "turn.start",
            json!({"turnId": "provider-turn-2", "text": "Continue."})
        ))
        .is_err());
    original.shutdown().unwrap();
}

#[test]
fn restores_the_conversation_after_losing_an_active_turn_to_a_runner_restart() {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("acpx-restart-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let ports = unused_fence_ports();
    let args = vec![
        "--mode".to_owned(),
        "suspend".to_owned(),
        "--profile-digest".to_owned(),
        PROFILE_DIGEST.to_owned(),
        "--lifetime-fence-ports".to_owned(),
        format!("{},{},{}", ports[0], ports[1], ports[2]),
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
        "providerVersion": "0.13.1", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.13.1", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.160.0", "commandDigest": PROFILE_DIGEST,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    let mut original = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    original
        .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
        .unwrap();
    let opened = original
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let provider_session = opened.result["providerSessionId"].clone();
    let started = original
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId": "provider-turn-1", "text": "Do the work."}),
        ))
        .unwrap();
    assert_eq!(started.result["status"], "accepted");
    // The runner process dies with the turn still active, after the turn sent
    // the controller a semantic call that has no result yet.
    drop(original);
    let state_path = fixture.0.join("acpx-provider-state.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    saved["openSemanticCalls"] = json!(["call-lost"]);
    fs::write(&state_path, serde_json::to_vec(&saved).unwrap()).unwrap();

    let mut restored = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    let snapshot = restored
        .execute(&command(4, "session.snapshot", json!({})))
        .unwrap();
    assert_ne!(snapshot.result["status"], "closed");
    assert_eq!(snapshot.result["providerSessionId"], provider_session);
    let events = restored.poll_events().unwrap();
    let failed = events
        .iter()
        .find(|event| event.event_type == "turn.failed")
        .expect("the lost turn is terminated");
    assert_eq!(failed.payload["providerTurnId"], "provider-turn-1");
    assert_eq!(failed.payload["providerTerminalObserved"], false);
    assert_eq!(
        failed.payload["error"]["code"],
        "provider_turn_lost_on_restore"
    );
    assert_eq!(failed.payload["error"]["recoverable"], true);
    // The run stays open for the controller's single same-conversation continuation.
    assert!(!events
        .iter()
        .any(|event| event.event_type == "run.terminal"));
    // The controller can still answer the lost call. That result settles the
    // call instead of failing against the restored provider, which never saw it.
    let lost_result = json!({
        "callId": "call-lost", "operationId": "register_deliverable",
        "result": {"ok": true}, "isError": false,
    });
    let settled = restored
        .execute(&command(5, "semantic_tool.result", lost_result.clone()))
        .unwrap();
    assert_eq!(settled.result["retired"], true);
    // The receipt is durable and idempotent, so a delivery left indeterminate
    // by a crash may replay to the same acknowledgement.
    assert!(restored.can_reconcile_result_delivery().unwrap());
    let replayed = restored
        .execute(&command(6, "semantic_tool.result", lost_result))
        .unwrap();
    assert_eq!(replayed.result["retired"], true);
    // Calls the lost turn never opened still fail closed.
    let unknown = json!({
        "callId": "call-unknown", "operationId": "register_deliverable",
        "result": {"ok": true}, "isError": false,
    });
    assert!(restored
        .execute(&command(7, "semantic_tool.result", unknown))
        .is_err());
    let continued = restored
        .execute(&command(
            8,
            "turn.start",
            json!({"turnId": "provider-turn-2", "text": "Continue."}),
        ))
        .unwrap();
    assert_eq!(continued.result["status"], "accepted");
    restored.shutdown().unwrap();
}

#[test]
fn restores_a_turn_lost_to_a_runner_upgrade_under_the_new_launch_profile() {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("acpx-upgrade-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let ports = unused_fence_ports();
    let args = vec![
        "--mode".to_owned(),
        "suspend".to_owned(),
        "--profile-digest".to_owned(),
        PROFILE_DIGEST.to_owned(),
        "--lifetime-fence-ports".to_owned(),
        format!("{},{},{}", ports[0], ports[1], ports[2]),
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
        "providerVersion": "0.13.1", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.13.1", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.160.0", "commandDigest": PROFILE_DIGEST,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    let mut original = AcpxCommandExecutor::with_runner_config(&fixture.0, &config);
    original
        .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
        .unwrap();
    let opened = original
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let provider_session = opened.result["providerSessionId"].clone();
    let started = original
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId": "provider-turn-1", "text": "Do the work."}),
        ))
        .unwrap();
    assert_eq!(started.result["status"], "accepted");
    drop(original);

    let mut upgraded = config.clone();
    upgraded
        .acpx_launch_profile
        .as_mut()
        .unwrap()
        .authority_digest = format!("sha256:{}", "e".repeat(64));
    let mut restored = AcpxCommandExecutor::with_runner_config(&fixture.0, &upgraded);
    let snapshot = restored
        .execute(&command(4, "session.snapshot", json!({})))
        .expect("the new build restores the conversation of the turn the upgrade lost");
    assert_ne!(snapshot.result["status"], "closed");
    assert_eq!(snapshot.result["providerSessionId"], provider_session);
    let events = restored.poll_events().unwrap();
    let failed = events
        .iter()
        .find(|event| event.event_type == "turn.failed")
        .expect("the lost turn is terminated");
    assert_eq!(failed.payload["providerTurnId"], "provider-turn-1");
    assert_eq!(
        failed.payload["error"]["code"],
        "provider_turn_lost_on_restore"
    );
    assert_eq!(failed.payload["error"]["recoverable"], true);
    assert!(!events
        .iter()
        .any(|event| event.event_type == "run.terminal"));
    let continued = restored
        .execute(&command(
            5,
            "turn.start",
            json!({"turnId": "provider-turn-2", "text": "Continue the work."}),
        ))
        .unwrap();
    assert_eq!(continued.result["status"], "accepted");
    let saved: Value =
        serde_json::from_slice(&fs::read(fixture.0.join("acpx-provider-state.json")).unwrap())
            .unwrap();
    let upgraded_digest = upgraded
        .acpx_launch_profile
        .as_ref()
        .unwrap()
        .canonical_digest()
        .unwrap();
    assert_eq!(saved["launchProfileDigest"], upgraded_digest);
    restored.shutdown().unwrap();
}
