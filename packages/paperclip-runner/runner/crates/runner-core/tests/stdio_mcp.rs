#![cfg(unix)]
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread;
use std::time::{Duration, Instant};

struct Fixture {
    root: PathBuf,
    _socket: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("m{}", &uuid::Uuid::new_v4().to_string()[..8]));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let socket = UnixListener::bind(root.join("resource.sock")).unwrap();
        fs::set_permissions(
            root.join("resource.sock"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        Self {
            root,
            _socket: socket,
        }
    }
    fn config(&self) -> Value {
        let command = fs::canonicalize(env!("CARGO_BIN_EXE_fake-stdio-mcp")).unwrap();
        let sha = format!("sha256:{:x}", Sha256::digest(fs::read(&command).unwrap()));
        json!({"name":"fixture","command":command,"args":[],"env":{
            "FIXTURE_LOG":self.root.join("calls"),"FIXTURE_GATE":self.root.join("release"),"FIXTURE_PING_READY":self.root.join("ping-ready")
        },"sha256":sha,"serialResource":self.root.join("resource.sock")})
    }
    fn spawn(&self, config: Value) -> Peer {
        self.spawn_options(config, false)
    }
    fn spawn_options(&self, config: Value, content_images: bool) -> Peer {
        self.spawn_output_gate(config, content_images, Arc::new(AtomicBool::new(true)))
    }
    fn spawn_output_gate(
        &self,
        config: Value,
        content_images: bool,
        gate: Arc<AtomicBool>,
    ) -> Peer {
        let path = self.root.join(format!("{}.json", uuid::Uuid::new_v4()));
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_paperclip-runnerd"));
        command.args(["--stdio-mcp", path.to_str().unwrap()]);
        if content_images {
            command.arg("--content-images");
        }
        let mut child = command
            .env("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", "must-not-leak")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        thread::spawn(move || {
            while !gate.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(5));
            }
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Peer { child, rx }
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.root.join("calls")).unwrap_or_default()
    }
    fn wait_begin(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.calls().contains("begin") {
            assert!(Instant::now() < deadline, "peer never received call");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
struct Peer {
    child: Child,
    rx: mpsc::Receiver<Value>,
}
impl Peer {
    fn send(&mut self, id: u64, method: &str, args: Value) {
        writeln!(
            self.child.stdin.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":args})
        )
        .unwrap();
    }
    fn wait_exit(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "relay did not reject invalid operation"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn response(&self, id: u64) -> Value {
        let value = self
            .rx
            .recv_timeout(Duration::from_secs(5))
            .expect("MCP response timeout");
        assert_eq!(value["id"], id, "unexpected response: {value}");
        value["result"].clone()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn preserves_native_schemas_images_and_assigned_environment() {
    let fixture = Fixture::new();
    let mut peer = fixture.spawn(fixture.config());
    peer.send(1, "tools/list", json!({}));
    assert_eq!(
        peer.response(1)["tools"][0]["inputSchema"],
        json!({"type":"object","properties":{"original":{"type":"string"}}})
    );
    peer.send(2, "ping", json!({}));
    assert_eq!(peer.response(2)["secretLeaked"], false);
    peer.send(
        3,
        "tools/call",
        json!({"name":"opaque","arguments":{"original":"literal $HOME `echo nope` ✓"}}),
    );
    let response = peer.response(3);
    assert_eq!(
        response["content"][0],
        json!({"type":"text","text":"unchanged"})
    );
    assert_eq!(response["content"][1]["type"], "image");
    assert_eq!(response["content"][1]["mimeType"], "image/png");
    assert!(response["content"][1]["data"]
        .as_str()
        .unwrap()
        .starts_with("iVBOR"));
    assert_eq!(
        response["structuredContent"]["original"]["original"],
        "literal $HOME `echo nope` ✓"
    );
}

#[test]
fn serializes_calls_across_connections_while_metadata_stays_responsive() {
    let fixture = Fixture::new();
    let mut first = fixture.spawn(fixture.config());
    let mut second = fixture.spawn(fixture.config());
    first.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"block":true}}),
    );
    fixture.wait_begin();
    first.send(3, "ping", json!({}));
    assert_eq!(first.response(3)["secretLeaked"], false);
    second.send(2, "tools/call", json!({"name":"opaque","arguments":{}}));
    second.send(4, "ping", json!({}));
    assert_eq!(second.response(4)["secretLeaked"], false);
    assert_eq!(fixture.calls(), "begin 1\n");
    fs::write(fixture.root.join("release"), "ready").unwrap();
    first.response(1);
    second.response(2);
    assert_eq!(fixture.calls(), "begin 1\nend 1\nbegin 2\nend 2\n");
}

#[test]
fn rejects_hash_drift_before_starting_the_server() {
    let fixture = Fixture::new();
    let mut config = fixture.config();
    config["sha256"] = json!(format!("sha256:{}", "0".repeat(64)));
    let mut peer = fixture.spawn(config);
    assert!(!peer.wait_exit().success());
    assert_eq!(fixture.calls(), "");
}

#[test]
fn lost_acknowledgement_blocks_calls_until_socket_replacement() {
    let fixture = Fixture::new();
    let mut first = fixture.spawn(fixture.config());
    first.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"block":true}}),
    );
    fixture.wait_begin();
    first.send(1, "ping", json!({}));
    assert!(!first.wait_exit().success());
    assert!(
        fs::read_dir(&fixture.root).unwrap().any(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .starts_with(".paperclip-mcp-")
                && fs::read(e.path()).unwrap() == b"pending"
        }),
        "unfinished marker missing"
    );
    let mut second = fixture.spawn(fixture.config());
    second.send(2, "tools/call", json!({"name":"opaque","arguments":{}}));
    assert!(!second.wait_exit().success());
    assert_eq!(fixture.calls(), "begin 1\n");
    fs::remove_file(fixture.root.join("resource.sock")).unwrap();
    let _next = UnixListener::bind(fixture.root.join("resource.sock")).unwrap();
    fs::set_permissions(
        fixture.root.join("resource.sock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut third = fixture.spawn(fixture.config());
    third.send(3, "tools/call", json!({"name":"opaque","arguments":{}}));
    third.response(3);
    assert!(fixture.calls().ends_with("begin 3\nend 3\n"));
}

#[test]
fn image_compatibility_keeps_pixels_and_structured_metadata() {
    let fixture = Fixture::new();
    let mut peer = fixture.spawn_options(fixture.config(), true);
    peer.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"original":"metadata"}}),
    );
    let response = peer.response(1);
    assert!(response.get("structuredContent").is_none());
    assert_eq!(response["content"][1]["type"], "image");
    assert_eq!(response["content"][1]["mimeType"], "image/png");
    let metadata: Value =
        serde_json::from_str(response["content"][2]["text"].as_str().unwrap()).unwrap();
    assert_eq!(metadata, json!({"original":{"original":"metadata"}}));
}

