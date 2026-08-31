use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet,
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
        transport: AcpxSidecarTransportConfig {
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
            args: vec!["--mode".to_owned(), mode.to_owned()],
            request_timeout: Duration::from_secs(1),
            shutdown_grace: Duration::from_millis(100),
        },
        agent: "codex".to_owned(),
        model: "gpt-5.6-sol".to_owned(),
        run_id: "run-1".to_owned(),
        catalog_revision: 1,
        runtime_directory: std::env::temp_dir(),
        normalized_session_id: "session-1".to_owned(),
        working_directory: std::env::temp_dir(),
        permission_mode: AcpxPermissionMode::ApproveReads,
        permission_mode_pinned: true,
        system_instructions: "Complete the supplied task.".to_owned(),
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

#[test]
fn returns_pending_tool_cancellations_before_the_terminal_event() {
    let mut session = AcpxProviderSession::start(&config("turns-tool-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(tool[0], AcpxProviderStateEvent::ToolCall { .. }));

    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &terminal[0],
        AcpxProviderStateEvent::ToolResult(result)
            if result.call_id == "call-1"
                && result.operation_id == "issues.read"
                && result.is_error
                && result.result["error"]["code"] == "acpx_turn_settled"
    ));
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));

    assert!(session.state().pending_tool("call-1").is_none());
    session
        .start_turn("turn-2", "Please continue", &std::env::temp_dir())
        .expect("terminal settlement must leave the session reusable");
    let next_tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &next_tool[0],
        AcpxProviderStateEvent::ToolCall { call_id, operation_id, .. }
            if call_id == "call-2" && operation_id == "issues.read"
    ));
    let next_terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        next_terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-2"
    ));
    assert!(session.state().pending_tool("call-2").is_none());
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
        assert!(matches!(
            &terminal[0],
            AcpxProviderStateEvent::ToolResult(result)
                if result.call_id == "call-reused"
                    && result.result["error"]["code"] == "acpx_turn_settled"
        ));
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
        assert!(reserved_session
            .poll_event(Duration::from_secs(1))
            .unwrap()
            .unwrap()
            .is_empty());
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
        assert!(invocation.is_empty());
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
fn correlates_reserved_results_by_raw_digest_without_exposing_sensitive_values() {
    let mut session =
        AcpxProviderSession::start(&config("turns-sensitive-reserved-result-terminal")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    assert!(session
        .poll_event(Duration::from_secs(1))
        .unwrap()
        .unwrap()
        .is_empty());
    let result_events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &result_events[0],
        AcpxProviderStateEvent::SemanticResult(result)
            if result.result["summary"]
                .as_str()
                .is_some_and(|summary| summary.contains("REDACTED")
                    && !summary.contains("matching-sensitive-value"))
    ));

    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id, .. } if turn_id == "turn-1"
    ));
    session.shutdown("test complete").unwrap();
}

#[test]
fn rejects_sensitive_reserved_results_that_only_match_after_redaction() {
    let mut session = AcpxProviderSession::start(&config(
        "turns-mismatched-sensitive-reserved-result-terminal",
    ))
    .unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    assert!(session
        .poll_event(Duration::from_secs(1))
        .unwrap()
        .unwrap()
        .is_empty());

    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("does not match its authorized invocation"),
        "{error}"
    );
    assert!(!error.contains("matching-sensitive-value"), "{error}");
    assert!(!error.contains("different-sensitive-value"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
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
    assert!(session
        .poll_event(Duration::from_secs(1))
        .unwrap()
        .unwrap()
        .is_empty());

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
