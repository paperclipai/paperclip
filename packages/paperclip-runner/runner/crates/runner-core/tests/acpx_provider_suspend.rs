use std::path::PathBuf;
use std::time::Duration;

use paperclip_runner_core::acpx_provider_session::{
    AcpxPermissionMode, AcpxProviderSession, AcpxProviderSessionConfig,
};
use paperclip_runner_core::acpx_sidecar_transport::AcpxSidecarTransportConfig;
use paperclip_runner_core::provider_bridge::{authorized_tool_catalog_digest, AuthorizedToolSet};

fn config(mode: &str) -> AcpxProviderSessionConfig {
    let operations = Vec::new();
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
        tool_set: AuthorizedToolSet {
            schema: "paperclip.runner.authorized-tools.v1".to_owned(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&operations).unwrap(),
            operations,
        },
        expected_identity: None,
    }
}

#[test]
fn suspends_only_after_the_exact_persistent_identity_is_confirmed() {
    let mut session = AcpxProviderSession::start(&config("suspend")).unwrap();
    let expected = session.identity().clone();

    assert_eq!(session.suspend("worker restart").unwrap(), expected);
    assert!(session.shutdown("already suspended").is_ok());
}

#[test]
fn rejects_suspension_during_an_active_turn_without_closing_the_session() {
    let mut session = AcpxProviderSession::start(&config("suspend")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    let error = session.suspend("too early").unwrap_err().to_string();
    assert!(error.contains("safe suspension point"), "{error}");
    assert_eq!(session.state().active_turn_id(), Some("turn-1"));
    session.shutdown("test complete").unwrap();
}

#[test]
fn reaps_an_active_provider_generation_at_the_suspension_boundary() {
    let mut session = AcpxProviderSession::start(&config("suspend")).unwrap();
    session
        .start_turn("turn-1", "Please help", &std::env::temp_dir())
        .unwrap();

    session
        .terminate_active_turn_for_suspension("turn-1")
        .unwrap();
    assert!(session.shutdown("already terminated").is_ok());
}

#[test]
fn fails_closed_when_the_suspension_acknowledgement_does_not_match() {
    for mode in ["suspend-wrong-ack", "suspend-wrong-identity"] {
        let mut session = AcpxProviderSession::start(&config(mode)).unwrap();
        let error = session.suspend("worker restart").unwrap_err().to_string();
        assert!(error.contains("exact suspended session"), "{mode}: {error}");
        assert!(session.shutdown("already closed").is_ok());
    }

    let mut session = AcpxProviderSession::start(&config("suspend-missing-identity")).unwrap();
    let error = session.suspend("worker restart").unwrap_err().to_string();
    assert!(error.contains("identity is invalid"), "{error}");
    assert!(session.shutdown("already closed").is_ok());
}
