#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::durable::{
    AcpxLaunchProfile, Command, CommandExecution, CommandExecutor, DurableRunnerConfig,
    QualifiedLaunchArtifact,
};
use paperclip_runner_core::native_provider_backend::NativeProviderCommandExecutor;
use paperclip_runner_core::provider_bridge::{authorized_tool_catalog_digest, AuthorizedTool};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[path = "support/acpx_turn_end_restart.rs"]
mod turn_end_restart;

#[path = "support/acpx_cut_turn_start.rs"]
mod cut_turn_start;

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Fixture {
    fn fault(&self, fault: &str) {
        fs::write(self.0.join("fault"), fault).unwrap();
    }

    fn journal(&self) -> Vec<Value> {
        fs::read_to_string(self.0.join("sidecar.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn process_starts(&self) -> Vec<Value> {
        self.journal()
            .into_iter()
            .filter(|line| line.get("processStart").is_some())
            .collect()
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("acpx-provider-state.json")).unwrap()).unwrap()
    }
}

struct Harness {
    fixture: Fixture,
    config: DurableRunnerConfig,
    executor: NativeProviderCommandExecutor,
    descriptor: Value,
    opened: Value,
    sequence: u64,
}

impl Harness {
    fn new() -> Self {
        Self::configured(|_| {})
    }

