use paperclip_runner_core::acpx_event_payload::{
    decode_acpx_event, AcpxEventPayload, AcpxRuntimeEventKind, AcpxTurnStatus,
};
use paperclip_runner_core::acpx_event_scope::AcpxEventScope;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use serde_json::{json, Value};

fn event(event_type: GeneratedAcpxSidecarEventType, payload: Value) -> AcpxSidecarEvent {
    AcpxSidecarEvent {
        sequence: 1,
        event_type,
        run_id: Some("run-1".to_owned()),
        turn_id: Some("turn-1".to_owned()),
        payload,
    }
}

fn active_scope() -> AcpxEventScope {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    scope
}

#[test]
fn decodes_every_admitted_runtime_event_shape() {
    let scope = active_scope();
    let cases = [
        (
            json!({"type": "text_delta", "text": "Hello"}),
            AcpxRuntimeEventKind::TextDelta,
        ),
        (
            json!({"type": "thinking", "text": "Inspect"}),
            AcpxRuntimeEventKind::Thinking,
        ),
        (
            json!({"type": "plan", "entries": [{"content": "Inspect", "status": "pending"}]}),
            AcpxRuntimeEventKind::Plan,
        ),
        (
            json!({"type": "status", "tag": "usage_update", "text": "Working"}),
            AcpxRuntimeEventKind::Status,
        ),
        (
            json!({"type": "tool_call", "toolCallId": "tool-1", "status": "completed", "locations": []}),
            AcpxRuntimeEventKind::ToolCall,
        ),
        (
            json!({"type": "semantic_result", "callId": "call-1", "operationId": "paperclip_finish", "ok": true, "result": {"ok": true}}),
            AcpxRuntimeEventKind::SemanticResult,
        ),
        (
            json!({"type": "provider_notice", "category": "provider_update", "summary": "Update"}),
            AcpxRuntimeEventKind::ProviderNotice,
        ),
        (
            json!({"type": "error", "code": "provider_error", "message": "Failed"}),
            AcpxRuntimeEventKind::Error,
        ),
        (
            json!({"type": "done", "stopReason": "end_turn"}),
            AcpxRuntimeEventKind::Done,
        ),
    ];

    for (payload, expected_kind) in cases {
        let decoded = decode_acpx_event(
            &scope,
            &event(GeneratedAcpxSidecarEventType::RuntimeEvent, payload),
        )
        .unwrap();
        assert!(matches!(
            decoded,
            AcpxEventPayload::Runtime { kind, .. } if kind == expected_kind
        ));
    }
}

#[test]
fn admits_sidecar_replacement_scalars_in_tool_fields() {
    let scope = active_scope();
    let kind = format!("{}\u{fffd}WRITE", "x".repeat(240));
    let decoded = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            json!({
                "type": "tool_call",
                "toolCallId": "tool-\u{fffd}",
                "kind": kind.clone(),
                "status": "pend\u{fffd}ing",
                "title": "Wri\u{fffd}te",
                "locations": [],
            }),
        ),
    )
    .expect("the sidecar's Unicode replacement values must remain admissible");

    assert!(matches!(
        decoded,
        AcpxEventPayload::Runtime {
            kind: AcpxRuntimeEventKind::ToolCall,
            tool_operation: Some("edit"),
            payload,
            ..
        } if payload["toolCallId"].as_str() == Some("tool-\u{fffd}")
            && payload["kind"].as_str() == Some(kind.as_str())
            && payload["status"].as_str() == Some("pend\u{fffd}ing")
    ));
}

#[test]
fn retains_full_kind_classification_from_a_bounded_sidecar_frame() {
    let scope = active_scope();
    let decoded = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeEvent,
            json!({
                "type": "tool_call",
                "toolCallId": "tool-oversized-kind",
                "kind": "x".repeat(4_000),
                "toolOperation": "edit",
                "status": "pending",
                "title": "Provider tool",
                "locations": [],
            }),
        ),
    )
    .expect("a bounded tool frame with sidecar classification must remain admissible");

    assert!(matches!(
        decoded,
        AcpxEventPayload::Runtime {
            kind: AcpxRuntimeEventKind::ToolCall,
            tool_operation: Some("edit"),
            payload,
            ..
        } if payload["type"] == "tool_call"
            && payload["kind"].as_str().is_some_and(|value| value.chars().count() == 4_000)
    ));

    let invalid = event(
        GeneratedAcpxSidecarEventType::RuntimeEvent,
        json!({"type": "tool_call", "toolCallId": "tool-1", "toolOperation": "write"}),
    );
    assert!(decode_acpx_event(&scope, &invalid)
        .unwrap_err()
        .to_string()
        .contains("tool operation is not admitted"));
}

