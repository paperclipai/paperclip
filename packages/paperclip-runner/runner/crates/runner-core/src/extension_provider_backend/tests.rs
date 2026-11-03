use super::*;
use std::time::Instant;

use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::process::Command as ProcessCommand;
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    profile: ExtensionLaunchProfile,
    config: DurableRunnerConfig,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("paperclip-extension-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let node = ProcessCommand::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is required for the real subprocess fixture");
        assert!(node.status.success());
        let source = PathBuf::from(String::from_utf8(node.stdout).unwrap().trim());
        let executable = root.join("node");
        fs::copy(&source, &executable).unwrap();
        // Homebrew Node uses a loader-relative libnode on Darwin. Preserve that
        // part of the real runtime closure beside the private executable.
        #[cfg(target_os = "macos")]
        if let Some(lib) = source
            .parent()
            .and_then(Path::parent)
            .map(|root| root.join("lib"))
        {
            if let Ok(entries) = fs::read_dir(lib) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with("libnode.")
                        && name.to_string_lossy().ends_with(".dylib")
                    {
                        let target = root.join(name);
                        fs::copy(entry.path(), &target).unwrap();
                        fs::set_permissions(target, fs::Permissions::from_mode(0o400)).unwrap();
                    }
                }
            }
        }
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o500)).unwrap();
        let script = root.join("harness.cjs");
        fs::write(&script, r#"
const readline = require('node:readline');
let sequence=0, completed=0;
const reply=(id,result)=>process.stdout.write(JSON.stringify({schema:'paperclip.harness.v1',id,ok:true,result})+'\n');
const emit=(eventType,payload={})=>process.stdout.write(JSON.stringify({schema:'paperclip.harness.v1',sequence:++sequence,eventType,priority:'p0',payload})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line), {method,id,params}=request;
 if(method==='initialize') return reply(id,{identity:params.identity,capabilities:{resume:true}});
 if(method==='snapshot') return reply(id,{providerSessionId:'native-session',lastSequence:sequence,accounting:{requests:completed}});
 if(method==='close') { reply(id,{}); return; }
 const command=params.command;
 if(command.type==='turn.start') {
   emit('turn.started',{providerTurnId:'native-turn'});
   if(command.payload.question) emit('runtime_request.created',{request:{schema:'paperclip.runtime_request.v2',requestKind:'runtime',requestId:'question',turnId:'turn',itemId:'question-item',type:'input',status:'pending',prompt:'Continue?'}});
   if(command.payload.complete) {
     emit('item.completed',{item:{id:'answer',type:'assistantMessage',text:'verified output'}});
     completed++;emit('turn.completed',{status:'completed'});
   }
 }
 if(command.type==='run.cancel') emit('turn.cancelled',{status:'cancelled'});
 if(command.payload.completeActive) {completed++;emit('turn.completed',{status:'completed'});}
 reply(id,{sessionId:'session',providerSessionId:'native-session',providerTurnId:'native-turn'});
 if(command.payload.crash) setImmediate(()=>process.exit(7));
 if(command.payload.poison) setImmediate(()=>emit('runner.connected',{}));
});
"#).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o400)).unwrap();
        let identity = ExtensionReleaseIdentity {
            harness_id: "fixture.native".to_owned(),
            package_name: "@fixture/native-harness".to_owned(),
            version: "1.0.0".to_owned(),
            integrity: "sha512-Zml4dHVyZQ==".to_owned(),
            protocol_version: 1,
            runtime_digest: format!("sha256:{}", "a".repeat(64)),
        };
        let profile = ExtensionLaunchProfile {
            schema: "paperclip.harness-launch.v1".to_owned(),
            identity,
            command: artifact(executable),
            entrypoint: Some(artifact(script)),
            args: Vec::new(),
            environment_keys: Vec::new(),
        };
        let config = DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:1".to_owned(),
            ca_bundle_path: None,
            state_dir: root.clone(),
            runner_instance_id: "runner".to_owned(),
            environment_lease_id: "lease".to_owned(),
            run_id: "run".to_owned(),
            normalized_session_id: "session".to_owned(),
            turn_id: "turn".to_owned(),
            item_id: "item".to_owned(),
            runner_version: "test".to_owned(),
            runner_digest: format!("sha256:{}", "b".repeat(64)),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            cursor_cloud_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 4096,
            max_frame_bytes: MAX_FRAME_BYTES,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::ZERO,
        };
        Self {
            root,
            profile,
            config,
        }
    }
    fn executor(&self) -> ExtensionCommandExecutor {
        ExtensionCommandExecutor::with_launch_profile(
            &self.root,
            &self.config,
            Some(self.profile.clone()),
        )
    }
    fn prepare(&self) -> Command {
        command(
            "run.prepare",
            json!({"provider":{"kind":"extension","harnessId":self.profile.identity.harness_id,"release":self.profile.identity,"model":"fixture-model","capabilities":{"resume":true},"config":{}}}),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn artifact(path: PathBuf) -> ExtensionLaunchArtifact {
    let digest = format!("sha256:{:x}", Sha256::digest(fs::read(&path).unwrap()));
    ExtensionLaunchArtifact {
        path,
        sha256: digest,
    }
}
fn command(kind: &str, payload: Value) -> Command {
    Command {
        schema: "paperclip.prp.command.v1".to_owned(),
        command_id: Uuid::new_v4().to_string(),
        controller_seq: 1,
        command_type: kind.to_owned(),
        issued_at: "2026-11-03T00:00:00Z".to_owned(),
        deadline_at: None,
        precondition: None,
        payload,
    }
}

#[test]
fn installed_process_emits_durable_events_and_runner_owned_terminal() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor
        .execute(&command("session.open", json!({})))
        .unwrap();
    executor
        .execute(&command("turn.start", json!({"complete":true})))
        .unwrap();
    let events = executor.poll_events().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        [
            "turn.started",
            "item.completed",
            "turn.completed",
            "run.terminal"
        ]
    );
    assert_eq!(
        events.last().unwrap().payload["runTerminalState"],
        "succeeded"
    );
    assert_eq!(executor.poll_events().unwrap(), events);
    executor.acknowledge_events(events.len()).unwrap();
    assert!(executor.retained_events().unwrap().is_empty());
    executor.shutdown().unwrap();
    assert!(executor.state.as_ref().unwrap().process_group.is_none());
}