    fn configured(adjust: impl FnOnce(&mut DurableRunnerConfig)) -> Self {
        let catalog: Value =
            serde_json::from_str(include_str!("../../../../acpx-profiles.json")).unwrap();
        let profile = &catalog["profiles"]["claude"];
        let digest = profile["commandDigest"].as_str().unwrap();
        let fixture =
            Fixture(std::env::temp_dir().join(format!("acpx-park-prep-{}", uuid::Uuid::new_v4())));
        fs::create_dir_all(&fixture.0).unwrap();
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o700)).unwrap();
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
        let descriptor = json!({
            "kind": "acpx", "provider": "acpx", "driver": "acpx_runtime",
            "providerVersion": "0.22.0", "agent": "claude", "model": "explicit-model",
            "acpxVersion": "0.22.0", "agentServerPackage": profile["agentServerPackage"],
            "agentServerVersion": profile["agentServerVersion"], "agentRuntimePackage": profile["agentRuntimePackage"],
            "agentRuntimeVersion": profile["agentRuntimeVersion"], "commandDigest": digest,
            "sidecarCommand": sidecar, "sidecarArgs": args, "runtimeDirectory": fixture.0,
            "normalizedSessionId": "session-1", "runId": "run-1", "cwd": fixture.0,
            "instructions": "Complete the supplied work.",
            "permissionMode": "approve-all", "permissionModePinned": true,
            "runtimeContext": {
                "aggregateDigest": "a".repeat(64),
                "skills": [{"key": "skill-1", "bundle": {"digest": "d".repeat(64), "rootPath": "/skills/one"}}],
                "mcp": {"assignmentSetId": "assignment-1", "digest": "e".repeat(64), "bindingId": "binding-run-1"},
            },
        });
        adjust(&mut config);
        let mut executor = NativeProviderCommandExecutor::with_runner_config(&fixture.0, &config);
        executor
            .execute(&command(1, "run.prepare", json!({"provider": descriptor})))
            .unwrap();
        let opened = executor
            .execute(&command(2, "session.open", json!({})))
            .unwrap()
            .result;
        let mut harness = Self {
            fixture,
            config,
            executor,
            descriptor,
            opened,
            sequence: 2,
        };
        harness.drain();
        harness
    }

    fn execute(&mut self, kind: &str, payload: Value) -> CommandExecution {
        self.sequence += 1;
        self.executor
            .execute(&command(self.sequence, kind, payload))
            .unwrap()
    }

    fn drain(&mut self) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let events = self.executor.poll_events().unwrap();
            if events.is_empty() {
                return seen;
            }
            seen.extend(
                events
                    .iter()
                    .map(|event| json!({"type":event.event_type,"payload":event.payload})),
            );
            self.executor.acknowledge_events(events.len()).unwrap();
        }
    }

    fn complete_turn(&mut self, turn: &str) -> Vec<Value> {
        let started = self.execute(
            "turn.start",
            json!({"turnId": turn, "text": "Complete the work."}),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = started
            .events
            .iter()
            .map(|(kind, _, payload)| json!({"type":kind,"payload":payload}))
            .collect::<Vec<_>>();
        while !seen
            .iter()
            .any(|event: &Value| event["type"] == "turn.completed")
        {
            assert!(Instant::now() < deadline, "no completed provider turn");
            seen.extend(self.drain());
        }
        seen.extend(self.drain());
        seen
    }

    fn attach_payload(&self, run: &str, mutate: impl FnOnce(&mut Value)) -> Value {
        let mut descriptor = self.descriptor.clone();
        descriptor["runId"] = json!(run);
        descriptor["runtimeContext"]["mcp"]["bindingId"] = json!(format!("binding-{run}"));
        descriptor["runtimeContext"]["aggregateDigest"] = json!(format!("{run}-aggregate"));
        let mut payload = json!({
            "provider": descriptor,
            "paperclipNextAuthority": {"identity": {
                "runId": run, "normalizedSessionId": self.config.normalized_session_id,
            }},
        });
        mutate(&mut payload);
        payload
    }

    fn attach(
        &mut self,
        run: &str,
        mutate: impl FnOnce(&mut Value),
    ) -> (CommandExecution, Duration) {
        let payload = self.attach_payload(run, mutate);
        let started = Instant::now();
        let attached = self.execute("run.attach", payload);
        let elapsed = started.elapsed();
        self.config.run_id = run.to_owned();
        self.executor.rotate_authority(&self.config);
        (attached, elapsed)
    }

    fn quiesce(&mut self) {
        let ready = self.execute("session.snapshot", json!({"quiesceForWarmAttach": true}));
        assert_eq!(self.drain(), Vec::<Value>::new());
        assert_eq!(ready.result["warmAttachReady"], true);
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

fn alive(pid: &Value) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn commands_after(journal: &[Value], start: usize) -> Vec<String> {
    journal[start..]
        .iter()
        .filter_map(|line| line["command"].as_str().map(str::to_owned))
        .collect()
}

fn last_process_start(journal: &[Value]) -> usize {
    journal
        .iter()
        .rposition(|line| line.get("processStart").is_some())
        .unwrap()
}

fn prepared_park(harness: &mut Harness) -> Value {
    harness.complete_turn("first");
    harness.executor.prepare_next_turn().unwrap();
    assert!(harness.executor.host_park_ready().unwrap());
    assert!(!harness.executor.prepare_for_park(park_deadline()).unwrap());
    harness.fixture.process_starts().last().unwrap()["processStart"].clone()
}

#[test]
fn park_reaps_the_old_generation_before_spawning_and_proves_the_new_one_dormant() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    let before = harness.fixture.journal().len();
    assert!(harness.executor.host_park_ready().unwrap());
    assert!(harness.executor.prepare_for_park(park_deadline()).unwrap());
    let journal = harness.fixture.journal();
    let spawned = last_process_start(&journal);
    assert!(spawned > before);
    assert_eq!(
        commands_after(&journal[..spawned], before),
        ["session.goal.get", "session.snapshot", "session.suspend"]
    );
    assert_eq!(journal[spawned]["livePredecessors"], json!([]));
    assert_ne!(journal[spawned]["processStart"], old_pid);
    assert_eq!(
        commands_after(&journal, spawned),
        [
            "initialize",
            "session.open",
            "run.attach",
            "session.goal.get",
            "session.snapshot"
        ]
    );
    assert_eq!(journal[spawned + 3]["params"]["runId"], "run-1");
    assert!(!alive(&old_pid));
    assert!(alive(&journal[spawned]["processStart"]));
    assert!(
        harness.executor.host_park_ready().unwrap(),
        "a prepared dormant generation is park-ready"
    );
    assert_eq!(harness.drain(), Vec::<Value>::new());
    assert_eq!(harness.fixture.state()["lifecycle"], "session_open");
    assert!(
        !harness.executor.prepare_for_park(park_deadline()).unwrap(),
        "a prepared generation is not prepared twice"
    );
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
    assert!(!alive(&journal[spawned]["processStart"]));
}

#[test]
fn compatible_attach_keeps_the_prepared_provider_and_rebinds_its_run() {
    let mut cold = Harness::new();
    cold.complete_turn("first");
    cold.quiesce();
    let (_, cold_attach) = cold.attach("run-2", |_| {});
    cold.executor.shutdown().unwrap();

    let mut harness = Harness::new();
    let prepared_pid = prepared_park(&mut harness);
    let before = harness.fixture.journal().len();
    let (attached, warm_attach) = harness.attach("run-2", |_| {});
    eprintln!("run.attach cold={cold_attach:?} prepared={warm_attach:?}");
    assert_eq!(attached.result["status"], "resumed");
    assert_eq!(attached.result["processId"], prepared_pid);
    assert_eq!(
        attached.result["providerSessionId"],
        harness.opened["providerSessionId"]
    );
    let journal = harness.fixture.journal();
    assert_eq!(harness.fixture.process_starts().len(), 2);
    assert_eq!(
        commands_after(&journal, before),
        [
            "run.attach",
            "session.goal.get",
            "session.snapshot",
            "session.goal.get"
        ]
    );
    assert_eq!(journal[before]["params"]["runId"], "run-2");
    let state = harness.fixture.state();
    assert_eq!(state["descriptor"]["runId"], "run-2");
    assert_eq!(
        state["descriptor"]["runtimeContext"]["mcp"]["bindingId"],
        "binding-run-2"
    );
    let events = harness.complete_turn("second");
    assert!(events
        .iter()
        .any(|event| event["type"] == "harness.diagnostic"
            && event["payload"]["details"]["pid"] == prepared_pid));
    assert_eq!(
        harness.fixture.process_starts().len(),
        2,
        "the first turn of the rebound run reuses the prepared provider"
    );
    let snapshot = harness.execute("session.snapshot", json!({}));
    assert_eq!(snapshot.result["warmAttachReady"], true);
    assert!(harness.executor.host_park_ready().unwrap());
    harness.executor.shutdown().unwrap();
}

#[test]
fn changed_tools_or_skills_take_the_cold_path() {
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    let tools = json!({
        "schema": "paperclip.runner.authorized-tools.v1", "schemaVersion": 1,
        "catalogDigest": authorized_tool_catalog_digest(&operations).unwrap(),
        "operations": operations,
    });
    let changes: [(&str, Box<dyn Fn(&mut Value)>); 2] = [
        (
            "tools",
            Box::new(move |payload| payload["authorizedTools"] = tools.clone()),
        ),
        (
            "skills",
            Box::new(|payload| {
                payload["provider"]["runtimeContext"]["skills"][0]["bundle"]["rootPath"] =
                    json!("/skills/two")
            }),
        ),
    ];
    for (name, change) in changes {
        let mut harness = Harness::new();
        let prepared_pid = prepared_park(&mut harness);
        let (attached, _) = harness.attach("run-2", |payload| change(payload));
        assert_eq!(attached.result["status"], "resumed", "{name}");
        assert_ne!(attached.result["processId"], prepared_pid, "{name}");
        assert!(!alive(&prepared_pid), "{name}");
        assert_eq!(harness.fixture.process_starts().len(), 3, "{name}");
        let journal = harness.fixture.journal();
        let spawned = last_process_start(&journal);
        assert_eq!(journal[spawned]["livePredecessors"], json!([]), "{name}");
        assert_eq!(journal[spawned + 3]["params"]["runId"], "run-2", "{name}");
        harness.complete_turn("second");
        harness.executor.shutdown().unwrap();
    }
}

#[test]
fn a_generation_that_ran_a_turn_is_never_rebound() {
    let mut harness = Harness::new();
    let prepared_pid = prepared_park(&mut harness);
    harness.attach("run-2", |_| {});
    harness.complete_turn("second");
    harness.quiesce();
    let (attached, _) = harness.attach("run-3", |_| {});
    assert_ne!(attached.result["processId"], prepared_pid);
    assert!(!alive(&prepared_pid));
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.executor.shutdown().unwrap();
}

#[test]
fn late_and_pre_turn_callbacks_never_reach_the_next_run() {
    let mut harness = Harness::new();
    harness.complete_turn("first");
    harness.fixture.fault("late-tool-after-suspend");
    assert!(harness.executor.prepare_for_park(park_deadline()).unwrap());
    harness.fixture.fault("");
    let (attached, _) = harness.attach("run-2", |_| {});
    let events = harness.complete_turn("second");
    assert!(!format!("{events:?}").contains("late-call"));
    assert!(!format!("{events:?}").contains("late-old-generation"));
    let reused_pid = attached.result["processId"].clone();
    assert_eq!(harness.fixture.process_starts().len(), 2);
    harness.executor.shutdown().unwrap();
    assert!(!alive(&reused_pid));

    let mut harness = Harness::new();
    harness.complete_turn("first");
    harness.fixture.fault("pre-turn-tool");
    assert!(harness.executor.prepare_for_park(park_deadline()).unwrap());
    harness.fixture.fault("");
    let prepared_pid = harness.fixture.process_starts().last().unwrap()["processStart"].clone();
    assert!(
        !harness.executor.host_park_ready().unwrap(),
        "a turn-bound callback before any turn blocks the park"
    );
    let (attached, _) = harness.attach("run-2", |_| {});
    assert_ne!(attached.result["processId"], prepared_pid);
    assert!(!alive(&prepared_pid));
    let events = harness.complete_turn("second");
    assert!(!format!("{events:?}").contains("pre-turn-call"));
    harness.executor.shutdown().unwrap();
}

#[test]
fn failed_preparation_conflicts_and_leaves_a_cold_recoverable_session() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    harness.fixture.fault("reject-open");
    let error = harness
        .executor
        .prepare_for_park(park_deadline())
        .unwrap_err();
    assert!(
        error.to_string().contains("park preparation failed"),
        "{error}"
    );
    harness.fixture.fault("");
    assert!(!alive(&old_pid));
    let failed_pid = harness.fixture.process_starts().last().unwrap()["processStart"].clone();
    assert!(!alive(&failed_pid));
    let state = harness.fixture.state();
    assert_eq!(state["lifecycle"], "suspended");
    assert_eq!(state["providerExitUnconfirmed"], false);
    assert!(state["identity"].is_object());
    assert!(!harness.executor.host_park_ready().unwrap());
    assert!(!harness.executor.prepare_for_park(park_deadline()).unwrap());
    assert_eq!(harness.drain(), Vec::<Value>::new());
    let (attached, _) = harness.attach("run-2", |_| {});
    assert_eq!(attached.result["status"], "resumed");
    assert_eq!(
        attached.result["providerSessionId"],
        harness.opened["providerSessionId"]
    );
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.complete_turn("second");
    harness.executor.shutdown().unwrap();
}

