use std::path::PathBuf;
use std::time::Duration;

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
        runtime_context: serde_json::Value::Null,
        tool_set: tool_set(),
        expected_identity: None,
    }
}

use paperclip_runner_core::indexed_store::IndexedStore;
use serde_json::Value;
use std::fs;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("paperclip-acpx-indexed-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("acpx-provider-receipts.sqlite")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn retains_exact_receipts_beyond_the_active_turn_limit_without_growing_current_state() {
    let directory = Directory::new();
    let mut config = config("indexed-many-tools");
    let expected_calls: usize = std::env::var("PAPERCLIP_ACPX_RECEIPT_QUALIFICATION")
        .map(|value| value.parse().expect("invalid qualification call count"))
        .unwrap_or(64);
    assert!(expected_calls >= 64);
    config
        .transport
        .args
        .extend(["--calls".to_owned(), expected_calls.to_string()]);
    let mut session =
        AcpxProviderSession::start_with_indexed_receipts(&config, &directory.path()).unwrap();
    let pid = session.process_id();
    session
        .start_turn(
            "turn-1",
            "Run many sequential calls",
            &config.working_directory,
        )
        .unwrap();
    let reader = IndexedStore::open(&directory.path(), "acpx/session-1", false).unwrap();
    let initial_current = reader
        .read_state("acpx-session")
        .unwrap()
        .unwrap()
        .bytes
        .len();
    let mut calls = 0;
    let mut peak = 0;
    while session.state().active_turn_id().is_some() {
        let events = session
            .poll_event(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        if !events.is_empty() {
            let batch = session.pending_event_batch().unwrap();
            assert_eq!(session.poll_event(Duration::ZERO).unwrap().unwrap(), events);
            assert_eq!(session.pending_event_batch().as_ref(), Some(&batch));
        }
        // This consumer's acceptance is deliberately explicit. The production
        // executor does this only after saving its normalized outbox.
        session.acknowledge_event_batch().unwrap();
        for event in events {
            if let AcpxProviderStateEvent::ToolCall {
                call_id,
                operation_id,
                input,
            } = event
            {
                assert_eq!(input["index"], calls);
                session
                    .deliver_tool_result(&ToolResult {
                        call_id,
                        operation_id,
                        result: json!({"index":calls}),
                        is_error: false,
                    })
                    .unwrap();
                calls += 1;
            }
        }
        peak = peak.max(
            reader
                .read_state("acpx-session")
                .unwrap()
                .unwrap()
                .bytes
                .len(),
        );
        assert_eq!(session.process_id(), pid);
    }
    assert_eq!(calls, expected_calls);
    println!("ACPX indexed receipts: calls={calls}, initial_current_bytes={initial_current}, peak_current_bytes={peak}");
    assert!(
        peak <= initial_current + 4096,
        "current checkpoint grew from {initial_current} to {peak} bytes"
    );
    let ancient = reader
        .receipt("acpx/run-1/turn-1/dynamic", "history-call-0")
        .unwrap()
        .unwrap();
    let ancient: Value = serde_json::from_slice(&ancient).unwrap();
    assert_eq!(ancient["receipt"]["result"]["result"], json!({"index":0}));
    assert!(reader
        .receipt("acpx-turns/run-1", "turn-1")
        .unwrap()
        .is_some());
    let mut recovered_config = config.clone();
    recovered_config.expected_identity = Some(session.identity().clone());
    session.shutdown("finished").unwrap();
    drop(session);
    let mut recovered =
        AcpxProviderSession::start_with_indexed_receipts(&recovered_config, &directory.path())
            .unwrap();
    assert!(recovered
        .start_turn(
            "turn-1",
            "Must reject ancient turn",
            &config.working_directory
        )
        .unwrap_err()
        .to_string()
        .contains("settled turn identity"));
    recovered.shutdown("finished").unwrap();
}

#[test]
fn rejects_unacknowledged_history_before_spawning_a_replacement() {
    let directory = Directory::new();
    let mut config = config("indexed-many-tools");
    let mut session =
        AcpxProviderSession::start_with_indexed_receipts(&config, &directory.path()).unwrap();
    session
        .start_turn("turn-1", "One pending call", &config.working_directory)
        .unwrap();
    let events = session
        .poll_event(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    assert!(!events.is_empty());
    config.expected_identity = Some(session.identity().clone());
    session.shutdown("simulated interrupted consumer").unwrap();
    drop(session);
    // A valid executable with an observable side effect proves that the
    // retained-state guard runs before process creation.
    let command = directory.0.join("must-not-spawn");
    fs::write(&command, "#!/bin/sh\n: > \"$0.spawned\"\nexit 72\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&command, fs::Permissions::from_mode(0o700)).unwrap();
    }
    config.transport.command = command;
    let error = match AcpxProviderSession::start_with_indexed_receipts(&config, &directory.path()) {
        Ok(_) => panic!("unacknowledged batch granted a replacement"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("requires reconciliation"));
    assert!(!directory.0.join("must-not-spawn.spawned").exists());
    let reader = IndexedStore::open(&directory.path(), "acpx/session-1", false).unwrap();
    let current = reader.read_state("acpx-session").unwrap().unwrap();
    let value: Value = serde_json::from_slice(&current.bytes).unwrap();
    assert!(!value["events"].as_array().unwrap().is_empty());
}

#[test]
fn an_unconfirmed_resolution_retains_its_exact_receipt_and_delivery_intent() {
    let directory = Directory::new();
    let config = config("resolutions-wrong-ack");
    let mut session =
        AcpxProviderSession::start_with_indexed_receipts(&config, &directory.path()).unwrap();
    session
        .start_turn("turn-1", "Resolve one call", &config.working_directory)
        .unwrap();
    session
        .poll_event(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    session.acknowledge_event_batch().unwrap();
    let result = ToolResult {
        call_id: "call-1".into(),
        operation_id: "issues.read".into(),
        result: json!({"id":"issue-1"}),
        is_error: false,
    };
    assert!(session.deliver_tool_result(&result).is_err());
    let reader = IndexedStore::open(&directory.path(), "acpx/session-1", false).unwrap();
    assert!(reader
        .receipt("acpx/run-1/turn-1/dynamic", "call-1")
        .unwrap()
        .is_some());
    let value: Value =
        serde_json::from_slice(&reader.read_state("acpx-session").unwrap().unwrap().bytes).unwrap();
    assert_eq!(value["delivery"], serde_json::to_value(&result).unwrap());
    session.shutdown("finished").unwrap();
}

#[test]
fn a_failed_receipt_commit_never_releases_the_tool_result_to_the_provider() {
    let directory = Directory::new();
    let mut config = config("indexed-many-tools");
    let marker = directory.0.join("resolution-received");
    config.transport.args.extend([
        "--resolution-marker".to_owned(),
        marker.to_string_lossy().into_owned(),
    ]);
    let mut session =
        AcpxProviderSession::start_with_indexed_receipts(&config, &directory.path()).unwrap();
    session
        .start_turn("turn-1", "One pending call", &config.working_directory)
        .unwrap();
    session
        .poll_event(Duration::from_secs(10))
        .unwrap()
        .unwrap();
    session.acknowledge_event_batch().unwrap();
    let database = rusqlite::Connection::open(directory.path()).unwrap();
    database.execute_batch("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON current_state BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END;").unwrap();
    let error = session
        .deliver_tool_result(&ToolResult {
            call_id: "history-call-0".into(),
            operation_id: "issues.read".into(),
            result: json!({"index":0}),
            is_error: false,
        })
        .unwrap_err();
    assert!(error.to_string().contains("fixture checkpoint failure"));
    assert!(
        !marker.exists(),
        "tool result escaped before its durable receipt"
    );
    assert!(session.state().pending_tool("history-call-0").is_some());
    session.shutdown("finished").unwrap();
}
