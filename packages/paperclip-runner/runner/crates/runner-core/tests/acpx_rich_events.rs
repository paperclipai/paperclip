use paperclip_runner_core::acpx_event_payload::{decode_acpx_event, AcpxEventPayload};
use paperclip_runner_core::acpx_event_scope::AcpxEventScope;
use paperclip_runner_core::acpx_provider_state::{AcpxProviderState, AcpxProviderStateEvent};
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::durable::EventPriority;
use paperclip_runner_core::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use serde_json::{json, Value};

fn scope() -> AcpxEventScope {
    let mut scope = AcpxEventScope::new("run-1").unwrap();
    scope.bind_turn("turn-1").unwrap();
    scope
}
fn event(event_type: &str, payload: Value) -> AcpxSidecarEvent {
    AcpxSidecarEvent {
        sequence: 1,
        event_type: GeneratedAcpxSidecarEventType::RuntimeRichEvent,
        run_id: Some("run-1".to_owned()),
        turn_id: Some("turn-1".to_owned()),
        payload: json!({"eventType":event_type,"itemId":"display-1","payload":payload}),
    }
}
fn plan() -> Value {
    json!({"schema":"paperclip.plan.updated.v1","planId":"plan-1","revision":2,"explanation":"Changed order","steps":[{"stepId":"step-1","body":"Inspect","status":"completed"},{"stepId":"step-2","body":"Build","status":"in_progress"}],"complete":false,"syncStatus":"not_applicable","documentRevision":null})
}
fn artifact() -> Value {
    json!({"schema":"paperclip.artifact.generated.v1","artifactId":"image-1","status":"completed","reference":"outputs/diagram.png","mediaType":"image/png","registered":false,"failure":null})
}

#[test]
fn rich_activity_preserves_plans_children_and_artifact_metadata_without_mutation_authority() {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    for (event_type, payload) in [
        ("plan.updated", plan()),
        ("artifact.generated", artifact()),
        (
            "delegation.completed",
            json!({"schema":"paperclip.delegation.v1","delegationId":"task-1","action":"spawn","status":"completed","children":[{"childId":"child-1","role":"explore","model":"small-model","status":"completed","summary":"Found the implementation","activitySummary":"Searched src; duration 310 ms"}]}),
        ),
    ] {
        let projected = state
            .accept_event(&event(event_type, payload.clone()))
            .unwrap();
        assert_eq!(projected.len(), 1);
        let AcpxProviderStateEvent::Activity(activity) = &projected[0] else {
            panic!("rich event became an authority-bearing event");
        };
        assert_eq!(activity.event_type, event_type);
        assert_eq!(activity.priority, EventPriority::P1);
        assert_eq!(activity.payload, payload);
        assert!(!state.has_pending_requests());
        assert_eq!(state.active_turn_id(), Some("turn-1"));
    }
}

#[test]
fn rich_activity_rejects_terminal_semantic_source_and_schema_injection() {
    for event_type in [
        "turn.completed",
        "run.result",
        "run.completed",
        "semantic_tool.input",
        "semantic_tool.result",
        "runtime.input_requested",
        "workspace.changed",
        "harness.diagnostic",
        "unknown.event",
    ] {
        assert!(
            decode_acpx_event(&scope(), &event(event_type, plan())).is_err(),
            "{event_type}"
        );
    }
    assert!(decode_acpx_event(&scope(), &event("artifact.generated", plan())).is_err());
    for field in ["source", "sourceRef", "runId", "priority"] {
        let mut injected = event("plan.updated", plan());
        injected.payload[field] = json!("forged");
        assert!(decode_acpx_event(&scope(), &injected).is_err());
    }
    let mut extra = plan();
    extra["sourceRef"] = json!("file:///private/key");
    assert!(decode_acpx_event(&scope(), &event("plan.updated", extra)).is_err());
    let mut registered = artifact();
    registered["registered"] = json!(true);
    assert!(decode_acpx_event(&scope(), &event("artifact.generated", registered)).is_err());
    let mut synchronized = plan();
    synchronized["syncStatus"] = json!("synchronized");
    synchronized["documentRevision"] = json!(1);
    assert!(decode_acpx_event(&scope(), &event("plan.updated", synchronized)).is_err());
    for path in [
        "/private/key",
        "../outside",
        "file:///private/key",
        "C:\\private\\key",
        "outputs/evil\u{0000}.png",
    ] {
        let mut escaped = artifact();
        escaped["reference"] = json!(path);
        assert!(
            decode_acpx_event(&scope(), &event("artifact.generated", escaped)).is_err(),
            "{path}"
        );
    }
}