#[test]
fn cancellation_stops_the_actual_process_and_retains_terminal_facts() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor.execute(&command("turn.start", json!({}))).unwrap();
    let group = executor.process.as_ref().unwrap().process_group_id();
    executor.execute(&command("run.cancel", json!({}))).unwrap();
    require_group_absent(group).unwrap();
    assert!(executor
        .poll_events()
        .unwrap()
        .iter()
        .any(|event| event.event_type == "run.terminal"
            && event.payload["runTerminalState"] == "cancelled"));
}

#[test]
fn checkpoint_recovers_only_with_the_same_release_and_stopped_process() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor
        .execute(&command("session.open", json!({})))
        .unwrap();
    executor
        .execute(&command("session.snapshot", json!({})))
        .unwrap();
    let mut concurrent = fixture.executor();
    assert!(concurrent
        .execute(&command("session.open", json!({})))
        .unwrap_err()
        .to_string()
        .contains("proven stopped"));
    executor.shutdown().unwrap();
    let mut recovered = fixture.executor();
    recovered
        .execute(&command("session.open", json!({})))
        .unwrap();
    assert_eq!(recovered.state.as_ref().unwrap().generation, 2);
    recovered.shutdown().unwrap();
    let mut wrong = fixture.profile.clone();
    wrong.identity.version = "2.0.0".to_owned();
    let mut refused =
        ExtensionCommandExecutor::with_launch_profile(&fixture.root, &fixture.config, Some(wrong));
    assert!(refused
        .retained_events()
        .unwrap_err()
        .to_string()
        .contains("identity"));
}

#[test]
fn run_payload_cannot_choose_executables_or_an_uninstalled_release() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    let mut prepared = fixture.prepare();
    prepared.payload["provider"]["command"] = json!("/bin/sh");
    assert!(executor
        .execute(&prepared)
        .unwrap_err()
        .to_string()
        .contains("executable"));
    let mut prepared = fixture.prepare();
    prepared.payload["provider"]["release"]["version"] = json!("9.0.0");
    assert!(executor
        .execute(&prepared)
        .unwrap_err()
        .to_string()
        .contains("release identity"));
    let mut missing =
        ExtensionCommandExecutor::with_launch_profile(&fixture.root, &fixture.config, None);
    assert!(missing
        .execute(&fixture.prepare())
        .unwrap_err()
        .to_string()
        .contains("startup"));
}

