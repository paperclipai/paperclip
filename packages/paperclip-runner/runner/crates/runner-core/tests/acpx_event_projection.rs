use paperclip_runner_core::acpx_event_payload::AcpxTurnStatus;
use paperclip_runner_core::acpx_provider_state::{AcpxProviderState, AcpxProviderStateEvent};
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarEvent;
use paperclip_runner_core::durable::EventPriority;
use paperclip_runner_core::generated_acpx_sidecar_contract::GeneratedAcpxSidecarEventType;
use paperclip_runner_core::provider_bridge::ToolResult;
use paperclip_runner_core::provider_events::{
    project_acpx_state_event, AcpxEventProjectionContext, NormalizedProviderEvent,
};
use serde_json::{json, Value};

fn context() -> AcpxEventProjectionContext {
    AcpxEventProjectionContext {
        run_id: "run-1".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        item_id: "item-1".to_owned(),
    }
}

fn project(event: AcpxProviderStateEvent) -> Vec<NormalizedProviderEvent> {
    project_acpx_state_event(&context(), &event).unwrap()
}

fn reduced_semantic_result(
    call_id: &str,
    operation_id: &str,
    ok: bool,
    result: Value,
) -> AcpxProviderStateEvent {
    let mut state = AcpxProviderState::new("run-1").unwrap();
    state.begin_turn("turn-1").unwrap();
    state
        .accept_event(&AcpxSidecarEvent {
            sequence: 1,
            event_type: GeneratedAcpxSidecarEventType::RuntimeEvent,
            run_id: Some("run-1".to_owned()),
            turn_id: Some("turn-1".to_owned()),
            payload: json!({
                "type":"semantic_result",
                "callId":call_id,
                "operationId":operation_id,
                "ok":ok,
                "result":result,
            }),
        })
        .unwrap()
        .remove(0)
}

#[test]
fn projects_authorized_tools_with_exact_durable_correlation() {
    let events = project(AcpxProviderStateEvent::ToolCall {
        call_id: "call-1".to_owned(),
        operation_id: "get_task_context".to_owned(),
        input: json!({"taskId":"task-1"}),
    });

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "semantic_tool.input");
    assert_eq!(events[0].priority, EventPriority::P0);
    assert_eq!(
        events[0].payload["semantic_tool"]["correlation"],
        json!({
            "runId":"run-1",
            "normalizedSessionId":"session-1",
            "turnId":"turn-1",
            "itemId":"item-1",
        })
    );
    assert_eq!(
        events[0].payload["semantic_tool"]["input"],
        json!({"taskId":"task-1"})
    );
    assert!(events[0].payload["semantic_tool"]["content"]["digest"]
        .as_str()
        .is_some_and(|value| value.starts_with("sha256:")));
}

#[test]
fn projects_terminal_tool_cancellations_as_correlated_results() {
    let events = project(AcpxProviderStateEvent::ToolResult(ToolResult {
        call_id: "call-1".to_owned(),
        operation_id: "issues.read".to_owned(),
        result: json!({
            "error": {
                "code": "acpx_turn_settled",
                "message": "The provider turn stopped before this semantic tool completed",
                "retryable": false,
            },
        }),
        is_error: true,
    }));

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "semantic_tool.result");
    assert_eq!(events[0].priority, EventPriority::P0);
    assert_eq!(events[0].payload["semantic_tool"]["phase"], "result");
    assert_eq!(events[0].payload["semantic_tool"]["callId"], "call-1");
    assert_eq!(events[0].payload["semantic_tool"]["outcome"], "failed");
    assert_eq!(
        events[0].payload["semantic_tool"]["correlation"],
        json!({
            "runId":"run-1",
            "normalizedSessionId":"session-1",
            "turnId":"turn-1",
            "itemId":"item-1",
        }),
    );
}

