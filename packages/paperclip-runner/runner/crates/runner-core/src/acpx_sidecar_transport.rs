use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::generated_acpx_sidecar_contract::{
    GeneratedAcpxSidecarCommand, GeneratedAcpxSidecarEventType,
    GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
};
use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::{
    BoundedLogBuffer, ProcessOutput, SupervisedProcess, VerifiedProcessLaunch,
};
use crate::stable_identity::{is_stable_id, DURABLE_STABLE_ID_CHARS, SHORT_STABLE_ID_CHARS};

pub const ACPX_SIDECAR_MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_BUFFERED_EVENTS: usize = 512;
const MAX_EVENT_POLL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
pub struct AcpxSidecarTransportConfig {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub verified_launch: Option<VerifiedProcessLaunch>,
    pub request_timeout: Duration,
    pub shutdown_grace: Duration,
}

impl AcpxSidecarTransportConfig {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if !self.command.is_absolute()
            || (self.verified_launch.is_none() && !self.command.is_file())
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar command must be an existing absolute file",
            ));
        }
        if self.args.len() > 64
            || self.args.iter().any(|argument| {
                argument.len() > 4_096 || argument.chars().any(|character| character == '\0')
            })
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar arguments exceed the bounded launch contract",
            ));
        }
        if self.request_timeout < Duration::from_millis(1)
            || self.request_timeout > Duration::from_secs(120)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar request timeout must be in the range 1 ms through 120 s",
            ));
        }
        if self.shutdown_grace < Duration::from_millis(1)
            || self.shutdown_grace > Duration::from_secs(30)
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar shutdown grace must be in the range 1 ms through 30 s",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AcpxSidecarEvent {
    pub sequence: u64,
    pub event_type: GeneratedAcpxSidecarEventType,
    pub run_id: Option<String>,
    pub turn_id: Option<String>,
    pub payload: Value,
}

pub struct AcpxSidecarTransport {
    process: SupervisedProcess,
    request_timeout: Duration,
    next_request_id: u64,
    last_event_sequence: u64,
    buffered_events: VecDeque<AcpxSidecarEvent>,
    stderr_tail: BoundedLogBuffer,
    poisoned: bool,
}

impl AcpxSidecarTransport {
    pub fn start(config: &AcpxSidecarTransportConfig) -> Result<Self, LocalRunnerError> {
        Self::start_with_environment_keys(config, &[])
    }