#[test]
fn runtime_integrity_and_event_authority_fail_closed() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    assert!(executor.receive_event(json!({"schema":WIRE_SCHEMA,"sequence":1,"eventType":"runner.connected","priority":"p0","payload":{}})).is_err());
    assert!(executor.receive_event(json!({"schema":WIRE_SCHEMA,"sequence":2,"eventType":"item.delta","priority":"p1","payload":{}})).is_err());
    assert!(executor.receive_event(json!({"schema":WIRE_SCHEMA,"sequence":1,"eventType":"item.delta","turnId":"another-turn","priority":"p1","payload":{}})).is_err());
    let mut wrong = fixture.profile.clone();
    wrong.command.sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(wrong.verified_launch().is_err());
}

#[test]
fn capability_handshake_cannot_change_admitted_controls() {
    let fixture = Fixture::new();
    let mut prepare = fixture.prepare();
    prepare.payload["provider"]["capabilities"] = json!({"resume":true,"interruption":true});
    let mut executor = fixture.executor();
    assert!(executor
        .execute(&prepare)
        .unwrap_err()
        .to_string()
        .contains("capabilities differ"));
    assert!(executor.process.is_none());
    let mut malformed = fixture.prepare();
    malformed.payload["provider"]["capabilities"] = json!({"resume":"true"});
    assert!(fixture
        .executor()
        .execute(&malformed)
        .unwrap_err()
        .to_string()
        .contains("boolean map"));
}

#[test]
fn native_conversation_identity_is_durable_and_cannot_change() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor
        .execute(&command("session.open", json!({})))
        .unwrap();
    let state = executor.state.as_ref().unwrap();
    assert_eq!(
        state
            .provider_session_identity
            .as_ref()
            .unwrap()
            .provider_session_id,
        "native-session"
    );
    assert_eq!(
        state
            .provider_session_identity
            .as_ref()
            .unwrap()
            .backend_session_id,
        "native-session"
    );
    let snapshot = executor
        .execute(&command("session.snapshot", json!({})))
        .unwrap();
    assert_eq!(
        snapshot.result["extensionCheckpoint"]["providerSessionIdentity"]["providerSessionId"],
        "native-session"
    );
    assert!(executor.receive_event(json!({"schema":WIRE_SCHEMA,"sequence":1,"eventType":"session.resumed","priority":"p0","payload":{"providerSessionId":"unrelated"}})).unwrap_err().to_string().contains("conversation identity"));
    let persisted: Value = serde_json::from_slice(
        &fs::read(fixture.root.join(EXTENSION_PROVIDER_STATE_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(
        persisted["providerSessionIdentity"]["backendSessionId"],
        "native-session"
    );
}

#[test]
fn process_loss_expires_pending_questions_and_commits_failure_once() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor
        .execute(&command(
            "turn.start",
            json!({"question":true,"crash":true}),
        ))
        .unwrap();
    let initial = executor.retained_events().unwrap();
    assert!(initial
        .iter()
        .any(|event| event.event_type == "runtime_request.created"));
    executor.acknowledge_events(initial.len()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let events = loop {
        let events = executor.poll_events().unwrap();
        if !events.is_empty() {
            break events;
        }
        assert!(Instant::now() < deadline, "fixture child did not exit");
        std::thread::sleep(Duration::from_millis(5));
    };
    let expired = events
        .iter()
        .find(|event| event.event_type == "runtime_request.expired")
        .unwrap();
    assert_eq!(expired.payload["requestId"], "question");
    assert_eq!(expired.payload["replayAllowed"], false);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "run.terminal")
            .count(),
        1
    );
    assert_eq!(events.last().unwrap().payload["runTerminalState"], "failed");
    executor.acknowledge_events(events.len()).unwrap();
    assert!(executor.poll_events().unwrap().is_empty());
    assert!(executor
        .execute(&command(
            "request.resolve",
            json!({"requestId":"question","resolution":{"action":"accept"}})
        ))
        .is_err());
}