#[test]
fn projects_structured_input_and_semantic_results_without_provider_envelopes() {
    let question_set = json!({
        "schema":"paperclip.question_set.v1",
        "title":"Choose a target",
        "questions":[],
    });
    let input = project(AcpxProviderStateEvent::InputRequest {
        request_id: "request-1".to_owned(),
        question_set: question_set.clone(),
        origin: None,
    });
    assert_eq!(input[0].event_type, "runtime_request.created");
    assert_eq!(input[0].payload["request"]["requestId"], "request-1");
    assert_eq!(input[0].payload["request"]["turnId"], "turn-1");
    assert_eq!(input[0].payload["request"]["itemId"], "item-1");
    assert_eq!(input[0].payload["request"]["input"], question_set);
    assert_eq!(
        input[0].payload["request"]["origin"]["adapter"],
        "codex-acpx"
    );

    let result = json!({
        "schema":"paperclip.run_result.v1",
        "reportedWorkDisposition":"done",
        "summary":"Finished",
    });
    let projected = project(reduced_semantic_result(
        "finish-1",
        "paperclip_finish",
        true,
        result.clone(),
    ));
    assert_eq!(projected[0].event_type, "run.result.proposed");
    assert_eq!(projected[0].payload, result);

    let dynamic = project(reduced_semantic_result(
        "call-1",
        "issues.read",
        true,
        json!({"id":"issue-1"}),
    ));
    assert_eq!(dynamic[0].event_type, "semantic_tool.result");
    assert_eq!(dynamic[0].payload["semantic_tool"]["phase"], "result");
    assert_eq!(
        dynamic[0].payload["semantic_tool"]["operationId"],
        "issues.read"
    );
    assert_eq!(dynamic[0].payload["semantic_tool"]["callId"], "call-1");

    let activity = NormalizedProviderEvent {
        event_type: "usage.reported".to_owned(),
        priority: EventPriority::P0,
        payload: json!({"cumulative":{"inputTokens":1}}),
    };
    assert_eq!(
        project(AcpxProviderStateEvent::Activity(activity.clone())),
        vec![activity]
    );
}

#[test]
fn projects_runtime_request_prompt_and_origin_into_the_strict_schema() {
    let empty_title = AcpxProviderStateEvent::InputRequest {
        request_id: "request-1".to_owned(),
        question_set: json!({
            "schema":"paperclip.question_set.v1",
            "title":"",
            "questions":[{
                "id":"target",
                "prompt":"Which target?",
                "required":true,
                "answerMode":"single_select",
                "options":[{"id":"first","label":"First"}],
            }],
        }),
        origin: Some(json!({
            "adapter":"codex-acpx",
            "provider":"codex",
            "method":"runtime.input_requested",
        })),
    };
    let projected = project(empty_title);
    assert_eq!(projected[0].payload["request"]["prompt"], "Which target?");

    for origin in [
        json!({"provider":"codex"}),
        json!({"adapter":"codex-acpx","extra":true}),
        json!({"adapter":""}),
        json!({"adapter":"codex-acpx","method":null}),
    ] {
        let invalid = AcpxProviderStateEvent::InputRequest {
            request_id: "request-1".to_owned(),
            question_set: json!({
                "schema":"paperclip.question_set.v1",
                "questions":[],
            }),
            origin: Some(origin),
        };
        assert!(project_acpx_state_event(&context(), &invalid).is_err());
    }
}

