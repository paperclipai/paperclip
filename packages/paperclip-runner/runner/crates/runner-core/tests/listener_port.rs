#![cfg(unix)]

use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct Runner {
    process: Child,
    directory: PathBuf,
}

impl Drop for Runner {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn launches_concurrent_runners_on_separate_ports() {
    let mut runners = Vec::new();
    'attempt: for _ in 0..10 {
        let index = runners.len();
        let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let directory =
            std::env::temp_dir().join(format!("runner-listener-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let run_id = format!("run_{index}");
        let process = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"))
            .env(
                "PAPERCLIP_RUNNER_BOOTSTRAP_TICKET",
                "fixture-bootstrap-ticket",
            )
            .args([
                "--listen-address",
                "0.0.0.0",
                "--listen-port",
                &port.to_string(),
                "--listen-path",
                &format!("/api/runner/v1/connect/{run_id}"),
                "--state-dir",
                directory.to_str().unwrap(),
                "--runner-id",
                "runner",
                "--environment-lease-id",
                "lease",
                "--run-id",
                &run_id,
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
            .spawn()
            .unwrap();
        let mut runner = Runner { process, directory };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = runner.process.try_wait().unwrap() {
                match TcpListener::bind(("0.0.0.0", port)) {
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                        continue 'attempt;
                    }
                    _ => panic!("Runner exited before listening: {status}"),
                }
            }
            if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Runner did not bind its selected port"
            );
            thread::sleep(Duration::from_millis(10));
        }
        runners.push(runner);
        if runners.len() == 2 {
            break;
        }
    }
    assert_eq!(
        runners.len(),
        2,
        "could not acquire two available Runner ports"
    );
    for runner in &mut runners {
        assert!(runner.process.try_wait().unwrap().is_none());
    }
}