    pub fn start_for_agent(
        config: &AcpxSidecarTransportConfig,
        agent: &str,
    ) -> Result<Self, LocalRunnerError> {
        let credential_keys: &[&str] = match agent {
            "claude" => &["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
            "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY"],
            _ => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar credentials require a qualified claude or codex agent",
                ))
            }
        };
        let mut keys = vec![
            "LANGUAGE",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
            "all_proxy",
            "RUST_BACKTRACE",
            "PAPERCLIP_NATIVE_MCP_NAME",
            "PAPERCLIP_NATIVE_MCP_URL",
            "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT",
            "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST",
        ];
        keys.extend_from_slice(credential_keys);
        Self::start_with_environment_keys(config, &keys)
    }

    fn start_with_environment_keys(
        config: &AcpxSidecarTransportConfig,
        environment_keys: &[&str],
    ) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        let process = if let Some(launch) = config.verified_launch.as_ref() {
            SupervisedProcess::spawn_verified_with_environment_keys(
                launch,
                config.shutdown_grace,
                ACPX_SIDECAR_MAX_FRAME_BYTES,
                environment_keys,
            )?
        } else {
            SupervisedProcess::spawn_with_environment_keys(
                &config.command,
                &config.args,
                config.shutdown_grace,
                ACPX_SIDECAR_MAX_FRAME_BYTES,
                environment_keys,
            )?
        };
        Ok(Self {
            process,
            request_timeout: config.request_timeout,
            next_request_id: 1,
            last_event_sequence: 0,
            buffered_events: VecDeque::new(),
            stderr_tail: BoundedLogBuffer::new(32, 8 * 1024),
            poisoned: false,
        })
    }

    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub fn request(
        &mut self,
        command: GeneratedAcpxSidecarCommand,
        params: Value,
    ) -> Result<Value, LocalRunnerError> {
        if self.poisoned {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar transport is unavailable after a protocol failure",
            ));
        }
        let result = self.request_inner(command, params);
        match result {
            Ok(CommandOutcome::Success(value)) => Ok(value),
            Ok(CommandOutcome::Rejected(error)) => Err(error),
            Err(error) => {
                self.poison();
                Err(error)
            }
        }
    }

    pub fn poll_event(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<AcpxSidecarEvent>, LocalRunnerError> {
        if self.poisoned {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar transport is unavailable after a protocol failure",
            ));
        }
        if timeout > MAX_EVENT_POLL_TIMEOUT {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event poll timeout must not exceed 120 s",
            ));
        }
        if let Some(event) = self.buffered_events.pop_front() {
            return Ok(Some(event));
        }
        if timeout.is_zero() {
            return Ok(None);
        }
        let result = self.poll_event_inner(timeout);
        if result.is_err() {
            self.poison();
        }
        result
    }

    pub fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.poisoned = true;
        self.process.terminate_group().map(|_| ())
    }

    fn request_inner(
        &mut self,
        command: GeneratedAcpxSidecarCommand,
        params: Value,
    ) -> Result<CommandOutcome, LocalRunnerError> {
        if !params.is_object() {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar command params must be an object",
            ));
        }
        let request_id = self.next_request_id;
        if request_id > MAX_JSON_SAFE_INTEGER {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar request sequence is exhausted",
            ));
        }
        let frame = json!({
            "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "id": request_id,
            "command": command.as_str(),
            "params": params,
        });
        let frame_bytes = serde_json::to_vec(&frame).map_err(|error| {
            LocalRunnerError::invalid(format!("ACPX sidecar request is not serializable: {error}"))
        })?;
        if frame_bytes.len() > ACPX_SIDECAR_MAX_FRAME_BYTES {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar request exceeds the frame limit",
            ));
        }
        self.process.send(&frame).map_err(|error| {
            LocalRunnerError::invalid(format!(
                "ACPX sidecar request transport failed at {}: {error}",
                command.as_str()
            ))
        })?;
        self.next_request_id = request_id + 1;

        let deadline = Instant::now() + self.request_timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(self.request_timeout_error(command));
            }
            let Some(line) = self.receive_stdout_line(remaining, command.as_str())? else {
                return Err(self.request_timeout_error(command));
            };
            match parse_frame(&line)? {
                ParsedFrame::Event(event) => self.buffer_event(event)?,
                ParsedFrame::Response(response) => {
                    if response.id != request_id {
                        return Err(LocalRunnerError::invalid(format!(
                            "ACPX sidecar response id mismatch: expected {request_id}, received {}",
                            response.id
                        )));
                    }
                    if response.ok {
                        return Ok(CommandOutcome::Success(
                            response.result.unwrap_or_else(|| json!({})),
                        ));
                    }
                    let error = response.error.expect("failed response has validated error");
                    return Ok(CommandOutcome::Rejected(LocalRunnerError::invalid(
                        format!(
                            "ACPX sidecar command {} was rejected (retryable={}, classification={})",
                            command.as_str(),
                            error.retryable,
                            response_error_classification(&error),
                        ),
                    )));
                }
            }
        }
    }

    fn poll_event_inner(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<AcpxSidecarEvent>, LocalRunnerError> {
        let Some(line) = self.receive_stdout_line(timeout, "event.poll")? else {
            return Ok(None);
        };
        match parse_frame(&line)? {
            ParsedFrame::Event(event) => {
                self.validate_event_sequence(event.sequence)?;
                Ok(Some(event))
            }
            ParsedFrame::Response(response) => Err(LocalRunnerError::invalid(format!(
                "ACPX sidecar emitted response {} without a pending request",
                response.id
            ))),
        }
    }

    fn receive_stdout_line(
        &mut self,
        timeout: Duration,
        stage: &str,
    ) -> Result<Option<String>, LocalRunnerError> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.process.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_diagnostic(&line));
                }
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(format!(
                        "ACPX sidecar stdout failed at {stage}: {}{}",
                        message,
                        self.diagnostic_suffix()
                    )));
                }
                Ok(ProcessOutput::StdoutClosed) => return Err(self.closed_error(stage)),
                Ok(ProcessOutput::StderrClosed) => {}
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(LocalRunnerError::invalid(format!(
                        "ACPX sidecar output channel closed at {stage}{}",
                        self.diagnostic_suffix()
                    )));
                }
            }
        }
    }

    fn buffer_event(&mut self, event: AcpxSidecarEvent) -> Result<(), LocalRunnerError> {
        if self.buffered_events.len() >= MAX_BUFFERED_EVENTS {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar exceeded the buffered event limit",
            ));
        }
        self.validate_event_sequence(event.sequence)?;
        self.buffered_events.push_back(event);
        Ok(())
    }

    fn validate_event_sequence(&mut self, sequence: u64) -> Result<(), LocalRunnerError> {
        let expected = self.last_event_sequence + 1;
        if sequence != expected {
            let disposition = if sequence <= self.last_event_sequence {
                "replayed"
            } else {
                "has a gap"
            };
            return Err(LocalRunnerError::invalid(format!(
                "ACPX sidecar event sequence {disposition}: expected {expected}, received {sequence}"
            )));
        }
        self.last_event_sequence = sequence;
        Ok(())
    }

    fn request_timeout_error(&self, command: GeneratedAcpxSidecarCommand) -> LocalRunnerError {
        LocalRunnerError::invalid(format!(
            "ACPX sidecar request timed out at {}{}",
            command.as_str(),
            self.diagnostic_suffix()
        ))
    }

    fn closed_error(&mut self, stage: &str) -> LocalRunnerError {
        self.drain_diagnostics(Duration::from_millis(20));
        let suffix = self.diagnostic_suffix();
        match self.process.try_wait() {
            Ok(Some(exit)) => LocalRunnerError::invalid(format!(
                "ACPX sidecar exited at {stage}: exitCode={:?} signal={:?}{suffix}",
                exit.exit_code, exit.signal
            )),
            Ok(None) => {
                LocalRunnerError::invalid(format!("ACPX sidecar closed stdout at {stage}{suffix}"))
            }
            Err(error) => LocalRunnerError::invalid(format!(
                "ACPX sidecar status failed at {stage}: {error}{suffix}"
            )),
        }
    }

    fn drain_diagnostics(&mut self, max_wait: Duration) {
        let deadline = Instant::now() + max_wait;
        loop {
            let output = if max_wait.is_zero() {
                self.process.try_recv().ok()
            } else {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    None
                } else {
                    self.process.recv_timeout(remaining).ok()
                }
            };
            match output {
                Some(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_diagnostic(&line));
                }
                Some(ProcessOutput::StderrClosed) | None => break,
                Some(ProcessOutput::Stdout(_))
                | Some(ProcessOutput::StdoutError(_))
                | Some(ProcessOutput::StdoutClosed) => {}
            }
        }
    }

    fn diagnostic_suffix(&self) -> String {
        let diagnostics = self.stderr_tail.snapshot().lines.join("\n");
        if diagnostics.is_empty() {
            String::new()
        } else {
            format!(" stderrTail={diagnostics:?}")
        }
    }

    fn poison(&mut self) {
        if self.poisoned {
            return;
        }
        self.poisoned = true;
        self.buffered_events.clear();
        let _ = self.process.terminate_group();
    }
}

