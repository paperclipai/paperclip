#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::{
    AcpxLaunchProfile, Command, CommandExecutor, DurableRunnerConfig, QualifiedLaunchArtifact,
};
use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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

fn fixture(
    agent: &str,
) -> (
    Fixture,
    DurableRunnerConfig,
    NativeProviderCommandExecutor,
    Value,
) {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../../acpx-profiles.json")).unwrap();
    let profile = &catalog["profiles"][agent];
    let digest = profile["commandDigest"].as_str().unwrap();
    let fixture = Fixture(std::env::temp_dir().join(format!("acpx-warm-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&fixture.0).unwrap();
    fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &sidecar).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let native = fixture.0.join("native-sidecar");
    fs::rename(&sidecar, &native).unwrap();
    fs::write(&sidecar, format!("#!/bin/sh\nexec '{}' --mode source-reconcile --journal '{}' --source-fault '{}' \"$@\"\n", native.display(), fixture.0.join("sidecar.jsonl").display(), fixture.0.join("fault").display())).unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let args = vec!["--profile-digest".to_owned(), digest.to_owned()];
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
    };
    let descriptor = json!({
        "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
        "providerVersion": "0.13.1", "agent": agent, "model": "explicit-model",
        "acpxVersion": "0.13.1", "agentServerPackage": profile["agentServerPackage"],
        "agentServerVersion": profile["agentServerVersion"], "agentRuntimePackage": profile["agentRuntimePackage"],
        "agentRuntimeVersion": profile["agentRuntimeVersion"], "commandDigest": digest,
        "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
        "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
        "instructions": "Complete the supplied work.",
        "permissionMode": "approve-all", "permissionModePinned": true,
    });
    let mut executor = NativeProviderCommandExecutor::with_runner_config(&fixture.0, &config);
    executor
        .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
        .unwrap();
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    (fixture, config, executor, opened.result)
}

fn settle(executor: &mut NativeProviderCommandExecutor) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    let mut completed = false;
    loop {
        let events = executor.poll_events().unwrap();
        if events.is_empty() && completed {
            return seen;
        }
        for event in &events {
            completed |= event.event_type == "turn.completed";
            seen.push(json!({"type":event.event_type,"payload":event.payload}));
        }
        executor.acknowledge_events(events.len()).unwrap();
        assert!(Instant::now() < deadline, "no completed provider turn");
    }
}

#[test]
fn ordinary_acpx_read_tail_survives_immediate_next_turn_without_a_park_probe() {
    let (fixture, _config, mut executor, _) = fixture("claude");
    executor
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId":"first", "text":"Complete."}),
        ))
        .unwrap();
    settle(&mut executor);
    fs::write(fixture.0.join("fault"), "read-diagnostic").unwrap();
    executor
        .execute(&command(4, "session.goal.get", json!({})))
        .unwrap();
    fs::write(fixture.0.join("fault"), "").unwrap();
    executor
        .execute(&command(
            5,
            "turn.start",
            json!({"turnId":"second", "text":"Continue without a park probe."}),
        ))
        .unwrap();
    let events = settle(&mut executor);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["payload"]["code"] == "ordinary_read_tail")
            .count(),
        1
    );
    executor.shutdown().unwrap();
}

#[test]
fn ordinary_acpx_replacement_retains_a_multi_batch_tail_behind_existing_ack_debt() {
    for attach in [false, true] {
        let (fixture, config, mut executor, opened) = fixture("claude");
        executor
            .execute(&command(
                3,
                "turn.start",
                json!({"turnId":"first", "text":"Complete."}),
            ))
            .unwrap();
        settle(&mut executor);
        fs::write(fixture.0.join("fault"), "read-diagnostic").unwrap();
        executor
            .execute(&command(4, "session.goal.get", json!({})))
            .unwrap();
        assert_eq!(executor.poll_events().unwrap().len(), 1); // deliberately do not ACK
        fs::write(fixture.0.join("fault"), "read-burst").unwrap();
        executor
            .execute(&command(5, "session.goal.get", json!({})))
            .unwrap();
        fs::write(fixture.0.join("fault"), "").unwrap();
        let events = if attach {
            let state: Value = serde_json::from_slice(
                &fs::read(fixture.0.join("acpx-provider-state.json")).unwrap(),
            )
            .unwrap();
            let mut descriptor = state["descriptor"].clone();
            descriptor["runId"] = json!("run-2");
            let error = executor.execute(&command(6, "run.attach", json!({"provider":descriptor,
                "paperclipNextAuthority":{"identity":{"runId":"run-2","normalizedSessionId":config.normalized_session_id}}}))).unwrap_err();
            assert!(error.to_string().contains("settled ACPX"));
            let readiness = executor
                .execute(&command(
                    7,
                    "session.snapshot",
                    json!({"quiesceForWarmAttach":true}),
                ))
                .unwrap();
            assert_eq!(readiness.result["warmAttachReady"], false);
            assert!(std::process::Command::new("kill")
                .args(["-0", &opened["processId"].to_string()])
                .status()
                .unwrap()
                .success());
            let mut retained = Vec::new();
            loop {
                let batch = executor.retained_events().unwrap();
                if batch.is_empty() {
                    break;
                }
                retained.extend(
                    batch
                        .iter()
                        .map(|event| json!({"type":event.event_type,"payload":event.payload})),
                );
                executor.acknowledge_events(batch.len()).unwrap();
            }
            let readiness = executor
                .execute(&command(
                    8,
                    "session.snapshot",
                    json!({"quiesceForWarmAttach":true}),
                ))
                .unwrap();
            assert_eq!(readiness.result["warmAttachReady"], true);
            let attached = executor.execute(&command(9, "run.attach", json!({"provider":descriptor,
                "paperclipNextAuthority":{"identity":{"runId":"run-2","normalizedSessionId":config.normalized_session_id}}}))).unwrap();
            assert_eq!(
                attached.result["providerSessionId"],
                opened["providerSessionId"]
            );
            retained
        } else {
            executor
                .execute(&command(
                    6,
                    "turn.start",
                    json!({"turnId":"second","text":"Continue without waiting for old ACKs."}),
                ))
                .unwrap();
            settle(&mut executor)
        };
        assert_eq!(
            events
                .iter()
                .filter(|event| event["payload"]["code"] == "ordinary_read_tail")
                .count(),
            201
        );
        executor.shutdown().unwrap();
    }
}
