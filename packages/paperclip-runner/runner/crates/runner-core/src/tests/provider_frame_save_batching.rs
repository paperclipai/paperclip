use super::*;

fn frame_test_state() -> CodexProviderState {
    let mut state = CodexProviderState::new(
        CodexProviderConfig {
            provider: "opencode".to_owned(),
            driver: "opencode_server".to_owned(),
            provider_version: "1.18.34".to_owned(),
            command: PathBuf::from("node"),
            args: Vec::new(),
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            model: Some("openrouter/model".to_owned()),
            provider_session_id: None,
            instructions: String::new(),
            approval_policy: "never".to_owned(),
            externally_sandboxed: false,
            read_only: false,
            include_skill_instructions: None,
            conversation_mode: None,
        },
        Some(CompletionContractBinding {
            revision: "revision-1".to_owned(),
            criterion_ids: vec!["criterion-1".to_owned()],
        }),
        ProviderToolBridge::default(),
    );
    state.thread_id = Some("thread-1".to_owned());
    state.active_provider_turn_id = Some("turn-1".to_owned());
    state.lifecycle = "turn_active".to_owned();
    state
}

fn streamed_task_context_operation() -> crate::provider_bridge::AuthorizedTool {
    crate::provider_bridge::AuthorizedTool {
        operation_id: "get_task_context".to_owned(),
        version: 1,
        description: "Read the active task context.".to_owned(),
        input_schema: json!({"type": "object"}),
        response_schema: json!({"type": "object"}),
    }
}

#[cfg(unix)]
fn streamed_turn_before_tool_call(
    frames: usize,
    retained_results: usize,
    tool: &str,
    wait_for_stream: bool,
) -> (PathBuf, CodexCommandExecutor) {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-streamed-frames-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).unwrap();
    let streamed = directory.join("streamed");
    let script = r#"
while IFS= read -r line; do
  case "$line" in
*'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
*'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"}}}' ;;
*'"method":"turn/start"'*)
  printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
  printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"inProgress"}}}'
  i=0
  while [ "$i" -lt FRAMES ]; do
    printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"message-1","delta":"x"}}'
    printf '%s\n' '{"method":"item/updated","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"reasoning-1","type":"reasoning","summary":[],"content":[]}}}'
    i=$((i+1))
  done
  printf '%s\n' '{"id":"tool-1","method":"item/tool/call","params":{"threadId":"thread-1","turnId":"turn-1","callId":"call-streamed","tool":"TOOL","arguments":{}}}'
  touch 'STREAMED' ;;
  esac
done
"#
    .replace("FRAMES", &frames.to_string())
    .replace("TOOL", tool)
    .replace("STREAMED", &streamed.display().to_string());
    let operation = streamed_task_context_operation();
    let mut bridge = ProviderToolBridge::default();
    bridge
        .prepare(AuthorizedToolSet {
            schema: TOOL_SET_SCHEMA.to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(std::slice::from_ref(&operation))
                .unwrap(),
            operations: vec![operation.clone()],
        })
        .unwrap();
    for index in 0..retained_results {
        let call_id = format!("retained-{index}");
        bridge
            .begin_call(call_id.clone(), "get_task_context".to_owned(), json!({}))
            .unwrap();
        bridge
            .apply_result(ToolResult {
                call_id,
                operation_id: "get_task_context".to_owned(),
                result: json!({"body": "x".repeat(10_000)}),
                is_error: false,
            })
            .unwrap();
    }
    let mut state = frame_test_state();
    state.config.provider = "codex".to_owned();
    state.config.driver = "codex_app_server".to_owned();
    state.config.command = PathBuf::from("/bin/sh");
    state.config.args = vec!["-c".to_owned(), script];
    state.config.model = None;
    state.tool_bridge = bridge;
    let mut provider = CodexProvider::start_with_tools(&state.config, [operation], None).unwrap();
    provider.start_turn("Test", &state.config.cwd).unwrap();
    state.provider_process_generation = provider.process_generation();
    let mut executor = CodexCommandExecutor::new(&directory);
    executor.event_identity = Some(ProviderEventIdentity {
        runner_instance_id: "runner-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
    });
    executor.state = Some(state);
    executor.provider = Some(provider);
    executor.restore_checked = true;
    executor.save_state().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while wait_for_stream && !streamed.exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    (directory, executor)
}

