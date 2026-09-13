#![cfg(unix)]

use std::fs::{self, File};
#[cfg(target_os = "macos")]
use std::io::Read;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;

use paperclip_runner_core::local_runner::HarnessCommand;
use paperclip_runner_core::process_supervisor::{
    SupervisedProcess, VerifiedProcessArgument, VerifiedProcessArtifact, VerifiedProcessLaunch,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn process_exists(pid: u64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn write_executable(path: &Path, contents: &str) {
    let mut file = File::create(path).unwrap();
    file.write_all(contents.as_bytes()).unwrap();
    file.sync_all().unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn sha256(contents: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(contents.as_bytes()))
}

#[cfg(target_os = "macos")]
fn sha256_file(path: &Path) -> String {
    let mut file = File::open(path).unwrap();
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    format!("sha256:{:x}", digest.finalize())
}

#[test]
fn verified_launch_uses_open_command_and_script_after_atomic_path_replacement() {
    let directory = std::env::temp_dir().join(format!(
        "paperclip-verified-launch-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&directory).unwrap();
    let command = directory.join("command");
    let script = directory.join("script");
    let original_command = "#!/bin/sh\nprintf '%s\\n' old-command\nprintf '%s\\n' \"$PAPERCLIP_VERIFIED_RUNTIME_EXECUTABLE\"\nexec /bin/sh \"$1\"\n";
    let original_script = "#!/bin/sh\nprintf '%s\\n' old-script\n";
    write_executable(&command, original_command);
    write_executable(&script, original_script);

    let launch = VerifiedProcessLaunch::new(
        VerifiedProcessArtifact::snapshot_verified(
            command.clone(),
            File::open(&command).unwrap(),
            &sha256(original_command),
        )
        .unwrap(),
        vec![VerifiedProcessArgument::Artifact(
            VerifiedProcessArtifact::snapshot_verified(
                script.clone(),
                File::open(&script).unwrap(),
                &sha256(original_script),
            )
            .unwrap(),
        )],
    )
    .with_inherited_runtime_executable();

    let replacement_command = directory.join("replacement-command");
    let replacement_script = directory.join("replacement-script");
    write_executable(
        &replacement_command,
        "#!/bin/sh\nprintf '%s\\n' replacement-command\nexec /bin/sh \"$1\"\n",
    );
    write_executable(
        &replacement_script,
        "#!/bin/sh\nprintf '%s\\n' replacement-script\n",
    );
    fs::rename(replacement_command, &command).unwrap();
    fs::rename(replacement_script, &script).unwrap();

    let mut process = SupervisedProcess::spawn_verified_with_environment_keys(
        &launch,
        Duration::from_millis(50),
        1024,
        &[],
    )
    .unwrap();
    assert_eq!(
        process
            .receive_stdout_line(Duration::from_secs(1))
            .unwrap()
            .as_deref(),
        Some("old-command")
    );
    let inherited_runtime = process
        .receive_stdout_line(Duration::from_secs(1))
        .unwrap()
        .expect("verified launch should identify its inherited runtime");
    #[cfg(target_os = "linux")]
    assert!(inherited_runtime.starts_with("/proc/self/fd/"));
    #[cfg(target_os = "macos")]
    {
        assert!(inherited_runtime.contains(".paperclip-verified-executable-"));
        assert_eq!(
            Path::new(&inherited_runtime).parent(),
            command.parent(),
            "macOS verified launches must preserve loader-relative runtime layout"
        );
    }
    assert_eq!(
        process
            .receive_stdout_line(Duration::from_secs(1))
            .unwrap()
            .as_deref(),
        Some("old-script")
    );
    process.wait().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn verified_launch_preserves_homebrew_node_loader_layout() {
    let resolved = Command::new("/usr/bin/which")
        .arg("node")
        .output()
        .expect("node lookup should run");
    assert!(
        resolved.status.success(),
        "node should be available on PATH"
    );
    let node = fs::canonicalize(
        String::from_utf8(resolved.stdout)
            .expect("node path should be UTF-8")
            .trim(),
    )
    .expect("node path should resolve");
    let launch = VerifiedProcessLaunch::new(
        VerifiedProcessArtifact::snapshot_verified(
            node.clone(),
            File::open(&node).unwrap(),
            &sha256_file(&node),
        )
        .unwrap(),
        vec![
            VerifiedProcessArgument::Literal("--eval".to_owned()),
            VerifiedProcessArgument::Literal("console.log(process.execPath)".to_owned()),
        ],
    );

    let mut process = SupervisedProcess::spawn_verified_with_environment_keys(
        &launch,
        Duration::from_millis(50),
        1024,
        &[],
    )
    .expect("verified Node should start with its loader-relative libraries");
    let executed_node = process
        .receive_stdout_line(Duration::from_secs(2))
        .unwrap()
        .expect("Node should report its executable path");
    assert_eq!(
        Path::new(&executed_node).parent(),
        node.parent(),
        "verified Node must execute beside the authenticated runtime"
    );
    process.wait().unwrap();
}

fn spawn_linger_process() -> (SupervisedProcess, u32, u64) {
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
    (process, harness_pid, worker_pid)
}

#[test]
fn forced_process_group_cleanup_stops_harness_and_worker() {
    let (mut process, harness_pid, worker_pid) = spawn_linger_process();

    process
        .terminate_group()
        .expect("process group cleanup should finish");
    std::thread::sleep(Duration::from_millis(20));
    assert!(!process_exists(u64::from(harness_pid)));
    assert!(!process_exists(worker_pid));
}

#[test]
fn natural_harness_exit_also_cleans_up_workers() {
    let (mut process, harness_pid, worker_pid) = spawn_linger_process();
    process
        .send(&HarnessCommand {
            schema: "paperclip.fake_harness.command.v1".to_owned(),
            command_id: "interrupt".to_owned(),
            command_type: "turn.interrupt".to_owned(),
            payload: json!({ "reason": "cleanup_test" }),
        })
        .expect("turn.interrupt should send");
    process
        .wait()
        .expect("harness should exit after interruption");

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
