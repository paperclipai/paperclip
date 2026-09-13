use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_provider_state::AcpxProviderStateEvent;
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{
    authorized_tool_catalog_digest, AuthorizedTool, AuthorizedToolSet, ToolResult,
};
use paperclip_runner_core::provider_events::{
    project_acpx_state_event, AcpxEventProjectionContext,
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
            verified_launch: None,
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

fn started(mode: &str) -> AcpxProviderSession {
    let mut session = AcpxProviderSession::start(&config(mode)).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    for _ in 0..2 {
        session.poll_event(Duration::from_secs(1)).unwrap().unwrap();
    }
    session
}

fn tool_result(operation_id: &str) -> ToolResult {
    ToolResult {
        call_id: "call-1".to_owned(),
        operation_id: operation_id.to_owned(),
        result: json!({"id":"issue-1"}),
        is_error: false,
    }
}

fn input_resolution(option_id: &str) -> serde_json::Value {
    json!({
        "action":"submit",
        "response":{
            "schema":"paperclip.question_response.v1",
            "answers":{"target":{"selectedOptionIds":[option_id]}}
        }
    })
}

#[test]
fn commits_each_resolution_only_after_sidecar_acknowledgement() {
    let mut session = started("resolutions");
    session
        .deliver_tool_result(&tool_result("issues.read"))
        .unwrap();
    session
        .resolve_input("input-1", "turn-1", &input_resolution("first"))
        .unwrap();
    assert!(session.state().pending_tool("call-1").is_none());
    assert!(session.state().pending_question_set("input-1").is_none());
    assert!(session
        .deliver_tool_result(&tool_result("issues.read"))
        .is_err());
    session.shutdown("test complete").unwrap();
}

#[test]
fn projected_request_id_resolves_the_exact_upstream_sidecar_request() {
    let mut session = AcpxProviderSession::start(&config("resolutions-projected-id")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();
    let mut input = None;
    for _ in 0..2 {
        for event in session.poll_event(Duration::from_secs(1)).unwrap().unwrap() {
            if matches!(&event, AcpxProviderStateEvent::InputRequest { .. }) {
                input = Some(event);
            }
        }
    }
    let input = input.expect("observe the upstream input request");
    let projected = project_acpx_state_event(
        &AcpxEventProjectionContext {
            run_id: "run-1".to_owned(),
            normalized_session_id: "session-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            provider_turn_id: None,
            item_id: "item-1".to_owned(),
        },
        &input,
    )
    .unwrap();
    let request_id = projected[0].payload["request"]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(request_id.starts_with("acpx-request-"));

    session
        .deliver_tool_result(&tool_result("issues.read"))
        .unwrap();
    session
        .resolve_input(&request_id, "turn-1", &input_resolution("first"))
        .unwrap();
    assert!(session.state().pending_question_set(&request_id).is_none());
    session.shutdown("test complete").unwrap();
}

#[test]
fn local_validation_preserves_pending_requests_for_a_correct_retry() {
    let mut session = started("resolutions");
    assert!(session
        .deliver_tool_result(&tool_result("issues.write"))
        .unwrap_err()
        .to_string()
        .contains("operation mismatch"));
    assert!(session.state().pending_tool("call-1").is_some());
    let mut invalid_result = tool_result("issues.read");
    invalid_result.result = json!("not an object");
    assert!(session
        .deliver_tool_result(&invalid_result)
        .unwrap_err()
        .to_string()
        .contains("JSON Schema validation"));
    assert!(session.state().pending_tool("call-1").is_some());
    session
        .deliver_tool_result(&tool_result("issues.read"))
        .unwrap();

    assert!(session
        .resolve_input("input-1", "turn-1", &input_resolution("unknown"))
        .unwrap_err()
        .to_string()
        .contains("unknown option"));
    assert!(session.state().pending_question_set("input-1").is_some());
    session
        .resolve_input("input-1", "turn-1", &input_resolution("first"))
        .unwrap();

    session.shutdown("test complete").unwrap();
}

#[test]
fn redacts_failed_tool_payload_without_losing_correlation_or_retry() {
    let mut session = started("resolutions-error-redaction");
    let mut failed = ToolResult {
        call_id: "call-1".to_owned(),
        operation_id: "issues.write".to_owned(),
        result: json!({
            "diagnostic":"violet-internal-diagnostic-4821",
            "request":{"private":"value"},
        }),
        is_error: true,
    };

    assert!(session.deliver_tool_result(&failed).is_err());
    assert!(session.state().pending_tool("call-1").is_some());

    failed.operation_id = "issues.read".to_owned();
    session.deliver_tool_result(&failed).unwrap();
    assert!(session.state().pending_tool("call-1").is_none());
    assert!(session.deliver_tool_result(&failed).is_err());
    session.shutdown("test complete").unwrap();
}

#[test]
fn rejects_permission_requests_that_bypass_the_pinned_codex_policy() {
    let mut session = AcpxProviderSession::start(&config("turns-permission")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    let error = session
        .poll_event(Duration::from_secs(1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("pinned runner policy"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}

#[test]
fn fake_sidecar_rejects_the_unsupported_permission_resolution_command() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_fake-acpx-sidecar"))
        .args(["--mode", "happy"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            json!({
                "protocolVersion":"paperclip.runner.acpx-sidecar.v1",
                "id":1,
                "command":"permission.resolve",
                "params":{"requestId":"permission-1","resolution":"approved"}
            })
        )
        .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(
        response["error"]["code"],
        "permission_resolution_unsupported"
    );
}

#[test]
fn fails_closed_when_a_resolution_is_not_acknowledged() {
    let mut session = started("resolutions-wrong-ack");
    let error = session
        .deliver_tool_result(&tool_result("issues.read"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("did not confirm tool resolution"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}
