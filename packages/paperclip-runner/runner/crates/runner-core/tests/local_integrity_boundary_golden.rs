use std::fs;
use std::path::PathBuf;

use paperclip_runner_core::acpx_event_payload::{AcpxRuntimeEventKind, AcpxTurnStatus};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::provider_events::{
    normalize_acpx_runtime_event, normalize_codex_notification, project_acpx_state_event,
    AcpxEventProjectionContext, NormalizedProviderEvent,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/provider-boundary/local-integrity.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read local integrity golden"))
        .expect("parse local integrity golden")
}

fn event<'a>(fixture: &'a Value, source_event_id: &str) -> &'a Value {
    fixture["events"]
        .as_array()
        .expect("golden events")
        .iter()
        .find(|event| event["sourceEventId"] == source_event_id)
        .expect("golden event exists")
}

fn one(events: Vec<NormalizedProviderEvent>, event_type: &str) -> NormalizedProviderEvent {
    assert_eq!(events.len(), 1, "{event_type} must map exactly once");
    let event = events.into_iter().next().expect("one normalized event");
    assert_eq!(event.event_type, event_type);
    event
}

#[test]
fn canonical_boundary_fixture_names_all_qualified_local_profiles() {
    let fixture = fixture();
    assert_eq!(
        fixture["schema"],
        "paperclip.local-provider-boundary-golden.v1"
    );
    let profiles = fixture["profiles"].as_array().expect("qualified profiles");
    assert_eq!(profiles.len(), 4);
    assert_eq!(
        profiles
            .iter()
            .map(|profile| profile["id"].as_str().expect("profile id"))
            .collect::<Vec<_>>(),
        vec![
            "runner-codex",
            "runner-opencode",
            "runner-acpx-claude",
            "runner-acpx-codex",
        ]
    );

    let events = fixture["events"].as_array().expect("golden events");
    assert_eq!(events.len(), 10);
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event["sourceSeq"], (index + 1) as u64);
        assert!(event["sourceEventId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        assert!(event["eventType"]
            .as_str()
            .is_some_and(|kind| !kind.is_empty()));
    }
}

#[test]
fn codex_facade_normalization_matches_the_shared_identity_and_channel_golden() {
    let fixture = fixture();

    for source_event_id in [
        "progress-completed",
        "reasoning-completed",
        "final-completed",
    ] {
        let expected = event(&fixture, source_event_id);
        let payload = &expected["payload"];
        let normalized = one(
            normalize_codex_notification(
                "item/completed",
                &json!({
                    "item": {
                        "id": payload["itemId"],
                        "type": payload["kind"],
                        "status": payload["status"],
                        "phase": payload["providerPhase"],
                        "text": payload["text"],
                    }
                }),
            ),
            "item.completed",
        );
        assert_eq!(normalized.payload["itemId"], payload["itemId"]);
        assert_eq!(normalized.payload["kind"], payload["kind"]);
        assert_eq!(normalized.payload["channel"], payload["channel"]);
        assert_eq!(
            normalized.payload["providerPhase"],
            payload["providerPhase"]
        );
        assert_eq!(normalized.payload["text"], payload["text"]);
    }

    let expected_tool = event(&fixture, "tool-completed");
    let tool_payload = &expected_tool["payload"];
    let tool = one(
        normalize_codex_notification(
            "item/completed",
            &json!({
                "item": {
                    "id": tool_payload["executionId"],
                    "type": "commandExecution",
                    "status": "completed",
                    "command": tool_payload["name"],
                    "aggregatedOutput": tool_payload["output"],
                    "durationMs": tool_payload["durationMs"],
                    "exitCode": tool_payload["exitCode"],
                }
            }),
        ),
        "tool.execution.completed",
    );
    assert_eq!(tool.payload["executionId"], tool_payload["executionId"]);
    assert_eq!(tool.payload["output"], tool_payload["output"]);

    let expected_plan = event(&fixture, "plan-updated");
    let plan_payload = &expected_plan["payload"];
    let plan = one(
        normalize_codex_notification(
            "turn/plan/updated",
            &json!({
                "turnId": fixture["turnId"],
                "revision": plan_payload["revision"],
                "explanation": plan_payload["explanation"],
                "plan": plan_payload["steps"].as_array().expect("plan steps").iter().map(|step| json!({
                    "step": step["body"],
                    "status": step["status"],
                })).collect::<Vec<_>>(),
            }),
        ),
        "plan.updated",
    );
    assert_eq!(&plan.payload, plan_payload);

    let usage_payload = &event(&fixture, "usage-reported")["payload"];
    let usage = one(
        normalize_codex_notification(
            "thread/tokenUsage/updated",
            &json!({
                "threadId": usage_payload["providerSessionId"],
                "model": usage_payload["model"],
                "tokenUsage": {
                    "total": usage_payload["cumulative"],
                    "last": usage_payload["runDelta"],
                }
            }),
        ),
        "usage.reported",
    );
    assert_eq!(usage.payload["runDeltaAvailable"], true);
    assert_eq!(usage.payload["runDelta"], usage_payload["runDelta"]);

    let terminal_payload = &event(&fixture, "turn-completed")["payload"];
    let terminal = one(
        normalize_codex_notification(
            "turn/completed",
            &json!({
                "turn": {
                    "id": terminal_payload["providerTurnId"],
                    "status": terminal_payload["status"],
                }
            }),
        ),
        "turn.completed",
    );
    assert_eq!(
        terminal.payload["providerTurnId"],
        terminal_payload["providerTurnId"]
    );
    assert_eq!(terminal.payload["status"], terminal_payload["status"]);
}