#[test]
fn stop_after_child_loss_does_not_launch_a_replacement() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor.execute(&command("turn.start", json!({}))).unwrap();
    let generation = executor.state.as_ref().unwrap().generation;
    drop(executor.process.take());
    executor.execute(&command("run.cancel", json!({}))).unwrap();
    assert_eq!(executor.state.as_ref().unwrap().generation, generation);
    assert!(executor.process.is_none());
    assert!(executor
        .retained_events()
        .unwrap()
        .iter()
        .any(|event| event.event_type == "run.terminal"
            && event.payload["runTerminalState"] == "cancelled"));
}

#[test]
fn clean_checkpoint_continues_in_a_new_run_with_fresh_runner_state() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    executor
        .execute(&command("turn.start", json!({"complete":true})))
        .unwrap();
    let events = executor.retained_events().unwrap();
    executor.acknowledge_events(events.len()).unwrap();
    let closed = executor
        .execute(&command("session.close", json!({})))
        .unwrap();
    let checkpoint = closed.result["extensionCheckpoint"].clone();
    assert_eq!(checkpoint["schema"], "paperclip.harness-checkpoint.v1");
    assert!(checkpoint["processGroup"].is_null());
    let fresh = fixture.root.join("next-run");
    fs::create_dir(&fresh).unwrap();
    fs::set_permissions(&fresh, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = fixture.config.clone();
    config.run_id = "second-run".to_owned();
    config.turn_id = "second-turn".to_owned();
    config.item_id = "second-item".to_owned();
    config.state_dir = fresh.clone();
    let mut next = ExtensionCommandExecutor::with_launch_profile(
        &fresh,
        &config,
        Some(fixture.profile.clone()),
    );
    let mut prepare = fixture.prepare();
    prepare.payload["provider"]["checkpoint"] = checkpoint.clone();
    next.execute(&prepare).unwrap();
    assert_eq!(
        next.state.as_ref().unwrap().snapshot.as_ref().unwrap()["providerSessionId"],
        "native-session"
    );
    assert_eq!(next.state.as_ref().unwrap().run_id, "second-run");
    next.execute(&command("session.open", json!({}))).unwrap();
    next.shutdown().unwrap();
    let refused = fixture.root.join("foreign-session");
    fs::create_dir(&refused).unwrap();
    fs::set_permissions(&refused, fs::Permissions::from_mode(0o700)).unwrap();
    config.normalized_session_id = "other-session".to_owned();
    let mut wrong = ExtensionCommandExecutor::with_launch_profile(
        &refused,
        &config,
        Some(fixture.profile.clone()),
    );
    assert!(wrong
        .execute(&prepare)
        .unwrap_err()
        .to_string()
        .contains("continuation checkpoint"));
}

#[test]
fn continuation_rejects_changed_credential_revision() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    let mut original = fixture.prepare();
    original.payload["provider"]["credentialIdentity"] =
        json!(format!("sha256:{}", "1".repeat(64)));
    executor.execute(&original).unwrap();
    let closed = executor
        .execute(&command("session.close", json!({})))
        .unwrap();
    let checkpoint = closed.result["extensionCheckpoint"].clone();
    assert_eq!(
        checkpoint["credentialIdentity"],
        original.payload["provider"]["credentialIdentity"]
    );
    let fresh = fixture.root.join("changed-account");
    fs::create_dir(&fresh).unwrap();
    fs::set_permissions(&fresh, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = fixture.config.clone();
    config.run_id = "new-run".to_owned();
    config.state_dir = fresh.clone();
    let mut next = ExtensionCommandExecutor::with_launch_profile(
        &fresh,
        &config,
        Some(fixture.profile.clone()),
    );
    let mut prepare = fixture.prepare();
    prepare.payload["provider"]["checkpoint"] = checkpoint;
    prepare.payload["provider"]["credentialIdentity"] = json!(format!("sha256:{}", "2".repeat(64)));
    assert!(next
        .execute(&prepare)
        .unwrap_err()
        .to_string()
        .contains("continuation checkpoint"));
    assert!(next.process.is_none());
}