enum CommandOutcome {
    Success(Value),
    Rejected(LocalRunnerError),
}

enum ParsedFrame {
    Response(ResponseFrame),
    Event(AcpxSidecarEvent),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseFrame {
    protocol_version: u64,
    id: u64,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ResponseError>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResponseError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventFrame {
    protocol_version: u64,
    sequence: u64,
    event_type: GeneratedAcpxSidecarEventType,
    run_id: Value,
    turn_id: Value,
    payload: Value,
}

fn parse_frame(line: &str) -> Result<ParsedFrame, LocalRunnerError> {
    let value: Value = serde_json::from_str(line)
        .map_err(|_| LocalRunnerError::invalid("ACPX sidecar emitted invalid JSON"))?;
    let object = value
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("ACPX sidecar frame must be an object"))?;
    if object.contains_key("eventType") {
        let frame: EventFrame = serde_json::from_value(value)
            .map_err(|_| LocalRunnerError::invalid("ACPX sidecar event frame is invalid"))?;
        if frame.protocol_version != GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event protocol version mismatch",
            ));
        }
        if frame.sequence == 0 || frame.sequence > MAX_JSON_SAFE_INTEGER {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event sequence is invalid",
            ));
        }
        let run_id = nullable_identifier(frame.run_id, "event runId", SHORT_STABLE_ID_CHARS)?;
        let turn_id = nullable_identifier(frame.turn_id, "event turnId", DURABLE_STABLE_ID_CHARS)?;
        if !frame.payload.is_object() {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar event payload must be an object",
            ));
        }
        return Ok(ParsedFrame::Event(AcpxSidecarEvent {
            sequence: frame.sequence,
            event_type: frame.event_type,
            run_id,
            turn_id,
            payload: frame.payload,
        }));
    }

    let result_is_present = object.contains_key("result");
    let error_is_present = object.contains_key("error");
    if result_is_present && !object.get("result").is_some_and(Value::is_object) {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar response result must be an object",
        ));
    }
    if error_is_present && !object.get("error").is_some_and(Value::is_object) {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar response error must be an object",
        ));
    }
    let frame: ResponseFrame = serde_json::from_value(value)
        .map_err(|_| LocalRunnerError::invalid("ACPX sidecar response frame is invalid"))?;
    if frame.protocol_version != GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar response protocol version mismatch",
        ));
    }
    if frame.id == 0 || frame.id > MAX_JSON_SAFE_INTEGER {
        return Err(LocalRunnerError::invalid(
            "ACPX sidecar response id is invalid",
        ));
    }
    if frame.ok {
        if error_is_present {
            return Err(LocalRunnerError::invalid(
                "successful ACPX sidecar response contains an error",
            ));
        }
    } else if result_is_present || !error_is_present || frame.error.is_none() {
        return Err(LocalRunnerError::invalid(
            "failed ACPX sidecar response has an invalid result/error shape",
        ));
    }
    if let Some(error) = frame.error.as_ref() {
        if error.code.is_empty()
            || error.code.chars().count() > 160
            || !error
                .code
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
            || error.message.chars().count() > 8_192
        {
            return Err(LocalRunnerError::invalid(
                "ACPX sidecar response error exceeds its contract bounds",
            ));
        }
    }
    Ok(ParsedFrame::Response(frame))
}