fn poll_until_semantic_tool_call(executor: &mut CodexCommandExecutor) -> Vec<PolledEvent> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut observed = Vec::new();
    loop {
        assert!(std::time::Instant::now() < deadline);
        let events = executor.poll_events().unwrap();
        let count = events.len();
        let delivered = events
            .iter()
            .any(|event| event.event_type == "semantic_tool.input");
        observed.extend(events);
        if delivered {
            return observed;
        }
        executor.acknowledge_events(count).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn streamed_frames_do_not_multiply_durable_saves_before_a_tool_call() {
    let mut saves = Vec::new();
    for frames in [8, 48] {
        let (directory, mut executor) =
            streamed_turn_before_tool_call(frames, 4, "get_task_context", true);
        let before = executor.persist_count.get();
        let observed = poll_until_semantic_tool_call(&mut executor);
        saves.push(executor.persist_count.get() - before);
        assert_eq!(
            observed
                .iter()
                .filter(|event| event.event_type == "item.delta")
                .count(),
            frames
        );
        executor.provider.as_mut().unwrap().shutdown().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }
    eprintln!("durable saves before the tool call: {saves:?}");
    assert_eq!(
        saves[0], saves[1],
        "saves grew with streamed frames: {saves:?}"
    );
}

fn saved_provider_state(executor: &CodexCommandExecutor) -> CodexProviderState {
    serde_json::from_slice(&fs::read(executor.state_path()).unwrap()).unwrap()
}

#[cfg(unix)]
#[test]
fn batched_frame_state_is_saved_before_events_leave_and_survives_a_restart() {
    let (directory, mut executor) =
        streamed_turn_before_tool_call(300, 4, "get_task_context", false);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        assert!(std::time::Instant::now() < deadline);
        let events = executor.poll_events().unwrap();
        assert!(!executor.unsaved_frame_state.get());
        let saved = saved_provider_state(&executor);
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(executor.state.as_ref().unwrap()).unwrap()
        );
        assert_eq!(saved.pending_events, events);
        if events
            .iter()
            .any(|event| event.event_type == "semantic_tool.input")
        {
            break;
        }
        let count = events.len();
        executor.acknowledge_events(count).unwrap();
    }
    let live = executor.state.clone().unwrap();
    executor.provider.as_mut().unwrap().shutdown().unwrap();
    drop(executor);

    let mut resumed = CodexCommandExecutor::new(&directory);
    resumed.load_state_without_provider().unwrap();
    let resumed_state = resumed.state.as_ref().unwrap();
    assert_eq!(
        serde_json::to_value(resumed_state).unwrap(),
        serde_json::to_value(&live).unwrap()
    );
    assert!(resumed_state
        .tool_bridge
        .pending_calls()
        .any(|call| call.call_id == "call-streamed"));
    assert_eq!(
        resumed.retained_events().unwrap(),
        live.pending_events.iter().cloned().collect::<Vec<_>>()
    );
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn batched_frame_state_is_saved_when_a_later_frame_fails() {
    let (directory, mut executor) =
        streamed_turn_before_tool_call(20, 0, "unauthorized_tool", true);
    assert!(executor.poll_events().is_err());
    assert!(!executor.unsaved_frame_state.get());
    let saved = saved_provider_state(&executor);
    assert_eq!(
        serde_json::to_value(&saved).unwrap(),
        serde_json::to_value(executor.state.as_ref().unwrap()).unwrap()
    );
    assert_eq!(
        saved
            .pending_events
            .iter()
            .filter(|event| event.event_type == "item.delta")
            .count(),
        20
    );
    let _ = executor.provider.as_mut().unwrap().shutdown();
    fs::remove_dir_all(directory).unwrap();
}

fn previous_release_state() -> CodexProviderState {
    let mut state = frame_test_state();
    state.config.provider = "codex".to_owned();
    state.config.driver = "codex_app_server".to_owned();
    state.config.model = None;
    state
}

#[test]
fn previous_release_state_is_rewritten_by_the_first_batched_save() {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-batched-save-upgrade-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    let mut previous = serde_json::to_value(previous_release_state()).unwrap();
    let object = previous.as_object_mut().unwrap();
    assert!(object.remove("activeTerminalToolRejected").is_some());
    assert!(object.remove("descendantThreadIds").is_some());
    let previous_bytes = serde_json::to_vec(&previous).unwrap();
    let path = directory.join(CODEX_PROVIDER_STATE_FILE);
    fs::write(&path, &previous_bytes).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

    let mut resumed = CodexCommandExecutor::new(&directory);
    resumed.load_state_without_provider().unwrap();
    assert_eq!(resumed.state.as_ref().unwrap(), &previous_release_state());
    resumed.unsaved_frame_state.set(true);
    resumed.save_unsaved_frame_state().unwrap();
    assert_eq!(resumed.persist_count.get(), 1);
    assert_ne!(fs::read(&path).unwrap(), previous_bytes);
    assert_eq!(
        serde_json::to_value(saved_provider_state(&resumed)).unwrap(),
        serde_json::to_value(resumed.state.as_ref().unwrap()).unwrap()
    );

    resumed.unsaved_frame_state.set(true);
    resumed.save_unsaved_frame_state().unwrap();
    assert_eq!(resumed.persist_count.get(), 1);

    resumed.state.as_mut().unwrap().last_agent_message = Some("streamed".to_owned());
    resumed.unsaved_frame_state.set(true);
    resumed.save_unsaved_frame_state().unwrap();
    assert_eq!(resumed.persist_count.get(), 2);
    assert_eq!(
        saved_provider_state(&resumed).last_agent_message.as_deref(),
        Some("streamed")
    );
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
#[ignore = "timing measurement; run with --ignored --nocapture"]
fn measure_streamed_frame_cost_before_a_tool_call() {
    for retained in [0, 20, 80] {
        for frames in [50, 200] {
            let (directory, mut executor) =
                streamed_turn_before_tool_call(frames, retained, "get_task_context", false);
            let state_bytes = fs::metadata(executor.state_path()).unwrap().len();
            let before = executor.persist_count.get();
            let started = std::time::Instant::now();
            poll_until_semantic_tool_call(&mut executor);
            let elapsed = started.elapsed();
            eprintln!(
                "retained={retained} stateBytes={state_bytes} frames={} saves={} toolCallLatencyMs={:.1}",
                frames * 2,
                executor.persist_count.get() - before,
                elapsed.as_secs_f64() * 1000.0
            );
            executor.provider.as_mut().unwrap().shutdown().unwrap();
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
