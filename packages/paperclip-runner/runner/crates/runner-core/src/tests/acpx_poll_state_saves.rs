use super::tests::{artifact, descriptor, temporary_directory, test_config, write_artifact};
use super::*;
use crate::generated_acpx_sidecar_contract::GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION;
use crate::provider_bridge::AuthorizedTool;

const TOOL: &str = "issues.read";

fn tool_set() -> AuthorizedToolSet {
    let operations = vec![AuthorizedTool {
        operation_id: TOOL.to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type": "object"}),
        response_schema: json!({"type": "object"}),
    }];
    AuthorizedToolSet {
        schema: TOOL_SET_SCHEMA.to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    }
}

fn frame(sequence: u64, event_type: &str, payload: Value) -> Value {
    json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "sequence": sequence,
        "eventType": event_type,
        "runId": "run-1",
        "turnId": "turn-1",
        "payload": payload,
    })
}

fn text(sequence: u64) -> Value {
    frame(
        sequence,
        "runtime.event",
        json!({"type": "text_delta", "text": "x"}),
    )
}

struct StreamedTurn {
    directory: PathBuf,
    config: DurableRunnerConfig,
    executor: AcpxCommandExecutor,
}

impl Drop for StreamedTurn {
    fn drop(&mut self) {
        // Dropping the session stops the sidecar without a close request.
        drop(self.executor.session.take());
        let _ = fs::remove_dir_all(&self.directory);
    }
}

