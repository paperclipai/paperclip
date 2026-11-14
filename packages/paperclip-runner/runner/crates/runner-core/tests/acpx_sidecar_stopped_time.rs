//! Runs alone in its own test binary: it stops this whole test process.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use paperclip_runner_core::acpx_sidecar_transport::{
    AcpxSidecarTransport, AcpxSidecarTransportConfig,
};
use paperclip_runner_core::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
};
use serde_json::json;

/// Chaos w-20261111T011704-s9107/t05: the Runner and its ACPX sidecar were
/// stopped together (SIGSTOP, a host-sleep stand-in) past the sidecar request
/// bound. On thaw the bound had already passed, so the Runner failed the turn
/// start before the sidecar could answer. Here the sidecar stops this process
/// for 6 s against a 3 s bound and answers 0.5 s after the thaw: once early in
/// the wait, and once in its last half second. Both cases share one test so
/// no other test thread runs while this process is stopped.
#[test]
fn a_request_answered_after_this_process_was_stopped_past_its_bound_succeeds() {
    for stop_after in ["0", "2.5"] {
        answered_after_stop(stop_after);
    }
}

fn answered_after_stop(stop_after: &str) {
    let response = json!({
        "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
        "id": 1, "ok": true, "result": { "answered": true },
    });
    let runner = std::process::id();
    let script = format!(
        "IFS= read -r request; sleep {stop_after}; \
         (sleep 6; kill -CONT {runner}; sleep 0.5; printf '%s\\n' '{response}') & \
         kill -STOP {runner}; wait; IFS= read -r next"
    );
    let mut transport = AcpxSidecarTransport::start(&AcpxSidecarTransportConfig {
        command: PathBuf::from("/bin/sh"),
        args: vec!["-c".to_owned(), script],
        verified_launch: None,
        request_timeout: Duration::from_secs(3),
        shutdown_grace: Duration::from_millis(100),
    })
    .expect("sidecar should start");
    let started = Instant::now();
    let result = transport
        .request(GeneratedAcpxSidecarCommand::Initialize, json!({}))
        .expect("stopped time must not count against the request bound");
    assert_eq!(result["answered"], true);
    assert!(started.elapsed() >= Duration::from_secs(6));
    transport.shutdown().expect("sidecar should stop");
}
