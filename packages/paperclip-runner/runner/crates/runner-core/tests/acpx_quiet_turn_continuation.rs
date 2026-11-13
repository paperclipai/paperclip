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