#[test]
fn a_slow_replacement_open_fails_at_the_park_deadline_and_leaves_the_runner_responsive() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    harness.complete_turn("first");
    harness.fixture.fault("slow-open");
    let started = Instant::now();
    let error = harness
        .executor
        .prepare_for_park(Instant::now() + Duration::from_secs(1))
        .unwrap_err();
    let elapsed = started.elapsed();
    harness.fixture.fault("");
    assert!(
        error.to_string().contains("timed out at session.open"),
        "{error}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "park preparation took {elapsed:?}"
    );
    assert!(!alive(&old_pid));
    let slow_pid = harness.fixture.process_starts().last().unwrap()["processStart"].clone();
    assert!(!alive(&slow_pid));
    let state = harness.fixture.state();
    assert_eq!(state["lifecycle"], "suspended");
    assert_eq!(state["providerExitUnconfirmed"], false);
    assert!(!harness.executor.host_park_ready().unwrap());
    let (attached, _) = harness.attach("run-2", |_| {});
    assert_eq!(attached.result["status"], "resumed");
    harness.complete_turn("second");
    harness.executor.shutdown().unwrap();
}

#[test]
fn failed_preparation_recovers_the_same_run_on_its_next_turn() {
    let mut harness = Harness::new();
    harness.complete_turn("first");
    harness.fixture.fault("reject-open");
    assert!(harness.executor.prepare_for_park(park_deadline()).is_err());
    harness.fixture.fault("");
    let events = harness.complete_turn("second");
    assert!(events
        .iter()
        .any(|event| event["type"] == "session.resumed"));
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.executor.shutdown().unwrap();
}

