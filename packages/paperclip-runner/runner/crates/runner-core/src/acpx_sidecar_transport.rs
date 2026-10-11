use std::collections::{BTreeSet, VecDeque};
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
    session_open_timeout: Duration,
    next_request_id: u64,
    last_event_sequence: u64,
    buffered_events: VecDeque<AcpxSidecarEvent>,
    stderr_tail: BoundedLogBuffer,
    stderr_categories: BTreeSet<&'static str>,
    admission_diagnostic: Option<(&'static str, u64)>,
    poisoned: bool,
}

// A fresh Pi process verifies and copies its native closure before ACP admission.
// Reopen/recovery uses the same path. Ordinary sidecar requests retain their bound.
fn session_open_timeout(agent: &str, ordinary: Duration) -> Duration {
    if agent == "pi" {
        Duration::from_secs(60)
    } else {
        ordinary
    }
}

// Pi's provider catalog is caller-selected. The authenticated controller binds
// credential names (including custom models.json references); a Rust provider
// roster would silently drop credentials before the sidecar can validate them.
fn pi_credential_environment_keys(binding: Option<&str>) -> Result<Vec<String>, LocalRunnerError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Binding {
        schema: String,
        agent: String,
        session_id: String,
        names: Vec<String>,
    }
    let invalid = || LocalRunnerError::invalid("Pi credentials require a valid controller binding");
    let Some(raw) = binding else {
        return Ok(Vec::new());
    };
    if raw.len() > 4_096 {
        return Err(invalid());
    }
    let value: Binding = serde_json::from_str(raw).map_err(|_| invalid())?;
    if value.schema != "paperclip.acpx_credential_binding.v1"
        || value.agent != "pi"
        || !is_stable_id(&value.session_id, SHORT_STABLE_ID_CHARS)
        || value.names.len() > 128
    {
        return Err(invalid());
    }
    let mut seen = BTreeSet::new();
    for name in &value.names {
        let valid_name = name.len() <= 128
            && name.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
            && name
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_');
        // Match pi-provider-config.ts: prefixes such as LD_API_KEY are valid
        // credentials; only the reserved process controls are rejected.
        let protected_name = (name.starts_with("PAPERCLIP_") && name != "PAPERCLIP_PI_PROVIDERS")
            || name.starts_with("NODE_")
            || name.starts_with("NPM_")
            || matches!(
                name.as_str(),
                "PATH"
                    | "HOME"
                    | "SHELL"
                    | "TMPDIR"
                    | "BASH_ENV"
                    | "ENV"
                    | "ZDOTDIR"
                    | "LD_AUDIT"
                    | "LD_LIBRARY_PATH"
                    | "LD_PRELOAD"
                    | "LD_DEBUG"
                    | "LD_DEBUG_OUTPUT"
                    | "LD_PROFILE"
                    | "LD_PROFILE_OUTPUT"
                    | "LD_TRACE_LOADED_OBJECTS"
                    | "LD_ORIGIN_PATH"
                    | "LD_BIND_NOW"
                    | "LD_BIND_NOT"
                    | "LD_DYNAMIC_WEAK"
                    | "LD_HWCAP_MASK"
                    | "LD_SHOW_AUXV"
                    | "LD_USE_LOAD_BIAS"
                    | "LD_VERBOSE"
                    | "LD_WARN"
                    | "LD_ASSUME_KERNEL"
                    | "LD_PREFER_MAP_32BIT_EXEC"
                    | "DYLD_INSERT_LIBRARIES"
                    | "DYLD_LIBRARY_PATH"
                    | "DYLD_FRAMEWORK_PATH"
                    | "DYLD_FALLBACK_LIBRARY_PATH"
                    | "DYLD_FALLBACK_FRAMEWORK_PATH"
                    | "DYLD_VERSIONED_LIBRARY_PATH"
                    | "DYLD_VERSIONED_FRAMEWORK_PATH"
                    | "DYLD_ROOT_PATH"
                    | "DYLD_IMAGE_SUFFIX"
                    | "DYLD_SHARED_CACHE_DIR"
                    | "GLIBC_TUNABLES"
                    | "GCONV_PATH"
                    | "LOCPATH"
                    | "NLSPATH"
                    | "AWS_ACCESS_KEY_ID"
                    | "AWS_SECRET_ACCESS_KEY"
                    | "AWS_SESSION_TOKEN"
            );
        if !valid_name || protected_name || !seen.insert(name) {
            return Err(invalid());
        }
    }
    // The sidecar still checks every name against Pi's pinned SDK/custom
    // configuration and the exact session.open identity before provider launch.
    Ok(value.names)
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
            "claude" => &[
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ANTHROPIC_AUTH_TOKEN",
                "AWS_BEARER_TOKEN_BEDROCK",
            ],
            "codex" => &[
                "OPENAI_API_KEY",
                "CODEX_API_KEY",
                "PAPERCLIP_AI_PROVIDER_KEY",
            ],
            "grok" => &["XAI_API_KEY", "PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET"],
            "pi" => &[],
            "cursor" => &["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
            "copilot" => &["COPILOT_GITHUB_TOKEN"],
            _ => {
                return Err(LocalRunnerError::invalid(
                    "ACPX sidecar credentials require a known agent profile",
                ))
            }
        };
        let mut keys = vec![
            "PAPERCLIP_AGENT_KEY_ID",
            "PAPERCLIP_AGENT_PUBLIC_KEY",
            "PAPERCLIP_AGENT_PRIVATE_KEY",
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
            // The qualified sidecar configures the runner-owned gateway. Keep
            // its credential with the name/URL; unrelated secrets stay excluded.
            "PAPERCLIP_NATIVE_MCP_TOKEN",
            "PAPERCLIP_ACPX_BUILTIN_ROOT",
            "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT",
            "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST",
        ];
        if matches!(agent, "pi" | "cursor" | "copilot") {
            // Credential values alone are not proof of an explicit task binding.
            // The sidecar checks this controller-minted provider/session marker.
            keys.push("PAPERCLIP_ACPX_CREDENTIAL_BINDING");
        }
        if agent == "claude" {
            keys.extend_from_slice(&[
                "ANTHROPIC_BASE_URL",
                "CLAUDE_CODE_USE_BEDROCK",
                "AWS_REGION",
                "AWS_DEFAULT_REGION",
                "AWS_EC2_METADATA_DISABLED",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "CLAUDE_CODE_SUBAGENT_MODEL",
            ]);
        }
        let pi_keys = if agent == "pi" {
            pi_credential_environment_keys(
                std::env::var("PAPERCLIP_ACPX_CREDENTIAL_BINDING")
                    .ok()
                    .as_deref(),
            )?
        } else {
            Vec::new()
        };
        keys.extend(pi_keys.iter().map(String::as_str));
        keys.extend_from_slice(credential_keys);
        // Pi owns a native distribution copy, including a pending refresh at
        // suspension. Allow its bounded cleanup to settle before group KILL;
        // the ordinary two-second grace can cut off deletion mid-tree.
        config.validate()?;
        let mut launch_config = config.clone();
        if agent == "pi" {
            launch_config.shutdown_grace = Duration::from_secs(30);
        }
        let mut transport = Self::start_with_environment_keys(&launch_config, &keys)?;
        transport.session_open_timeout = session_open_timeout(agent, config.request_timeout);
        Ok(transport)
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
            session_open_timeout: config.request_timeout,
            next_request_id: 1,
            last_event_sequence: 0,
            buffered_events: VecDeque::new(),
            stderr_tail: BoundedLogBuffer::new(32, 8 * 1024),
            stderr_categories: BTreeSet::new(),
            admission_diagnostic: None,
            poisoned: false,
        })
    }

    fn command_timeout(&self, command: GeneratedAcpxSidecarCommand) -> Duration {
        if command == GeneratedAcpxSidecarCommand::SessionOpen {
            self.session_open_timeout
        } else {
            self.request_timeout
        }
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

        let timeout = self.command_timeout(command);
        let deadline = Instant::now() + timeout;
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
                            "ACPX sidecar command {} was rejected (retryable={}, classification={}){}",
                            command.as_str(),
                            error.retryable,
                            response_error_classification(&error),
                            self.diagnostic_suffix(),
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
                    self.record_stderr(&line);
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
        if event.event_type == GeneratedAcpxSidecarEventType::RuntimeDiagnostic {
            if let (Some(code), Some(message)) = (
                event.payload.get("code").and_then(Value::as_str),
                event.payload.get("message").and_then(Value::as_str),
            ) {
                // These frames precede the response on stdout, unlike stderr
                // whose reader may deliver a matching diagnostic later.
                if let Some(progress) = parse_admission_diagnostic(&format!(
                    "[paperclip-acpx-sidecar] {code}: {message}"
                )) {
                    self.record_admission_diagnostic(progress);
                }
            }
        }
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
                    self.record_stderr(&line);
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
        let admission = admission_diagnostic_suffix(self.admission_diagnostic);
        let categories = if self.stderr_categories.is_empty() {
            String::new()
        } else {
            format!(
                " stderrCategories={}",
                self.stderr_categories
                    .iter()
                    .copied()
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        if diagnostics.is_empty() {
            format!("{admission}{categories}")
        } else {
            format!("{admission}{categories} stderrTail={diagnostics:?}")
        }
    }

    fn record_stderr(&mut self, line: &str) {
        // Only fixed categories cross this boundary. Raw errors, stack paths,
        // identifiers, and credential-bearing strings remain fully redacted.
        if let Some(progress) = parse_admission_diagnostic(line) {
            self.record_admission_diagnostic(progress);
        }
        self.stderr_categories
            .extend(stderr_diagnostic_categories(line));
        self.stderr_tail.push(redact_diagnostic(line));
    }

    fn record_admission_diagnostic(&mut self, progress: (&'static str, u64)) {
        // Preserve the failed step through cleanup and delayed duplicate stderr.
        // Neither channel may move the observed admission clock backwards.
        if self
            .admission_diagnostic
            .is_some_and(|current| progress.0 == "cleanup" || progress.1 < current.1)
        {
            return;
        }
        self.admission_diagnostic = Some(progress);
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

// Reuse the sidecar's diagnostic channel, retaining only a closed stage and
// bounded integer. Unknown lines remain fully redacted and never grant authority.
fn parse_admission_diagnostic(line: &str) -> Option<(&'static str, u64)> {
    let (stage, elapsed) = line
        .strip_prefix("[paperclip-acpx-sidecar] admission_")?
        .split_once(": elapsedMs=")?;
    let stage = match stage {
        "binding" => "binding",
        "installation" => "installation",
        "sandbox" => "sandbox",
        "lifetime" => "lifetime",
        "agent_files" => "agent_files",
        "skills" => "skills",
        "command" => "command",
        "tool_bridge" => "tool_bridge",
        "handshake" => "handshake",
        "verification" => "verification",
        "ready" => "ready",
        "cleanup" => "cleanup",
        _ => return None,
    };
    if elapsed.is_empty() || !elapsed.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let elapsed = elapsed.parse::<u64>().ok()?;
    (elapsed <= 3_600_000).then_some((stage, elapsed))
}

fn admission_diagnostic_suffix(progress: Option<(&'static str, u64)>) -> String {
    progress.map_or_else(String::new, |(stage, elapsed)| {
        format!(" admissionStage={stage} admissionElapsedMs={elapsed}")
    })
}

fn redact_diagnostic(value: &str) -> String {
    if value.is_empty() {
        String::new()
    } else {
        "[REDACTED]".to_owned()
    }
}

fn stderr_diagnostic_categories(value: &str) -> BTreeSet<&'static str> {
    const CATEGORIES: &[(&str, &str)] = &[
        ("TypeError", "javascript_type_error"),
        ("ReferenceError", "javascript_reference_error"),
        ("SyntaxError", "javascript_syntax_error"),
        ("RangeError", "javascript_range_error"),
        ("AssertionError", "javascript_assertion_error"),
        ("UnhandledPromiseRejection", "unhandled_rejection"),
        ("ERR_UNHANDLED_REJECTION", "unhandled_rejection"),
        ("ERR_UNHANDLED_ERROR", "unhandled_event_error"),
        ("ERR_INVALID_ARG_TYPE", "invalid_argument_type"),
        ("ERR_INVALID_ARG_VALUE", "invalid_argument_value"),
        ("ERR_STREAM_WRITE_AFTER_END", "stream_write_after_end"),
        ("ERR_STREAM_DESTROYED", "stream_destroyed"),
        ("ERR_IPC_CHANNEL_CLOSED", "ipc_channel_closed"),
        ("ERR_SOCKET_CLOSED", "socket_closed"),
        ("ERR_MODULE_NOT_FOUND", "module_not_found"),
        ("MODULE_NOT_FOUND", "module_not_found"),
        ("EPIPE", "broken_pipe"),
        ("ECONNRESET", "connection_reset"),
        ("EADDRINUSE", "address_in_use"),
        ("ENOENT", "file_not_found"),
        ("EACCES", "permission_denied"),
        ("EPERM", "permission_denied"),
        (
            "ACPX_PERSISTED_SESSION_IDENTITY_MISMATCH",
            "persisted_session_identity_mismatch",
        ),
        ("SESSION_RESUME_REQUIRED", "session_resume_required"),
    ];
    let mut categories: BTreeSet<&'static str> = value
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .filter_map(|token| {
            CATEGORIES
                .iter()
                .find_map(|(known, category)| (token == *known).then_some(*category))
        })
        .collect();
    if value.contains("triggerUncaughtException") && value.contains("fromPromise") {
        categories.insert("unhandled_rejection");
    }
    if value.contains("ACPX provider spawned after ownership admission was sealed") {
        categories.insert("provider_spawn_after_ownership_seal");
    }
    categories
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
        "ACPX_TOOL_CALL_STALE" => return "provider_tool_call_retired",
        "AUTH_REQUIRED" => return "authentication_required",
        "COPILOT_AUTH_REQUIRED" => return "authentication_required",
        "COPILOT_POLICY_VIOLATION" => return "copilot_policy_violation",
        "COPILOT_DETACHED_WORK_UNSUPPORTED" => return "copilot_detached_work_unsupported",
        "COPILOT_ENTITLEMENT_DENIED" => return "provider_entitlement_denied",
        "COPILOT_MODEL_UNAVAILABLE" => return "requested_model_unsupported",
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
        "ACPX provider spawned after ownership admission was sealed" => {
            "provider_spawn_after_ownership_seal"
        }
        "ACPX recovery identity conflicts with the immutable session configuration" => {
            "recovery_configuration_mismatch"
        }
        "ACPX recovery identity does not match the persisted runtime record" => {
            "recovery_identity_mismatch"
        }
        // Older pinned sidecars send these internal failures without a stable
        // code. Keep only closed categories: messages can contain filesystem
        // paths, provider output, or credentials and must never be surfaced.
        "ACPX sidecar already owns a session or its cleanup" => "sidecar_session_owned",
        "ACPX session profile differs from its initialization" => "sidecar_profile_mismatch",
        "assigned native MCP launch binding is unavailable" => "native_mcp_binding_unavailable",
        "Verified ACPX installation does not match its profile" => "installation_profile_mismatch",
        "ACP agent directory must be an absolute normalized registered path"
        | "ACP agent directory must be a real directory"
        | "ACP agent directory cannot be a filesystem root" => "agent_directory_invalid",
        "ACP agent directory overlaps protected runtime state" => "agent_directory_overlap",
        "ACP registered agent directory changed during provider lifetime" => {
            "agent_directory_changed"
        }
        "ACPX agent home must be a real directory" => "provider_home_invalid",
        "ACPX agent home permissions are unsafe" => "provider_home_permissions",
        "Managed Codex credential ownership could not be established" => {
            "provider_lifetime_admission_failed"
        }
        "ACPX recovery runtime directory is unavailable" => "recovery_directory_unavailable",
        "ACPX recovery runtime directory escaped its namespace" => "recovery_directory_escape",
        "ACPX recovery workspace record is unavailable" => "recovery_workspace_record_unavailable",
        "ACPX recovery workspace record is invalid" => "recovery_workspace_record_invalid",
        "ACPX recovery workspace record changed while read" => "recovery_workspace_record_changed",
        "ACPX recovery workspace is unavailable" => "recovery_workspace_unavailable",
        "ACPX sandbox path must be a real directory"
        | "ACPX sandbox directory changed during preparation"
        | "ACPX sandbox directory escaped its private parent" => "sandbox_directory_invalid",
        "runtime context asset root must be a directory"
        | "staged runtime context root must be a directory"
        | "staged runtime context asset must be a regular file"
        | "materialized runtime context root must be a directory"
        | "materialized runtime context asset must be a regular file" => {
            "runtime_asset_type_invalid"
        }
        "runtime context skill name must be a safe relative path"
        | "runtime context skill name must stay inside the skills home"
        | "runtime context skill names must not overlap" => "runtime_skill_name_invalid",
        "runtime context skills home must be a fresh destination" => {
            "runtime_skills_destination_exists"
        }
        _ if error
            .message
            .starts_with("runtime context asset contains a symlink: ") =>
        {
            "runtime_asset_symlink"
        }
        _ if error
            .message
            .starts_with("runtime context asset contains an unsupported file: ") =>
        {
            "runtime_asset_type_invalid"
        }
        _ if error.message.starts_with("ENOENT: ") => "filesystem_entry_missing",
        _ if error.message.starts_with("EACCES: ") || error.message.starts_with("EPERM: ") => {
            "filesystem_permission_denied"
        }
        _ if error.message.starts_with("ELOOP: ") => "filesystem_link_rejected",
        _ if error.message.starts_with("ENOTDIR: ") => "filesystem_not_directory",
        _ if error.message.starts_with("EROFS: ") => "filesystem_read_only",
        _ if error.message.starts_with("ENOSPC: ") => "filesystem_full",
        "ACPX provider lifetime lease is unavailable" => "provider_lifetime_unavailable",
        "Managed Codex credential home already has an active lease" => "provider_lifetime_owned",
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
    #[test]
    fn admission_diagnostics_accept_only_closed_stages_and_bounded_integer_timing() {
        assert_eq!(
            parse_admission_diagnostic(
                "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=321"
            ),
            Some(("handshake", 321))
        );
        for line in [
            "[paperclip-acpx-sidecar] admission_private-path: elapsedMs=321",
            "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=321 private-token",
            "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=-1",
            "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=NaN",
            "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=3600001",
            "[paperclip-acpx-sidecar] admission_handshake: elapsedMs=18446744073709551616",
            "private-prefix [paperclip-acpx-sidecar] admission_handshake: elapsedMs=321",
        ] {
            assert_eq!(parse_admission_diagnostic(line), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn admission_timeout_retains_last_safe_stage_without_untrusted_stderr() {
        let config = AcpxSidecarTransportConfig {
            command: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), "printf '%s\\n' '[paperclip-acpx-sidecar] admission_sandbox: elapsedMs=1' '[paperclip-acpx-sidecar] admission_handshake: elapsedMs=24' '[paperclip-acpx-sidecar] admission_handshake: elapsedMs=25 /private/token-canary' '[paperclip-acpx-sidecar] admission_cleanup: elapsedMs=26' >&2; sleep 2".into()],
            verified_launch: None,
            request_timeout: Duration::from_millis(200),
            shutdown_grace: Duration::from_millis(10),
        };
        let mut transport = AcpxSidecarTransport::start(&config).unwrap();
        let error = transport
            .request(GeneratedAcpxSidecarCommand::SessionOpen, json!({}))
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("request timed out at session.open"),
            "{error}"
        );
        assert!(
            error.contains("admissionStage=handshake admissionElapsedMs=24"),
            "{error}"
        );
        assert!(
            !error.contains("private") && !error.contains("token-canary"),
            "{error}"
        );
        assert!(transport
            .request(GeneratedAcpxSidecarCommand::SessionOpen, json!({}))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn admission_rejection_retains_sequenced_stage_and_preserves_buffered_frames() {
        let diagnostics = [
            ("admission_handshake", "elapsedMs=24"),
            ("admission_sandbox", "elapsedMs=1"),
            ("admission_handshake", "elapsedMs=25 /private/token-canary"),
            ("admission_cleanup", "elapsedMs=26"),
        ];
        let frames: Vec<Value> = diagnostics
            .iter()
            .enumerate()
            .map(|(index, (code, message))| {
                json!({
                    "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
                    "sequence": index + 1, "eventType": "runtime.diagnostic", "runId": null,
                    "turnId": null, "payload": { "code": code, "message": message },
                })
            })
            .collect();
        let response = json!({ "protocolVersion": GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
            "id": 1, "ok": false, "error": { "code": "UNKNOWN_PRIVATE_CODE",
            "message": "/private/token-canary", "retryable": false } });
        let lines = frames
            .iter()
            .chain(std::iter::once(&response))
            .map(|frame| format!("'{}'", frame))
            .collect::<Vec<_>>()
            .join(" ");
        let config = AcpxSidecarTransportConfig {
            command: PathBuf::from("/bin/sh"),
            args: vec![
                "-c".into(),
                format!("read request; printf '%s\\n' {lines}; sleep 2"),
            ],
            verified_launch: None,
            request_timeout: Duration::from_secs(2),
            shutdown_grace: Duration::from_millis(10),
        };
        let mut transport = AcpxSidecarTransport::start(&config).unwrap();
        let error = transport
            .request(GeneratedAcpxSidecarCommand::SessionOpen, json!({}))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("was rejected (retryable=false, classification=unclassified)"),
            "{error}"
        );
        assert!(
            error.contains("admissionStage=handshake admissionElapsedMs=24"),
            "{error}"
        );
        assert!(
            !error.contains("private")
                && !error.contains("canary")
                && !error.contains("UNKNOWN_PRIVATE_CODE"),
            "{error}"
        );
        assert!(!transport.poisoned);
        for frame in frames {
            let event = transport
                .poll_event(Duration::from_millis(1))
                .unwrap()
                .unwrap();
            assert_eq!(event.sequence, frame["sequence"].as_u64().unwrap());
            assert_eq!(event.payload, frame["payload"]);
        }
        assert!(transport.buffered_events.is_empty());
        // Delayed stderr must not regress the stage learned from sequenced stdout.
        transport.record_stderr("[paperclip-acpx-sidecar] admission_binding: elapsedMs=0");
        assert_eq!(transport.admission_diagnostic, Some(("handshake", 24)));
    }

    #[cfg(unix)]
    #[test]
    fn rejected_diagnostic_sequence_cannot_update_admission_progress() {
        let config = AcpxSidecarTransportConfig {
            command: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), "sleep 2".into()],
            verified_launch: None,
            request_timeout: Duration::from_secs(2),
            shutdown_grace: Duration::from_millis(10),
        };
        let mut transport = AcpxSidecarTransport::start(&config).unwrap();
        let error = transport
            .buffer_event(AcpxSidecarEvent {
                sequence: 2,
                event_type: GeneratedAcpxSidecarEventType::RuntimeDiagnostic,
                run_id: None,
                turn_id: None,
                payload: json!({"code":"admission_ready", "message":"elapsedMs=25"}),
            })
            .unwrap_err();
        assert!(error.to_string().contains("sequence has a gap"));
        assert_eq!(transport.admission_diagnostic, None);
        assert!(transport.buffered_events.is_empty());
    }

    #[test]
    fn pi_credentials_require_a_bounded_binding_without_process_control_variables() {
        assert!(pi_credential_environment_keys(None).unwrap().is_empty());
        for name in [
            "NODE_OPTIONS",
            "PATH",
            "HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "PAPERCLIP_NATIVE_MCP_TOKEN",
            "INVALID-NAME",
        ] {
            let binding = json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"pi", "sessionId":"session-1", "names":[name]});
            assert!(pi_credential_environment_keys(Some(&binding.to_string())).is_err());
        }
        for binding in [
            json!({"schema":"other", "agent":"pi", "sessionId":"session-1", "names":[]}),
            json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"cursor", "sessionId":"session-1", "names":[]}),
            json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"pi", "sessionId":"session-1", "names":["MY_PI_KEY", "MY_PI_KEY"]}),
            json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"pi", "sessionId":"session-1", "names":[], "extra":true}),
        ] {
            assert!(pi_credential_environment_keys(Some(&binding.to_string())).is_err());
        }
        assert!(pi_credential_environment_keys(Some(&"x".repeat(4_097))).is_err());
    }

    #[test]
    fn pi_loader_and_shell_controls_match_the_controller_reservations() {
        let names: Vec<String> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test-fixtures/pi-acp/reserved-credential-names.json"
        )))
        .unwrap();
        for name in names {
            let binding = json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"pi", "sessionId":"session-1", "names":[name]});
            assert!(pi_credential_environment_keys(Some(&binding.to_string())).is_err());
        }
    }

    #[test]
    fn pi_custom_credential_names_follow_the_controller_contract() {
        let names = vec!["LD_API_KEY", "DYLD_API_KEY", "MY_PI_SERVICE_KEY"];
        let binding = json!({"schema":"paperclip.acpx_credential_binding.v1", "agent":"pi", "sessionId":"session-1", "names":names});
        assert_eq!(
            pi_credential_environment_keys(Some(&binding.to_string())).unwrap(),
            names
        );
    }

    #[test]
    fn only_pi_cold_open_gets_the_longer_admission_budget() {
        let ordinary = Duration::from_secs(30);
        assert_eq!(
            session_open_timeout("pi", ordinary),
            Duration::from_secs(60)
        );
        for agent in ["claude", "codex", "grok", "cursor", "copilot"] {
            assert_eq!(session_open_timeout(agent, ordinary), ordinary);
        }
    }

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
    fn candidate_auth_diagnostics_use_only_closed_codes_and_never_provider_text() {
        for (code, expected) in [
            ("ACPX_TOOL_CALL_STALE", "provider_tool_call_retired"),
            ("ACPX_TOOL_CALL_STALE_EXTRA", "unclassified"),
            ("COPILOT_AUTH_REQUIRED", "authentication_required"),
            ("COPILOT_ENTITLEMENT_DENIED", "provider_entitlement_denied"),
            ("COPILOT_MODEL_UNAVAILABLE", "requested_model_unsupported"),
            ("COPILOT_AUTH_REQUIRED_EXTRA", "unclassified"),
            ("COPILOT_REQUEST_FAILED", "unclassified"),
            ("UNKNOWN_CANDIDATE_FAILURE", "unclassified"),
        ] {
            let error = ResponseError {
                code: code.to_owned(),
                message:
                    "private-token-canary COPILOT_AUTH_REQUIRED https://user:secret@example.invalid"
                        .to_owned(),
                retryable: false,
            };
            let classification = response_error_classification(&error);
            assert_eq!(classification, expected);
            assert!(!classification.contains("canary"));
            assert!(!classification.contains("secret"));
        }
    }

    #[test]
    fn pinned_sidecar_admission_failures_expose_only_closed_categories() {
        for (message, expected) in [
            (
                "ACP agent directory overlaps protected runtime state",
                "agent_directory_overlap",
            ),
            (
                "ACPX recovery workspace record is invalid",
                "recovery_workspace_record_invalid",
            ),
            (
                "ACPX agent home permissions are unsafe",
                "provider_home_permissions",
            ),
            (
                "assigned native MCP launch binding is unavailable",
                "native_mcp_binding_unavailable",
            ),
            (
                "runtime context skills home must be a fresh destination",
                "runtime_skills_destination_exists",
            ),
            (
                "runtime context asset contains a symlink: /private-token-canary",
                "runtime_asset_symlink",
            ),
            (
                "runtime context asset contains an unsupported file: /private-token-canary",
                "runtime_asset_type_invalid",
            ),
            (
                "ENOENT: no such file or directory, open '/private-token-canary'",
                "filesystem_entry_missing",
            ),
            (
                "EACCES: permission denied, open '/private-token-canary'",
                "filesystem_permission_denied",
            ),
            (
                "EPERM: operation not permitted '/private-token-canary'",
                "filesystem_permission_denied",
            ),
            (
                "ELOOP: too many symbolic links '/private-token-canary'",
                "filesystem_link_rejected",
            ),
            (
                "ENOTDIR: not a directory '/private-token-canary'",
                "filesystem_not_directory",
            ),
            (
                "EROFS: read-only filesystem '/private-token-canary'",
                "filesystem_read_only",
            ),
            (
                "ENOSPC: no space left '/private-token-canary'",
                "filesystem_full",
            ),
            ("private-token-canary ENOENT: missing", "unclassified"),
            ("ENOENT_EXTRA: private-token-canary", "unclassified"),
            (
                "ACP agent directory overlaps protected runtime state private-token-canary",
                "unclassified",
            ),
            (
                "unknown failure https://user:private-token-canary@example.invalid",
                "unclassified",
            ),
        ] {
            let error = ResponseError {
                code: "acpx_sidecar_command_failed".to_owned(),
                message: message.to_owned(),
                retryable: false,
            };
            let classification = response_error_classification(&error);
            assert_eq!(classification, expected);
            assert!(!classification.contains("private-token-canary"));
            assert!(!classification.contains('/'));
        }
        // An established stable code keeps precedence over incidental text.
        let error = ResponseError {
            code: "AUTH_REQUIRED".to_owned(),
            message: "ENOENT: private-token-canary".to_owned(),
            retryable: true,
        };
        assert_eq!(
            response_error_classification(&error),
            "authentication_required"
        );
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
        for (message, classification) in [
            (
                "ACPX recovery identity conflicts with the immutable session configuration",
                "recovery_configuration_mismatch",
            ),
            (
                "ACPX recovery identity does not match the persisted runtime record",
                "recovery_identity_mismatch",
            ),
            (
                "ACPX provider lifetime lease is unavailable",
                "provider_lifetime_unavailable",
            ),
        ] {
            assert_eq!(
                response_error_classification(&error("acpx_sidecar_command_failed", message)),
                classification
            );
            assert_eq!(
                response_error_classification(&error(
                    "acpx_sidecar_command_failed",
                    &format!("{message}: private-provider-detail")
                )),
                "unclassified"
            );
        }
        assert_eq!(
            response_error_classification(&error(
                "acpx_sidecar_command_failed",
                "Managed Codex credential home already has an active lease"
            )),
            "provider_lifetime_owned"
        );
        let admission_failures = [
            ("COPILOT_POLICY_VIOLATION", "copilot_policy_violation"),
            (
                "COPILOT_DETACHED_WORK_UNSUPPORTED",
                "copilot_detached_work_unsupported",
            ),
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