fn nullable_identifier(
    value: Value,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, LocalRunnerError> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_str() else {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX sidecar {field} must be a string or null"
        )));
    };
    if !is_stable_id(value, max_chars) {
        return Err(LocalRunnerError::invalid(format!(
            "ACPX sidecar {field} is invalid"
        )));
    }
    Ok(Some(value.to_owned()))
}

fn redact_diagnostic(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        "[REDACTED]".to_owned()
    }
}

fn response_error_classification(error: &ResponseError) -> &'static str {
    match error.code.as_str() {
        "ACP_MODEL_UNSUPPORTED" => return "requested_model_unsupported",
        "AGENT_STARTUP_FAILED" => return "agent_startup_failed",
        "AGENT_STARTUP_FAILED.UNVERIFIED_MODULE" => return "agent_startup_unverified_module",
        "AGENT_STARTUP_FAILED.MODULE_NOT_FOUND" => return "agent_startup_module_not_found",
        "AGENT_STARTUP_FAILED.PERMISSION_DENIED" => return "agent_startup_permission_denied",
        "AGENT_STARTUP_FAILED.FILE_NOT_FOUND" => return "agent_startup_file_not_found",
        "AGENT_STARTUP_FAILED.SYNTAX_ERROR" => return "agent_startup_syntax_error",
        "AGENT_STARTUP_FAILED.INVALID_ARGUMENT" => return "agent_startup_invalid_argument",
        "AGENT_STARTUP_FAILED.NO_STDERR" => return "agent_startup_no_stderr",
        "AGENT_STARTUP_FAILED.SIGNAL" => return "agent_startup_signal",
        "AGENT_STARTUP_FAILED.EXIT_NONZERO" => return "agent_startup_exit_nonzero",
        "AGENT_STARTUP_FAILED.OTHER" => return "agent_startup_other",
        "AGENT_DISCONNECTED" => return "agent_disconnected",
        "AUTH_REQUIRED" => return "authentication_required",
        "SESSION_RESUME_REQUIRED" => return "session_resume_required",
        "SESSION_MODE_REPLAY_FAILED" => return "session_mode_replay_failed",
        "SESSION_MODEL_REPLAY_FAILED" => return "session_model_replay_failed",
        "SESSION_CONFIG_OPTION_REPLAY_FAILED" => return "session_config_option_replay_failed",
        "CLAUDE_ACP_SESSION_CREATE_TIMEOUT" => return "claude_session_create_timeout",
        "ACPX_SESSION_HANDSHAKE_TIMEOUT" => return "session_handshake_timeout",
        "ACPX_SESSION_ENSURE_FAILED" => return "session_ensure_failed",
        "ACPX_SESSION_ENSURE_TYPE_ERROR" => return "session_ensure_type_error",
        "ACPX_SESSION_ENSURE_NON_ERROR" => return "session_ensure_non_error",
        "ACP_SESSION_INIT_FAILED" => return "acp_session_init_failed",
        "NO_SESSION" => return "acpx_no_session",
        "TIMEOUT" => return "acpx_timeout",
        "PERMISSION_DENIED" => return "acpx_permission_denied",
        "PERMISSION_PROMPT_UNAVAILABLE" => return "acpx_permission_prompt_unavailable",
        "RUNTIME" => return "acpx_runtime_failure",
        "USAGE" => return "acpx_usage_failure",
        "ACPX_RUNTIME_ADMISSION_VERIFICATION_TIMEOUT" => {
            return "runtime_admission_verification_timeout"
        }
        "ACPX_SIDECAR_STATUS_READ_TIMEOUT" => return "session_status_read_timeout",
        "ACPX_PERSISTED_SESSION_MISSING" => return "persisted_session_missing",
        "ACPX_PERSISTED_SESSION_IDENTITY_MISMATCH" => return "persisted_session_identity_mismatch",
        "ACPX_MODEL_STATUS_UNAVAILABLE" => return "model_status_unavailable",
        "ACPX_MODEL_SELECTION_UNAVAILABLE" => return "model_selection_unavailable",
        "ACPX_EFFECTIVE_MODEL_MISMATCH" => return "effective_model_mismatch",
        _ => {}
    }
    match error.message.as_str() {
        "ACPX session handshake exceeded its admission deadline" => "session_handshake_timeout",
        "ACPX provider lifetime guardian exited before ownership transfer" => {
            "provider_guardian_exit"
        }
        "ACPX provider lifetime guardian ownership timed out" => "provider_guardian_timeout",
        "ACPX session handshake and runtime cleanup failed" => "session_handshake_cleanup_failed",
        "ACPX runtime initialization and cleanup failed" => "runtime_initialization_cleanup_failed",
        _ if error
            .message
            .starts_with("ACP agent exited before initialize completed") =>
        {
            "agent_startup_failed"
        }
        _ if error.message.starts_with("Failed to spawn agent command:") => "agent_spawn_failed",
        _ if error
            .message
            .starts_with("ACP agent disconnected during request") =>
        {
            "agent_disconnected"
        }
        _ if error.message.starts_with("Authentication required") => "authentication_required",
        _ => "unclassified",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frame_does_not_echo_untrusted_deserialization_details() {
        let cases = [
            (
                json!({
                    "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
                    "id": 1,
                    "ok": true,
                    "result": {},
                    "opaque_field_canary_Q7Z9": true,
                })
                .to_string(),
                "ACPX sidecar response frame is invalid",
            ),
            (
                json!({
                    "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
                    "sequence": 1,
                    "eventType": "opaque_variant_canary_Q7Z9",
                    "runId": null,
                    "turnId": null,
                    "payload": {},
                })
                .to_string(),
                "ACPX sidecar event frame is invalid",
            ),
            (
                r#"{"opaque_json_canary_Q7Z9":"#.to_owned(),
                "ACPX sidecar emitted invalid JSON",
            ),
        ];

        for (input, expected) in cases {
            let message = match parse_frame(&input) {
                Ok(_) => panic!("untrusted frame must be rejected"),
                Err(error) => error.to_string(),
            };
            assert!(message.contains(expected), "unexpected error: {message}");
            assert!(!message.contains("Q7Z9"), "error leaked input: {message}");
        }
    }

    #[test]
    fn classifies_only_allowlisted_internal_sidecar_failures() {
        let error = |code: &str, message: &str| ResponseError {
            code: code.to_owned(),
            message: message.to_owned(),
            retryable: false,
        };
        assert_eq!(
            response_error_classification(&error(
                "acpx_sidecar_command_failed",
                "ACPX session handshake exceeded its admission deadline",
            )),
            "session_handshake_timeout"
        );
        assert_eq!(
            response_error_classification(&error(
                "ACPX_SESSION_HANDSHAKE_TIMEOUT",
                "bounded provider admission failed",
            )),
            "session_handshake_timeout"
        );
        let admission_failures = [
            (
                "ACPX_RUNTIME_ADMISSION_VERIFICATION_TIMEOUT",
                "runtime_admission_verification_timeout",
            ),
            ("ACPX_SESSION_ENSURE_FAILED", "session_ensure_failed"),
            (
                "ACPX_SESSION_ENSURE_TYPE_ERROR",
                "session_ensure_type_error",
            ),
            ("ACPX_SESSION_ENSURE_NON_ERROR", "session_ensure_non_error"),
            ("ACP_SESSION_INIT_FAILED", "acp_session_init_failed"),
            ("NO_SESSION", "acpx_no_session"),
            ("TIMEOUT", "acpx_timeout"),
            ("PERMISSION_DENIED", "acpx_permission_denied"),
            (
                "PERMISSION_PROMPT_UNAVAILABLE",
                "acpx_permission_prompt_unavailable",
            ),
            ("RUNTIME", "acpx_runtime_failure"),
            ("USAGE", "acpx_usage_failure"),
            (
                "ACPX_SIDECAR_STATUS_READ_TIMEOUT",
                "session_status_read_timeout",
            ),
            (
                "ACPX_PERSISTED_SESSION_MISSING",
                "persisted_session_missing",
            ),
            (
                "ACPX_PERSISTED_SESSION_IDENTITY_MISMATCH",
                "persisted_session_identity_mismatch",
            ),
            ("ACPX_MODEL_STATUS_UNAVAILABLE", "model_status_unavailable"),
            (
                "ACPX_MODEL_SELECTION_UNAVAILABLE",
                "model_selection_unavailable",
            ),
            ("ACPX_EFFECTIVE_MODEL_MISMATCH", "effective_model_mismatch"),
        ];
        for (code, classification) in admission_failures {
            assert_eq!(
                response_error_classification(&error(code, "violet-circuit-4821")),
                classification,
            );
        }
        assert_eq!(
            response_error_classification(&error("ACP_MODEL_UNSUPPORTED", "violet-circuit-4821",)),
            "requested_model_unsupported"
        );
        assert_eq!(
            response_error_classification(&error(
                "acpx_sidecar_command_failed",
                "ACP agent exited before initialize completed (exit=1, signal=null): violet-circuit-4821",
            )),
            "agent_startup_failed"
        );
        assert_eq!(
            response_error_classification(&error("VIOLET_CIRCUIT", "violet-circuit-4821")),
            "unclassified"
        );
    }
}