#[test]
fn acpx_projection_matches_shared_plan_question_final_and_terminal_identity() {
    let fixture = fixture();
    let context = AcpxEventProjectionContext {
        run_id: "run-boundary".to_owned(),
        normalized_session_id: "session-boundary".to_owned(),
        turn_id: fixture["turnId"].as_str().expect("turn id").to_owned(),
        item_id: "question-boundary-1".to_owned(),
    };

    let expected_plan = &event(&fixture, "plan-updated")["payload"];
    let plan = one(
        normalize_acpx_runtime_event(
            AcpxRuntimeEventKind::Plan,
            &json!({
                "type": "plan",
                "entries": expected_plan["steps"].as_array().expect("plan steps").iter().map(|step| json!({
                    "content": step["body"],
                    "status": step["status"],
                })).collect::<Vec<_>>(),
            }),
            None,
            "fallback-plan",
            context.turn_id.as_str(),
            1,
        ),
        "plan.updated",
    );
    assert_eq!(plan.payload["planId"], expected_plan["planId"]);
    assert_eq!(plan.payload["steps"], expected_plan["steps"]);

    let expected_question = &event(&fixture, "question-created")["payload"]["request"];
    let question = one(
        project_acpx_state_event(
            &context,
            &AcpxProviderStateEvent::InputRequest {
                request_id: expected_question["requestId"]
                    .as_str()
                    .expect("request id")
                    .to_owned(),
                question_set: expected_question["input"].clone(),
                origin: Some(expected_question["origin"].clone()),
            },
        )
        .expect("project ACPX question"),
        "runtime_request.created",
    );
    assert_eq!(
        question.payload["request"]["requestId"],
        expected_question["requestId"]
    );
    assert_eq!(
        question.payload["request"]["input"],
        expected_question["input"]
    );
    assert_eq!(
        question.payload["request"]["origin"],
        expected_question["origin"]
    );

    let expected_final = &event(&fixture, "final-completed")["payload"];
    let final_message = one(
        project_acpx_state_event(
            &AcpxEventProjectionContext {
                item_id: expected_final["itemId"]
                    .as_str()
                    .expect("final item id")
                    .to_owned(),
                ..context.clone()
            },
            &AcpxProviderStateEvent::AssistantMessage {
                turn_id: context.turn_id.clone(),
                text: expected_final["text"]
                    .as_str()
                    .expect("final text")
                    .to_owned(),
            },
        )
        .expect("project ACPX final"),
        "item.completed",
    );
    assert_eq!(final_message.payload["itemId"], expected_final["itemId"]);
    assert_eq!(final_message.payload["channel"], "final");
    assert_eq!(final_message.payload["text"], expected_final["text"]);

    let expected_terminal = &event(&fixture, "turn-completed")["payload"];
    let terminal = one(
        project_acpx_state_event(
            &context,
            &AcpxProviderStateEvent::TurnTerminal {
                turn_id: context.turn_id.clone(),
                status: AcpxTurnStatus::Completed,
                error: None,
            },
        )
        .expect("project ACPX terminal"),
        "turn.completed",
    );
    assert_eq!(terminal.payload["status"], expected_terminal["status"]);
    assert_eq!(terminal.payload["providerTurnId"], context.turn_id);
}