#[test]
fn projects_assistant_terminal_and_diagnostic_events_fail_closed() {
    let assistant = project(AcpxProviderStateEvent::AssistantMessage {
        turn_id: "turn-1".to_owned(),
        text: "Done".to_owned(),
    });
    assert_eq!(assistant[0].event_type, "item.completed");
    assert_eq!(assistant[0].payload["itemId"], "item-1");
    assert_eq!(assistant[0].payload["channel"], "final");

    for (status, expected) in [
        (AcpxTurnStatus::Completed, "turn.completed"),
        (AcpxTurnStatus::Failed, "turn.failed"),
        (AcpxTurnStatus::Cancelled, "turn.cancelled"),
        (AcpxTurnStatus::Interrupted, "turn.interrupted"),
    ] {
        let terminal = project(AcpxProviderStateEvent::TurnTerminal {
            turn_id: "turn-1".to_owned(),
            status,
            error: None,
        });
        assert_eq!(terminal[0].event_type, expected);
    }

    let process = project(AcpxProviderStateEvent::Process(json!({"pid":7})));
    assert_eq!(process[0].event_type, "harness.diagnostic");
    assert_eq!(process[0].payload["details"]["pid"], 7);
    let diagnostic = project(AcpxProviderStateEvent::Diagnostic {
        code: "provider_notice".to_owned(),
        message: "Retrying".to_owned(),
    });
    assert_eq!(diagnostic[0].payload["message"], "Retrying");

    let wrong_turn = AcpxProviderStateEvent::TurnTerminal {
        turn_id: "turn-other".to_owned(),
        status: AcpxTurnStatus::Completed,
        error: None,
    };
    assert!(project_acpx_state_event(&context(), &wrong_turn)
        .unwrap_err()
        .to_string()
        .contains("durable turn projection"));
    let permission = AcpxProviderStateEvent::PermissionRequest {
        request_id: "permission-1".to_owned(),
        kind: "write".to_owned(),
        title: "Allow write".to_owned(),
        details: Value::Null,
    };
    assert!(project_acpx_state_event(&context(), &permission)
        .unwrap_err()
        .to_string()
        .contains("pinned runner policy"));
}

#[test]
fn rejects_invalid_durable_projection_identity() {
    let mut invalid = context();
    invalid.run_id = "".to_owned();
    let event = AcpxProviderStateEvent::Diagnostic {
        code: "notice".to_owned(),
        message: "message".to_owned(),
    };
    assert!(project_acpx_state_event(&invalid, &event)
        .unwrap_err()
        .to_string()
        .contains("run identity"));

    for (field, max_chars) in [
        ("run", 160),
        ("normalized session", 160),
        ("turn", 240),
        ("item", 240),
    ] {
        let mut invalid = context();
        let oversized = "x".repeat(max_chars + 1);
        match field {
            "run" => invalid.run_id = oversized,
            "normalized session" => invalid.normalized_session_id = oversized,
            "turn" => invalid.turn_id = oversized,
            "item" => invalid.item_id = oversized,
            _ => unreachable!(),
        }
        let error = project_acpx_state_event(&invalid, &event)
            .unwrap_err()
            .to_string();
        assert!(error.contains(&format!("{field} identity")), "{error}");
    }

    for request_id in [String::new(), "x".repeat(241), "request\n1".to_owned()] {
        let request = AcpxProviderStateEvent::InputRequest {
            request_id,
            question_set: json!({
                "schema":"paperclip.question_set.v1",
                "questions":[],
            }),
            origin: None,
        };
        let error = project_acpx_state_event(&context(), &request)
            .unwrap_err()
            .to_string();
        assert!(error.contains("request identity"), "{error}");
    }

    for field in ["run", "normalized session", "turn", "item"] {
        let mut invalid = context();
        match field {
            "run" => invalid.run_id = "run 1".to_owned(),
            "normalized session" => invalid.normalized_session_id = "session/1".to_owned(),
            "turn" => invalid.turn_id = "turn 1".to_owned(),
            "item" => invalid.item_id = "item/1".to_owned(),
            _ => unreachable!(),
        }
        let error = project_acpx_state_event(&invalid, &event)
            .unwrap_err()
            .to_string();
        assert!(error.contains(&format!("{field} identity")), "{error}");
    }
}

#[test]
fn rejects_semantic_events_that_cannot_form_stable_receipts() {
    for event in [
        AcpxProviderStateEvent::ToolCall {
            call_id: "call 1".to_owned(),
            operation_id: "issues.read".to_owned(),
            input: json!({}),
        },
        AcpxProviderStateEvent::ToolResult(ToolResult {
            call_id: "call-1".to_owned(),
            operation_id: "issues/read".to_owned(),
            result: json!({}),
            is_error: false,
        }),
        reduced_semantic_result("réturn-1", "issues.read", true, json!({})),
        reduced_semantic_result("call-1", "issues read", true, json!({})),
    ] {
        let error = project_acpx_state_event(&context(), &event)
            .unwrap_err()
            .to_string();
        assert!(error.contains("semantic"), "{error}");
        assert!(error.contains("identity"), "{error}");
    }
}