#[test]
fn prepared_park_retires_through_ordinary_shutdown() {
    let mut harness = Harness::new();
    let prepared_pid = prepared_park(&mut harness);
    assert!(harness.executor.host_park_ready().unwrap());
    harness.executor.shutdown().unwrap();
    assert!(!alive(&prepared_pid));
    let journal = harness.fixture.journal();
    assert_eq!(
        journal.last().unwrap()["command"],
        "session.close",
        "retirement closes the prepared provider"
    );
    assert_eq!(harness.fixture.state()["descriptor"]["runId"], "run-1");
}

#[test]
fn a_conflicted_park_keeps_the_prepared_provider_for_the_same_run() {
    let mut harness = Harness::new();
    let old_pid = harness.opened["processId"].clone();
    let prepared_pid = prepared_park(&mut harness);
    let events = harness.complete_turn("second");
    let reconciled = events
        .iter()
        .find(|event| event["type"] == "session.reconciled")
        .expect("the turn reports the replaced provider process");
    assert_eq!(reconciled["payload"]["previousProcessId"], old_pid);
    assert_eq!(reconciled["payload"]["processId"], prepared_pid);
    assert!(events
        .iter()
        .any(|event| event["type"] == "harness.diagnostic"
            && event["payload"]["details"]["pid"] == prepared_pid));
    assert_eq!(harness.fixture.process_starts().len(), 2);
    let events = harness.complete_turn("third");
    assert!(events
        .iter()
        .any(|event| event["type"] == "session.reconciled"
            && event["payload"]["previousProcessId"] == prepared_pid));
    assert_eq!(harness.fixture.process_starts().len(), 3);
    harness.executor.shutdown().unwrap();
}

fn park_deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
