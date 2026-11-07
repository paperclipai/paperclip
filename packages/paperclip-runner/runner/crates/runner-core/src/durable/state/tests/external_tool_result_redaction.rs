use super::*;

fn dot_tool_outcome_fixture() -> Value {
    json!({"status":"completed","isError":false,"result":{
        "schema": {"type":"object","description":"Public catalog",
            "properties":{"credentials":{"type":"string","description":"User supplied value",
                "default":"synthetic-private-value","examples":["synthetic-private-value"]}}},
        "tools":[{"schema":{"type":"object",
            "properties":{"credentials":{"type":"string"}}}}],
        "requestId":"token=synthetic-data-id",
        "password":"synthetic-private-value"
    }})
}

fn dot_settled_fixture(outcome: Value) -> Value {
    json!({"binding":{
        "companyId":"company-1","agentId":"agent-1","bindingId":"binding-1",
        "bindingGeneration":1,"runId":"run_1","normalizedSessionId":"session_1",
        "turnId":"turn_1","assignmentRevision":1
    },"requestId":"request-1","outcome":outcome})
}

fn dot_tool_command_fixture() -> Command {
    let mut command = command("dot-tool-1", 1);
    command.schema = "paperclip.prp.command.v3".to_owned();
    command.command_type = "external_provider.operation".to_owned();
    let input = json!({"name":"search_api","arguments":{}});
    command.payload = json!({
        "requestId":"request-1","bindingId":"binding-1","bindingGeneration":1,
        "runId":"run_1","normalizedSessionId":"session_1","turnId":"turn_1",
        "assignmentRevision":1,"action":"tool",
        "digest":semantic_value_digest(&json!({"action":"tool","input":input})),
        "input":input
    });
    command
}

#[test]
fn dot_tool_data_is_redacted_without_becoming_protocol_identity() {
    let config = config(PathBuf::from("unused"));
    let mut state = DurableState::new(&config);
    let original = dot_settled_fixture(dot_tool_outcome_fixture());
    let sanitized = sanitize_value(&original);
    assert!(durable_semantics_changed_by_sanitization(
        &original, &sanitized
    ));
    assert!(!durable_event_semantics_changed_by_sanitization(
        "external_provider.operation_settled",
        &original,
        &sanitized
    ));
    assert_eq!(
        sanitized["outcome"]["result"]["schema"]["properties"]["credentials"],
        "[REDACTED]"
    );
    assert_eq!(
        sanitized["outcome"]["result"]["tools"][0]["schema"]["properties"]["credentials"],
        "[REDACTED]"
    );
    assert_eq!(sanitized["outcome"]["result"]["password"], "[REDACTED]");
    assert!(!sanitized.to_string().contains("synthetic-private-value"));
    assert!(!sanitized.to_string().contains("synthetic-data-id"));
    state
        .enqueue_event(
            &config,
            "external_provider.operation_settled",
            EventPriority::P0,
            original,
        )
        .unwrap();
    assert_eq!(
        state.outbox[0].envelope.pointer("/payload/payload"),
        Some(&sanitized)
    );
}