#[test]
fn drain_and_suspend_after_stop_do_not_restart_the_provider() {
    let fixture = Fixture::new();
    let mut executor = fixture.executor();
    executor.execute(&fixture.prepare()).unwrap();
    let stopped = executor.execute(&command("turn.stop", json!({}))).unwrap();
    assert_eq!(stopped.result["providerExitConfirmed"], true);
    let generation = executor.state.as_ref().unwrap().generation;
    let drained = executor
        .execute(&command("runner.drain", json!({})))
        .unwrap();
    assert_eq!(drained.result["retainedEventsDrained"], true);
    let suspended = executor
        .execute(&command("runner.suspend", json!({})))
        .unwrap();
    assert_eq!(suspended.result["providerExitConfirmed"], true);
    assert_eq!(
        suspended.result["extensionCheckpoint"]["schema"],
        "paperclip.harness-checkpoint.v1"
    );
    assert!(executor.process.is_none());
    assert_eq!(executor.state.as_ref().unwrap().generation, generation);
}

#[test]
fn protocol_loss_exports_only_a_snapshot_captured_after_settlement() {
    for (prior_settled, settled) in [(false, false), (true, false), (false, true)] {
        let fixture = Fixture::new();
        let mut executor = fixture.executor();
        executor.execute(&fixture.prepare()).unwrap();
        if prior_settled {
            executor
                .execute(&command("turn.start", json!({"complete":true})))
                .unwrap();
            let prior = executor
                .execute(&command("session.snapshot", json!({})))
                .unwrap();
            assert_eq!(
                prior.result["extensionCheckpoint"]["providerState"]["accounting"]["requests"],
                1
            );
            let events = executor.retained_events().unwrap();
            executor.acknowledge_events(events.len()).unwrap();
        }
        executor.execute(&command("turn.start", json!({}))).unwrap();
        assert!(
            executor.state.as_ref().unwrap().snapshot.is_none(),
            "new turn retained an older settled snapshot"
        );
        let active = executor
            .execute(&command("session.snapshot", json!({})))
            .unwrap();
        assert!(active.result.get("extensionCheckpoint").is_none());
        if settled {
            executor
                .execute(&command(
                    "semantic_tool.result",
                    json!({"completeActive":true}),
                ))
                .unwrap();
            let snapshot = executor
                .execute(&command("session.snapshot", json!({})))
                .unwrap();
            assert_eq!(
                snapshot.result["extensionCheckpoint"]["providerState"]["accounting"]["requests"],
                1
            );
        }
        let events = executor.retained_events().unwrap();
        executor.acknowledge_events(events.len()).unwrap();
        let group = executor.process.as_ref().unwrap().process_group_id();
        executor
            .execute(&command("semantic_tool.result", json!({"poison":true})))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !executor.poisoned {
            executor.poll_events().unwrap();
            assert!(
                Instant::now() < deadline,
                "fixture did not poison its protocol"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        require_group_absent(group).unwrap();
        for kind in ["runner.drain", "runner.suspend"] {
            let result = executor.execute(&command(kind, json!({}))).unwrap();
            let checkpoint = &result.result["extensionCheckpoint"];
            if settled {
                assert_eq!(checkpoint["providerState"]["accounting"]["requests"], 1);
            } else {
                assert!(
                    checkpoint.is_null(),
                    "active provider snapshot became a cold checkpoint"
                );
            }
        }
    }
}

#[test]
fn stopping_after_an_active_snapshot_never_exports_it_as_settled() {
    for kind in ["turn.stop", "runner.suspend"] {
        let fixture = Fixture::new();
        let mut executor = fixture.executor();
        executor.execute(&fixture.prepare()).unwrap();
        executor.execute(&command("turn.start", json!({}))).unwrap();
        executor
            .execute(&command("session.snapshot", json!({})))
            .unwrap();
        let result = executor.execute(&command(kind, json!({}))).unwrap();
        assert!(
            result.result["extensionCheckpoint"].is_null(),
            "active snapshot became a cold checkpoint after {kind}"
        );
        let drained = executor
            .execute(&command("runner.drain", json!({})))
            .unwrap();
        assert!(drained.result["extensionCheckpoint"].is_null());
    }
}
