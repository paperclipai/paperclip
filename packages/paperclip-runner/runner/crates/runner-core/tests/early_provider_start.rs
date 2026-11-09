#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use paperclip_runner_core::codex_provider::CodexProviderConfig;
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

impl Fixture {
    fn new(label: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("early-provider-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        Self(directory)
    }

    fn codex_state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("codex-provider-state.json")).unwrap())
            .unwrap()
    }

    fn codex_calls(&self, method: &str) -> usize {
        fs::read_to_string(self.0.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .filter(|line| *line == method)
            .count()
    }

    fn sidecar_journal(&self) -> Vec<Value> {
        fs::read_to_string(self.0.join("sidecar.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn sidecar_starts(&self) -> Vec<u64> {
        self.sidecar_journal()
            .iter()
            .filter_map(|line| line["processStart"].as_u64())
            .collect()
    }

    fn sidecar_commands(&self) -> Vec<String> {
        self.sidecar_journal()
            .iter()
            .filter_map(|line| line["command"].as_str().map(str::to_owned))
            .collect()
    }

    fn wait_for_sidecar_start(&self) -> u64 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pid) = self.sidecar_starts().last() {
                return *pid;
            }
            assert!(Instant::now() < deadline, "the sidecar never started");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn runner_config(directory: &Path) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1/runner".to_owned(),
        ca_bundle_path: None,
        state_dir: directory.to_owned(),
        runner_instance_id: "runner-1".to_owned(),
        environment_lease_id: "lease-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
        runner_version: "0.0.0".to_owned(),
        runner_digest: format!("sha256:{}", "a".repeat(64)),
        acpx_launch_profile: None,
        opencode_launch_profile: None,
        cursor_cloud_launch_profile: None,
        max_outbox_bytes: 1024 * 1024,
        p0_reserve_bytes: 64 * 1024,
        max_frame_bytes: 1024 * 1024,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(30),
        turn_scoped: false,
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

fn alive(pid: u64) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn zombie(pid: u64) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|output| {
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .starts_with('Z')
        })
}

