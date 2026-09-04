use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn run_fixture(script_name: &str, commands: &[Value]) -> (std::process::ExitStatus, Vec<Value>) {
    let runnerd = PathBuf::from(env!("CARGO_BIN_EXE_paperclip-runnerd"));
    let fake_harness = PathBuf::from(env!("CARGO_BIN_EXE_fake-harness"));
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../protocol/fixtures/local-runner/scripts")
        .join(format!("{script_name}.json"));
    let mut child = Command::new(runnerd)
        .args([
            "--run-id",
            "run_local_test",
            "--session-id",
            "session_local_test",
            "--runner-id",
            "runner_local_test",
            "--fake-harness",
        ])
        .arg(fake_harness)
        .args(["--script"])
        .arg(script)
        .args(["--delay-ms", "0", "--shutdown-grace-ms", "100"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("local runner should start");
    let mut stdin = child.stdin.take().expect("runner stdin should be piped");
    for command in commands {
        serde_json::to_writer(&mut stdin, command).expect("command should serialize");
        stdin.write_all(b"\n").expect("command should write");
    }
    stdin.flush().expect("commands should flush");

    let mut output = String::new();
    child
        .stdout
        .take()
        .expect("runner stdout should be piped")
        .read_to_string(&mut output)
        .expect("runner output should be readable");
    let status = child.wait().expect("local runner should exit");
    let messages = output
        .lines()
        .map(|line| serde_json::from_str(line).expect("runner output should be JSONL"))
        .collect();
    (status, messages)
}

fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Value {
    json!({
        "schema": "paperclip.prp.command.v1",
        "commandId": id,
        "controllerSeq": sequence,
        "type": command_type,
        "issuedAt": "2026-08-07T21:00:00.000Z",
        "payload": payload,
    })
}

fn event_type(message: &Value) -> Option<&str> {
    (message["message"]["kind"] == "event")
        .then(|| message["message"]["event"]["eventType"].as_str())
        .flatten()
}

#[test]
fn happy_path_emits_one_result_and_one_terminal() {
    let commands = [
        command("command_prepare", 1, "run.prepare", json!({})),
        command("command_session", 2, "session.open", json!({})),
        command(
            "command_turn",
            3,
            "turn.start",
            json!({ "turnId": "turn_local_test", "text": "Run the fixture." }),
        ),
    ];
    let (status, messages) = run_fixture("happy-path", &commands);

    assert!(status.success());
    assert_eq!(
        messages
            .iter()
            .filter(|message| event_type(message) == Some("run.result.proposed"))
            .count(),
        1
    );
    let terminals = messages
        .iter()
        .filter(|message| event_type(message) == Some("run.terminal"))
        .collect::<Vec<_>>();
    assert_eq!(terminals.len(), 1);
    assert_eq!(
        terminals[0]["message"]["event"]["payload"]["runTerminalState"],
        "succeeded"
    );
}

#[test]
fn equivalent_command_redelivery_is_idempotent() {
    let prepare = command("command_prepare", 1, "run.prepare", json!({}));
    let commands = [
        prepare.clone(),
        prepare,
        command("command_session", 2, "session.open", json!({})),
        command(
            "command_turn",
            3,
            "turn.start",
            json!({ "turnId": "turn_local_test", "text": "Run the fixture." }),
        ),
    ];
    let (status, messages) = run_fixture("happy-path", &commands);

    assert!(status.success());
    assert!(messages.iter().any(|message| {
        message["message"]["kind"] == "command_receipt"
            && message["message"]["commandId"] == "command_prepare"
            && message["message"]["status"] == "duplicate"
    }));
}
