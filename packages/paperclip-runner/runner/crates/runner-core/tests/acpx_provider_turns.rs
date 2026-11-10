use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ToolResult,
};
use serde_json::json;

fn tool_set() -> AuthorizedToolSet {
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    AuthorizedToolSet {
        schema: "paperclip.runner.authorized-tools.v1".to_owned(),
        schema_version: 1,
        catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
        operations,
    }
}

fn config(mode: &str) -> AcpxProviderSessionConfig {
    AcpxProviderSessionConfig {
        candidate_admission: None,
        transport: AcpxSidecarTransportConfig {
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
            args: vec!["--mode".to_owned(), mode.to_owned()],
            verified_launch: None,
            request_timeout: Duration::from_secs(1),
            shutdown_grace: Duration::from_millis(100),
        },
        agent: if mode.starts_with("controls") {
            "pi"
        } else {
            "codex"
        }
        .to_owned(),
        model: "explicit-test-model".to_owned(),
        run_id: "run-1".to_owned(),
        catalog_revision: 1,
        runtime_directory: std::env::temp_dir(),
        normalized_session_id: "session-1".to_owned(),
        working_directory: std::env::temp_dir(),
        permission_mode: AcpxPermissionMode::ApproveReads,
        mode: None,
        claude_effort: None,
        grok_effort: None,
        grok_disable_web_search: None,
        pi_thinking_level: if mode.starts_with("controls") {
            Some(paperclip_runner_core::acpx_provider_session::PiThinkingLevel::Low)
        } else {
            None
        },
        permission_mode_pinned: true,
        provider_policy: if mode.starts_with("controls") {
            Some(
                paperclip_runner_core::acpx_provider_session::AcpxProviderRuntimePolicy {
                    read_only: false,
                },
            )
        } else {
            None
        },
        system_instructions: "Complete the supplied task.".to_owned(),
        runtime_context: serde_json::Value::Null,
        tool_set: tool_set(),
        expected_identity: None,
    }
}

#[test]
fn starts_interrupts_and_settles_one_scoped_turn() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    assert!(session
        .poll_event(Duration::from_millis(1))
        .unwrap()
        .is_none());
    let response = session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    assert_eq!(response["turnId"], "turn-1");
    assert_eq!(session.state().active_turn_id(), Some("turn-1"));

    let activity = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &activity[0],
        AcpxProviderStateEvent::Activity(event)
            if event.event_type == "item.delta" && event.payload["text"] == "hello"
    ));
    session
        .interrupt_turn("turn-1", "Paperclip interruption")
        .unwrap();
    assert_eq!(session.state().active_turn_id(), Some("turn-1"));
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    assert_eq!(session.state().active_turn_id(), None);
    session.shutdown("test complete").unwrap();
}

#[test]
fn rejects_invalid_turn_inputs_without_mutating_the_session() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    let other_directory = std::env::current_dir().unwrap();
    assert!(session
        .start_turn("turn-1", "Please help", &other_directory)
        .unwrap_err()
        .to_string()
        .contains("immutable session workspace"));
    assert!(session
        .start_turn("turn-1", "bad\0message", &std::env::temp_dir())
        .unwrap_err()
        .to_string()
        .contains("bounded contract"));
    assert_eq!(session.state().active_turn_id(), None);
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    session.shutdown("test complete").unwrap();
}

#[test]
fn preserves_the_durable_turn_identity_boundary_through_the_sidecar() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    let turn_id = "t".repeat(240);
    let response = session
        .start_turn(&turn_id, "Please help", &std::env::temp_dir())
        .unwrap();
    assert_eq!(response["turnId"], turn_id);

    let activity = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &activity[0],
        AcpxProviderStateEvent::Activity(event)
            if event.event_type == "item.delta" && event.payload["text"] == "hello"
    ));
    session
        .interrupt_turn(&turn_id, "Paperclip interruption")
        .unwrap();
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. } if settled == &turn_id
    ));
    session.shutdown("test complete").unwrap();

    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    for invalid_turn_id in ["t".repeat(241), "turn 1".to_owned()] {
        assert!(session
            .start_turn(&invalid_turn_id, "Please help", &std::env::temp_dir(),)
            .unwrap_err()
            .to_string()
            .contains("turn id is invalid"));
    }
    assert_eq!(session.state().active_turn_id(), None);
    session.shutdown("test complete").unwrap();
}