#[test]
fn rejects_unclassified_and_malformed_runtime_payloads() {
    let scope = active_scope();
    for payload in [
        json!({"type": "future_event"}),
        json!({"type": "text_delta", "text": "x".repeat(65_537)}),
        json!({"type": "text_delta", "text": "ok", "messageId": "x".repeat(241)}),
        json!({"type": "plan", "entries": [{"content": "Inspect", "status": "blocked"}]}),
        json!({"type": "semantic_result", "callId": "call-1", "operationId": "finish", "result": "not-an-object"}),
        json!({"type": "tool_call", "status": "pending"}),
        json!({"type": "tool_call", "locations": vec![json!({}); 2_001]}),
        json!({"type": "tool_call", "locations": {"path": "file.txt"}}),
        json!({"type": "provider_notice", "category": "", "summary": "Update"}),
    ] {
        assert!(decode_acpx_event(
            &scope,
            &event(GeneratedAcpxSidecarEventType::RuntimeEvent, payload),
        )
        .is_err());
    }
}

#[test]
fn decodes_tool_and_permission_requests_after_scope_validation() {
    let scope = active_scope();
    let tool = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeToolCalled,
            json!({
                "callId": "call-1",
                "operationId": "get_issue",
                "input": {"issueId": "issue-1", "apiToken": "secret-value"},
            }),
        ),
    )
    .unwrap();
    assert!(matches!(
        tool,
        AcpxEventPayload::ToolCalled { call_id, operation_id, input, .. }
            if call_id == "call-1"
                && operation_id == "get_issue"
                && input["apiToken"] == "[REDACTED]"
    ));

    let permission = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimePermissionRequested,
            json!({
                "requestId": "permission-1",
                "kind": "write",
                "title": "Authorization: Bearer permission-secret"
            }),
        ),
    )
    .unwrap();
    assert!(matches!(
        permission,
        AcpxEventPayload::PermissionRequested { request_id, kind, title, details }
            if request_id == "permission-1"
                && kind == "write"
                && title.contains("REDACTED")
                && !title.contains("permission-secret")
                && details["title"].as_str().is_some_and(|value| value.contains("REDACTED"))
    ));
}

