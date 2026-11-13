#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::generated_acpx_sidecar_contract::read_generated_acpx_background_tasks;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ToolResult,
};
use serde_json::json;

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("acpx-quiet-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn background(&self, mode: &str) {
        std::fs::write(self.0.join("background-tasks"), mode).unwrap();
    }
}

fn config(scratch: &Path, mode: &str, agent: &str) -> AcpxProviderSessionConfig {
    let operations = vec![AuthorizedTool {
        operation_id: "issues.read".to_owned(),
        version: 1,
        description: "Read an issue.".to_owned(),
        input_schema: json!({"type":"object"}),
        response_schema: json!({"type":"object"}),
    }];
    AcpxProviderSessionConfig {
        candidate_admission: None,
        transport: AcpxSidecarTransportConfig {
            command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
            args: vec![
                "--mode".to_owned(),
                mode.to_owned(),
                "--background-tasks".to_owned(),
                scratch.join("background-tasks").display().to_string(),
            ],
            verified_launch: None,
            request_timeout: Duration::from_secs(1),
            shutdown_grace: Duration::from_millis(100),
        },
        agent: agent.to_owned(),
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
        pi_thinking_level: None,
        permission_mode_pinned: true,
        provider_policy: None,
        system_instructions: "Complete the supplied task.".to_owned(),
        runtime_context: serde_json::Value::Null,
        tool_set: AuthorizedToolSet {
            schema: "paperclip.runner.authorized-tools.v1".to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        },
        expected_identity: None,
    }
}

fn reused_result() -> ToolResult {
    ToolResult {
        call_id: "call-reused".to_owned(),
        operation_id: "issues.read".to_owned(),
        result: json!({"id":"issue-1"}),
        is_error: false,
    }
}

fn settle_reused_call(session: &mut AcpxProviderSession, turn_id: &str) {
    session
        .start_turn(turn_id, "Please continue", &std::env::temp_dir())
        .unwrap();
    let tool = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        &tool[0],
        AcpxProviderStateEvent::ToolCall { call_id, .. } if call_id == "call-reused"
    ));
    let terminal = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    assert!(matches!(
        terminal.last().unwrap(),
        AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. } if settled == turn_id
    ));
    session.deliver_tool_result(&reused_result()).unwrap();
}

