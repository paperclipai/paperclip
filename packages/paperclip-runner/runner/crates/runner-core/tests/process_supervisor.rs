use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

use paperclip_runner_core::local_runner::HarnessCommand;
use paperclip_runner_core::process_supervisor::SupervisedProcess;
use serde_json::{json, Value};

fn process_exists(pid: u64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn process_group_cleanup_stops_harness_and_worker() {
    let harness = PathBuf::from(env!("CARGO_BIN_EXE_fake-harness"));
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/local-runner/scripts/linger.json");
    let mut process = SupervisedProcess::spawn(
        &harness,
        &[
            "--script".to_owned(),
            script.display().to_string(),
            "--delay-ms".to_owned(),
            "1".to_owned(),
        ],
        Duration::from_millis(50),
        64 * 1024,
    )
    .expect("fake harness should start");
    let harness_pid = process.id();
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("ready line should be readable")
        .expect("ready line should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "open".to_owned(),
            command_type: "session.open".to_owned(),
            payload: json!({}),
        })
        .expect("session.open should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("session line should be readable")
        .expect("session line should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "turn".to_owned(),
            command_type: "turn.start".to_owned(),
            payload: json!({ "turnId": "turn_cleanup" }),
        })
        .expect("turn.start should send");

    let mut worker_pid = None;
    for _ in 0..5 {
        let line = process
            .receive_stdout_line(Duration::from_secs(1))
            .expect("harness output should be readable")
            .expect("harness output should continue");
        let message: Value = serde_json::from_str(&line).expect("harness output should be JSON");
        if message["type"] == "diagnostic" {
            worker_pid = message["payload"]["workerPid"].as_u64();
            break;
        }
    }
    let worker_pid = worker_pid.expect("linger script should report its worker pid");
    assert!(process_exists(u64::from(harness_pid)));
    assert!(process_exists(worker_pid));

    process
        .terminate_group()
        .expect("process group cleanup should finish");
    std::thread::sleep(Duration::from_millis(20));
    assert!(!process_exists(u64::from(harness_pid)));
    assert!(!process_exists(worker_pid));
}

#[test]
fn oversized_harness_stdout_frame_is_rejected() {
    let harness = PathBuf::from(env!("CARGO_BIN_EXE_fake-harness"));
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/local-runner/scripts/oversized-line.json");
    let mut process = SupervisedProcess::spawn(
        &harness,
        &[
            "--script".to_owned(),
            script.display().to_string(),
            "--delay-ms".to_owned(),
            "1".to_owned(),
        ],
        Duration::from_millis(50),
        512,
    )
    .expect("fake harness should start");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("ready frame should fit")
        .expect("ready frame should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "open".to_owned(),
            command_type: "session.open".to_owned(),
            payload: json!({}),
        })
        .expect("session.open should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("session frame should fit")
        .expect("session frame should exist");
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "turn".to_owned(),
            command_type: "turn.start".to_owned(),
            payload: json!({ "turnId": "turn_oversized" }),
        })
        .expect("turn.start should send");
    process
        .receive_stdout_line(Duration::from_secs(1))
        .expect("turn frame should fit")
        .expect("turn frame should exist");

    let mut oversized_error = None;
    for _ in 0..3 {
        match process.receive_stdout_line(Duration::from_secs(1)) {
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(error) => {
                oversized_error = Some(error);
                break;
            }
        }
    }
    let error = oversized_error.expect("oversized harness frame must be rejected");
    assert!(error.to_string().contains("exceeded 512 bytes"));

    process
        .terminate_group()
        .expect("oversized-frame harness should be cleaned up");
}
