use paperclip_runner_core::acpx_event_payload::{
    decode_acpx_event, AcpxEventPayload, AcpxRuntimeEventKind,
};
use paperclip_runner_core::acpx_event_scope::AcpxEventScope;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::durable::EventPriority;
use paperclip_runner_core::generated_acpx_sidecar_contract::{
    classify_generated_acpx_tool_operation, GeneratedAcpxSidecarEventType,
};
use paperclip_runner_core::provider_events::normalize_acpx_runtime_event;
use serde_json::json;

fn normalize(
    kind: AcpxRuntimeEventKind,
    payload: serde_json::Value,
) -> Vec<paperclip_runner_core::provider_events::NormalizedProviderEvent> {
    let operation = (kind == AcpxRuntimeEventKind::ToolCall).then(|| {
        classify_generated_acpx_tool_operation(
            payload
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            payload
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
        )
    });
    normalize_acpx_runtime_event(kind, &payload, operation, "event-7", "turn-1", 3)
}

#[test]
fn generated_tool_classification_uses_ascii_case_mapping_for_kind_and_title() {
    assert_eq!(
        classify_generated_acpx_tool_operation("ſearch", ""),
        "execute"
    );
    assert_eq!(
        classify_generated_acpx_tool_operation("", "ſearch"),
        "execute"
    );
    assert_eq!(
        classify_generated_acpx_tool_operation("SEARCH", ""),
        "search"
    );
    assert_eq!(classify_generated_acpx_tool_operation("", "WRITE"), "edit");
    assert_eq!(
        classify_generated_acpx_tool_operation(&format!("{}WRITE", "x".repeat(240)), ""),
        "edit"
    );
}

