#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
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

const RUN_ID: &str = "run_accept";

fn upgrade(stream: &mut TcpStream) -> Duration {
    let started = Instant::now();
    stream
        .write_all(
            format!(
                "GET /api/runner/v1/connect/{RUN_ID} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
                 Upgrade: websocket\r\nConnection: Upgrade\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = Vec::new();
    let mut byte = [0_u8; 1];
    while !response.ends_with(b"\r\n\r\n") {
        assert_eq!(
            stream.read(&mut byte).unwrap(),
            1,
            "Runner closed the upgrade"
        );
        response.push(byte[0]);
    }
    assert!(
        response.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&response)
    );
    started.elapsed()
}

fn spawn_listening_runner() -> (Runner, u16, TcpStream) {
    for _ in 0..10 {
        let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let directory =
            std::env::temp_dir().join(format!("runner-accept-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
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
                &format!("/api/runner/v1/connect/{RUN_ID}"),
                "--state-dir",
                directory.to_str().unwrap(),
                "--runner-id",
                "runner",
                "--environment-lease-id",
                "lease",
                "--run-id",
                RUN_ID,
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
                "20000",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut runner = Runner { process, directory };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = runner.process.try_wait().unwrap() {
                match TcpListener::bind(("0.0.0.0", port)) {
                    Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => break,
                    _ => panic!("Runner exited before listening: {status}"),
                }
            }
            if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) {
                return (runner, port, stream);
            }
            assert!(Instant::now() < deadline, "Runner did not bind its port");
            thread::sleep(Duration::from_millis(10));
        }
    }
    panic!("could not acquire an available Runner port");
}

#[test]
fn listener_answers_the_next_connection_without_waiting_out_the_reconnect_delay() {
    let (_runner, port, mut stale) = spawn_listening_runner();
    upgrade(&mut stale);
    drop(stale);
    thread::sleep(Duration::from_millis(30));

    let mut current = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let waited = upgrade(&mut current);
    assert!(
        waited < Duration::from_millis(120),
        "listener answered after {waited:?}"
    );
}
