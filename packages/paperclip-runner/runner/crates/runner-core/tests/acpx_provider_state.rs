use paperclip_runner_core::acpx_event_payload::AcpxTurnStatus;
use paperclip_runner_core::acpx_provider_state::{AcpxProviderState, AcpxProviderStateEvent};
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use paperclip_runner_core::provider_events::{
    project_acpx_state_event, AcpxEventProjectionContext,
};
use serde_json::{json, Value};

fn event(
    sequence: u64,
    event_type: GeneratedAcpxSidecarEventType,
    turn_id: Option<&str>,
    payload: Value,
) -> AcpxSidecarEvent {
    AcpxSidecarEvent {
        sequence,
        event_type,
        run_id: Some("run-1".to_owned()),
        turn_id: turn_id.map(str::to_owned),
        payload,
    }
}

fn question_set() -> Value {
    json!({
        "schema":"paperclip.question_set.v1",
        "title":"Choose",
        "questions":[{
            "id":"question-1",
            "prompt":"Which option?",
            "required":true,
            "answerMode":"single_select",
            "options":[{"id":"option-1","label":"First"}]
        }]
    })
}

#[test]
fn accumulates_assistant_text_preserves_reasoning_and_flushes_before_terminal() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();

    let thinking = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        Some("turn-1"),
        json!({"type":"thinking","messageId":"reasoning-1","text":"Inspecting."}),
    );
    let first_summary = state.accept_event(&thinking).unwrap();
    assert!(matches!(
        &first_summary[0],
        AcpxProviderStateEvent::Activity(event)
            if event.event_type == "item.delta"
                && event.payload["channel"] == "summary"
                && event.payload["text"] == "Inspecting."
    ));
    let repeated = event(
        2,
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        Some("turn-1"),
        json!({"type":"thinking","messageId":"reasoning-1","text":"Checking the result."}),
    );
    let next_summary = state.accept_event(&repeated).unwrap();
    assert!(matches!(
        &next_summary[0],
        AcpxProviderStateEvent::Activity(event)
            if event.event_type == "item.delta"
                && event.payload["itemId"] == "reasoning-1"
                && event.payload["text"] == "Checking the result."
    ));

    for (sequence, text) in [(3, "Hello "), (4, "world")] {
        state
            .accept_event(&event(
                sequence,
                GeneratedAcpxSidecarEventType::RuntimeEvent,
                Some("turn-1"),
                json!({"type":"text_delta","text":text}),
            ))
            .unwrap();
    }
    let terminal = state
        .accept_event(&event(
            5,
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            Some("turn-1"),
            json!({"status":"completed"}),
        ))
        .unwrap();
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::AssistantMessage { turn_id, text }
            if turn_id == "turn-1" && text == "Hello world"
    ));
    assert!(matches!(
        &terminal[1],
        AcpxProviderStateEvent::TurnTerminal {
            turn_id,
            status: AcpxTurnStatus::Completed,
            error: None,
        } if turn_id == "turn-1"
    ));
    assert_eq!(state.active_turn_id(), None);
}

#[test]
fn assigns_monotonic_revisions_to_plan_snapshots_within_a_turn() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();

    for (sequence, expected_revision, content) in
        [(1, 1, "Inspect"), (2, 2, "Implement"), (3, 3, "Verify")]
    {
        let events = state
            .accept_event(&event(
                sequence,
                GeneratedAcpxSidecarEventType::RuntimeEvent,
                Some("turn-1"),
                json!({
                    "type":"plan",
                    "entries":[{"content":content,"status":"in_progress"}]
                }),
            ))
            .unwrap();
        assert!(matches!(
            &events[0],
            AcpxProviderStateEvent::Activity(event)
                if event.event_type == "plan.updated"
                    && event.payload["planId"] == "turn-1"
                    && event.payload["revision"] == expected_revision
        ));
    }
}

#[test]
fn promotes_only_the_latest_provider_message_as_the_terminal_reply() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let mut progress = Vec::new();

    for (sequence, message_id, text) in [
        (1, "message-1", "First paragraph."),
        (2, "message-2", "Second paragraph."),
        (3, "message-2", "\n\nStill final."),
    ] {
        let emitted = state
            .accept_event(&event(
                sequence,
                GeneratedAcpxSidecarEventType::RuntimeEvent,
                Some("turn-1"),
                json!({"type":"text_delta","messageId":message_id,"text":text}),
            ))
            .unwrap();
        assert!(matches!(
            &emitted[0],
            AcpxProviderStateEvent::Activity(event)
                if event.payload["channel"] == "progress"
        ));
        progress.push(emitted[0].clone());
    }
    assert_eq!(progress.len(), 3);
    let terminal = state
        .accept_event(&event(
            4,
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            Some("turn-1"),
            json!({"status":"completed"}),
        ))
        .unwrap();
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::AssistantMessage { text, .. }
            if text == "Second paragraph.\n\nStill final."
    ));
}