#[test]
fn deterministically_projects_bounded_upstream_request_ids() {
    let question_set = json!({
        "schema":"paperclip.question_set.v1",
        "questions":[],
    });
    for upstream_id in [
        "request 1".to_owned(),
        "réquest-1".to_owned(),
        "request/1".to_owned(),
        "_request-1".to_owned(),
        "x".repeat(240),
    ] {
        let event = AcpxProviderStateEvent::InputRequest {
            request_id: upstream_id.clone(),
            question_set: question_set.clone(),
            origin: None,
        };
        let first = project_acpx_state_event(&context(), &event).unwrap();
        let second = project_acpx_state_event(&context(), &event).unwrap();
        let projected_id = first[0].payload["request"]["requestId"].as_str().unwrap();
        assert_ne!(projected_id, upstream_id);
        assert_eq!(second[0].payload["request"]["requestId"], projected_id);
        assert!(projected_id.starts_with("acpx-request-"));
        assert!(projected_id.len() <= 160);
        assert!(projected_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character)));
    }

    let canonical = AcpxProviderStateEvent::InputRequest {
        request_id: "request-1".to_owned(),
        question_set,
        origin: None,
    };
    assert_eq!(
        project_acpx_state_event(&context(), &canonical).unwrap()[0].payload["request"]
            ["requestId"],
        "request-1"
    );
}

#[test]
fn runtime_request_projection_preserves_durable_identity_boundaries() {
    let canonical_request_schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/request.schema.json"
    ))
    .unwrap();
    let mut runtime_request_schema = canonical_request_schema["oneOf"][0].clone();
    // This test owns identity projection. The question-set validator has its
    // own coverage, so replace its remote reference with an unconstrained
    // local schema before compiling the canonical runtime-request branch.
    runtime_request_schema["properties"]["input"] = json!({});
    let request_validator = jsonschema::validator_for(&runtime_request_schema).unwrap();
    let request_event = AcpxProviderStateEvent::InputRequest {
        request_id: "request-1".to_owned(),
        question_set: json!({
            "schema":"paperclip.question_set.v1",
            "questions":[],
        }),
        origin: None,
    };
    let valid = project_acpx_state_event(&context(), &request_event).unwrap();
    assert!(request_validator.is_valid(&valid[0].payload["request"]));

    let mut durable_context = context();
    durable_context.turn_id = "t".repeat(240);
    durable_context.item_id = "i".repeat(240);
    let durable_request = project_acpx_state_event(&durable_context, &request_event).unwrap();
    assert_eq!(
        durable_request[0].payload["request"]["turnId"],
        durable_context.turn_id
    );
    assert_eq!(
        durable_request[0].payload["request"]["itemId"],
        durable_context.item_id
    );
    assert!(request_validator.is_valid(&durable_request[0].payload["request"]));

    for request_id in ["request 1", "réquest-1", "request/1", "_request-1"] {
        let mut legacy_request = valid[0].payload["request"].clone();
        legacy_request["requestId"] = Value::String(request_id.to_owned());
        assert!(request_validator.is_valid(&legacy_request), "{request_id}");
    }

    for field in ["turnId", "itemId"] {
        let mut invalid_request = valid[0].payload["request"].clone();
        invalid_request[field] = Value::String("x".repeat(241));
        assert!(!request_validator.is_valid(&invalid_request));
    }

    let diagnostic = AcpxProviderStateEvent::Diagnostic {
        code: "notice".to_owned(),
        message: "message".to_owned(),
    };
    assert!(project_acpx_state_event(&durable_context, &diagnostic).is_ok());

    let semantic = project_acpx_state_event(
        &durable_context,
        &AcpxProviderStateEvent::ToolCall {
            call_id: "call-1".to_owned(),
            operation_id: "issues.read".to_owned(),
            input: json!({"taskId":"task-1"}),
        },
    )
    .unwrap();
    let semantic_schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/semantic-tool.schema.json"
    ))
    .unwrap();
    let semantic_validator = jsonschema::validator_for(&semantic_schema).unwrap();
    assert!(semantic_validator.is_valid(&semantic[0].payload["semantic_tool"]));
}