fn kill_and_wait(pid: u64) {
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && !zombie(pid) {
        assert!(Instant::now() < deadline, "process {pid} survived KILL");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn codex_prepare(directory: &Path) -> Value {
    let provider = CodexProviderConfig {
        provider: "codex".to_owned(),
        driver: "codex_app_server".to_owned(),
        provider_version: "fake-1".to_owned(),
        command: PathBuf::from(env!("CARGO_BIN_EXE_fake-codex-app-server")),
        args: vec![
            "--state-file".to_owned(),
            directory.join("fake-state.json").display().to_string(),
            "--call-log".to_owned(),
            directory.join("calls.log").display().to_string(),
        ],
        cwd: std::env::current_dir().unwrap().display().to_string(),
        model: Some("test-model".to_owned()),
        provider_session_id: None,
        instructions: "Stay inside the test workspace.".to_owned(),
        approval_policy: "never".to_owned(),
        externally_sandboxed: false,
        read_only: false,
        include_skill_instructions: None,
        conversation_mode: None,
    };
    let mut provider = serde_json::to_value(provider).unwrap();
    provider["kind"] = json!("codex");
    json!({ "provider": provider })
}

fn prepared_codex(fixture: &Fixture) -> (NativeProviderCommandExecutor, u64) {
    let mut executor =
        NativeProviderCommandExecutor::with_runner_config(&fixture.0, &runner_config(&fixture.0));
    let prepared = executor
        .execute(&command(1, "run.prepare", codex_prepare(&fixture.0)))
        .unwrap();
    assert_eq!(prepared.result["status"], "prepared");
    let attempt = fixture.codex_state()["startupAttempt"].clone();
    assert_eq!(attempt["phase"], "spawned");
    assert_eq!(attempt["command"]["commandType"], "run.prepare");
    let pid = attempt["processId"].as_u64().unwrap();
    assert!(alive(pid));
    assert_eq!(fixture.codex_calls("initialize"), 0);
    (executor, pid)
}

fn retired_startups(fixture: &Fixture) -> usize {
    fixture.codex_state()["pendingEvents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["payload"]["code"] == "provider_startup_retired")
        .count()
}

#[test]
fn codex_session_open_adopts_the_app_server_started_at_run_prepare() {
    let fixture = Fixture::new("codex-adopt");
    let (mut executor, pid) = prepared_codex(&fixture);
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["status"], "started");
    let state = fixture.codex_state();
    assert!(state["startupAttempt"].is_null());
    assert_eq!(state["lifecycle"], "session_open");
    assert_eq!(state["providerProcessGeneration"], 1);
    assert_eq!(fixture.codex_calls("initialize"), 1);
    assert_eq!(fixture.codex_calls("thread/start"), 1);
    assert!(alive(pid));
    assert_eq!(retired_startups(&fixture), 0);
    executor.shutdown().unwrap();
    assert!(!alive(pid));
}

#[test]
fn codex_session_open_replaces_an_early_app_server_that_died() {
    let fixture = Fixture::new("codex-died");
    let (mut executor, pid) = prepared_codex(&fixture);
    kill_and_wait(pid);
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["status"], "started");
    let state = fixture.codex_state();
    assert!(state["startupAttempt"].is_null());
    assert_eq!(state["lifecycle"], "session_open");
    assert_eq!(fixture.codex_calls("initialize"), 1);
    assert_eq!(retired_startups(&fixture), 1);
    executor.shutdown().unwrap();
}

#[test]
fn codex_early_app_server_stops_when_another_command_replaces_session_open() {
    let fixture = Fixture::new("codex-cancel");
    let (mut executor, pid) = prepared_codex(&fixture);
    executor
        .execute(&command(2, "session.close", json!({})))
        .unwrap();
    assert!(!alive(pid));
    let state = fixture.codex_state();
    assert!(state["startupAttempt"].is_null());
    assert_eq!(state["lifecycle"], "closed");
    assert_eq!(fixture.codex_calls("initialize"), 0);
    executor.shutdown().unwrap();
}

#[test]
fn codex_early_app_server_stops_at_runner_shutdown() {
    let fixture = Fixture::new("codex-shutdown");
    let (mut executor, pid) = prepared_codex(&fixture);
    executor.shutdown().unwrap();
    assert!(!alive(pid));
    assert!(fixture.codex_state()["startupAttempt"].is_null());
}

#[test]
fn codex_early_app_server_stops_when_the_runner_authority_rotates() {
    let fixture = Fixture::new("codex-rotate");
    let (mut executor, pid) = prepared_codex(&fixture);
    let mut rotated = runner_config(&fixture.0);
    rotated.run_id = "run-2".to_owned();
    executor.rotate_authority(&rotated);
    assert!(!alive(pid));
    assert!(fixture.codex_state()["startupAttempt"].is_null());
    executor.shutdown().unwrap();
}

struct Acpx {
    fixture: Fixture,
    config: DurableRunnerConfig,
    descriptor: Value,
}

fn acpx(agent: &str) -> Acpx {
    let catalog: Value =
        serde_json::from_str(include_str!("../../../../acpx-profiles.json")).unwrap();
    let profile = &catalog["profiles"][agent];
    let digest = profile["commandDigest"].as_str().unwrap();
    let fixture = Fixture::new("acpx");
    let native = fixture.0.join("native-sidecar");
    fs::copy(env!("CARGO_BIN_EXE_fake-acpx-sidecar"), &native).unwrap();
    fs::set_permissions(&native, fs::Permissions::from_mode(0o700)).unwrap();
    let sidecar = fixture.0.join("sidecar");
    fs::write(
        &sidecar,
        format!(
            "#!/bin/sh\nexec '{}' --mode source-reconcile --emit-process --journal '{}' --source-fault '{}' \"$@\"\n",
            native.display(),
            fixture.0.join("sidecar.jsonl").display(),
            fixture.0.join("fault").display()
        ),
    )
    .unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o700)).unwrap();
    let args = vec!["--profile-digest".to_owned(), digest.to_owned()];
    let mut config = runner_config(&fixture.0);
    config.acpx_launch_profile = Some(AcpxLaunchProfile {
        candidate_admission: None,
        authority_digest: format!("sha256:{}", "d".repeat(64)),
        command: sidecar.clone(),
        args: args.clone(),
        artifacts: vec![QualifiedLaunchArtifact {
            path: sidecar.clone(),
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(&sidecar).unwrap())),
        }],
    });
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
        "runtimeContext": null,
    });
    Acpx {
        fixture,
        config,
        descriptor,
    }
}

impl Acpx {
    fn prepared(&self) -> NativeProviderCommandExecutor {
        let mut executor =
            NativeProviderCommandExecutor::with_runner_config(&self.fixture.0, &self.config);
        let prepared = executor
            .execute(&command(
                1,
                "run.prepare",
                json!({"provider": self.descriptor}),
            ))
            .unwrap();
        assert_eq!(prepared.result["status"], "prepared");
        executor
    }
}

