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
    let tail = format!(
        r#"{{"id":"tool-1","method":"item/tool/call","params":{{"threadId":"thread-1","turnId":"turn-1","callId":"call-streamed","tool":"{tool}","arguments":{{}}}}}}"#
    );
    streamed_turn(frames, retained_results, &tail, wait_for_stream, |_| {})
}

#[cfg(unix)]
fn streamed_turn(
    frames: usize,
    retained_results: usize,
    tail: &str,
    wait_for_stream: bool,
    prepare_provider: impl FnOnce(&mut CodexProvider),
) -> (PathBuf, CodexCommandExecutor) {
    streamed_turn_then(
        frames,
        retained_results,
        tail,
        ":",
        wait_for_stream,
        prepare_provider,
    )
}

#[cfg(unix)]
fn streamed_turn_then(
    frames: usize,
    retained_results: usize,
    tail: &str,
    after: &str,
    wait_for_stream: bool,
    prepare_provider: impl FnOnce(&mut CodexProvider),
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
      printf '%s\n' 'TAIL'
      touch 'STREAMED'
      AFTER ;;
  esac
done
"#
    .replace("FRAMES", &frames.to_string())
    .replace("TAIL", tail)
    .replace("AFTER", after)
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
    prepare_provider(&mut provider);
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

#[cfg(unix)]
fn event_identity_for_tests() -> ProviderEventIdentity {
    ProviderEventIdentity {
        runner_instance_id: "runner-1".to_owned(),
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
    }
}

#[cfg(unix)]
fn read_saved_state(path: &std::path::Path) -> CodexProviderState {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[cfg(unix)]
#[test]
fn courtesy_rejections_reach_the_provider_only_after_earlier_frames_are_saved() {
    let directory_slot = std::sync::Arc::new(std::sync::Mutex::new(None::<PathBuf>));
    let saved_at_rejection = std::sync::Arc::new(std::sync::Mutex::new(None::<CodexProviderState>));
    let observer_directory = std::sync::Arc::clone(&directory_slot);
    let observer_saved = std::sync::Arc::clone(&saved_at_rejection);
    let tail = r#"{"id":"courtesy-1","method":"paperclip/test/unsupported","params":{"threadId":"thread-1","turnId":"turn-1"}}"#;
    let (directory, mut executor) = streamed_turn(20, 0, tail, true, move |provider| {
        provider.sent_frame_observer = Some(Box::new(move |frame: &Value| {
            if frame["id"] != "courtesy-1" {
                return;
            }
            let directory = observer_directory.lock().unwrap().clone().unwrap();
            *observer_saved.lock().unwrap() =
                Some(read_saved_state(&directory.join(CODEX_PROVIDER_STATE_FILE)));
        }));
    });
    *directory_slot.lock().unwrap() = Some(directory.clone());
    let events = executor.poll_events().unwrap();
    assert!(events.iter().any(|event| event.event_type == "item.delta"));

    let resumed = saved_at_rejection
        .lock()
        .unwrap()
        .take()
        .expect("runnerd sent the courtesy rejection");
    assert_eq!(
        resumed
            .pending_events
            .iter()
            .filter(|event| event.event_type == "item.delta")
            .count(),
        20
    );
    assert_eq!(
        serde_json::to_value(&resumed).unwrap(),
        serde_json::to_value(executor.state.as_ref().unwrap()).unwrap()
    );
    executor.provider.as_mut().unwrap().shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn trace_interpretations_name_only_saved_events() {
    let directory_slot = std::sync::Arc::new(std::sync::Mutex::new(None::<PathBuf>));
    let checked = std::sync::Arc::new(std::sync::Mutex::new((0usize, Vec::<String>::new())));
    let observer_directory = std::sync::Arc::clone(&directory_slot);
    let observer_checked = std::sync::Arc::clone(&checked);
    let trace_path = std::env::temp_dir().join(format!(
        "paperclip-frame-trace-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let provider_trace_path = trace_path.clone();
    let (directory, mut executor) = streamed_turn_before_tool_call_with(40, move |provider| {
        provider.enable_trace_for_test(provider_trace_path);
        provider.interpretation_observer = Some(Box::new(move |ids: &[String]| {
            if ids.is_empty() {
                return;
            }
            let directory = observer_directory.lock().unwrap().clone().unwrap();
            let saved = read_saved_state(&directory.join(CODEX_PROVIDER_STATE_FILE));
            let identity = event_identity_for_tests();
            let saved_ids = (0..saved.next_provider_event_seq)
                .map(|sequence| identity.source_event_id(&provider_event_id(sequence)))
                .collect::<HashSet<_>>();
            let mut checked = observer_checked.lock().unwrap();
            checked.0 += ids.len();
            checked
                .1
                .extend(ids.iter().filter(|id| !saved_ids.contains(*id)).cloned());
        }));
    });
    *directory_slot.lock().unwrap() = Some(directory.clone());
    poll_until_semantic_tool_call(&mut executor);
    let (count, unsaved) = checked.lock().unwrap().clone();
    assert!(count >= 40, "trace named {count} events");
    assert!(
        unsaved.is_empty(),
        "trace named unsaved events: {unsaved:?}"
    );
    executor.provider.as_mut().unwrap().shutdown().unwrap();
    fs::remove_dir_all(directory).unwrap();
    let _ = fs::remove_file(trace_path);
}

#[cfg(unix)]
#[test]
fn a_crash_inside_an_unsaved_batch_leaves_saved_state_and_provider_output_unchanged() {
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let observer_sent = std::sync::Arc::clone(&sent);
    let tail = r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"message-1","delta":"last"}}"#;
    let (directory, mut executor) = streamed_turn(60, 0, tail, true, move |provider| {
        provider.sent_frame_observer = Some(Box::new(move |frame: &Value| {
            observer_sent.lock().unwrap().push(frame.clone());
        }));
    });
    let path = executor.state_path();
    let saved_before = fs::read(&path).unwrap();
    let sent_before = sent.lock().unwrap().len();
    executor
        .provider
        .as_mut()
        .unwrap()
        .hold_courtesy_responses();
    executor.poll_provider_frames(true, false).unwrap();
    assert!(executor.unsaved_frame_state.get());
    let live_next = executor.state.as_ref().unwrap().next_provider_event_seq;
    let saved_next = read_saved_state(&path).next_provider_event_seq;
    assert!(live_next >= saved_next + 121);
    assert_eq!(fs::read(&path).unwrap(), saved_before);
    assert_eq!(sent.lock().unwrap().len(), sent_before);
    executor.provider.as_mut().unwrap().shutdown().unwrap();
    drop(executor);

    let mut resumed = CodexCommandExecutor::new(&directory);
    resumed.load_state_without_provider().unwrap();
    let resumed_state = resumed.state.as_ref().unwrap();
    assert_eq!(resumed_state.next_provider_event_seq, saved_next);
    assert!(resumed_state.pending_events.is_empty());
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
fn streamed_turn_before_tool_call_with(
    frames: usize,
    prepare_provider: impl FnOnce(&mut CodexProvider),
) -> (PathBuf, CodexCommandExecutor) {
    let tail = r#"{"id":"tool-1","method":"item/tool/call","params":{"threadId":"thread-1","turnId":"turn-1","callId":"call-streamed","tool":"get_task_context","arguments":{}}}"#;
    streamed_turn(frames, 0, tail, true, prepare_provider)
}

#[cfg(unix)]
#[test]
fn a_held_cancellation_that_cannot_reach_the_provider_keeps_the_completed_turn() {
    // Shutdown during the script's `sleep 2` can orphan it for a moment.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let _orphans = crate::process_lineage::host_orphans::may_orphan();
    let tail = r#"{"id":"tool-1","method":"item/tool/call","params":{"threadId":"thread-1","turnId":"turn-1","callId":"call-streamed","tool":"get_task_context","arguments":{}}}"#;
    let after = r#"exec 0<&-; printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","status":"completed"}}}'; sleep 2; exit 0"#;
    let (directory, mut executor) = streamed_turn_then(10, 0, tail, after, true, |_| {});
    std::thread::sleep(std::time::Duration::from_millis(200));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut observed = Vec::new();
    while !observed
        .iter()
        .any(|event: &PolledEvent| event.event_type == "turn.completed")
    {
        assert!(std::time::Instant::now() < deadline);
        let events = executor.poll_events().unwrap();
        let count = events.len();
        observed.extend(events);
        executor.acknowledge_events(count).unwrap();
    }
    assert!(observed
        .iter()
        .any(|event| event.event_type == "semantic_tool.input"));
    let saved = read_saved_state(&executor.state_path());
    assert!(saved.completed_turn_authoritative);
    if let Some(provider) = executor.provider.as_mut() {
        let _ = provider.shutdown();
    }
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn trace_interpretations_survive_a_provider_exit_in_the_same_poll() {
    let named = std::sync::Arc::new(std::sync::Mutex::new(0usize));
    let observer_named = std::sync::Arc::clone(&named);
    let tail = r#"{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"message-1","delta":"last"}}"#;
    let trace_path = std::env::temp_dir().join(format!(
        "paperclip-frame-trace-exit-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let provider_trace_path = trace_path.clone();
    let (directory, mut executor) =
        streamed_turn_then(20, 0, tail, "exit 0", true, move |provider| {
            provider.enable_trace_for_test(provider_trace_path);
            provider.interpretation_observer = Some(Box::new(move |ids: &[String]| {
                *observer_named.lock().unwrap() += ids.len();
            }));
        });
    std::thread::sleep(std::time::Duration::from_millis(200));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while executor.provider.is_some() {
        assert!(std::time::Instant::now() < deadline);
        let events = executor.poll_events().unwrap();
        let count = events.len();
        executor.acknowledge_events(count).unwrap();
    }
    assert!(*named.lock().unwrap() >= 41);
    fs::remove_dir_all(directory).unwrap();
    let _ = fs::remove_file(trace_path);
}
