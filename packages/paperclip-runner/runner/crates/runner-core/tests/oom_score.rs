#![cfg(target_os = "linux")]

use std::fs;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use paperclip_runner_core::oom_score::set_own_oom_score_adj;
use paperclip_runner_core::process_supervisor::SupervisedProcess;

fn listener_runner(directory: &Path, port: u16, flag: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"));
    command
        .env(
            "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET",
            "fixture-bootstrap-ticket",
        )
        .args(flag)
        .args(["--listen-address", "0.0.0.0", "--listen-port"])
        .arg(port.to_string())
        .args(["--listen-path", "/api/runner/v1/connect/run", "--state-dir"])
        .arg(directory)
        .args([
            "--runner-id",
            "runner",
            "--environment-lease-id",
            "lease",
            "--run-id",
            "run",
            "--session-id",
            "session",
            "--turn-id",
            "turn",
            "--item-id",
            "item",
            "--runner-version",
            "0.0.0",
            "--runner-digest",
            &format!("sha256:{}", "a".repeat(64)),
            "--max-runtime-ms",
            "10000",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

fn private_directory() -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!("runner-oom-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

#[test]
fn launch_flag_sets_the_runner_score() {
    let directory = private_directory();
    let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut runner = listener_runner(&directory, port, &["--oom-score-adj", "9"])
        .spawn()
        .unwrap();
    let path = format!("/proc/{}/oom_score_adj", runner.id());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut score = String::new();
    while Instant::now() < deadline {
        score = fs::read_to_string(&path).unwrap();
        if score.trim() == "9" {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = runner.kill();
    let _ = runner.wait();
    let _ = fs::remove_dir_all(&directory);
    assert_eq!(score.trim(), "9");
}

// Lowering is refused without privilege, and that must not stop the run.
#[test]
fn launch_flag_starts_without_the_privilege_to_apply_it() {
    let directory = private_directory();
    let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut runner = listener_runner(&directory, port, &["--oom-score-adj", "-1"])
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    thread::sleep(Duration::from_millis(500));
    let status = runner.try_wait().unwrap();
    let _ = runner.kill();
    let _ = runner.wait();
    let _ = fs::remove_dir_all(&directory);
    assert_eq!(status, None);
}

#[test]
fn launch_flag_rejects_an_invalid_score() {
    let directory = private_directory();
    for flag in [
        &["--oom-score-adj", "low"][..],
        &["--oom-score-adj", "1001"][..],
        &["--oom-score-adj"][..],
    ] {
        let output = listener_runner(&directory, 43127, flag).output().unwrap();
        assert!(!output.status.success());
    }
    let _ = fs::remove_dir_all(&directory);
}

// Runs under CAP_SYS_RESOURCE only: nothing else in this binary reads its score.
#[test]
fn supervised_processes_do_not_inherit_protection() {
    if set_own_oom_score_adj(-1).is_err() {
        eprintln!("skipped: lowering oom_score_adj requires CAP_SYS_RESOURCE");
        return;
    }
    let directory = private_directory();
    let result = directory.join("score");
    let mut process = SupervisedProcess::spawn(
        Path::new("/bin/sh"),
        &[
            "-c".to_owned(),
            format!(
                "read -r start; cat /proc/self/oom_score_adj > {}.tmp; mv {0}.tmp {0}; read -r finish",
                result.display()
            ),
        ],
        Duration::from_secs(2),
        1024,
    )
    .unwrap();
    // Read the score only after spawn returns, which is when Runner has reset it.
    process.send(&"start").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !result.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let score = fs::read_to_string(&result).unwrap();
    let _ = set_own_oom_score_adj(0);
    let _ = fs::remove_dir_all(&directory);
    assert_eq!(score.trim(), "0");
}
