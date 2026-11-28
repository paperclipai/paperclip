#![cfg(unix)]

//! A sidecar that refuses to reload a saved conversation in a new provider
//! process (`ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE`) names the restore failure
//! `provider_state_incompatible`, so the server starts a replacement
//! conversation instead of retrying a generic interruption.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_backend::AcpxCommandExecutor;
use paperclip_runner_core::durable::{
    AcpxLaunchProfile, Command, CommandExecutor, DurableRunnerConfig, QualifiedLaunchArtifact,
    PROVIDER_STATE_INCOMPATIBLE,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PROFILE_DIGEST: &str =
    "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc";
const INCOMPATIBLE: &str = "ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE";

struct Fixture {
    directory: PathBuf,
    config: DurableRunnerConfig,
    descriptor: Value,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

impl Fixture {
    fn new(label: &str) -> Self {
        let directory = std::env::temp_dir().join(format!("acpx-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let native = directory.join("native-sidecar");
        fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &native).unwrap();
        fs::set_permissions(&native, fs::Permissions::from_mode(0o700)).unwrap();
        // The launch profile authenticates every absolute argument, so the
        // rejection file is named inside the authenticated wrapper.
        let sidecar = directory.join("sidecar");
        fs::write(
            &sidecar,
            format!(
                "#!/bin/sh\nexec '{}' --open-rejection '{}' \"$@\"\n",
                native.display(),
                directory.join("open-rejection").display()
            ),
        )
        .unwrap();
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
            state_dir: directory.clone(),
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
            controller_silence: paperclip_runner_core::durable::DEFAULT_CONTROLLER_SILENCE,
        };
        let descriptor = json!({
            "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
            "providerVersion": "0.22.0", "agent": "codex", "model": "gpt-5.6-sol",
            "acpxVersion": "0.22.0", "agentServerPackage": "@agentclientprotocol/codex-acp",
            "agentServerVersion": "1.6.2", "agentRuntimePackage": "@openai/codex",
            "agentRuntimeVersion": "0.170.0", "commandDigest": PROFILE_DIGEST,
            "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": directory,
            "normalizedSessionId": "session-1", "runId": "run-1", "cwd": directory,
            "instructions": "Complete the supplied work.",
            "permissionMode": "approve-all", "permissionModePinned": true,
        });
        Self {
            directory,
            config,
            descriptor,
        }
    }

    fn reject_open(&self, scope: &str, code: &str) {
        fs::write(
            self.directory.join("open-rejection"),
            format!("{scope} {code}"),
        )
        .unwrap();
    }

    fn executor(&self) -> AcpxCommandExecutor {
        AcpxCommandExecutor::with_runner_config(&self.directory, &self.config)
    }

    /// Opens the conversation in a first runner and returns that runner.
    fn opened(&self) -> AcpxCommandExecutor {
        let mut original = self.executor();
        original
            .execute(&command(
                1,
                "run.prepare",
                json!({"provider": self.descriptor}),
            ))
            .unwrap();
        original
            .execute(&command(2, "session.open", json!({})))
            .unwrap();
        original
    }

    /// Opens the conversation, then retires that runner with `runner.suspend`.
    fn suspended(&self) {
        let mut original = self.opened();
        original
            .execute(&command(3, "runner.suspend", json!({})))
            .unwrap();
        drop(original);
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

fn unused_fence_ports() -> [u16; 3] {
    // Lifetime fence candidates must be dynamic ports (49152 and above).
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

#[test]
fn a_refused_reload_of_a_suspended_session_names_the_saved_state_incompatible() {
    let fixture = Fixture::new("incompatible-suspended");
    fixture.suspended();
    fixture.reject_open("recovering", INCOMPATIBLE);
    let mut restored = fixture.executor();
    let error = restored
        .execute(&command(4, "session.snapshot", json!({})))
        .expect_err("the provider refused to reload the saved conversation");
    assert_eq!(
        error.classification(),
        Some(PROVIDER_STATE_INCOMPATIBLE),
        "{error}"
    );
    // The refusal is deterministic: the same runner reports the same class.
    let repeated = restored
        .execute(&command(5, "session.open", json!({})))
        .unwrap_err();
    assert_eq!(repeated.classification(), Some(PROVIDER_STATE_INCOMPATIBLE));
}

#[test]
fn a_refused_reload_of_a_lost_turn_names_the_saved_state_incompatible() {
    let fixture = Fixture::new("incompatible-lost-turn");
    let mut original = fixture.opened();
    let started = original
        .execute(&command(
            3,
            "turn.start",
            json!({"turnId": "provider-turn-1", "text": "Do the work."}),
        ))
        .unwrap();
    assert_eq!(started.result["status"], "accepted");
    drop(original);
    fixture.reject_open("recovering", INCOMPATIBLE);
    let mut restored = fixture.executor();
    let error = restored
        .execute(&command(4, "session.snapshot", json!({})))
        .expect_err("the provider refused to reload the lost turn's conversation");
    assert_eq!(
        error.classification(),
        Some(PROVIDER_STATE_INCOMPATIBLE),
        "{error}"
    );
}

/// Antigravity never restarts its provider at the end of a turn (the
/// turn-end generation restart is Claude-only), so a provider lost between
/// turns is reopened by the next `turn.start`. A refusal to reload the saved
/// conversation there is named the same way, never a generic closed session.
#[test]
fn a_refused_reload_at_the_next_turn_start_names_the_saved_state_incompatible() {
    let fixture = Fixture::new("incompatible-next-turn");
    fixture.suspended();
    fixture.reject_open("recovering", INCOMPATIBLE);
    let mut restored = fixture.executor();
    let error = restored
        .execute(&command(
            4,
            "turn.start",
            json!({"turnId": "provider-turn-2", "text": "Continue the work."}),
        ))
        .expect_err("the provider refused to reload the saved conversation");
    assert_eq!(
        error.classification(),
        Some(PROVIDER_STATE_INCOMPATIBLE),
        "{error}"
    );
}

#[test]
fn another_reload_refusal_keeps_its_ordinary_failure() {
    let fixture = Fixture::new("incompatible-other-code");
    fixture.suspended();
    fixture.reject_open("recovering", "ACPX_PERSISTED_SESSION_MISSING");
    let mut restored = fixture.executor();
    let error = restored
        .execute(&command(4, "session.snapshot", json!({})))
        .unwrap_err();
    assert_ne!(
        error.classification(),
        Some(PROVIDER_STATE_INCOMPATIBLE),
        "{error}"
    );
}

#[test]
fn a_fresh_open_with_the_same_code_is_not_named_incompatible() {
    let fixture = Fixture::new("incompatible-fresh-open");
    fixture.reject_open("any", INCOMPATIBLE);
    let mut executor = fixture.executor();
    executor
        .execute(&command(
            1,
            "run.prepare",
            json!({"provider": fixture.descriptor}),
        ))
        .unwrap();
    let error = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap_err();
    assert!(
        error.to_string().contains("failed to start ACPX provider"),
        "{error}"
    );
    assert_ne!(
        error.classification(),
        Some(PROVIDER_STATE_INCOMPATIBLE),
        "{error}"
    );
}