#[test]
fn rich_activity_requires_the_current_run_and_active_turn() {
    let mut event = event("plan.updated", plan());
    event.run_id = Some("old-run".to_owned());
    assert!(decode_acpx_event(&scope(), &event).is_err());
    event.run_id = None;
    assert!(decode_acpx_event(&scope(), &event).is_err());
    event.run_id = Some("run-1".to_owned());
    event.turn_id = Some("old-turn".to_owned());
    assert!(decode_acpx_event(&scope(), &event).is_err());
    event.turn_id = None;
    assert!(decode_acpx_event(&scope(), &event).is_err());
    event.turn_id = Some("turn-1".to_owned());
    let mut settled = scope();
    settled.clear_turn("turn-1").unwrap();
    assert!(decode_acpx_event(&settled, &event).is_err());
}

#[test]
fn rich_activity_is_byte_bounded_and_preserves_long_schema_bounded_output() {
    let text = "Unicode 漢字\n".repeat(1_000);
    let payload = json!({"schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"read","status":"completed","output":text,"outputBytes":text.len(),"outputTruncated":false,"outputDigest":null});
    let AcpxEventPayload::RichActivity { payload, .. } =
        decode_acpx_event(&scope(), &event("tool.execution.completed", payload)).unwrap()
    else {
        panic!("not rich activity");
    };
    assert_eq!(payload["output"], text);
    let mut oversized = plan();
    oversized["steps"] = json!((0..100).map(|index|json!({"stepId":format!("step-{index}"),"body":"漢".repeat(3_000),"status":"pending"})).collect::<Vec<_>>());
    assert!(
        decode_acpx_event(&scope(), &event("plan.updated", oversized))
            .unwrap_err()
            .to_string()
            .contains("256 KiB")
    );
}

fn question_event(description: String) -> AcpxSidecarEvent {
    AcpxSidecarEvent {
        sequence: 1,
        event_type: GeneratedAcpxSidecarEventType::RuntimeInputRequested,
        run_id: Some("run-1".to_owned()),
        turn_id: Some("turn-1".to_owned()),
        payload: json!({"requestId":"plan-request","questionSet":{"schema":"paperclip.question_set.v1","description":description,"questions":[{"id":"revision-123","prompt":"Approve?","required":true,"answerMode":"single_select","options":[{"id":"accept","label":"Accept"},{"id":"reject","label":"Reject"}]}]}}),
    }
}

#[test]
fn full_plan_presentation_survives_utf8_redaction_without_diagnostic_truncation() {
    let description = "Review 漢字\n".repeat(2_000);
    let AcpxEventPayload::InputRequested { question_set, .. } =
        decode_acpx_event(&scope(), &question_event(description.clone())).unwrap()
    else {
        panic!("not input");
    };
    assert_eq!(question_set["description"], description);
    let secret = format!("{description}\napi_key=topsecret\nFinal action");
    let AcpxEventPayload::InputRequested { question_set, .. } =
        decode_acpx_event(&scope(), &question_event(secret)).unwrap()
    else {
        panic!("not input");
    };
    let displayed = question_set["description"].as_str().unwrap();
    assert!(displayed.starts_with("Sensitive values were redacted"));
    assert!(displayed.ends_with("Final action"));
    assert!(!displayed.contains("topsecret"));
    assert!(!displayed.contains("[truncated]"));
    assert!(
        decode_acpx_event(&scope(), &question_event("漢".repeat(70_000)))
            .unwrap_err()
            .to_string()
            .contains("196 KiB")
    );
}

#[test]
fn redaction_keeps_full_length_rich_display_inside_its_schema_bounds() {
    let markdown: String = format!("# Plan\ntoken=abc\n{}", "- step\n".repeat(10_000))
        .chars()
        .take(60_000)
        .collect();
    let line = format!("{}\nGITHUB_TOKEN: ***\n", "x".repeat(70));
    let output: String = line
        .repeat(65_536 / line.len() + 1)
        .chars()
        .take(65_536)
        .collect();
    for (event_type, payload, field, limit) in [
        (
            "plan.proposed",
            json!({"schema":"paperclip.plan.proposed.v1","proposalId":"proposal-1","status":"completed","markdown":markdown,"source":"claude_exit_plan_mode"}),
            "markdown",
            60_000,
        ),
        (
            "tool.execution.completed",
            json!({"schema":"paperclip.tool.execution.v1","executionId":"tool-1","transport":"builtin","operation":"execute","status":"completed","output":output,"outputBytes":200_000,"outputTruncated":false,"outputDigest":null}),
            "output",
            65_536,
        ),
    ] {
        let decoded = decode_acpx_event(&scope(), &event(event_type, payload))
            .unwrap_or_else(|error| panic!("{event_type} was rejected: {error:?}"));
        let AcpxEventPayload::RichActivity { payload, .. } = decoded else {
            panic!("{event_type} did not decode as rich activity");
        };
        let text = payload[field].as_str().unwrap();
        assert_eq!(text.chars().count(), limit, "{event_type}");
        assert!(text.contains("[REDACTED]"), "{event_type}");
        assert!(
            !text.contains("token=abc") && !text.contains("TOKEN: ***"),
            "{event_type}"
        );
        if field == "markdown" {
            assert!(text.starts_with("# Plan\ntoken=[REDACTED]\n"));
        } else {
            assert_eq!(payload["outputTruncated"], true);
        }
    }
}