#[test]
fn dot_result_control_fields_are_exact_and_unknown_fields_get_no_exception() {
    let original = dot_settled_fixture(dot_tool_outcome_fixture());
    let sanitized = sanitize_value(&original);
    for path in [
        "/binding/companyId",
        "/binding/agentId",
        "/binding/bindingId",
        "/binding/runId",
        "/binding/normalizedSessionId",
        "/binding/turnId",
        "/binding/bindingGeneration",
        "/binding/assignmentRevision",
        "/requestId",
        "/outcome/status",
        "/outcome/isError",
    ] {
        let mut changed = sanitized.clone();
        *changed.pointer_mut(path).unwrap() = json!("changed");
        assert!(durable_event_semantics_changed_by_sanitization(
            "external_provider.operation_settled",
            &original,
            &changed
        ));
    }
    for path in ["", "/binding", "/outcome"] {
        let mut malformed = original.clone();
        let object = if path.is_empty() {
            malformed.as_object_mut().unwrap()
        } else {
            malformed
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
        };
        object.insert("unexpected".to_owned(), json!(true));
        assert!(durable_event_semantics_changed_by_sanitization(
            "external_provider.operation_settled",
            &malformed,
            &sanitize_value(&malformed)
        ));
    }
    for event_type in [
        "runtime_request.created",
        "run.result.proposed",
        "session.updated",
    ] {
        assert!(durable_event_semantics_changed_by_sanitization(
            event_type, &original, &sanitized
        ));
    }
    let mut unsafe_identity = original;
    unsafe_identity["binding"]["runId"] = json!("token=synthetic-binding-secret");
    assert!(durable_event_semantics_changed_by_sanitization(
        "external_provider.operation_settled",
        &unsafe_identity,
        &sanitize_value(&unsafe_identity)
    ));
}

#[test]
fn dot_tool_receipt_redaction_is_durable_and_replay_does_not_execute() {
    let directory = temporary_directory("dot-redacted-tool-replay");
    let _ = fs::remove_dir_all(&directory);
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).unwrap();
    let (mut state, _) = store.load_or_create(&config).unwrap();
    let command = dot_tool_command_fixture();
    assert_eq!(
        state.begin_command(&command).unwrap(),
        CommandDisposition::Execute
    );
    let original = dot_tool_outcome_fixture();
    let expected = sanitize_value(&original);
    let completed = state.complete_command(&command, original).unwrap();
    assert_eq!(completed.result, expected);
    let receipt_digest = semantic_value_digest(&completed.result);
    store.save(&state).unwrap();
    let persisted = fs::read_to_string(directory.join(STATE_FILE)).unwrap();
    assert!(!persisted.contains("synthetic-private-value"));
    assert!(!persisted.contains("synthetic-data-id"));
    let (mut recovered, existed) = store.load_or_create(&config).unwrap();
    assert!(existed);
    match recovered.begin_command(&command).unwrap() {
        CommandDisposition::Replay(receipt) => {
            assert_eq!(receipt.result, expected);
            assert_eq!(semantic_value_digest(&receipt.result), receipt_digest);
        }
        _ => panic!("recovered command must replay the same redacted receipt, not execute"),
    }
    let mut conflicting = command.clone();
    conflicting.payload["input"]["arguments"] = json!({"changed":true});
    assert!(recovered.begin_command(&conflicting).is_err());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn dot_command_exception_requires_closed_tool_command_and_unchanged_control() {
    let original = dot_tool_outcome_fixture();
    let sanitized = sanitize_value(&original);
    let command = dot_tool_command_fixture();
    assert!(!durable_command_result_semantics_changed_by_sanitization(
        &command, &original, &sanitized
    ));
    for field in ["status", "isError"] {
        let mut changed = sanitized.clone();
        changed[field] = json!("changed");
        assert!(durable_command_result_semantics_changed_by_sanitization(
            &command, &original, &changed
        ));
    }
    for change in ["unknown", "digest", "action", "input", "command_type"] {
        let mut invalid = command.clone();
        match change {
            "unknown" => invalid.payload["unexpected"] = json!(true),
            "digest" => invalid.payload["digest"] = json!("sha256:wrong"),
            "action" => invalid.payload["action"] = json!("finish"),
            "input" => invalid.payload["input"]["unexpected"] = json!(true),
            _ => invalid.command_type = "session.snapshot".to_owned(),
        }
        assert!(durable_command_result_semantics_changed_by_sanitization(
            &invalid, &original, &sanitized
        ));
    }
    let protocol_identity = json!({"receiptId":"token=synthetic-protocol-secret"});
    assert!(durable_command_result_semantics_changed_by_sanitization(
        &command,
        &protocol_identity,
        &sanitize_value(&protocol_identity)
    ));
}
