use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig, AcpxProviderSessionIdentity,
};
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

fn expected_identity() -> AcpxProviderSessionIdentity {
    AcpxProviderSessionIdentity {
        kind: "acpx".to_owned(),
        normalized_session_id: "session-1".to_owned(),
        acpx_record_id: "record-1".to_owned(),
        backend_session_id: "backend-1".to_owned(),
        agent_session_id: "agent-1".to_owned(),
        profile_digest: format!("sha256:{}", "1".repeat(64)),
        workspace_digest: format!("sha256:{}", "2".repeat(64)),
        requested_model: "gpt-5.6-sol".to_owned(),
        effective_model: "gpt-5.6-sol".to_owned(),
        permission_mode: Some(AcpxPermissionMode::ApproveReads),
        provider_lifetime_fence_candidates: [60_001, 60_002, 60_003],
    }
}

fn start_error(config: &AcpxProviderSessionConfig) -> String {
    match AcpxProviderSession::start(config) {
        Ok(mut session) => {
            let _ = session.shutdown("unexpected successful bootstrap");
            panic!("ACPX provider session unexpectedly started")
        }
        Err(error) => error.to_string(),
    }
}

#[test]
fn bootstraps_a_codex_session_and_confirms_run_identity() {
    let mut session = AcpxProviderSession::start(&config("bootstrap")).unwrap();
    assert!(session.process_id() > 0);
    assert_eq!(session.identity(), &expected_identity());
    assert_eq!(session.state().run_id(), "run-1");
    assert_eq!(session.state().active_turn_id(), None);
    assert_eq!(session.catalog_revision(), 1);
    session.shutdown("test complete").unwrap();
    session.shutdown("already closed").unwrap();
}

#[test]
fn validates_qualified_policy_and_tool_catalog_before_spawning() {
    let mut invalid_agent = config("bootstrap");
    invalid_agent.agent = "pi".to_owned();
    assert!(start_error(&invalid_agent).contains("claude or codex"));

    let mut unpinned = config("bootstrap");
    unpinned.permission_mode_pinned = false;
    assert!(start_error(&unpinned).contains("must be pinned"));

    let mut invalid_tools = config("bootstrap");
    invalid_tools.tool_set.catalog_digest = "invalid".to_owned();
    assert!(start_error(&invalid_tools).contains("authorized tools"));

    let mut invalid_lifetime_fence = config("bootstrap");
    let mut invalid_identity = expected_identity();
    invalid_identity.provider_lifetime_fence_candidates = [60_001, 60_001, 60_003];
    invalid_lifetime_fence.expected_identity = Some(invalid_identity);
    assert!(start_error(&invalid_lifetime_fence).contains("lifetime fence candidates"));
}

#[test]
fn admits_each_exact_qualified_agent_model_pair() {
    for (agent, model) in [("codex", "gpt-5.6-sol"), ("claude", "claude-sonnet-5")] {
        let mut qualified = config("bootstrap");
        qualified.agent = agent.to_owned();
        qualified.model = model.to_owned();
        qualified.validate().unwrap();
    }

    let mut drifted = config("bootstrap");
    drifted.agent = "claude".to_owned();
    assert!(drifted
        .validate()
        .unwrap_err()
        .to_string()
        .contains("exact model"));
}

#[test]
fn rejects_a_sidecar_that_reports_another_effective_model() {
    let error = start_error(&config("bootstrap-wrong-model"));
    assert!(error.contains("identity does not match"), "{error}");
}

#[test]
fn rejects_a_sidecar_that_does_not_confirm_the_run_attachment() {
    let error = start_error(&config("bootstrap-wrong-run"));
    assert!(error.contains("run attachment"), "{error}");
}

#[test]
fn validates_recovery_identity_against_the_requested_session() {
    let mut recovered = config("bootstrap");
    recovered.expected_identity = Some(expected_identity());
    let mut session = AcpxProviderSession::start(&recovered).unwrap();
    assert_eq!(
        session.identity(),
        recovered.expected_identity.as_ref().unwrap()
    );
    session.shutdown("test complete").unwrap();

    let mut mismatch = config("bootstrap");
    let mut expected = expected_identity();
    expected.normalized_session_id = "another-session".to_owned();
    mismatch.expected_identity = Some(expected);
    assert!(start_error(&mismatch).contains("conflicts with the requested session"));
}

#[cfg(unix)]
#[test]
fn rejects_non_utf8_directories_before_spawning() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let mut directory_name =
        format!("paperclip-acpx-non-utf8-{}-", std::process::id()).into_bytes();
    directory_name.push(0xff);
    let directory = std::env::temp_dir().join(OsString::from_vec(directory_name));

    let mut invalid = config("bootstrap");
    invalid.working_directory = directory;
    let error = start_error(&invalid);

    assert!(error.contains("must be valid UTF-8"), "{error}");
}