#[test]
fn preserves_an_idless_prefix_when_the_provider_begins_identifying_deltas() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    state
        .accept_event(&event(
            1,
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            Some("turn-1"),
            json!({"type":"text_delta","text":"Preface.\n\n"}),
        ))
        .unwrap();
    state
        .accept_event(&event(
            2,
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            Some("turn-1"),
            json!({"type":"text_delta","messageId":"message-1","text":"Final response."}),
        ))
        .unwrap();
    let terminal = state
        .accept_event(&event(
            3,
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            Some("turn-1"),
            json!({"status":"completed"}),
        ))
        .unwrap();
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::AssistantMessage { text, .. }
            if text == "Preface.\n\nFinal response."
    ));
}

#[test]
fn does_not_promote_partial_text_to_a_final_reply_after_failure_or_cancellation() {
    for status in ["failed", "cancelled", "interrupted"] {
        let mut state = AcpxProviderState::new("run-1").unwrap();
        state.begin_turn("turn-1").unwrap();
        state
            .accept_event(&event(
                1,
                GeneratedAcpxSidecarEventType::RuntimeEvent,
                Some("turn-1"),
                json!({"type":"text_delta","messageId":"message-1","text":"Partial"}),
            ))
            .unwrap();
        let terminal = state
            .accept_event(&event(
                2,
                GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
                Some("turn-1"),
                json!({"status":status,"error": {"message":"stopped"}}),
            ))
            .unwrap();
        assert_eq!(terminal.len(), 1);
        assert!(matches!(
            &terminal[0],
            AcpxProviderStateEvent::TurnTerminal { .. }
        ));
    }
}

#[test]
fn correlates_semantic_tool_calls_until_the_sidecar_resolution_commits() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let called = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeToolCalled,
        Some("turn-1"),
        json!({"callId":"call-1","operationId":"issues.read","input":{"id":"issue-1"}}),
    );
    let emitted = state.accept_event(&called).unwrap();
    assert!(matches!(
        &emitted[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, .. }
            if call_id == "call-1" && operation_id == "issues.read"
    ));
    assert_eq!(
        state.pending_tool("call-1").unwrap().operation_id,
        "issues.read"
    );
    assert!(state.complete_tool("call-1", "issues.write").is_err());
    assert!(state.pending_tool("call-1").is_some());
    state.complete_tool("call-1", "issues.read").unwrap();
    assert!(state.pending_tool("call-1").is_none());

    assert!(state.accept_event(&called).is_ok());
    assert!(state.accept_event(&called).is_err());
}

#[test]
fn tracks_structured_input_and_permission_requests_without_cross_kind_reuse() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let input = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeInputRequested,
        Some("turn-1"),
        json!({"requestId":"request-1","questionSet":question_set()}),
    );
    assert!(matches!(
        &state.accept_event(&input).unwrap()[0],
        AcpxProviderStateEvent::InputRequest { request_id, .. }
            if request_id == "request-1"
    ));
    let permission_with_reused_id = event(
        2,
        GeneratedAcpxSidecarEventType::RuntimePermissionRequested,
        Some("turn-1"),
        json!({"requestId":"request-1","kind":"execute","title":"Run?"}),
    );
    assert!(state.accept_event(&permission_with_reused_id).is_err());
    state.complete_input("request-1").unwrap();
    assert!(state.complete_input("request-1").is_err());

    let permission = event(
        3,
        GeneratedAcpxSidecarEventType::RuntimePermissionRequested,
        Some("turn-1"),
        json!({"requestId":"permission-1","kind":"execute","title":"Run?"}),
    );
    assert!(matches!(
        &state.accept_event(&permission).unwrap()[0],
        AcpxProviderStateEvent::PermissionRequest { request_id, .. }
            if request_id == "permission-1"
    ));
    state.complete_permission("permission-1").unwrap();
}