#[test]
fn cancellation_removes_queued_calls_and_fences_active_calls_until_ack() {
    let fixture = Fixture::new();
    let mut first = fixture.spawn(fixture.config());
    let mut second = fixture.spawn(fixture.config());
    first.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"block":true}}),
    );
    fixture.wait_begin();
    second.send(2, "tools/call", json!({"name":"opaque","arguments":{}}));
    writeln!(
        second.child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}})
    )
    .unwrap();
    let cancelled = second.rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(cancelled["error"]["code"], -32800);
    writeln!(
        first.child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}})
    )
    .unwrap();
    second.send(3, "tools/call", json!({"name":"opaque","arguments":{}}));
    second.send(4, "ping", json!({}));
    second.response(4);
    assert_eq!(fixture.calls(), "begin 1\n");
    fs::write(fixture.root.join("release"), "ready").unwrap();
    first.response(1);
    second.response(3);
    assert_eq!(fixture.calls(), "begin 1\nend 1\nbegin 3\nend 3\n");
}

#[test]
fn cancellation_waiting_behind_output_is_handled_before_new_dispatch() {
    let fixture = Fixture::new();
    let mut first = fixture.spawn(fixture.config());
    first.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"block":true}}),
    );
    fixture.wait_begin();
    let gate = Arc::new(AtomicBool::new(false));
    let mut second = fixture.spawn_output_gate(fixture.config(), false, gate.clone());
    second.send(4, "ping", json!({"padding":true}));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fixture.root.join("ping-ready").exists() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(50));
    second.send(2, "tools/call", json!({"name":"opaque","arguments":{}}));
    writeln!(
        second.child.stdin.as_mut().unwrap(),
        "{}",
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}})
    )
    .unwrap();
    fs::write(fixture.root.join("release"), "ready").unwrap();
    first.response(1);
    thread::sleep(Duration::from_millis(50));
    gate.store(true, Ordering::SeqCst);
    second.response(4);
    let response = second.rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        response["error"]["code"], -32800,
        "cancelled call was dispatched: {response}"
    );
    assert_eq!(fixture.calls(), "begin 1\nend 1\n");
}

#[test]
fn metadata_only_socket_changes_do_not_bypass_unknown_outcome() {
    let fixture = Fixture::new();
    let mut first = fixture.spawn(fixture.config());
    first.send(
        1,
        "tools/call",
        json!({"name":"opaque","arguments":{"block":true}}),
    );
    fixture.wait_begin();
    first.send(1, "ping", json!({}));
    assert!(!first.wait_exit().success());
    fs::set_permissions(
        fixture.root.join("resource.sock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mut second = fixture.spawn(fixture.config());
    second.send(2, "tools/call", json!({"name":"opaque","arguments":{}}));
    assert!(!second.wait_exit().success());
    assert_eq!(fixture.calls(), "begin 1\n");
}