#[test]
fn claude_session_open_adopts_the_sidecar_started_at_run_prepare() {
    let claude = acpx("claude");
    let mut executor = claude.prepared();
    let pid = claude.fixture.wait_for_sidecar_start();
    assert!(claude.fixture.sidecar_commands().is_empty());
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(opened.result["processId"], pid);
    assert_eq!(claude.fixture.sidecar_starts(), [pid]);
    assert_eq!(
        claude.fixture.sidecar_commands()[..3],
        ["initialize", "session.open", "run.attach"]
    );
    executor.shutdown().unwrap();
    assert!(!alive(pid));
}

#[test]
fn claude_session_open_replaces_an_early_sidecar_that_died() {
    let claude = acpx("claude");
    let mut executor = claude.prepared();
    let early = claude.fixture.wait_for_sidecar_start();
    kill_and_wait(early);
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    let replacement = opened.result["processId"].as_u64().unwrap();
    assert_ne!(replacement, early);
    assert_eq!(claude.fixture.sidecar_starts(), [early, replacement]);
    assert_eq!(
        claude.fixture.sidecar_commands()[..3],
        ["initialize", "session.open", "run.attach"]
    );
    executor.shutdown().unwrap();
}

#[test]
fn claude_early_sidecar_stops_when_another_command_replaces_session_open() {
    let claude = acpx("claude");
    let mut executor = claude.prepared();
    let pid = claude.fixture.wait_for_sidecar_start();
    let _ = executor.execute(&command(2, "session.close", json!({})));
    assert!(!alive(pid));
    assert!(claude.fixture.sidecar_commands().is_empty());
    executor.shutdown().unwrap();
}

#[test]
fn claude_early_sidecar_stops_at_runner_shutdown() {
    let claude = acpx("claude");
    let mut executor = claude.prepared();
    let pid = claude.fixture.wait_for_sidecar_start();
    executor.shutdown().unwrap();
    assert!(!alive(pid));
    assert!(claude.fixture.sidecar_commands().is_empty());
}

#[test]
fn other_acpx_agents_keep_starting_their_sidecar_at_session_open() {
    let codex = acpx("codex");
    let mut executor = codex.prepared();
    std::thread::sleep(Duration::from_millis(200));
    assert!(codex.fixture.sidecar_starts().is_empty());
    let opened = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap();
    assert_eq!(
        codex.fixture.sidecar_starts(),
        [opened.result["processId"].as_u64().unwrap()]
    );
    executor.shutdown().unwrap();
}

#[test]
fn codex_early_launch_failure_is_reported_by_session_open_as_before() {
    let fixture = Fixture::new("codex-spawn-failure");
    let unexecutable = fixture.0.join("codex");
    fs::write(&unexecutable, "not a program").unwrap();
    fs::set_permissions(&unexecutable, fs::Permissions::from_mode(0o600)).unwrap();
    let mut payload = codex_prepare(&fixture.0);
    payload["provider"]["command"] = json!(unexecutable);
    let mut executor =
        NativeProviderCommandExecutor::with_runner_config(&fixture.0, &runner_config(&fixture.0));
    let prepared = executor
        .execute(&command(1, "run.prepare", payload))
        .unwrap();
    assert_eq!(prepared.result["status"], "prepared");
    assert!(fixture.codex_state()["startupAttempt"].is_null());
    assert_eq!(retired_startups(&fixture), 1);
    let error = executor
        .execute(&command(2, "session.open", json!({})))
        .unwrap_err();
    assert!(error.to_string().contains("failed to start Codex provider"));
    let attempt = fixture.codex_state()["startupAttempt"].clone();
    assert_eq!(attempt["phase"], "initialization_failed");
    assert_eq!(attempt["command"]["commandType"], "session.open");
}

#[test]
fn claude_early_sidecar_stops_when_the_runner_authority_rotates() {
    let claude = acpx("claude");
    let mut executor = claude.prepared();
    let pid = claude.fixture.wait_for_sidecar_start();
    let mut rotated = claude.config.clone();
    rotated.run_id = "run-2".to_owned();
    executor.rotate_authority(&rotated);
    assert!(!alive(pid));
    assert!(claude.fixture.sidecar_commands().is_empty());
    executor.shutdown().unwrap();
}
