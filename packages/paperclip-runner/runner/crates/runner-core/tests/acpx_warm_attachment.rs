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
    "sha256:c4538599d1ab767db5dff50934f13bb5ba313a59d9c4a83e993fac4617ea63d3";

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
            authority_digest: format!("sha256:{}", "d".repeat(64)),
            command: sidecar.clone(),
            args: args.clone(),
            artifacts: vec![QualifiedLaunchArtifact {
                path: sidecar.clone(),
                sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&sidecar).unwrap())),
            }],
        }),
        opencode_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(30),
    };
    let mut descriptor = json!({
        "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
        "providerVersion": "0.13.1", "agent": "codex", "model": "gpt-5.6-sol",
        "acpxVersion": "0.13.1", "agentServerPackage": "@agentclientprotocol/codex-acp",
        "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
        "agentRuntimeVersion": "0.156.0", "commandDigest": PROFILE_DIGEST,
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
