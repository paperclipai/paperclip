use std::collections::HashMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::process_supervisor::{
    read_bounded_line, BoundedLine, BoundedLogBuffer, ProcessExitFact, ProcessOutput,
    SupervisedProcess,
};

const RUNNER_STREAM_SCHEMA: &str = "paperclip.runner.stream.v1";
const RUNNER_COMMAND_SCHEMA: &str = "paperclip.prp.command.v1";
const HARNESS_COMMAND_SCHEMA: &str = "paperclip.fake_harness.command.v1";
const HARNESS_MESSAGE_SCHEMA: &str = "paperclip.fake_harness.message.v1";
const CONTROLLER_COMMAND_QUEUE_CAPACITY: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalRunnerError(String);

impl LocalRunnerError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for LocalRunnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for LocalRunnerError {}

#[derive(Clone, Debug)]
pub struct RunnerConfig {
    pub run_id: String,
    pub normalized_session_id: String,
    pub runner_instance_id: String,
    pub fake_harness_path: PathBuf,
    pub script_path: PathBuf,
    pub delay_override_ms: Option<u64>,
    pub log_max_lines: usize,
    pub log_max_bytes: usize,
    pub command_history_limit: usize,
    pub controller_max_line_bytes: usize,
    pub harness_max_line_bytes: usize,
    pub shutdown_grace: Duration,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCommand {
    pub schema: String,
    pub command_id: String,
    pub controller_seq: u64,
    #[serde(rename = "type")]
    pub command_type: String,
    pub issued_at: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCommand {
    pub schema: String,
    pub command_id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessMessage {
    schema: String,
    message_seq: u64,
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RunnerStreamMessage<'a> {
    Event {
        event: &'a Value,
    },
    CommandReceipt {
        #[serde(rename = "commandId")]
        command_id: &'a str,
        #[serde(rename = "controllerSeq")]
        controller_seq: u64,
        status: &'a str,
        detail: &'a str,
    },
    Diagnostic {
        level: &'a str,
        message: &'a str,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum TerminalIntent {
    #[default]
    Natural,
    Interrupted,
    Cancelled,
    ControllerClosed,
    ProtocolViolation,
}

fn enum_field<'a>(value: &'a Value, key: &str, allowed: &[&str]) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|candidate| allowed.contains(candidate))
}

fn valid_terminal_proposal(value: &Value) -> bool {
    value.get("schema").and_then(Value::as_str) == Some("paperclip.prp.terminal.v1")
        && enum_field(
            value,
            "turnTerminalState",
            &["completed", "failed", "interrupted", "cancelled"],
        )
        .is_some()
        && enum_field(
            value,
            "runTerminalState",
            &["succeeded", "failed", "cancelled"],
        )
        .is_some()
        && enum_field(
            value,
            "reportedWorkDisposition",
            &["done", "blocked", "needs_review", "yielded"],
        )
        .is_some()
}

fn reconcile_terminal(
    proposal: Option<Value>,
    exit: &ProcessExitFact,
    semantic_result: Option<&Value>,
    intent: TerminalIntent,
) -> Value {
    let (turn_terminal_state, run_terminal_state, reason) = match intent {
        TerminalIntent::Interrupted => ("interrupted", "cancelled", "turn_interrupted"),
        TerminalIntent::Cancelled => ("cancelled", "cancelled", "run_cancelled"),
        TerminalIntent::ControllerClosed => ("cancelled", "cancelled", "controller_closed"),
        TerminalIntent::ProtocolViolation => ("failed", "failed", "harness_protocol_violation"),
        TerminalIntent::Natural if exit.success && semantic_result.is_some() => {
            ("completed", "succeeded", "successful_process_and_result")
        }
        TerminalIntent::Natural if !exit.success => ("failed", "failed", "harness_process_failed"),
        TerminalIntent::Natural => ("failed", "failed", "semantic_result_missing"),
    };

    let proposal_valid = proposal.as_ref().is_some_and(valid_terminal_proposal);
    let proposal_contradicted = proposal.as_ref().is_some_and(|value| {
        proposal_valid
            && (value.get("turnTerminalState").and_then(Value::as_str) != Some(turn_terminal_state)
                || value.get("runTerminalState").and_then(Value::as_str)
                    != Some(run_terminal_state))
    });
    let proposed_disposition = proposal.as_ref().and_then(|value| {
        enum_field(
            value,
            "reportedWorkDisposition",
            &["done", "blocked", "needs_review", "yielded"],
        )
        .map(str::to_owned)
    });
    let result_disposition = semantic_result.and_then(|value| {
        enum_field(
            value,
            "reportedWorkDisposition",
            &["done", "blocked", "needs_review", "yielded"],
        )
        .map(str::to_owned)
    });
    let reported_work_disposition = if run_terminal_state == "succeeded" {
        result_disposition
            .or(proposed_disposition)
            .unwrap_or_else(|| "done".to_owned())
    } else {
        result_disposition
            .filter(|value| value != "done")
            .or_else(|| proposed_disposition.filter(|value| value != "done"))
            .unwrap_or_else(|| "yielded".to_owned())
    };
    let harness_terminal_proposal = proposal.unwrap_or(Value::Null);

    json!({
        "schema": "paperclip.prp.terminal.v1",
        "turnTerminalState": turn_terminal_state,
        "runTerminalState": run_terminal_state,
        "reportedWorkDisposition": reported_work_disposition,
        "harnessTerminalProposal": harness_terminal_proposal,
        "reconciliation": {
            "authority": "runner",
            "reason": reason,
            "proposalValid": proposal_valid,
            "proposalContradicted": proposal_contradicted,
            "processExit": exit,
            "semanticResultObserved": semantic_result.is_some(),
        }
    })
}

struct RunnerState {
    config: RunnerConfig,
    source_seq: u64,
    next_controller_seq: u64,
    commands: HashMap<String, String>,
    next_harness_message_seq: u64,
    harness: Option<SupervisedProcess>,
    logs: BoundedLogBuffer,
    semantic_result: Option<Value>,
    pending_terminal: Option<Value>,
    terminal_intent: TerminalIntent,
    terminal_emitted: bool,
    stdout_closed: bool,
}

impl RunnerState {
    fn new(config: RunnerConfig) -> Self {
        Self {
            logs: BoundedLogBuffer::new(config.log_max_lines, config.log_max_bytes),
            config,
            source_seq: 0,
            next_controller_seq: 1,
            commands: HashMap::new(),
            next_harness_message_seq: 1,
            harness: None,
            semantic_result: None,
            pending_terminal: None,
            terminal_intent: TerminalIntent::Natural,
            terminal_emitted: false,
            stdout_closed: false,
        }
    }