#[test]
fn preserves_tool_operation_authority_across_payload_sanitization() {
    for payload in [
        json!({
            "type":"tool_call",
            "toolCallId":"tool-long-kind",
            "kind":format!("{}write", "x".repeat(4_097)),
            "title":"Long kind",
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
        json!({
            "type":"tool_call",
            "toolCallId":"tool-multibyte-title",
            "kind":"",
            "title":format!("{}write", "é".repeat(2_049)),
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    ] {
        let mut scope = AcpxEventScope::new("run-1").unwrap();
        scope.bind_turn("turn-1").unwrap();
        let decoded = decode_acpx_event(
            &scope,
            &AcpxSidecarEvent {
                sequence: 1,
                event_type: GeneratedAcpxSidecarEventType::RuntimeEvent,
                run_id: Some("run-1".to_owned()),
                turn_id: Some("turn-1".to_owned()),
                payload,
            },
        )
        .unwrap();
        let AcpxEventPayload::Runtime {
            kind,
            tool_operation,
            payload,
            ..
        } = decoded
        else {
            panic!("runtime event must decode as runtime payload");
        };
        let events =
            normalize_acpx_runtime_event(kind, &payload, tool_operation, "event-7", "turn-1", 3);
        assert_eq!(events[0].payload["operation"], "edit");
        assert_eq!(events[0].payload["target"], "src:new.rs");
        assert!(events[0].payload["name"].as_str().unwrap().chars().count() <= 240);
    }
}

#[test]
fn maps_text_and_thinking_without_exposing_reasoning() {
    let text = normalize(
        AcpxRuntimeEventKind::TextDelta,
        json!({"type":"text_delta","messageId":"message-1","text":"Working"}),
    );
    assert_eq!(text[0].event_type, "item.delta");
    assert_eq!(text[0].payload["itemId"], "message-1");
    assert_eq!(text[0].payload["text"], "Working");
    assert_eq!(text[0].priority, EventPriority::P2);

    let thinking = normalize(
        AcpxRuntimeEventKind::Thinking,
        json!({"type":"thinking","text":"private chain of thought"}),
    );
    assert_eq!(thinking[0].event_type, "item.started");
    assert_eq!(thinking[0].payload["kind"], "reasoning");
    assert_eq!(thinking[0].payload["text"], serde_json::Value::Null);
    assert!(!thinking[0].payload.to_string().contains("private chain"));
}

#[test]
fn maps_bounded_plan_and_completion_state() {
    let events = normalize(
        AcpxRuntimeEventKind::Plan,
        json!({
            "type":"plan",
            "entries":[
                {"content":"Inspect", "status":"in_progress"},
                {"content":"Ship", "status":"completed"}
            ]
        }),
    );
    assert_eq!(events[0].event_type, "plan.updated");
    assert_eq!(events[0].payload["planId"], "turn-1");
    assert_eq!(events[0].payload["steps"][0]["status"], "in_progress");
    assert_eq!(events[0].payload["complete"], false);
    assert_eq!(events[0].priority, EventPriority::P1);
}

#[test]
fn maps_usage_and_review_status_but_ignores_inventory_updates() {
    let usage = normalize(
        AcpxRuntimeEventKind::Status,
        json!({
            "type":"status",
            "tag":"usage_update",
            "breakdown":{"inputTokens":12,"outputTokens":4,"cachedReadTokens":2},
            "cost":{"amount":0.25}
        }),
    );
    assert_eq!(usage[0].event_type, "usage.reported");
    assert_eq!(usage[0].payload["cumulative"]["inputTokens"], 12);
    assert_eq!(usage[0].payload["cumulative"]["requests"], 3);
    assert_eq!(usage[0].priority, EventPriority::P0);

    let review = normalize(
        AcpxRuntimeEventKind::Status,
        json!({"type":"status","tag":"current_mode_update","text":"review mode"}),
    );
    assert_eq!(review[0].event_type, "review.mode.changed");
    assert_eq!(review[0].payload["state"], "entered");

    assert!(normalize(
        AcpxRuntimeEventKind::Status,
        json!({"type":"status","tag":"available_commands_update"}),
    )
    .is_empty());
}

#[test]
fn maps_tool_lifecycle_and_preserves_safe_display_paths() {
    let started = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-1",
            "kind":"read",
            "title":"Read file",
            "status":"pending",
            "locations":[{
                "path":"src/main.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2"
            }],
            "text":"Opening"
        }),
    );
    assert_eq!(started[0].event_type, "tool.execution.started");
    assert_eq!(started[0].payload["operation"], "read");
    assert_eq!(started[0].payload["target"], "src/main.rs");
    assert_eq!(started[0].payload["readOnly"], true);

    let completed = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call_update",
            "toolCallId":"tool-1",
            "kind":"read",
            "status":"completed",
            "locations":[{"path":"../../secret"}],
            "rawOutput":"Authorization: Bearer top-secret"
        }),
    );
    assert_eq!(completed[0].event_type, "tool.execution.completed");
    assert_eq!(completed[0].payload["target"], serde_json::Value::Null);
    assert_eq!(completed[0].payload["outputTruncated"], true);
    assert!(!completed[0].payload.to_string().contains("top-secret"));

    for display_path in [
        "src:main.rs",
        "foo:bar/baz",
        "src:/main.rs",
        "a:/foo",
        "A:b/file.txt",
        r"\notes.md",
        r"folder\literal",
        r"foo\..\bar",
        "reports/100%/summary.txt",
    ] {
        let display = normalize(
            AcpxRuntimeEventKind::ToolCall,
            json!({
                "type":"tool_call",
                "tag":"tool_call_update",
                "toolCallId":"tool-display",
                "kind":"read",
                "status":"completed",
                "locations":[{
                    "path":display_path,
                    "pathBoundary":"paperclip.workspace_relative_display.v2",
                    "pathAttestation":"paperclip.workspace_entry.v1"
                }]
            }),
        );
        assert_eq!(display[0].payload["target"], display_path);
    }

    for unsafe_path in [
        r"\server\share",
        r"C:\secret",
        r"https:\host\secret",
        "https://example.test/private",
        "https:example.test/private",
        "file:secret.txt",
        "custom:payload",
        "urn:isbn:9780131103627",
        "tel:+15555550100",
        r"C:Users\alice\secret.txt",
        "D:relative.txt",
    ] {
        let rejected = normalize(
            AcpxRuntimeEventKind::ToolCall,
            json!({
                "type":"tool_call",
                "tag":"tool_call_update",
                "toolCallId":"tool-unsafe-display",
                "kind":"read",
                "status":"completed",
                "locations":[{
                    "path":unsafe_path,
                    "pathBoundary":"paperclip.workspace_relative_display.v2"
                }]
            }),
        );
        assert_eq!(rejected[0].payload["target"], serde_json::Value::Null);
    }

    let create_target = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-create-display",
            "kind":"edit",
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    );
    assert_eq!(create_target[0].payload["target"], "src:new.rs");

    for compound_kind in ["read_write", "search_write"] {
        let compound_create_target = normalize(
            AcpxRuntimeEventKind::ToolCall,
            json!({
                "type":"tool_call",
                "tag":"tool_call",
                "toolCallId":format!("tool-{compound_kind}-display"),
                "kind":compound_kind,
                "status":"pending",
                "locations":[{
                    "path":"src:new.rs",
                    "pathBoundary":"paperclip.workspace_relative_display.v2",
                    "pathAttestation":"paperclip.workspace_create_target.v1"
                }]
            }),
        );
        assert_eq!(compound_create_target[0].payload["operation"], "edit");
        assert_eq!(compound_create_target[0].payload["readOnly"], false);
        assert_eq!(compound_create_target[0].payload["target"], "src:new.rs");
    }

    let long_edit_kind = format!("{}write", "x".repeat(240));
    let long_kind_create_target = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-long-edit-display",
            "kind":long_edit_kind,
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    );
    assert_eq!(long_kind_create_target[0].payload["operation"], "edit");
    assert_eq!(long_kind_create_target[0].payload["readOnly"], false);
    assert_eq!(long_kind_create_target[0].payload["target"], "src:new.rs");

    let long_edit_title = format!("{}write", "x".repeat(240));
    let long_title_create_target = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-long-title-edit-display",
            "kind":"",
            "title":long_edit_title,
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    );
    assert_eq!(long_title_create_target[0].payload["operation"], "edit");
    assert_eq!(long_title_create_target[0].payload["readOnly"], false);
    assert_eq!(long_title_create_target[0].payload["target"], "src:new.rs");

    // The sidecar classifies and emits the same 4,000-character title. A
    // mutation token outside that transport boundary cannot authorize a create
    // target that runner-core would see only as an execute operation.
    let bounded_non_edit_title = "x".repeat(4_000);
    let overlong_title_create_target = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-overlong-title-display",
            "kind":"",
            "title":bounded_non_edit_title,
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    );
    assert_eq!(
        overlong_title_create_target[0].payload["operation"],
        "execute"
    );
    assert_eq!(overlong_title_create_target[0].payload["readOnly"], false);
    assert_eq!(
        overlong_title_create_target[0].payload["target"],
        serde_json::Value::Null
    );

    let create_attestation_on_read = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call",
            "toolCallId":"tool-read-create-display",
            "kind":"read",
            "status":"pending",
            "locations":[{
                "path":"src:new.rs",
                "pathBoundary":"paperclip.workspace_relative_display.v2",
                "pathAttestation":"paperclip.workspace_create_target.v1"
            }]
        }),
    );
    assert_eq!(
        create_attestation_on_read[0].payload["target"],
        serde_json::Value::Null
    );

    let uri_only = normalize(
        AcpxRuntimeEventKind::ToolCall,
        json!({
            "type":"tool_call",
            "tag":"tool_call_update",
            "toolCallId":"tool-uri",
            "kind":"read",
            "status":"completed",
            "locations":[{"uri":"https://example.test/private"}]
        }),
    );
    assert_eq!(uri_only[0].payload["target"], serde_json::Value::Null);
}

#[test]
fn maps_provider_notices_and_errors_with_stable_fields() {
    let notice = normalize(
        AcpxRuntimeEventKind::ProviderNotice,
        json!({
            "type":"provider_notice",
            "severity":"warning",
            "category":"rate limit",
            "summary":"Retrying"
        }),
    );
    assert_eq!(notice[0].event_type, "provider.notice.recorded");
    assert_eq!(notice[0].payload["severity"], "warning");
    assert_eq!(notice[0].payload["category"], "rate-limit");

    let error = normalize(
        AcpxRuntimeEventKind::Error,
        json!({"type":"error","code":"provider/failure","message":"Stopped"}),
    );
    assert_eq!(error[0].payload["severity"], "error");
    assert_eq!(error[0].payload["userActionable"], true);
    assert_eq!(error[0].priority, EventPriority::P0);
}

#[test]
fn leaves_operational_semantic_and_terminal_events_to_the_adapter() {
    assert!(normalize(
        AcpxRuntimeEventKind::SemanticResult,
        json!({"type":"semantic_result","callId":"call-1","result":{}}),
    )
    .is_empty());
    assert!(normalize(AcpxRuntimeEventKind::Done, json!({"type":"done"})).is_empty());
}
