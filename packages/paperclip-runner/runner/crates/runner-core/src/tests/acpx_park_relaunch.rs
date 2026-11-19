use super::tests::{
    artifact, cold_attach_command, settled_session_after_runner_upgrade, write_artifact,
};
use super::*;

pub(crate) fn parked_acpx_fixture(
    agent: &str,
    active: bool,
) -> (
    PathBuf,
    DurableRunnerConfig,
    Command,
    Vec<u8>,
    AcpxProviderSessionIdentity,
) {
    let (directory, mut config, mut payload, before) =
        settled_session_after_runner_upgrade("acpx-park-relaunch", agent);
    config.run_id = "run-1".into();
    config.turn_id = "turn-1".into();
    config.item_id = "item-1".into();
    let profile = config.acpx_launch_profile.as_mut().unwrap();
    let checkpoint: AcpxDurableState = serde_json::from_slice(&before).unwrap();
    let identity = checkpoint.identity.unwrap();
    let marker = directory.join("starts");
    let goal = json!({
        "schema":"paperclip.session_goal.snapshot.v1",
        "goal": if active { json!({"status":"active"}) } else { Value::Null },
        "workingNow":false,
    });
    let mut script = format!("#!/bin/sh\nprintf x >> '{}'\n", marker.display());
    for (index, (command, result)) in [
        ("initialize", json!({"protocolVersion":2,"sidecarPid":900001,"profile":{},
            "capabilities":{"persistentSessions":true,"exactModelVerification":true,
            "permissions":"runner_policy","semanticTools":"runner_bridge","structuredInput":"paperclip.question_set.v1"}})),
        ("session.open", json!({"sidecarPid":900001,"identity":identity,"status":{}})),
        ("run.attach", json!({"runId":"run-2","catalogRevision":1})),
        ("session.goal.get", goal.clone()),
        ("session.snapshot", json!({"identity":identity,"runId":"run-2","turnId":null,
            "pendingToolCount":0,"pendingInputCount":0,"pendingRuntimeRequests":[]})),
        ("session.goal.get", goal),
    ].into_iter().enumerate() {
        let frame = json!({"protocolVersion":2,"id":index+1,"ok":true,"result":result});
        script.push_str(&format!("IFS= read -r line || exit 0\ncase \"$line\" in *'\"command\":\"{command}\"'*) ;; *) exit 1;; esac\nprintf '%s\\n' '{}'\n",
            frame.to_string().replace("900001", "'\"$$\"'")));
    }
    script.push_str("while IFS= read -r line; do :; done\n");
    write_artifact(&profile.command, script.as_bytes(), true);
    profile.artifacts[0] = artifact(&profile.command);

    payload["paperclipNextAuthority"] =
        json!({"identity":{"runId":"run-2","normalizedSessionId":"session-1"}});
    (
        directory,
        config,
        cold_attach_command(payload),
        before,
        identity,
    )
}

#[test]
fn parked_acpx_relaunch_checks_dormancy_on_the_only_sidecar() {
    for (agent, active) in [("claude", false), ("claude", true), ("codex", false)] {
        let (directory, config, attach, before, identity) = parked_acpx_fixture(agent, active);
        let marker = directory.join("starts");
        let mut unsettled = AcpxCommandExecutor::with_runner_config(&directory, &config);
        unsettled.recovery_pending_effects = Some(1);
        assert!(unsettled.defer_parked_acpx_restore().is_err());
        assert!(!marker.exists());

        let mut recovered = AcpxCommandExecutor::with_runner_config(&directory, &config);
        recovered.recovery_pending_effects = Some(0);
        recovered.defer_parked_acpx_restore().unwrap();
        let mut snapshot = cold_attach_command(json!({"quiesceForWarmAttach":true}));
        snapshot.command_type = "session.snapshot".into();
        assert_eq!(
            recovered.execute(&snapshot).unwrap().result["warmAttachReady"],
            true
        );
        assert!(recovered.poll_events().unwrap().is_empty());
        assert!(!marker.exists());
        let result = recovered.execute(&attach);

        assert_eq!(fs::read_to_string(marker).unwrap(), "x");
        if active {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("active or unknown goal"));
            assert!(recovered.session.is_none());
            assert_eq!(fs::read(recovered.state_path()).unwrap(), before);
        } else {
            let result = result.unwrap();
            assert_eq!(result.result["status"], "resumed");
            assert!(result
                .events
                .iter()
                .any(|(name, _, _)| name == "run.attached"));
            assert_eq!(recovered.state.as_ref().unwrap().descriptor.run_id, "run-2");
            assert_eq!(
                recovered.state.as_ref().unwrap().identity.as_ref(),
                Some(&identity)
            );
        }
        drop(recovered);
        fs::remove_dir_all(directory).unwrap();
    }
}