#[test]
fn fails_closed_when_turn_start_acknowledges_another_turn() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-turn")).unwrap();
    let error = session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap_err()
        .to_string();
    assert!(error.contains("confirm the requested turn"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_when_cancellation_is_not_confirmed() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-cancel")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .interrupt_turn("turn-1", "stop")
        .unwrap_err()
        .to_string();
    assert!(error.contains("confirm turn cancellation"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_when_a_polled_event_violates_run_scope() {
    let mut session = AcpxProviderSession::start(&config("turns-wrong-scope")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("stale run"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn admits_only_catalog_authorized_tool_calls() {
    let mut session = AcpxProviderSession::start(&config("turns-tool")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &events[0],
        AcpxProviderStateEvent::ToolCall { operation_id, .. }
            if operation_id == "issues.read"
    ));
    assert_eq!(
        session.state().pending_tool("call-1").unwrap().operation_id,
        "issues.read"
    );
    session.shutdown("test complete").unwrap();
}

fn late_result(call_id: &str) -> ToolResult {
    ToolResult {
        call_id: call_id.to_owned(),
        operation_id: "issues.read".to_owned(),
        result: json!({"id":"issue-1"}),
        is_error: false,
    }
}

#[test]
fn retains_pending_tools_until_authoritative_late_results_and_deduplicates_retries() {
    let mut session = AcpxProviderSession::start(&config("turns-tool-terminal")).unwrap();
    for (turn_id, call_id) in [("turn-1", "call-1"), ("turn-2", "call-2")] {
        session
            .start_turn(turn_id, "Please help", &std::env::temp_dir())
            .unwrap();
        let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(
            matches!(&tool[0], AcpxProviderStateEvent::ToolCall { call_id: actual, .. } if actual == call_id)
        );
        let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert_eq!(terminal.len(), 1, "must not invent a cancellation result");
        assert!(
            matches!(&terminal[0], AcpxProviderStateEvent::TurnTerminal { turn_id: actual, .. } if actual == turn_id)
        );
        assert!(session.state().pending_tool(call_id).is_some());
        assert!(session
            .start_turn("blocked-turn", "Wait for settlement", &std::env::temp_dir())
            .is_err());
        session.deliver_tool_result(&late_result(call_id)).unwrap();
        session
            .deliver_tool_result(&late_result(call_id))
            .expect("lost acknowledgement is harmless");
        let mut conflict = late_result(call_id);
        conflict.result = json!({"id":"different"});
        let error = session
            .deliver_tool_result(&conflict)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(call_id) && error.contains("issues.read"),
            "{error}"
        );
        assert!(session.state().pending_tool(call_id).is_none());
    }
    session.shutdown("test complete").unwrap();
}

#[test]
fn rotates_settled_tool_receipts_between_reusable_turns() {
    let mut session = AcpxProviderSession::start(&config("turns-reused-tool-id-terminal")).unwrap();

    for turn_id in ["turn-1", "turn-2"] {
        session
            .start_turn(turn_id, "Please continue", &std::env::temp_dir())
            .unwrap();
        let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            &tool[0],
            AcpxProviderStateEvent::ToolCall { call_id, operation_id, .. }
                if call_id == "call-reused" && operation_id == "issues.read"
        ));
        let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert_eq!(terminal.len(), 1);
        session
            .deliver_tool_result(&late_result("call-reused"))
            .unwrap();
        assert!(matches!(
            terminal.last().unwrap(),
            AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. }
                if settled == turn_id
        ));
    }
    session.shutdown("test complete").unwrap();

    let mut reserved_session =
        AcpxProviderSession::start(&config("turns-reserved-result-terminal")).unwrap();
    for turn_id in ["turn-1", "turn-2"] {
        reserved_session
            .start_turn(turn_id, "Please continue", &std::env::temp_dir())
            .unwrap();
        assert!(matches!(
            &reserved_session.poll_event(Duration::from_secs(1)).unwrap().unwrap()[0],
            AcpxProviderStateEvent::ToolCall { operation_id, .. }
                if operation_id == "paperclip_finish"
        ));
        let result = reserved_session
            .poll_event(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert!(matches!(
            &result[0],
            AcpxProviderStateEvent::SemanticResult(result)
                if result.call_id == "call-finish"
                    && result.operation_id == "paperclip_finish"
        ));
        let terminal = reserved_session
            .poll_event(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert!(matches!(
            terminal.last().unwrap(),
            AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. }
                if settled == turn_id
        ));
    }
    reserved_session.shutdown("test complete").unwrap();
}

#[test]
fn reaps_the_old_provider_before_admitting_a_late_tool_callback() {
    let mut session = AcpxProviderSession::start(&config("turns-late-tool-after-suspend")).unwrap();
    session
        .start_turn("turn-1", "Please continue", &std::env::temp_dir())
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session
        .deliver_tool_result(&late_result("call-reused"))
        .unwrap();

    session
        .start_turn("turn-2", "Use a fresh provider", &std::env::temp_dir())
        .unwrap();
    let fresh = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &fresh[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, input }
            if call_id == "call-reused"
                && operation_id == "issues.read"
                && input["id"] == "issue-1"
    ));
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-2"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn fails_closed_before_reusing_a_settled_turn_identity() {
    let mut session = AcpxProviderSession::start(&config("turns-reused-tool-id-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please continue", &std::env::temp_dir())
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session
        .deliver_tool_result(&late_result("call-reused"))
        .unwrap();

    let reused = session
        .start_turn("turn-1", "Do not alias old events", &std::env::temp_dir())
        .unwrap_err();
    assert!(
        reused.to_string().contains("reused a settled turn"),
        "{reused}"
    );
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn completed_tool_results_are_not_cancelled_when_the_turn_terminates() {
    let mut session = AcpxProviderSession::start(&config("turns-tool-result-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(tool[0], AcpxProviderStateEvent::ToolCall { .. }));

    let result = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &result[0],
        AcpxProviderStateEvent::SemanticResult(result)
            if result.call_id == "call-1" && result.operation_id == "issues.read" && result.ok
    ));
    assert!(session.state().pending_tool("call-1").is_none());

    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert_eq!(terminal.len(), 1);
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn completes_multiple_distinct_dynamic_tool_results_in_one_turn() {
    let mut session =
        AcpxProviderSession::start(&config("turns-multiple-tool-results-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    for index in 1..=2 {
        let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            &tool[0],
            AcpxProviderStateEvent::ToolCall { call_id, .. }
                if call_id == &format!("call-{index}")
        ));
    }
    for index in 1..=2 {
        let result = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            &result[0],
            AcpxProviderStateEvent::SemanticResult(result)
                if result.call_id == format!("call-{index}")
                    && result.result["id"] == format!("issue-{index}")
        ));
        assert!(session
            .state()
            .pending_tool(&format!("call-{index}"))
            .is_none());
    }

    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert_eq!(terminal.len(), 1);
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn failed_semantic_results_preserve_error_status_and_release_pending_capacity() {
    let mut session =
        AcpxProviderSession::start(&config("turns-tool-error-result-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(tool[0], AcpxProviderStateEvent::ToolCall { .. }));

    let result = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &result[0],
        AcpxProviderStateEvent::SemanticResult(result)
            if result.call_id == "call-1"
                && !result.ok
                && result.result["error"]["code"] == "tool_failed"
    ));
    assert!(session.state().pending_tool("call-1").is_none());

    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn reserved_terminal_results_require_an_authorized_correlated_invocation() {
    for (mode, operation_id, disposition) in [
        ("turns-reserved-result-terminal", "paperclip_finish", "done"),
        (
            "turns-reserved-yielded-terminal",
            "paperclip_finish",
            "yielded",
        ),
        (
            "turns-reserved-block-terminal",
            "paperclip_block",
            "blocked",
        ),
    ] {
        let mut session = AcpxProviderSession::start(&config(mode)).unwrap();
        session
            .start_turn("turn-1", "Please help", &std::env::temp_dir())
            .unwrap();

        let invocation = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            &invocation[0],
            AcpxProviderStateEvent::ToolCall { operation_id, .. }
                if operation_id == "paperclip_finish" || operation_id == "paperclip_block"
        ));
        assert_eq!(
            session
                .state()
                .pending_tool("call-finish")
                .unwrap()
                .operation_id,
            operation_id
        );

        let result = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            &result[0],
            AcpxProviderStateEvent::SemanticResult(result)
                if result.call_id == "call-finish"
                    && result.operation_id == operation_id
                    && result.ok
                    && result.result["reportedWorkDisposition"] == disposition
        ));
        assert!(session.state().pending_tool("call-finish").is_none());

        let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(matches!(
            terminal.last().unwrap(),
            AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
        ));
        session.shutdown("test complete").unwrap();
    }
}