    fn write_stream(&self, message: &RunnerStreamMessage<'_>) -> Result<(), LocalRunnerError> {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let envelope = json!({
            "schema": RUNNER_STREAM_SCHEMA,
            "message": message,
        });
        serde_json::to_writer(&mut lock, &envelope).map_err(|error| {
            LocalRunnerError::invalid(format!("stream serialization failed: {error}"))
        })?;
        lock.write_all(b"\n")
            .and_then(|_| lock.flush())
            .map_err(|error| LocalRunnerError::invalid(format!("stream write failed: {error}")))
    }

    fn command_receipt(
        &self,
        command: &RunnerCommand,
        status: &str,
        detail: &str,
    ) -> Result<(), LocalRunnerError> {
        self.write_stream(&RunnerStreamMessage::CommandReceipt {
            command_id: &command.command_id,
            controller_seq: command.controller_seq,
            status,
            detail,
        })
    }

    fn diagnostic(&self, level: &str, message: &str) -> Result<(), LocalRunnerError> {
        self.write_stream(&RunnerStreamMessage::Diagnostic { level, message })
    }

    fn emit_event(
        &mut self,
        event_type: &str,
        payload: Value,
        turn_id: Option<&str>,
        item_id: Option<&str>,
    ) -> Result<(), LocalRunnerError> {
        if self.terminal_emitted {
            return Ok(());
        }
        self.source_seq += 1;
        let mut event = json!({
            "schema": "paperclip.prp.event.v1",
            "sourceEventId": format!("event_{}_{:03}", self.config.run_id, self.source_seq),
            "sourceSeq": self.source_seq,
            "sourceInstanceId": self.config.runner_instance_id,
            "sourceKind": "runner",
            "runId": self.config.run_id,
            "normalizedSessionId": self.config.normalized_session_id,
            "eventType": event_type,
            "schemaVersion": 1,
            "priority": event_priority(event_type),
            "emittedAt": format!("2026-08-07T21:00:{:02}.{:03}Z", (self.source_seq / 1000) % 60, self.source_seq % 1000),
            "payload": payload,
        });
        if let Some(turn_id) = turn_id {
            event["turnId"] = Value::String(turn_id.to_owned());
        }
        if let Some(item_id) = item_id {
            event["itemId"] = Value::String(item_id.to_owned());
        }
        self.write_stream(&RunnerStreamMessage::Event { event: &event })?;
        if event_type == "run.terminal" {
            self.terminal_emitted = true;
        }
        Ok(())
    }

    fn start_harness(&mut self) -> Result<(), LocalRunnerError> {
        self.emit_event(
            "runtime.phase.changed",
            json!({ "phase": "workspace_preparing" }),
            None,
            None,
        )?;
        self.emit_event(
            "workspace.ready",
            json!({ "workingDirectory": "standalone-fixture" }),
            None,
            None,
        )?;
        self.emit_event(
            "harness.starting",
            json!({ "driverKind": "fake", "transport": "stdio_jsonl" }),
            None,
            None,
        )?;
        let mut args = vec![
            "--script".to_owned(),
            self.config.script_path.display().to_string(),
        ];
        if let Some(milliseconds) = self.config.delay_override_ms {
            args.push("--delay-ms".to_owned());
            args.push(milliseconds.to_string());
        }
        let harness = SupervisedProcess::spawn(
            &self.config.fake_harness_path,
            &args,
            self.config.shutdown_grace,
            self.config.harness_max_line_bytes,
        )?;
        let ready_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = ready_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(LocalRunnerError::invalid(
                    "fake harness did not become ready",
                ));
            }
            match harness.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => {
                    let message = parse_harness_message(&line)?;
                    self.accept_harness_message_sequence(&message)?;
                    if message.message_type == "ready" {
                        self.emit_event(
                            "harness.ready",
                            json!({
                                "driverKind": "fake",
                                "driverVersion": message.payload.get("version").cloned().unwrap_or_else(|| json!("1.0.0")),
                                "transport": "stdio_jsonl"
                            }),
                            None,
                            None,
                        )?;
                        break;
                    }
                    return Err(LocalRunnerError::invalid(
                        "fake harness emitted data before ready",
                    ));
                }
                Ok(ProcessOutput::Stderr(line)) => self.logs.push(format!("stderr: {line}")),
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(message));
                }
                Ok(ProcessOutput::StdoutClosed) => {
                    return Err(LocalRunnerError::invalid(
                        "fake harness exited before ready",
                    ));
                }
                Ok(ProcessOutput::StderrClosed) => {}
                Err(RecvTimeoutError::Timeout) => {
                    return Err(LocalRunnerError::invalid("fake harness ready timed out"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(LocalRunnerError::invalid(
                        "fake harness output channel closed",
                    ));
                }
            }
        }
        self.harness = Some(harness);
        Ok(())
    }

    fn handle_command(&mut self, command: RunnerCommand) -> Result<(), LocalRunnerError> {
        if command.schema != RUNNER_COMMAND_SCHEMA {
            self.command_receipt(&command, "rejected", "unsupported command schema")?;
            return Ok(());
        }
        let canonical = canonical_json(&serde_json::to_value(&command).map_err(|error| {
            LocalRunnerError::invalid(format!("command canonicalization failed: {error}"))
        })?);
        if let Some(previous) = self.commands.get(&command.command_id) {
            if previous == &canonical {
                self.command_receipt(&command, "duplicate", "equivalent command already applied")?;
            } else {
                self.command_receipt(
                    &command,
                    "rejected",
                    "commandId was reused with different data",
                )?;
            }
            return Ok(());
        }
        if command.controller_seq != self.next_controller_seq {
            self.command_receipt(&command, "rejected", "controllerSeq is not contiguous")?;
            return Ok(());
        }
        if self.commands.len() >= self.config.command_history_limit.max(1) {
            self.command_receipt(&command, "rejected", "command history limit reached")?;
            return Ok(());
        }
        self.commands.insert(command.command_id.clone(), canonical);
        self.next_controller_seq += 1;

        match command.command_type.as_str() {
            "run.prepare" => {
                if self.harness.is_some() {
                    self.command_receipt(&command, "rejected", "run is already prepared")?;
                    return Ok(());
                }
                self.start_harness()?;
            }
            "session.open" => {
                self.emit_event("session.starting", json!({}), None, None)?;
                self.send_harness_command(&command)?;
            }
            "turn.start" => {
                self.emit_event(
                    "turn.submitted",
                    json!({ "text": command.payload.get("text").cloned().unwrap_or(Value::Null) }),
                    command.payload.get("turnId").and_then(Value::as_str),
                    None,
                )?;
                self.send_harness_command(&command)?;
            }
            "request.resolve" | "session.close" => {
                self.send_harness_command(&command)?;
            }
            "turn.interrupt" | "turn.stop" => {
                self.terminal_intent = TerminalIntent::Interrupted;
                self.send_harness_command(&command)?;
            }
            "run.cancel" => {
                self.terminal_intent = TerminalIntent::Cancelled;
                self.send_harness_command(&command)?;
            }
            unsupported => {
                self.command_receipt(
                    &command,
                    "rejected",
                    &format!("command {unsupported} is not implemented in Local runner"),
                )?;
                return Ok(());
            }
        }
        self.command_receipt(&command, "accepted", "command applied")
    }

    fn send_harness_command(&mut self, command: &RunnerCommand) -> Result<(), LocalRunnerError> {
        let harness = self
            .harness
            .as_mut()
            .ok_or_else(|| LocalRunnerError::invalid("run.prepare must start the harness first"))?;
        harness.send(&HarnessCommand {
            schema: HARNESS_COMMAND_SCHEMA.to_owned(),
            command_id: command.command_id.clone(),
            command_type: command.command_type.clone(),
            payload: command.payload.clone(),
        })
    }

    fn drain_harness_output(&mut self) -> Result<(), LocalRunnerError> {
        loop {
            let output = match self.harness.as_ref().map(SupervisedProcess::try_recv) {
                Some(Ok(output)) => output,
                Some(Err(mpsc::TryRecvError::Empty)) | None => return Ok(()),
                Some(Err(mpsc::TryRecvError::Disconnected)) => {
                    self.stdout_closed = true;
                    return Ok(());
                }
            };
            match output {
                ProcessOutput::Stdout(line) => self.handle_harness_line(&line)?,
                ProcessOutput::Stderr(line) => self.logs.push(format!("stderr: {line}")),
                ProcessOutput::StdoutError(message) => {
                    self.logs.push(format!("stdout: [{message}]"));
                    self.terminal_intent = TerminalIntent::ProtocolViolation;
                    self.terminate_harness()?;
                    return Ok(());
                }
                ProcessOutput::StdoutClosed => self.stdout_closed = true,
                ProcessOutput::StderrClosed => {}
            }
        }
    }

    fn handle_harness_line(&mut self, line: &str) -> Result<(), LocalRunnerError> {
        let message = parse_harness_message(line)?;
        self.accept_harness_message_sequence(&message)?;
        match message.message_type.as_str() {
            "event" => {
                let event_type = message
                    .payload
                    .get("eventType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| LocalRunnerError::invalid("harness event requires eventType"))?
                    .to_owned();
                let turn_id = message
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let item_id = message
                    .payload
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let payload = message
                    .payload
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.emit_event(&event_type, payload, turn_id.as_deref(), item_id.as_deref())?;
            }
            "request" => {
                let request =
                    message.payload.get("request").cloned().ok_or_else(|| {
                        LocalRunnerError::invalid("harness request requires request")
                    })?;
                self.emit_event(
                    "runtime_request.created",
                    json!({ "request": request }),
                    None,
                    None,
                )?;
            }
            "result" => {
                let result =
                    message.payload.get("result").cloned().ok_or_else(|| {
                        LocalRunnerError::invalid("harness result requires result")
                    })?;
                if self.semantic_result.is_none() {
                    self.semantic_result = Some(result.clone());
                    self.emit_event("run.result.proposed", result, None, None)?;
                } else {
                    self.emit_event(
                        "harness.diagnostic",
                        json!({
                            "code": "duplicate_semantic_result_ignored",
                            "message": "Duplicate semantic result ignored; the first result remains authoritative."
                        }),
                        None,
                        None,
                    )?;
                }
            }
            "terminal" => {
                let terminal = message.payload.get("terminal").cloned().ok_or_else(|| {
                    LocalRunnerError::invalid("harness terminal requires terminal")
                })?;
                if self.pending_terminal.is_none() {
                    self.pending_terminal = Some(terminal);
                } else {
                    self.emit_event(
                        "harness.diagnostic",
                        json!({
                            "code": "duplicate_terminal_ignored",
                            "message": "Duplicate terminal event ignored; the first terminal event remains authoritative."
                        }),
                        None,
                        None,
                    )?;
                }
            }
            "log" => {
                let stream = message
                    .payload
                    .get("stream")
                    .and_then(Value::as_str)
                    .unwrap_or("stdout");
                let text = message
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.logs.push(format!("{stream}: {text}"));
            }
            "diagnostic" => {
                self.logs.push(format!("diagnostic: {}", message.payload));
            }
            "ready" => {
                self.diagnostic("warning", "duplicate harness ready message ignored")?;
            }
            unsupported => {
                return Err(LocalRunnerError::invalid(format!(
                    "unsupported fake harness message {unsupported} at sequence {}",
                    message.message_seq
                )));
            }
        }
        Ok(())
    }

    fn accept_harness_message_sequence(
        &mut self,
        message: &HarnessMessage,
    ) -> Result<(), LocalRunnerError> {
        if message.message_seq != self.next_harness_message_seq {
            return Err(LocalRunnerError::invalid(format!(
                "fake harness message sequence must be {}; received {}",
                self.next_harness_message_seq, message.message_seq
            )));
        }
        self.next_harness_message_seq += 1;
        Ok(())
    }

    fn finish_harness(&mut self) -> Result<(), LocalRunnerError> {
        let exit = self
            .harness
            .as_mut()
            .ok_or_else(|| LocalRunnerError::invalid("harness was not started"))?
            .wait()?;
        self.finalize_harness(exit)
    }

    fn terminate_harness(&mut self) -> Result<(), LocalRunnerError> {
        let exit = self
            .harness
            .as_mut()
            .ok_or_else(|| LocalRunnerError::invalid("harness was not started"))?
            .terminate_group()?;
        self.finalize_harness(exit)
    }

    fn finalize_harness(&mut self, exit: ProcessExitFact) -> Result<(), LocalRunnerError> {
        self.emit_event(
            "harness.exited",
            json!({
                "processExit": &exit,
                "semanticResultObserved": self.semantic_result.is_some(),
                "logs": self.logs.snapshot(),
            }),
            None,
            None,
        )?;
        let terminal = reconcile_terminal(
            self.pending_terminal.take(),
            &exit,
            self.semantic_result.as_ref(),
            self.terminal_intent,
        );
        self.emit_event("run.terminal", terminal, None, None)
    }
}