/// An active turn whose sidecar has written every frame before the first
/// poll. The sidecar answers the requests that follow with `replies`.
fn streamed_turn(frames: &[Value], replies: &[Value]) -> StreamedTurn {
    let directory = temporary_directory("poll-state-saves");
    let command = directory.join("sidecar");
    write_artifact(&command, b"#!/bin/sh\nexit 1\n", true);
    let launch_profile = AcpxLaunchProfile {
        candidate_admission: None,
        authority_digest: format!("sha256:{}", "d".repeat(64)),
        command: command.clone(),
        args: Vec::new(),
        artifacts: vec![artifact(&command)],
    };
    let runtime = directory.join("runtime");
    let workspace = directory.join("workspace");
    for private in [&runtime, &workspace] {
        fs::create_dir_all(private).unwrap();
        fs::set_permissions(private, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut value = descriptor("codex");
    value["runtimeDirectory"] = json!(runtime);
    value["cwd"] = json!(workspace);
    value["sidecarCommand"] = json!(command);
    value["sidecarArgs"] = json!([]);
    let descriptor: AcpxProviderDescriptor = serde_json::from_value(value).unwrap();
    let identity = AcpxProviderSessionIdentity {
        kind: "acpx".into(),
        normalized_session_id: "session-1".into(),
        acpx_record_id: "record-1".into(),
        backend_session_id: "backend-1".into(),
        agent_session_id: "agent-1".into(),
        profile_digest: descriptor.command_digest.clone(),
        workspace_digest: format!("sha256:{}", "a".repeat(64)),
        requested_model: descriptor.model.clone(),
        effective_model: descriptor.model.clone(),
        permission_mode: Some(descriptor.permission_mode),
        mode: descriptor.mode.clone(),
        pi_thinking_level: descriptor.pi_thinking_level,
        claude_effort: descriptor.claude_effort.clone(),
        grok_effort: descriptor.grok_effort.clone(),
        grok_disable_web_search: descriptor.grok_disable_web_search,
        provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
    };
    let session_config = descriptor
        .session_config(tool_set(), Some(identity.clone()), Some(&launch_profile))
        .unwrap();
    let mut state = AcpxDurableState::new(
        descriptor,
        tool_set(),
        launch_profile.canonical_digest().unwrap(),
    );
    state.identity = Some(identity.clone());
    state.lifecycle = "turn_active".into();
    state.active_turn_id = Some("turn-1".into());

    let config = test_config(&directory, Some(launch_profile));
    let mut executor = AcpxCommandExecutor::with_runner_config(&directory, &config);
    executor.restore_checked = true;
    executor.context.provider_turn_id = Some("turn-1".into());
    executor.state = Some(state);
    executor.save_state().unwrap();
    let streamed = directory.join("streamed");
    let print = |value: &Value| {
        format!(
            "printf '%s\\n' '{}'\n",
            value.to_string().replace('\'', "'\"'\"'")
        )
    };
    let mut script: String = frames.iter().map(print).collect();
    script.push_str(&format!("touch '{}'\n", streamed.display()));
    for (index, reply) in replies.iter().enumerate() {
        // Record the saved state that the provider could rely on when it
        // received this request.
        script.push_str(&format!(
            "IFS= read -r request_line\ncp '{}' '{}'\n",
            executor.state_path().display(),
            directory
                .join(format!("state-at-request-{}", index + 1))
                .display(),
        ));
        script.push_str(&print(reply));
    }
    script.push_str("while IFS= read -r request_line; do :; done\n");
    let script_path = directory.join("streamed-sidecar.sh");
    write_artifact(&script_path, script.as_bytes(), false);
    executor.session = Some(AcpxProviderSession::scripted_turn_for_test(
        session_config,
        identity,
        &script_path,
        "turn-1",
    ));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !streamed.exists() {
        assert!(
            Instant::now() < deadline,
            "sidecar did not stream its frames"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    StreamedTurn {
        directory,
        config,
        executor,
    }
}

fn saved_state(executor: &AcpxCommandExecutor) -> AcpxDurableState {
    serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap()
}

/// Polls once and returns the retained events and the number of state writes.
fn poll_once(executor: &mut AcpxCommandExecutor) -> (Vec<PolledEvent>, usize) {
    let before = executor.state_writes.get();
    let events = executor.poll_events().unwrap();
    (events, executor.state_writes.get() - before)
}

#[test]
fn outputs_read_in_one_poll_share_one_state_write() {
    let frames: Vec<_> = (1..=48).map(text).collect();
    let mut turn = streamed_turn(&frames, &[]);
    let (events, writes) = poll_once(&mut turn.executor);
    assert_eq!(writes, 1, "48 outputs in one poll need one state write");
    assert!(events.len() >= 48, "every streamed output is retained");
    // Nothing leaves the executor before the poll's state is on disk.
    assert_eq!(
        &saved_state(&turn.executor),
        turn.executor.state.as_ref().unwrap()
    );
    let (more, writes) = poll_once(&mut turn.executor);
    assert_eq!(writes, 0, "a poll that reads no output writes nothing");
    assert_eq!(more, events);
}

#[test]
fn polled_outputs_survive_a_restart_once() {
    let frames: Vec<_> = (1..=48).map(text).collect();
    let mut turn = streamed_turn(&frames, &[]);
    let (events, _) = poll_once(&mut turn.executor);
    let acknowledged = events.len() / 2;
    turn.executor.acknowledge_events(acknowledged).unwrap();
    let saved = saved_state(&turn.executor);

    let mut recovered = AcpxCommandExecutor::with_runner_config(&turn.directory, &turn.config);
    recovered.restore_checked = true;
    recovered.state = Some(saved);
    let retained = recovered.retained_events().unwrap();
    assert_eq!(retained, events[acknowledged..]);
    let mut ids = HashSet::new();
    assert!(retained
        .iter()
        .all(|event| ids.insert(event.executor_event_id.clone())));
    assert!(events[..acknowledged]
        .iter()
        .all(|event| !ids.contains(&event.executor_event_id)));
}

#[test]
fn an_output_that_ends_the_turn_is_saved_at_once() {
    let mut frames: Vec<_> = (1..=24).map(text).collect();
    frames.push(frame(
        25,
        "runtime.turn_terminal",
        json!({"status": "completed"}),
    ));
    let goal = json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "id": 1,
        "ok": true,
        "result": {
            "schema": "paperclip.session_goal.snapshot.v1",
            "providerRevision": 1,
            "goal": null,
            "workingNow": false,
        },
    });
    let mut turn = streamed_turn(&frames, &[goal]);
    let (events, writes) = poll_once(&mut turn.executor);
    // The goal read at the terminal and the terminal itself each save, as
    // before. The 24 streamed outputs ahead of them add no write.
    assert_eq!(writes, 2);
    assert_eq!(events.last().unwrap().event_type, "run.terminal");
    assert_eq!(
        &saved_state(&turn.executor),
        turn.executor.state.as_ref().unwrap()
    );
}

#[test]
fn an_output_that_calls_a_tool_is_saved_at_once() {
    let mut frames: Vec<_> = (1..=10).map(text).collect();
    frames.push(frame(
        11,
        "runtime.tool_called",
        json!({"callId": "call-1", "operationId": TOOL, "input": {}}),
    ));
    frames.extend((12..=21).map(text));
    let mut turn = streamed_turn(&frames, &[]);
    let (events, writes) = poll_once(&mut turn.executor);
    // One write for the tool call, which carries the outputs before it, and
    // one at the end of the poll for the outputs after it.
    assert_eq!(writes, 2);
    assert!(events
        .iter()
        .any(|event| event.payload.to_string().contains("call-1")));
    assert_eq!(
        &saved_state(&turn.executor),
        turn.executor.state.as_ref().unwrap()
    );
}

fn tool_call(sequence: u64, index: usize) -> Value {
    frame(
        sequence,
        "runtime.tool_called",
        json!({"callId": format!("call-{index}"), "operationId": TOOL, "input": {"id": format!("issue-{index}")}}),
    )
}

#[test]
fn a_tool_rejection_reaches_the_provider_after_the_outputs_before_it_are_saved() {
    // The result reserve admits ten calls in flight. The provider rejects the
    // eleventh in the session; the ordinary output between them is in memory.
    let mut frames: Vec<_> = (0..10)
        .map(|index| tool_call(index as u64 + 1, index))
        .collect();
    frames.extend((11..=15).map(text));
    frames.push(tool_call(16, 10));
    frames.extend((17..=19).map(text));
    let resolved = json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "id": 1,
        "ok": true,
        "result": {"resolved": true},
    });
    let mut turn = streamed_turn(&frames, &[resolved]);
    let (_, writes) = poll_once(&mut turn.executor);
    // Ten admitted calls, the rejected call, and the end of the poll.
    assert_eq!(writes, 12);
    let at_rejection: AcpxDurableState =
        serde_json::from_slice(&fs::read(turn.directory.join("state-at-request-1")).unwrap())
            .unwrap();
    let saved = saved_state(&turn.executor);
    // The provider saw the rejection only after every output read before it
    // was on disk. The three outputs after it were not read yet.
    let trailing = saved.next_event_sequence - at_rejection.next_event_sequence;
    assert_eq!(trailing, 3);
    assert!(saved
        .pending_events
        .iter()
        .take(at_rejection.pending_events.len())
        .eq(at_rejection.pending_events.iter()));
}