#[test]
fn reserved_completion_waits_for_feedback_and_allows_correction_in_same_turn() {
    let mut session =
        AcpxProviderSession::start(&config("turns-reserved-feedback-roundtrip")).unwrap();
    session
        .start_turn("turn-1", "Please complete", &std::env::temp_dir())
        .unwrap();

    let first = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &first[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, input }
            if call_id == "call-finish" && operation_id == "paperclip_finish"
                && input["reportedWorkDisposition"] == "needs_review"
    ));
    session
        .deliver_tool_result(&paperclip_runner_core::provider_bridge::ToolResult {
            call_id: "call-finish".to_owned(),
            operation_id: "paperclip_finish".to_owned(),
            result: json!({
                "success":false,
                "contentItems":[
                    {"type":"inputText","text":"Name the reviewer and decision."}
                ]
            }),
            is_error: true,
        })
        .unwrap();

    let corrected = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &corrected[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, input }
            if call_id == "call-finish-2" && operation_id == "paperclip_finish"
                && input["reportedWorkDisposition"] == "done"
    ));
    session
        .deliver_tool_result(&paperclip_runner_core::provider_bridge::ToolResult {
            call_id: "call-finish-2".to_owned(),
            operation_id: "paperclip_finish".to_owned(),
            result: json!({
                "schema":"paperclip.run_result.v1",
                "reportedWorkDisposition":"done",
                "summary":"Corrected completion.",
                "completionClaim":{"contractRevision":"acpx-provider-turns-v1","objectiveSatisfied":true,"criteria":[],"remainingWork":[]},
                "evidence":[],"verification":[],"attentionRequests":[],"artifacts":[],
            }),
            is_error: false,
        })
        .unwrap();
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    session.shutdown("feedback roundtrip complete").unwrap();
}

