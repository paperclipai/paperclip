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