pub fn run_local_runner(config: RunnerConfig) -> Result<(), LocalRunnerError> {
    let controller_max_line_bytes = config.controller_max_line_bytes.max(1);
    let (command_sender, command_receiver) = mpsc::sync_channel(CONTROLLER_COMMAND_QUEUE_CAPACITY);
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let command = match read_bounded_line(&mut reader, controller_max_line_bytes) {
                Ok(BoundedLine::Line(line)) if line.trim().is_empty() => continue,
                Ok(BoundedLine::Line(line)) => serde_json::from_str::<RunnerCommand>(&line)
                    .map_err(|error| format!("invalid command JSON: {error}")),
                Ok(BoundedLine::TooLong) => Err(format!(
                    "controller command exceeded {controller_max_line_bytes} bytes"
                )),
                Ok(BoundedLine::Eof) => return,
                Err(error) => Err(format!("failed to read controller input: {error}")),
            };
            if command_sender.send(command).is_err() {
                return;
            }
        }
    });

    let mut state = RunnerState::new(config);
    loop {
        match command_receiver.recv_timeout(Duration::from_millis(2)) {
            Ok(Ok(command)) => state.handle_command(command)?,
            Ok(Err(error)) => state.diagnostic("error", &error)?,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if state.harness.is_none() {
                    return Err(LocalRunnerError::invalid(
                        "controller closed before run.prepare",
                    ));
                }
                state.terminal_intent = TerminalIntent::ControllerClosed;
                state.terminate_harness()?;
                return Ok(());
            }
        }
        state.drain_harness_output()?;
        if state.terminal_emitted {
            return Ok(());
        }
        if state.stdout_closed {
            state.finish_harness()?;
            return Ok(());
        }
    }
}