#[test]
fn preserves_sensitive_reserved_input_and_still_checks_result_correlation() {
    for mode in [
        "turns-sensitive-reserved-result-terminal",
        "turns-mismatched-sensitive-reserved-result-terminal",
    ] {
        let mut session = AcpxProviderSession::start(&config(mode)).unwrap();
        session
            .start_turn("turn-1", "Please help", &std::env::temp_dir())
            .unwrap();
        let calls = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(
            matches!(&calls[0], AcpxProviderStateEvent::ToolCall {input, ..}
            if input["summary"].as_str().is_some_and(|summary| summary.contains("matching-sensitive-value")))
        );
        assert!(session.state().pending_tool("call-finish").is_some());
        if mode == "turns-mismatched-sensitive-reserved-result-terminal" {
            let error = session
                .poll_event(Duration::from_secs(1))
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("does not match its authorized invocation"),
                "{error}"
            );
            assert!(!error.contains("matching-sensitive-value"));
            assert!(!error.contains("different-sensitive-value"));
        }
        session.shutdown("correlation checked").unwrap();
    }
}

#[test]
fn fails_closed_before_returning_an_uncorrelated_reserved_result() {
    let mut session =
        AcpxProviderSession::start(&config("turns-uncorrelated-reserved-result-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("no authorized pending invocation"),
        "{error}"
    );
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_before_returning_a_mismatched_reserved_result() {
    let mut session =
        AcpxProviderSession::start(&config("turns-mismatched-reserved-result-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    assert!(matches!(
        &session.poll_event(Duration::from_secs(1)).unwrap().unwrap()[0],
        AcpxProviderStateEvent::ToolCall { operation_id, .. }
            if operation_id == "paperclip_finish"
    ));

    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("does not match its authorized invocation"),
        "{error}"
    );
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_before_returning_a_malformed_reserved_result() {
    let mut session =
        AcpxProviderSession::start(&config("turns-invalid-reserved-block-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("failed the Paperclip result schema"),
        "{error}"
    );
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fails_closed_before_returning_an_unauthorized_tool_call() {
    let mut session = AcpxProviderSession::start(&config("turns-unauthorized-tool")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("unauthorized tool issues.delete"), "{error}");
    assert!(session.state().pending_tool("call-1").is_none());
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn turn_controls_preserve_mode_and_reject_stale_duplicate_and_oversized_delivery() {
    let mut session = AcpxProviderSession::start(&config("controls")).unwrap();
    assert!(session
        .steer_turn("turn-1", "control-1", "steer", "message")
        .is_err());
    session
        .start_turn("turn-1", "Work", &std::env::temp_dir())
        .unwrap();
    let first = session
        .steer_turn("turn-1", "control-1", "steer", "Change focus")
        .unwrap();
    assert_eq!(first["mode"], "steer");
    assert!(session
        .steer_turn("turn-1", "control-1", "follow_up", "Duplicate")
        .unwrap_err()
        .to_string()
        .contains("already attempted"));
    let queued = session
        .steer_turn("turn-1", "control-2", "follow_up", "Then validate")
        .unwrap();
    assert_eq!(queued["mode"], "follow_up");
    assert!(session
        .steer_turn("turn-2", "control-3", "steer", "Stale")
        .is_err());
    assert!(session
        .steer_turn("turn-1", "control-3", "cancel", "Wrong")
        .is_err());
    assert!(session
        .steer_turn("turn-1", "control-3", "steer", &"a".repeat(65_537))
        .is_err());
    session.shutdown("verified controls").unwrap();
}

#[test]
fn turn_controls_fail_closed_on_mismatched_acknowledgement() {
    let mut session = AcpxProviderSession::start(&config("controls-wrong-ack")).unwrap();
    session
        .start_turn("turn-1", "Work", &std::env::temp_dir())
        .unwrap();
    assert!(session
        .steer_turn("turn-1", "control-1", "steer", "Change focus")
        .unwrap_err()
        .to_string()
        .contains("exact turn control"));
    assert!(session
        .steer_turn("turn-1", "control-2", "follow_up", "Do not replay")
        .is_err());
}

#[test]
fn lazy_warm_handshake_updates_live_turn_control_discovery() {
    let mut session = AcpxProviderSession::start(&config("controls-lazy")).unwrap();
    assert!(!session.turn_control_capabilities().steering);
    assert!(!session.turn_control_capabilities().queued_follow_up);
    session
        .start_turn("turn-lazy", "Work", &std::env::temp_dir())
        .unwrap();
    assert!(session.turn_control_capabilities().steering);
    assert!(session.turn_control_capabilities().queued_follow_up);
    session
        .steer_turn("turn-lazy", "control-1", "follow_up", "Then validate")
        .unwrap();
    session.shutdown("verified live handshake").unwrap();
}

#[test]
fn forced_cancellation_retirement_preserves_terminal_polling_but_rejects_live_reuse() {
    for mode in ["turns-retired", "turns-retired-terminal-first"] {
        let mut session = AcpxProviderSession::start(&config(mode)).unwrap();
        session
            .start_turn("turn-1", "Please help", &std::env::temp_dir())
            .unwrap();
        session
            .interrupt_turn("turn-1", "Stop stuck provider")
            .unwrap();
        assert!(session.runtime_retired());
        let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        assert!(
            matches!(terminal.last().unwrap(), AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1")
        );
        assert!(session.state().active_turn_id().is_none());
        assert!(session
            .start_turn("turn-2", "Must not reuse", &std::env::temp_dir())
            .unwrap_err()
            .to_string()
            .contains("runtime was retired"));
        session.shutdown("test complete").unwrap();
    }
}

#[test]
fn lost_cancellation_reply_keeps_the_turn_terminal_and_the_transport() {
    // Restart-chaos PV2 interrupt_ack: the provider stops its prompt, but the
    // sidecar's reply to turn.cancel is lost or late. The terminal must still
    // settle the turn, and a late reply must not break the next request.
    for mode in ["lost", "late"] {
        let mut config = config("turns");
        config
            .transport
            .args
            .extend(["--cancel-reply".to_owned(), mode.to_owned()]);
        let mut session = AcpxProviderSession::start(&config).unwrap();
        session
            .start_turn("turn-1", "Please help", &std::env::temp_dir())
            .unwrap();
        let started = Instant::now();
        session
            .interrupt_turn("turn-1", "Paperclip interruption")
            .unwrap_or_else(|error| panic!("{mode}: {error}"));
        assert!(started.elapsed() < Duration::from_secs(3), "{mode}");
        assert!(session.runtime_retired(), "{mode}");
        // A repeated Stop while the first cancel is unanswered must not block.
        let repeated = Instant::now();
        session
            .interrupt_turn("turn-1", "Paperclip interruption again")
            .unwrap_or_else(|error| panic!("{mode} repeat: {error}"));
        assert!(repeated.elapsed() < Duration::from_millis(200), "{mode}");
        let mut terminal = None;
        while terminal.is_none() {
            let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
            terminal = events.into_iter().find(|event| {
                matches!(event, AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1")
            });
        }
        assert!(session.state().active_turn_id().is_none(), "{mode}");
        assert!(session
            .start_turn("turn-2", "Must not reuse", &std::env::temp_dir())
            .unwrap_err()
            .to_string()
            .contains("runtime was retired"));
        session
            .shutdown("test complete")
            .unwrap_or_else(|error| panic!("{mode}: {error}"));
    }
}

#[test]
fn a_tool_result_for_a_call_retired_by_our_cancellation_does_not_fail_the_transport() {
    // Restart-chaos S1 PV2: Stop lands while a semantic tool runs. The cancel
    // retires the call in the sidecar before its result arrives, and the turn
    // terminal is still buffered. The result must be kept, not fail the session.
    let mut config = config("turns-tool");
    config
        .transport
        .args
        .extend(["--cancel-reply".to_owned(), "lost".to_owned()]);
    let mut session = AcpxProviderSession::start(&config).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(
        matches!(&tool[0], AcpxProviderStateEvent::ToolCall { call_id, .. } if call_id == "call-1")
    );
    session
        .interrupt_turn("turn-1", "Cancelled by a board operator")
        .unwrap();
    session
        .deliver_tool_result(&late_result("call-1"))
        .expect("a call retired by our own cancellation keeps its result");
    assert!(session.state().pending_tool("call-1").is_none());
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(
        matches!(&terminal[0], AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1")
    );
    session.shutdown("test complete").unwrap();
}

fn reusable_config(directory: &std::path::Path) -> AcpxProviderSessionConfig {
    let mut config = config("source-reconcile");
    config.transport.args = vec![
        "--mode".to_owned(),
        "source-reconcile".to_owned(),
        "--journal".to_owned(),
        directory.join("journal.jsonl").display().to_string(),
        "--source-fault".to_owned(),
        directory.join("fault").display().to_string(),
    ];
    config.runtime_context = json!({
        "aggregateDigest": "run-1-aggregate",
        "skills": [{"key": "skill-1", "bundle": {"rootPath": "/skills/one"}}],
        "mcp": {"bindingId": "binding-run-1"},
    });
    config
}

fn settle_turn(session: &mut AcpxProviderSession, turn_id: &str) -> Vec<AcpxProviderStateEvent> {
    session
        .start_turn(turn_id, "Please continue", &std::env::temp_dir())
        .unwrap();
    let mut seen = Vec::new();
    loop {
        let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        let settled = events.iter().any(|event| {
            matches!(event, AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. } if settled == turn_id)
        });
        seen.extend(events);
        if settled {
            return seen;
        }
    }
}

fn process_starts(directory: &std::path::Path) -> usize {
    std::fs::read_to_string(directory.join("journal.jsonl"))
        .unwrap()
        .lines()
        .filter(|line| line.contains("processStart"))
        .count()
}

#[test]
fn prepared_generation_rebinds_only_an_identical_unused_configuration() {
    let directory = std::env::temp_dir().join(format!("acpx-generation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let config = reusable_config(&directory);
    let mut session = AcpxProviderSession::start(&config).unwrap();
    assert!(!session.can_prepare_next_generation());
    assert!(session
        .prepare_next_generation(Instant::now() + Duration::from_secs(20))
        .is_err());
    settle_turn(&mut session, "turn-1");
    let first_pid = session.process_id();
    session
        .prepare_next_generation(Instant::now() + Duration::from_secs(20))
        .unwrap();
    let prepared_pid = session.process_id();
    assert_ne!(prepared_pid, first_pid);
    assert!(session.awaits_run_rebind() && !session.generation_has_run_turn());
    let mut next = config.clone();
    next.run_id = "run-2".to_owned();
    next.expected_identity = Some(session.identity().clone());
    next.runtime_context["mcp"]["bindingId"] = json!("binding-run-2");
    next.runtime_context["aggregateDigest"] = json!("run-2-aggregate");
    let changes: [fn(&mut AcpxProviderSessionConfig); 7] = [
        |config| config.system_instructions.push_str(" Changed."),
        |config| config.tool_set.operations.clear(),
        |config| config.runtime_context["skills"][0]["bundle"]["rootPath"] = json!("/skills/two"),
        |config| config.runtime_context["mcp"]["bindingId"] = serde_json::Value::Null,
        |config| config.permission_mode = AcpxPermissionMode::DenyAll,
        |config| config.run_id = "run-1".to_owned(),
        |config| config.expected_identity = None,
    ];
    for change in changes {
        let mut changed = next.clone();
        change(&mut changed);
        assert!(!session.rebind_run(&changed).unwrap());
        assert_eq!(session.process_id(), prepared_pid);
        assert!(session.awaits_run_rebind());
    }
    assert!(session.rebind_run(&next).unwrap());
    assert_eq!(session.process_id(), prepared_pid);
    assert_eq!(session.state().run_id(), "run-2");
    assert!(!session.awaits_run_rebind());
    let attached_runs = std::fs::read_to_string(directory.join("journal.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|line| line["command"] == "run.attach")
        .map(|line| line["params"]["runId"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        attached_runs,
        [json!("run-1"), json!("run-1"), json!("run-2")]
    );
    settle_turn(&mut session, "turn-1");
    assert_eq!(session.process_id(), prepared_pid);
    assert!(session.generation_has_run_turn());
    let mut later = next.clone();
    later.run_id = "run-3".to_owned();
    assert!(
        !session.rebind_run(&later).unwrap(),
        "a used generation is never rebound"
    );
    session
        .prepare_next_generation(Instant::now() + Duration::from_secs(20))
        .unwrap();
    settle_turn(&mut session, "turn-2");
    assert!(
        !session.rebind_run(&later).unwrap(),
        "a prepared generation that ran a turn is never rebound"
    );
    assert_eq!(process_starts(&directory), 3);
    session.shutdown("test complete").unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn prepared_generation_never_admits_the_reaped_generation_late_callback() {
    let directory = std::env::temp_dir().join(format!("acpx-generation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let mut session = AcpxProviderSession::start(&reusable_config(&directory)).unwrap();
    settle_turn(&mut session, "turn-1");
    std::fs::write(directory.join("fault"), "late-tool-after-suspend").unwrap();
    session
        .prepare_next_generation(Instant::now() + Duration::from_secs(20))
        .unwrap();
    std::fs::write(directory.join("fault"), "").unwrap();
    let events = settle_turn(&mut session, "turn-2");
    assert!(!events
        .iter()
        .any(|event| matches!(event, AcpxProviderStateEvent::ToolCall { .. })));
    assert_eq!(
        process_starts(&directory),
        2,
        "the prepared turn does not restart again"
    );
    session.shutdown("test complete").unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn a_turn_end_restart_reaps_the_late_callback_and_releases_receipts_at_the_next_turn() {
    let mut session = AcpxProviderSession::start(&config("turns-late-tool-after-suspend")).unwrap();
    session
        .start_turn("turn-1", "Please continue", &std::env::temp_dir())
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(!session.can_restart_after_turn());
    session
        .deliver_tool_result(&late_result("call-reused"))
        .unwrap();
    let first_pid = session.process_id();
    session.restart_after_turn(None).unwrap();
    let fresh_pid = session.process_id();
    assert_ne!(fresh_pid, first_pid);
    assert_eq!(session.restarted_after_turn_from(), Some(first_pid));
    assert!(!session.generation_has_run_turn() && !session.can_restart_after_turn());
    assert!(session
        .poll_event(Duration::from_millis(200))
        .unwrap()
        .is_none());

    session
        .start_turn("turn-2", "Use the fresh provider", &std::env::temp_dir())
        .unwrap();
    assert_eq!(session.process_id(), fresh_pid);
    assert_eq!(session.restarted_after_turn_from(), None);
    let fresh = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &fresh[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, input }
            if call_id == "call-reused"
                && operation_id == "issues.read"
                && input["id"] == "issue-1"
    ));
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-2"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn an_interrupted_or_retired_turn_restarts_at_the_next_turn_start() {
    let mut session = AcpxProviderSession::start(&config("turns")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(!session.can_restart_after_turn());
    session
        .interrupt_turn("turn-1", "Paperclip interruption")
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    let interrupted_pid = session.process_id();
    assert!(!session.can_restart_after_turn());
    assert!(session.restart_after_turn(None).is_err());
    assert_eq!(session.process_id(), interrupted_pid);
    session
        .start_turn("turn-2", "Start again", &std::env::temp_dir())
        .unwrap();
    assert_ne!(session.process_id(), interrupted_pid);
    session.shutdown("test complete").unwrap();

    let mut retired = AcpxProviderSession::start(&config("turns-retired")).unwrap();
    retired
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    retired
        .interrupt_turn("turn-1", "Paperclip cancellation")
        .unwrap();
    retired.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(retired.state().active_turn_id().is_none());
    assert!(retired.runtime_retired());
    assert!(!retired.can_restart_after_turn());
    retired.shutdown("test complete").unwrap();
}