#[test]
fn correlates_projected_runtime_requests_to_the_upstream_input_id() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let upstream_request_id = format!("input / {}", "é".repeat(200));
    let emitted = state
        .accept_event(&event(
            1,
            GeneratedAcpxSidecarEventType::RuntimeInputRequested,
            Some("turn-1"),
            json!({"requestId":upstream_request_id,"questionSet":question_set()}),
        ))
        .unwrap();
    let projected = project_acpx_state_event(
        &AcpxEventProjectionContext {
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            provider_turn_id: None,
            item_id: "item-1".to_owned(),
        },
        &emitted[0],
    )
    .unwrap();
    let runtime_request_id = projected[0].payload["request"]["requestId"]
        .as_str()
        .unwrap();
    assert!(runtime_request_id.starts_with("acpx-request-"));
    assert!(state.pending_question_set(runtime_request_id).is_some());
    state.complete_input(runtime_request_id).unwrap();
    assert!(state.pending_question_set(runtime_request_id).is_none());
}

#[test]
fn accepts_an_identical_semantic_result_once_and_rejects_a_conflict() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let result = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        Some("turn-1"),
        json!({
            "type":"semantic_result",
            "callId":"finish-1",
            "operationId":"paperclip_finish",
            "ok":true,
            "result":{"reportedWorkDisposition":"done"}
        }),
    );
    assert!(matches!(
        &state.accept_event(&result).unwrap()[0],
        AcpxProviderStateEvent::SemanticResult(result)
            if result.call_id == "finish-1"
    ));
    assert!(state.accept_event(&result).unwrap().is_empty());
    assert_eq!(
        state.semantic_result().unwrap().result["reportedWorkDisposition"],
        "done"
    );

    let conflict = event(
        2,
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        Some("turn-1"),
        json!({
            "type":"semantic_result",
            "callId":"finish-2",
            "operationId":"paperclip_finish",
            "ok":true,
            "result":{"reportedWorkDisposition":"done"}
        }),
    );
    assert!(state.accept_event(&conflict).is_err());
    assert_eq!(state.semantic_result().unwrap().call_id, "finish-1");
}

#[test]
fn keeps_dynamic_results_independent_from_terminal_result_authority() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    for index in 1..=2 {
        let result = event(
            index,
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            Some("turn-1"),
            json!({
                "type":"semantic_result",
                "callId":format!("call-{index}"),
                "operationId":"issues.read",
                "ok":true,
                "result":{"id":format!("issue-{index}")}
            }),
        );
        assert!(matches!(
            &state.accept_event(&result).unwrap()[0],
            AcpxProviderStateEvent::SemanticResult(result)
                if result.call_id == format!("call-{index}")
        ));
    }
    assert!(state.semantic_result().is_none());
}

#[test]
fn validates_scope_before_mutating_pending_state() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    let mut wrong_run = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeToolCalled,
        Some("turn-1"),
        json!({"callId":"call-1","operationId":"issues.read","input":{}}),
    );
    wrong_run.run_id = Some("run-2".to_owned());
    assert!(state.accept_event(&wrong_run).is_err());
    assert!(state.pending_tool("call-1").is_none());

    let wrong_turn = event(
        2,
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        Some("turn-2"),
        json!({"type":"text_delta","text":"wrong"}),
    );
    assert!(state.accept_event(&wrong_turn).is_err());
}

#[test]
fn accepts_global_process_and_diagnostic_events_without_an_active_turn() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    let mut process = event(
        1,
        GeneratedAcpxSidecarEventType::RuntimeProcess,
        None,
        json!({"pid":17,"accessToken":"secret"}),
    );
    process.run_id = None;
    let process = state.accept_event(&process).unwrap();
    assert!(matches!(
        &process[0],
        AcpxProviderStateEvent::Process(details)
            if details["accessToken"] == "[REDACTED]"
    ));

    let mut diagnostic = event(
        2,
        GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
        None,
        json!({"code":"provider_notice","message":"token=super-secret"}),
    );
    diagnostic.run_id = None;
    let diagnostic = state.accept_event(&diagnostic).unwrap();
    assert!(matches!(
        &diagnostic[0],
        AcpxProviderStateEvent::Diagnostic { message, .. }
            if message.contains("REDACTED") && !message.contains("super-secret")
    ));
}

#[test]
fn terminal_events_clear_pending_requests_and_reject_late_turn_events() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    state
        .accept_event(&event(
            1,
            GeneratedAcpxSidecarEventType::RuntimeToolCalled,
            Some("turn-1"),
            json!({"callId":"call-1","operationId":"issues.read","input":{}}),
        ))
        .unwrap();
    state
        .accept_event(&event(
            2,
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            Some("turn-1"),
            json!({"status":"cancelled","error":{"message":"token=secret"}}),
        ))
        .unwrap();
    assert!(state.pending_tool("call-1").is_none());
    assert!(state.complete_tool("call-1", "issues.read").is_err());
    assert!(state
        .accept_event(&event(
            3,
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            Some("turn-1"),
            json!({"type":"text_delta","text":"late"}),
        ))
        .is_err());
}