#[test]
fn validates_question_sets_and_rejects_duplicate_question_ids() {
    let scope = active_scope();
    let question = json!({
        "id": "choice",
        "prompt": "Choose one",
        "required": true,
        "answerMode": "single_select",
        "options": [{"id": "one", "label": "One"}],
    });
    let valid = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeInputRequested,
            json!({
                "requestId": "input-1",
                "questionSet": {"schema": "paperclip.question_set.v1", "questions": [question.clone()]},
                "origin": {"provider": "codex"},
            }),
        ),
    )
    .unwrap();
    assert!(matches!(
        valid,
        AcpxEventPayload::InputRequested { request_id, .. } if request_id == "input-1"
    ));

    let sensitive = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeInputRequested,
            json!({
                "requestId": "input-sensitive",
                "questionSet": {
                    "schema": "paperclip.question_set.v1",
                    "title": "token=question-set-secret",
                    "description": "authorization: question-description-secret",
                    "submitLabel": "secret=submit-label-secret",
                    "questions": [{
                        "id": "token=stable-question-id",
                        "header": "token=question-header-secret",
                        "prompt": "password=question-prompt-secret",
                        "helpText": "api_key=question-help-secret",
                        "required": true,
                        "answerMode": "single_select",
                        "options": [{
                            "id": "token=stable-option-id",
                            "label": "bearer option-label-secret",
                            "description": "ticket=option-description-secret"
                        }],
                        "customAnswer": {
                            "enabled": true,
                            "label": "token=custom-label-secret",
                            "placeholder": "secret=custom-placeholder-secret"
                        },
                        "textValidation": {"pattern": "^token=protocol-value$"}
                    }]
                }
            }),
        ),
    )
    .unwrap();
    let AcpxEventPayload::InputRequested { question_set, .. } = sensitive else {
        panic!("input request must retain its question set");
    };
    let retained = question_set.to_string();
    assert!(!retained.contains("question-set-secret"));
    assert!(!retained.contains("question-prompt-secret"));
    assert!(!retained.contains("option-label-secret"));
    assert!(!retained.contains("custom-placeholder-secret"));
    assert_eq!(
        question_set["questions"][0]["id"],
        "token=stable-question-id"
    );
    assert_eq!(
        question_set["questions"][0]["options"][0]["id"],
        "token=stable-option-id"
    );
    assert_eq!(
        question_set["questions"][0]["textValidation"]["pattern"],
        "^token=protocol-value$"
    );

    let duplicate = event(
        GeneratedAcpxSidecarEventType::RuntimeInputRequested,
        json!({
            "requestId": "input-2",
            "questionSet": {"schema": "paperclip.question_set.v1", "questions": [question.clone(), question]},
        }),
    );
    assert!(decode_acpx_event(&scope, &duplicate)
        .unwrap_err()
        .to_string()
        .contains("must be unique"));

    let duplicate_options = event(
        GeneratedAcpxSidecarEventType::RuntimeInputRequested,
        json!({
            "requestId": "input-3",
            "questionSet": {
                "schema": "paperclip.question_set.v1",
                "questions": [{
                    "id": "choice",
                    "prompt": "Choose one",
                    "required": true,
                    "answerMode": "single_select",
                    "options": [
                        {"id": "same", "label": "One"},
                        {"id": "same", "label": "Two"},
                    ],
                }],
            },
        }),
    );
    assert!(decode_acpx_event(&scope, &duplicate_options)
        .unwrap_err()
        .to_string()
        .contains("option ids must be unique"));
}

#[test]
fn decodes_terminal_and_redacts_diagnostic_payloads() {
    let scope = active_scope();
    let terminal = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            json!({"status": "cancelled", "error": {"authorization": "Bearer secret"}}),
        ),
    )
    .unwrap();
    assert!(matches!(
        terminal,
        AcpxEventPayload::TurnTerminal { status: AcpxTurnStatus::Cancelled, error: Some(error) }
            if error["authorization"] == "[REDACTED]"
    ));

    let no_error = decode_acpx_event(
        &scope,
        &event(
            GeneratedAcpxSidecarEventType::RuntimeTurnTerminal,
            json!({"status": "completed", "error": null}),
        ),
    )
    .unwrap();
    assert!(matches!(
        no_error,
        AcpxEventPayload::TurnTerminal {
            status: AcpxTurnStatus::Completed,
            error: None
        }
    ));

    let mut diagnostic = event(
        GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
        json!({"code": "provider_warning", "message": "Authorization: Bearer secret"}),
    );
    diagnostic.run_id = None;
    diagnostic.turn_id = None;
    let decoded = decode_acpx_event(&scope, &diagnostic).unwrap();
    assert!(matches!(
        decoded,
        AcpxEventPayload::Diagnostic { message, .. }
            if message == "Authorization: Bearer [REDACTED]"
    ));
}

#[test]
fn rejects_payloads_before_decoding_when_scope_or_size_is_invalid() {
    let scope = active_scope();
    let mut wrong_run = event(
        GeneratedAcpxSidecarEventType::RuntimeToolCalled,
        json!({"malformed": true}),
    );
    wrong_run.run_id = Some("run-2".to_owned());
    let error = decode_acpx_event(&scope, &wrong_run).unwrap_err();
    assert!(error.to_string().contains("stale run"));

    let mut oversized = event(
        GeneratedAcpxSidecarEventType::RuntimeProcess,
        json!({"output": "x".repeat(256 * 1024)}),
    );
    oversized.run_id = None;
    oversized.turn_id = None;
    let error = decode_acpx_event(&scope, &oversized).unwrap_err();
    assert!(error.to_string().contains("256 KiB"));
}