fn parse_harness_message(line: &str) -> Result<HarnessMessage, LocalRunnerError> {
    let message: HarnessMessage = serde_json::from_str(line).map_err(|error| {
        LocalRunnerError::invalid(format!("fake harness emitted invalid JSONL: {error}"))
    })?;
    if message.schema != HARNESS_MESSAGE_SCHEMA {
        return Err(LocalRunnerError::invalid(
            "fake harness message schema is unsupported",
        ));
    }
    Ok(message)
}

fn event_priority(event_type: &str) -> u8 {
    match event_type {
        "run.result.proposed"
        | "run.terminal"
        | "turn.completed"
        | "turn.failed"
        | "turn.interrupted"
        | "harness.exited" => 0,
        "item.delta" | "harness.diagnostic" | "runner.diagnostic" => 2,
        _ => 1,
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object key should serialize"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;
    use std::path::Path;

    use crate::fake_harness::load_fake_harness_script;
    use crate::process_supervisor::{read_bounded_line, BoundedLine};

    #[test]
    fn bounded_logs_keep_only_the_tail() {
        let mut logs = BoundedLogBuffer::new(2, 12);
        logs.push("first");
        logs.push("second");
        logs.push("third");

        assert_eq!(logs.snapshot().lines, vec!["second", "third"]);
        assert_eq!(logs.snapshot().dropped_lines, 1);
        assert!(logs.snapshot().retained_bytes <= 12);
    }

    #[test]
    fn bounded_line_reader_rejects_an_oversized_frame_and_recovers() {
        let mut source = vec![b'x'; 4_096];
        source.extend_from_slice(b"\nnext\n");
        let mut reader = BufReader::new(std::io::Cursor::new(source));

        assert_eq!(
            read_bounded_line(&mut reader, 64).expect("oversized line should be classified"),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_bounded_line(&mut reader, 64).expect("reader should continue after the frame"),
            BoundedLine::Line("next".to_owned())
        );
    }

    #[test]
    fn nonzero_exit_overrides_a_success_terminal_proposal() {
        let terminal = reconcile_terminal(
            Some(json!({
                "schema": "paperclip.prp.terminal.v1",
                "turnTerminalState": "completed",
                "runTerminalState": "succeeded",
                "reportedWorkDisposition": "done"
            })),
            &ProcessExitFact {
                exit_code: Some(7),
                success: false,
                signal: None,
            },
            Some(&json!({ "reportedWorkDisposition": "done" })),
            TerminalIntent::Natural,
        );

        assert_eq!(terminal["turnTerminalState"], "failed");
        assert_eq!(terminal["runTerminalState"], "failed");
        assert_eq!(terminal["reportedWorkDisposition"], "yielded");
        assert_eq!(terminal["reconciliation"]["authority"], "runner");
        assert_eq!(terminal["reconciliation"]["proposalValid"], true);
        assert_eq!(terminal["reconciliation"]["proposalContradicted"], true);
        assert_eq!(
            terminal["harnessTerminalProposal"]["runTerminalState"],
            "succeeded"
        );
    }

    #[test]
    fn successful_process_and_result_override_a_failed_terminal_proposal() {
        let terminal = reconcile_terminal(
            Some(json!({
                "schema": "paperclip.prp.terminal.v1",
                "turnTerminalState": "failed",
                "runTerminalState": "failed",
                "reportedWorkDisposition": "yielded"
            })),
            &ProcessExitFact {
                exit_code: Some(0),
                success: true,
                signal: None,
            },
            Some(&json!({ "reportedWorkDisposition": "done" })),
            TerminalIntent::Natural,
        );

        assert_eq!(terminal["turnTerminalState"], "completed");
        assert_eq!(terminal["runTerminalState"], "succeeded");
        assert_eq!(terminal["reportedWorkDisposition"], "done");
        assert_eq!(terminal["reconciliation"]["proposalContradicted"], true);
    }

    #[test]
    fn canonical_json_sorts_object_keys_without_reordering_arrays() {
        assert_eq!(
            canonical_json(&json!({ "z": [2, 1], "a": { "b": true } })),
            r#"{"a":{"b":true},"z":[2,1]}"#
        );
    }

    #[test]
    fn all_local_runner_scripts_load() {
        let scripts = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../protocol/fixtures/local-runner/scripts");
        for name in [
            "happy-path",
            "permission-input",
            "interrupted",
            "error",
            "duplicate-terminal",
            "linger",
            "oversized-line",
        ] {
            let script = load_fake_harness_script(&scripts.join(format!("{name}.json")))
                .expect("Local runner script should load");
            assert_eq!(script.name, name);
        }
    }
}