#[test]
fn a_quiet_claude_turn_continues_in_process_and_refuses_a_replayed_settled_call() {
    let scratch = Scratch::new();
    scratch.background("quiet");
    let mut session = AcpxProviderSession::start(&config(
        &scratch.0,
        "turns-reused-tool-id-terminal",
        "claude",
    ))
    .unwrap();
    settle_reused_call(&mut session, "turn-1");
    let first_pid = session.process_id();
    assert!(session.can_continue_after_turn());
    assert!(session.continue_after_quiet_turn());
    assert!(session.continues_in_process());

    session
        .start_turn("turn-2", "Please continue", &std::env::temp_dir())
        .unwrap();
    assert_eq!(session.process_id(), first_pid);
    assert!(!session.turn_start_replaced_provider());
    assert!(!session.continues_in_process());
    let replay = session.poll_event(Duration::from_secs(1)).unwrap_err();
    assert!(
        replay
            .to_string()
            .contains("provider reused a completed tool call id"),
        "{replay}"
    );
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn live_unknown_or_malformed_background_state_restarts_like_today() {
    for (mode, agent) in [
        ("live", "claude"),
        ("", "claude"),
        ("malformed", "claude"),
        ("quiet snapshot-live", "claude"),
        ("quiet snapshot-unknown", "claude"),
        ("quiet snapshot-reject", "claude"),
        ("quiet", "codex"),
    ] {
        let scratch = Scratch::new();
        scratch.background(mode);
        let mut session =
            AcpxProviderSession::start(&config(&scratch.0, "turns-reused-tool-id-terminal", agent))
                .unwrap();
        settle_reused_call(&mut session, "turn-1");
        let first_pid = session.process_id();
        let snapshot_only = mode.contains("snapshot-");
        assert_eq!(
            session.continue_after_quiet_turn(),
            snapshot_only,
            "{mode} {agent}"
        );
        settle_reused_call(&mut session, "turn-2");
        assert_ne!(session.process_id(), first_pid, "{mode} {agent}");
        assert!(session.turn_start_replaced_provider(), "{mode} {agent}");
        session.shutdown("test complete").unwrap();
    }
}

#[test]
fn an_interrupted_claude_turn_restarts_even_when_its_provider_reports_quiet() {
    let scratch = Scratch::new();
    scratch.background("quiet");
    let mut session = AcpxProviderSession::start(&config(&scratch.0, "turns", "claude")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    session
        .interrupt_turn("turn-1", "Paperclip interruption")
        .unwrap();
    session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    let interrupted_pid = session.process_id();
    assert!(!session.can_continue_after_turn());
    assert!(!session.continue_after_quiet_turn());
    session
        .start_turn("turn-2", "Start again", &std::env::temp_dir())
        .unwrap();
    assert_ne!(session.process_id(), interrupted_pid);
    session.shutdown("test complete").unwrap();
}

#[test]
fn a_full_settled_turn_ledger_still_rotates_through_a_restart() {
    let scratch = Scratch::new();
    scratch.background("quiet");
    let mut session =
        AcpxProviderSession::start(&config(&scratch.0, "turns-tool-result-terminal", "claude"))
            .unwrap();
    let first_pid = session.process_id();
    for index in 0..4_096 {
        let turn_id = format!("turn-{index}");
        session
            .start_turn(&turn_id, "Please continue", &std::env::temp_dir())
            .unwrap();
        loop {
            let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
            if events.iter().any(|event| {
                matches!(event, AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. } if settled == &turn_id)
            }) {
                break;
            }
        }
        assert!(session.continue_after_quiet_turn(), "{turn_id}");
    }
    assert_eq!(session.process_id(), first_pid);
    session
        .start_turn("turn-rotated", "Please continue", &std::env::temp_dir())
        .unwrap();
    assert_ne!(session.process_id(), first_pid);
    assert!(session.turn_start_replaced_provider());
    session.shutdown("test complete").unwrap();
}

fn provider_session(scratch: &Scratch, background: &str, agent: &str) -> AcpxProviderSession {
    provider_session_in(scratch, background, agent, "turns-tool-result-terminal")
}

fn provider_session_in(
    scratch: &Scratch,
    background: &str,
    agent: &str,
    mode: &str,
) -> AcpxProviderSession {
    scratch.background(background);
    AcpxProviderSession::start(&config(&scratch.0, mode, agent)).unwrap()
}

fn arm(session: &mut AcpxProviderSession) -> bool {
    session
        .take_provider_turn_offer()
        .is_some_and(|turn_id| session.arm_provider_turn(&turn_id))
}

fn poll_until_terminal(
    session: &mut AcpxProviderSession,
    turn_id: &str,
) -> Vec<AcpxProviderStateEvent> {
    let mut seen = Vec::new();
    loop {
        let events = session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
        let done = events.iter().any(|event| {
            matches!(event, AcpxProviderStateEvent::TurnTerminal { turn_id: settled, .. } if settled == turn_id)
        });
        seen.extend(events);
        if done {
            return seen;
        }
    }
}

#[test]
fn live_shell_tasks_at_a_completed_claude_terminal_await_and_admit_the_provider_started_turn() {
    let scratch = Scratch::new();
    let mut session = provider_session(&scratch, "live provider-turn", "claude");
    let pid = session.process_id();
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    assert!(!session.continue_after_quiet_turn());

    let started = session
        .poll_awaited_event(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert!(matches!(
        started.as_slice(),
        [AcpxProviderStateEvent::ProviderTurnStarted { turn_id }] if turn_id == "provider-1"
    ));
    assert_eq!(session.state().active_turn_id(), Some("provider-1"));
    let provider = poll_until_terminal(&mut session, "provider-1");
    assert!(provider.iter().any(|event| matches!(
        event,
        AcpxProviderStateEvent::Activity(activity) if activity.event_type == "usage.reported"
    )));
    assert_eq!(session.state().active_turn_id(), None);
    assert!(session.take_provider_turn_offer().is_none());
    assert_eq!(session.process_id(), pid);
    session.shutdown("test complete").unwrap();
}

#[test]
fn a_provider_started_turn_that_leaves_shells_running_awaits_again() {
    let scratch = Scratch::new();
    let mut session = provider_session(
        &scratch,
        "live provider-turn provider-terminal-live",
        "claude",
    );
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    session
        .poll_awaited_event(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    poll_until_terminal(&mut session, "provider-1");
    assert_eq!(
        session.take_provider_turn_offer().as_deref(),
        Some("provider-1")
    );
    session.shutdown("test complete").unwrap();
}

#[test]
fn an_unexpected_provider_started_turn_fails_closed_like_any_idle_event() {
    for (background, agent, expected) in [
        (
            "quiet provider-turn provider-turn-unarmed",
            "claude",
            "outside an awaited continuation",
        ),
        (
            "provider-turn provider-turn-unarmed",
            "claude",
            "outside an awaited continuation",
        ),
        (
            "live provider-turn provider-turn-unarmed",
            "codex",
            "outside an awaited continuation",
        ),
        (
            "live provider-turn provider-turn-id=turn-1",
            "claude",
            "reused a settled turn identity",
        ),
        (
            "live provider-turn provider-run=run-2",
            "claude",
            "bounded contract",
        ),
    ] {
        let scratch = Scratch::new();
        let mut session = provider_session(&scratch, background, agent);
        session
            .start_turn("turn-1", "Start background work", &std::env::temp_dir())
            .unwrap();
        poll_until_terminal(&mut session, "turn-1");
        let awaited = arm(&mut session);
        let error = if awaited {
            session.poll_awaited_event(Duration::from_secs(1))
        } else {
            session.poll_event(Duration::from_secs(1))
        }
        .unwrap_err();
        assert!(
            error.to_string().contains(expected),
            "{background} {agent}: {error}"
        );
        let _ = session.shutdown("test complete");
    }
}

#[test]
fn a_provider_started_turn_cannot_replay_a_settled_tool_call() {
    let scratch = Scratch::new();
    let mut session = provider_session(
        &scratch,
        "live provider-turn provider-reuse-call=call-1",
        "claude",
    );
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    session
        .poll_awaited_event(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    let error = session.poll_event(Duration::from_secs(1)).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("reused a completed tool call id"),
        "{error}"
    );
    let _ = session.shutdown("test complete");
}

#[test]
fn a_controller_turn_while_awaiting_restarts_the_provider_first() {
    let scratch = Scratch::new();
    let mut session = provider_session(&scratch, "live provider-turn", "claude");
    let pid = session.process_id();
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    session
        .start_turn("turn-2", "Paperclip's next turn", &std::env::temp_dir())
        .unwrap();
    assert_ne!(session.process_id(), pid);
    assert!(session.turn_start_replaced_provider());
    assert!(session.take_provider_turn_offer().is_none());
    session.shutdown("test complete").unwrap();
}

#[test]
fn the_generated_reader_matches_the_shared_background_task_vectors() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/provider-boundary/acpx-background-tasks.json");
    let vectors: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for vector in vectors["accepted"].as_array().unwrap() {
        assert_eq!(
            read_generated_acpx_background_tasks(&vector["value"]),
            vector["live"].as_u64(),
            "{vector}"
        );
    }
    for vector in vectors["rejected"].as_array().unwrap() {
        assert_eq!(
            read_generated_acpx_background_tasks(&vector["value"]),
            None,
            "{vector}"
        );
    }
}

#[test]
fn a_turn_that_reported_its_result_never_awaits_even_with_live_shells() {
    let scratch = Scratch::new();
    let mut session = provider_session_in(
        &scratch,
        "live provider-turn",
        "claude",
        "turns-reserved-result-terminal",
    );
    session
        .start_turn(
            "turn-1",
            "Finish with a shell still running",
            &std::env::temp_dir(),
        )
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(session.run_result_reported());
    assert!(session.take_provider_turn_offer().is_none());
    assert!(session
        .poll_event(Duration::from_millis(200))
        .unwrap()
        .is_none());
    session.shutdown("test complete").unwrap();
}

#[test]
fn a_provider_started_turn_that_reports_a_result_settles_and_does_not_await_again() {
    let scratch = Scratch::new();
    let mut session = provider_session(
        &scratch,
        "live provider-turn provider-result provider-terminal-live",
        "claude",
    );
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    session
        .poll_awaited_event(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    let events = poll_until_terminal(&mut session, "provider-1");
    assert!(events.iter().any(|event| matches!(
        event,
        AcpxProviderStateEvent::TurnTerminal { status, .. }
            if *status == paperclip_runner_core::acpx_event_payload::AcpxTurnStatus::Completed
    )));
    assert!(session.run_result_reported());
    assert!(session.take_provider_turn_offer().is_none());
    session.shutdown("test complete").unwrap();
}

#[test]
fn a_sidecar_that_cannot_arm_leaves_runnerd_not_awaiting() {
    let scratch = Scratch::new();
    let mut session =
        provider_session(&scratch, "live provider-turn provider-arm-reject", "claude");
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    let offer = session
        .take_provider_turn_offer()
        .expect("eligible terminal");
    assert!(!session.arm_provider_turn(&offer));
    session.shutdown("test complete").unwrap();
}

#[test]
fn cancelling_a_provider_started_turn_settles_it_cancelled_and_retires_the_provider() {
    let scratch = Scratch::new();
    let mut session = provider_session(&scratch, "live provider-turn provider-turn-open", "claude");
    session
        .start_turn("turn-1", "Start background work", &std::env::temp_dir())
        .unwrap();
    poll_until_terminal(&mut session, "turn-1");
    assert!(arm(&mut session));
    session
        .poll_awaited_event(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    assert_eq!(session.state().active_turn_id(), Some("provider-1"));
    let response = session
        .interrupt_turn("provider-1", "Operator stop")
        .unwrap();
    assert_eq!(response["sessionClosed"], json!(true));
    assert!(session.runtime_retired());
    let events = poll_until_terminal(&mut session, "provider-1");
    assert!(events.iter().any(|event| matches!(
        event,
        AcpxProviderStateEvent::TurnTerminal { status, .. }
            if *status == paperclip_runner_core::acpx_event_payload::AcpxTurnStatus::Cancelled
    )));
    assert!(session.take_provider_turn_offer().is_none());
    assert!(session
        .start_turn("turn-2", "Paperclip's next turn", &std::env::temp_dir())
        .is_err());
    let _ = session.shutdown("test complete");
}
