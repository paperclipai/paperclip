use std::io::{BufRead, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::local_runner::{HarnessCommand, LocalRunnerError};

const HARNESS_COMMAND_SCHEMA: &str = "paperclip.fake_harness.command.v1";
const HARNESS_MESSAGE_SCHEMA: &str = "paperclip.fake_harness.message.v1";
const HARNESS_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const INTERACTIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeHarnessScript {
    pub schema: String,
    pub name: String,
    pub steps: Vec<FakeHarnessStep>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FakeHarnessStep {
    Delay {
        milliseconds: u64,
    },
    Log {
        stream: String,
        text: String,
    },
    Event {
        event_type: String,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        item_id: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    Request {
        request: Value,
    },
    AwaitResolution {
        request_id: String,
    },
    AwaitInterrupt,
    Result {
        payload: Value,
    },
    Terminal {
        payload: Value,
    },
    SpawnWorker,
    Exit {
        code: i32,
    },
}

pub fn load_fake_harness_script(path: &Path) -> Result<FakeHarnessScript, LocalRunnerError> {
    let input = std::fs::read_to_string(path).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to read fake harness script {}: {error}",
            path.display()
        ))
    })?;
    let script: FakeHarnessScript = serde_json::from_str(&input).map_err(|error| {
        LocalRunnerError::invalid(format!("fake harness script must be valid JSON: {error}"))
    })?;
    if script.schema != "paperclip.fake_harness.script.v1" {
        return Err(LocalRunnerError::invalid(
            "fake harness script schema is unsupported",
        ));
    }
    if script.name.trim().is_empty() || script.steps.is_empty() {
        return Err(LocalRunnerError::invalid(
            "fake harness script requires a name and at least one step",
        ));
    }
    Ok(script)
}

pub fn run_fake_harness(
    script: FakeHarnessScript,
    delay_override_ms: Option<u64>,
) -> Result<i32, LocalRunnerError> {
    let (command_sender, command_receiver) = mpsc::channel::<HarnessCommand>();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let command = match serde_json::from_str::<HarnessCommand>(&line) {
                Ok(command) => command,
                Err(_) => continue,
            };
            if command_sender.send(command).is_err() {
                return;
            }
        }
    });

    let mut output = FakeHarnessOutput::default();
    output.send(
        "ready",
        json!({ "version": "1.0.0", "script": script.name }),
    )?;
    receive_harness_command(&command_receiver, "session.open", None)?;
    output.send_event(
        "session.started",
        None,
        None,
        json!({ "driverSessionId": "driver_local_runner_fake" }),
    )?;
    output.send_event(
        "runtime.phase.changed",
        None,
        None,
        json!({ "phase": "executing" }),
    )?;
    let turn = receive_harness_command(&command_receiver, "turn.start", None)?;
    let turn_id = turn
        .payload
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("turn_local_runner")
        .to_owned();
    output.send_event("turn.started", Some(&turn_id), None, json!({}))?;

    let mut workers = Vec::<Child>::new();
    for step in script.steps {
        match step {
            FakeHarnessStep::Delay { milliseconds } => {
                thread::sleep(Duration::from_millis(
                    delay_override_ms.unwrap_or(milliseconds),
                ));
            }
            FakeHarnessStep::Log { stream, text } => {
                output.send("log", json!({ "stream": stream, "text": text }))?;
            }
            FakeHarnessStep::Event {
                event_type,
                turn_id: step_turn_id,
                item_id,
                payload,
            } => {
                output.send_event(
                    &event_type,
                    step_turn_id.as_deref().or(Some(&turn_id)),
                    item_id.as_deref(),
                    payload,
                )?;
            }
            FakeHarnessStep::Request { request } => {
                output.send("request", json!({ "request": request }))?;
            }
            FakeHarnessStep::AwaitResolution { request_id } => {
                let command = receive_harness_command(
                    &command_receiver,
                    "request.resolve",
                    Some(&request_id),
                )?;
                output.send_event(
                    "runtime_request.resolved",
                    Some(&turn_id),
                    None,
                    json!({
                        "requestId": request_id,
                        "response": command.payload.get("response").cloned().unwrap_or(Value::Null)
                    }),
                )?;
            }
            FakeHarnessStep::AwaitInterrupt => {
                let command = receive_harness_command(&command_receiver, "turn.interrupt", None)?;
                output.send_event(
                    "turn.interrupted",
                    Some(&turn_id),
                    None,
                    json!({ "reason": command.payload.get("reason").cloned().unwrap_or_else(|| json!("operator")) }),
                )?;
            }
            FakeHarnessStep::Result { payload } => {
                output.send("result", json!({ "result": payload }))?;
            }
            FakeHarnessStep::Terminal { payload } => {
                output.send("terminal", json!({ "terminal": payload }))?;
            }
            FakeHarnessStep::SpawnWorker => {
                let worker = Command::new("sh")
                    .args(["-c", "sleep 60"])
                    .env_clear()
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| {
                        LocalRunnerError::invalid(format!("failed to spawn fake worker: {error}"))
                    })?;
                output.send(
                    "diagnostic",
                    json!({ "workerPid": worker.id(), "purpose": "cleanup_conformance" }),
                )?;
                workers.push(worker);
            }
            FakeHarnessStep::Exit { code } => {
                drop(workers);
                return Ok(code);
            }
        }
    }
    drop(workers);
    Ok(0)
}

fn receive_harness_command(
    receiver: &Receiver<HarnessCommand>,
    command_type: &str,
    request_id: Option<&str>,
) -> Result<HarnessCommand, LocalRunnerError> {
    let timeout = if command_type == "request.resolve" {
        INTERACTIVE_REQUEST_TIMEOUT
    } else {
        HARNESS_COMMAND_TIMEOUT
    };
    loop {
        let command = receiver.recv_timeout(timeout).map_err(|_| {
            LocalRunnerError::invalid(format!("timed out waiting for {command_type}"))
        })?;
        if command.schema != HARNESS_COMMAND_SCHEMA {
            continue;
        }
        if command.command_type != command_type {
            continue;
        }
        if let Some(request_id) = request_id {
            if command.payload.get("requestId").and_then(Value::as_str) != Some(request_id) {
                continue;
            }
        }
        return Ok(command);
    }
}

#[derive(Default)]
struct FakeHarnessOutput {
    sequence: u64,
}

impl FakeHarnessOutput {
    fn send(&mut self, message_type: &str, payload: Value) -> Result<(), LocalRunnerError> {
        self.sequence += 1;
        let message = json!({
            "schema": HARNESS_MESSAGE_SCHEMA,
            "messageSeq": self.sequence,
            "type": message_type,
            "payload": payload,
        });
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        serde_json::to_writer(&mut lock, &message).map_err(|error| {
            LocalRunnerError::invalid(format!("harness message serialization failed: {error}"))
        })?;
        lock.write_all(b"\n")
            .and_then(|_| lock.flush())
            .map_err(|error| {
                LocalRunnerError::invalid(format!("harness message write failed: {error}"))
            })
    }

    fn send_event(
        &mut self,
        event_type: &str,
        turn_id: Option<&str>,
        item_id: Option<&str>,
        payload: Value,
    ) -> Result<(), LocalRunnerError> {
        self.send(
            "event",
            json!({
                "eventType": event_type,
                "turnId": turn_id,
                "itemId": item_id,
                "payload": payload,
            }),
        )
    }
}