/// Turn the parked fixture into a built-in quota pool session: its bootstrap
/// goes through `session.prepare`/`session.commit`, and the sidecar runs
/// `commit_step` before it answers the commit.
fn pooled_parked_acpx_fixture(
    commit_step: &str,
) -> (PathBuf, DurableRunnerConfig, Command, String) {
    pooled_parked_acpx_fixture_with(commit_step, true)
}

fn pooled_parked_acpx_fixture_with(
    commit_step: &str,
    checkpoint_pooled: bool,
) -> (PathBuf, DurableRunnerConfig, Command, String) {
    let (directory, config, mut attach, _before, identity) = parked_acpx_fixture("codex", false);
    let state_path = directory.join(ACPX_PROVIDER_STATE_FILE);
    let capability = |run_id: &str| {
        json!({
            "schema": GENERATED_ACPX_QUOTA_CAPABILITY_SCHEMA, "companyId": "company-1", "agentId": "agent-1",
            "runId": run_id, "issueId": "issue-1", "poolId": "pool-1", "taskKey": "issue-1", "memberId": "member-1",
        })
    };
    // A pooled agent's checkpoint and its next run each carry their own run's capability.
    let mut checkpoint: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    if checkpoint_pooled {
        checkpoint["descriptor"]["builtinQuotaPoolCapability"] = capability("run-1");
    }
    attach.payload["provider"]["builtinQuotaPoolCapability"] = capability("run-2");
    fs::write(&state_path, serde_json::to_vec_pretty(&checkpoint).unwrap()).unwrap();
    fs::set_permissions(&state_path, fs::Permissions::from_mode(0o600)).unwrap();

    let preparation_id = "33333333-3333-4333-8333-333333333333".to_owned();
    let command = config.acpx_launch_profile.as_ref().unwrap().command.clone();
    let goal = json!({"schema":"paperclip.session_goal.snapshot.v1","goal":Value::Null,"workingNow":false});
    let mut script = String::from("#!/bin/sh\n");
    for (index, (command, result)) in [
        ("initialize", json!({"protocolVersion":2,"sidecarPid":900001,"profile":{},
            "capabilities":{"persistentSessions":true,"exactModelVerification":true,
            "permissions":"runner_policy","semanticTools":"runner_bridge","structuredInput":"paperclip.question_set.v1"}})),
        ("session.prepare", json!({"schema":GENERATED_ACPX_PROVIDER_PREPARATION_SCHEMA,
            "preparationId":preparation_id,"normalizedSessionId":"session-1","sidecarPid":900001,
            "providerLifetimeFenceCandidates":identity.provider_lifetime_fence_candidates})),
        ("session.commit", json!({"sidecarPid":900001,"identity":identity,"status":{}})),
        ("run.attach", json!({"runId":"run-2","catalogRevision":1})),
        ("session.goal.get", goal.clone()),
        ("session.snapshot", json!({"identity":identity,"runId":"run-2","turnId":null,
            "pendingToolCount":0,"pendingInputCount":0,"pendingRuntimeRequests":[]})),
        ("session.goal.get", goal),
    ].into_iter().enumerate() {
        let frame = json!({"protocolVersion":2,"id":index+1,"ok":true,"result":result});
        script.push_str(&format!("IFS= read -r line || exit 0\ncase \"$line\" in *'\"command\":\"{command}\"'*) ;; *) exit 1;; esac\n"));
        if command == "session.commit" {
            script.push_str(&commit_step
                .replace("{state}", &state_path.display().to_string())
                .replace("{preparation}", &preparation_id));
            script.push('\n');
        }
        script.push_str(&format!("printf '%s\\n' '{}'\n", frame.to_string().replace("900001", "'\"$$\"'")));
    }
    script.push_str("while IFS= read -r line; do :; done\n");
    write_artifact(&command, script.as_bytes(), true);
    let mut config = config;
    config.acpx_launch_profile.as_mut().unwrap().artifacts[0] = artifact(&command);
    (directory, config, attach, preparation_id)
}

