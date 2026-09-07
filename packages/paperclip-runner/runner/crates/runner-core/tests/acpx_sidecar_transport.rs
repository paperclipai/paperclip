use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::acpx_sidecar_transport::{
    AcpxSidecarTransport, AcpxSidecarTransportConfig,
};
use paperclip_runner_core::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GeneratedAcpxSidecarEventType,
};
use serde_json::json;

fn transport(mode: &str, timeout: Duration) -> AcpxSidecarTransport {
    AcpxSidecarTransport::start(&AcpxSidecarTransportConfig {
        command: PathBuf::from(env!("CARGO_BIN_EXE_fake-acpx-sidecar")),
        args: vec!["--mode".to_owned(), mode.to_owned()],
        verified_launch: None,
        request_timeout: timeout,
        shutdown_grace: Duration::from_millis(50),
    })
    .expect("fake ACPX sidecar should start")
}

#[test]
fn buffers_events_that_arrive_before_a_response() {
    let mut transport = transport("happy", Duration::from_secs(1));
    let result = transport
        .request(
            GeneratedAcpxSidecarCommand::Initialize,
            json!({ "agent": "codex", "model": "gpt-5.6-sol" }),
        )
        .expect("fake initialize should respond");
    assert_eq!(result["command"], "initialize");
    let event = transport
        .poll_event(Duration::ZERO)
        .expect("buffered event should parse")
        .expect("buffered event should exist");
    assert_eq!(event.sequence, 1);
    assert_eq!(
        event.event_type,
        GeneratedAcpxSidecarEventType::RuntimeDiagnostic
    );
    assert_eq!(event.run_id, None);
    transport.shutdown().expect("fake sidecar should stop");
}

#[test]
fn rejects_event_gaps_and_poisoned_transport_reuse() {
    let mut transport = transport("gap", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("event gap must fail");
    assert!(error.to_string().contains("has a gap"));
    let reuse = transport
        .request(GeneratedAcpxSidecarCommand::SessionRead, json!({}))
        .expect_err("poisoned transport must fail closed");
    assert!(reuse.to_string().contains("unavailable"));
}

#[test]
fn rejects_event_replay() {
    let mut transport = transport("replay", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("event replay must fail");
    assert!(error.to_string().contains("replayed"));
}

#[test]
fn rejects_response_identity_mismatch() {
    let mut transport = transport("wrong-id", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("wrong response id must fail");
    assert!(error.to_string().contains("response id mismatch"));
}

#[test]
fn a_poisoned_transport_discards_events_buffered_before_failure() {
    let mut transport = transport("event-wrong-id", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("wrong response id must fail after the event is buffered");
    assert!(error.to_string().contains("response id mismatch"));
    let poll_error = transport
        .poll_event(Duration::ZERO)
        .expect_err("a poisoned transport must not expose retained events");
    assert!(poll_error.to_string().contains("unavailable"));
}

#[test]
fn bounds_events_while_waiting_for_a_response() {
    let mut transport = transport("flood", Duration::from_secs(2));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("event flood must fail");
    assert!(error.to_string().contains("buffered event limit"));
}

#[test]
fn rejects_an_oversized_stdout_frame() {
    let mut transport = transport("oversized", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("oversized frame must fail");
    assert!(error.to_string().contains("exceeded 1048576 bytes"));
}

#[test]
fn times_out_and_terminates_a_silent_sidecar() {
    let mut transport = transport("silent", Duration::from_millis(30));
    let started = Instant::now();
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("silent sidecar must time out");
    assert!(error.to_string().contains("timed out"));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn an_empty_event_poll_does_not_poison_the_transport() {
    let mut transport = transport("silent", Duration::from_secs(1));
    assert_eq!(
        transport
            .poll_event(Duration::from_millis(20))
            .expect("an empty poll is not a protocol failure"),
        None
    );
    assert_eq!(
        transport
            .poll_event(Duration::from_millis(20))
            .expect("the transport remains available after an empty poll"),
        None
    );
    transport.shutdown().expect("fake sidecar should stop");
}

#[test]
fn rejects_an_unbounded_event_poll_without_poisoning_the_transport() {
    let mut transport = transport("silent", Duration::from_secs(1));
    let error = transport
        .poll_event(Duration::MAX)
        .expect_err("an unbounded event poll must be rejected");
    assert!(error.to_string().contains("must not exceed 120 s"));
    assert_eq!(
        transport
            .poll_event(Duration::ZERO)
            .expect("a caller timeout error must not poison the transport"),
        None
    );
    transport.shutdown().expect("fake sidecar should stop");
}

#[test]
fn keeps_valid_command_rejections_separate_from_protocol_failures() {
    let mut transport = transport("remote-error", Duration::from_secs(1));
    for command in [
        GeneratedAcpxSidecarCommand::Initialize,
        GeneratedAcpxSidecarCommand::SessionRead,
    ] {
        let error = transport
            .request(command, json!({}))
            .expect_err("fake command should be rejected");
        let message = error.to_string();
        assert!(message.contains("was rejected"));
        assert!(message.contains("classification=unclassified"));
        assert!(!message.contains("Q7Z9"));
        assert!(!message.contains("violet-circuit-4821"));
        assert!(!message.contains("unavailable"));
    }
    transport.shutdown().expect("fake sidecar should stop");
}

#[test]
fn redacts_sidecar_stderr_when_the_process_exits() {
    let mut transport = transport("exit-secret", Duration::from_secs(1));
    let error = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect_err("exited sidecar must fail");
    let message = error.to_string();
    assert!(message.contains("[REDACTED]"));
    assert!(!message.contains("amber-signal-7305"));
}