fn parked_pooled_executor(directory: &Path, config: &DurableRunnerConfig) -> AcpxCommandExecutor {
    let mut recovered = AcpxCommandExecutor::with_runner_config(directory, config);
    recovered.recovery_pending_effects = Some(0);
    recovered.defer_parked_acpx_restore().unwrap();
    recovered
}

#[test]
fn pooled_parked_relaunch_records_the_bootstrap_preparation_before_commit_and_settles_it_after() {
    // The sidecar only commits once the durable checkpoint names its preparation.
    let (directory, config, attach, _) =
        pooled_parked_acpx_fixture("grep -q '{preparation}' '{state}' || exit 1");
    let state_path = directory.join(ACPX_PROVIDER_STATE_FILE);
    let mut recovered = parked_pooled_executor(&directory, &config);
    let result = recovered.execute(&attach).unwrap();
    assert_eq!(result.result["status"], "resumed");
    let committed = recovered.state.as_ref().unwrap();
    assert_eq!(committed.descriptor.run_id, "run-2");
    assert!(committed.descriptor.builtin_quota_pool_capability.is_some());
    // A started provider owns its lifetime fence through the session identity.
    assert!(committed.bootstrap_preparation.is_none());
    let persisted: AcpxDurableState =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert!(persisted.bootstrap_preparation.is_none());
    assert!(settled_checkpoint_blockers(&persisted).is_empty());
    drop(recovered);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pooled_parked_relaunch_keeps_the_bootstrap_preparation_when_the_start_fails_after_preparing() {
    let (directory, config, attach, preparation_id) = pooled_parked_acpx_fixture("exit 3");
    let state_path = directory.join(ACPX_PROVIDER_STATE_FILE);
    let mut recovered = parked_pooled_executor(&directory, &config);
    assert!(recovered.execute(&attach).is_err());
    assert!(recovered.session.is_none());
    // The prepared provider may still hold its lifetime fence: the durable
    // checkpoint must keep the preparation so no new provider starts before
    // its cleanup is proven.
    let persisted: AcpxDurableState =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert_eq!(
        persisted
            .bootstrap_preparation
            .as_ref()
            .map(|preparation| preparation.preparation_id.as_str()),
        Some(preparation_id.as_str())
    );
    assert!(settled_checkpoint_blockers(&persisted).contains(&"provider_preparation_pending"));
    let mut retry = AcpxCommandExecutor::with_runner_config(&directory, &config);
    retry.recovery_pending_effects = Some(0);
    assert!(retry.defer_parked_acpx_restore().is_err());
    drop((recovered, retry));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn pooled_parked_relaunch_of_an_unpooled_checkpoint_records_the_preparation_durably() {
    // The agent joined a pool after its last run: the saved checkpoint has no
    // capability, but the attaching run's provider bootstraps through a preparation.
    let (directory, config, attach, _) =
        pooled_parked_acpx_fixture_with("grep -q '{preparation}' '{state}' || exit 1", false);
    let state_path = directory.join(ACPX_PROVIDER_STATE_FILE);
    let mut recovered = parked_pooled_executor(&directory, &config);
    let result = recovered.execute(&attach).unwrap();
    assert_eq!(result.result["status"], "resumed");
    let persisted: AcpxDurableState =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    assert!(persisted.bootstrap_preparation.is_none());
    assert!(persisted.descriptor.builtin_quota_pool_capability.is_some());
    drop(recovered);
    fs::remove_dir_all(directory).unwrap();
}
