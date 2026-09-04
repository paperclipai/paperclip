use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(test)]
use crate::durable::QualifiedLaunchArtifact;
use crate::durable::{redact_text, OpenCodeLaunchProfile};
use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::{
    is_node_interpreter, BoundedLogBuffer, ProcessOutput, SupervisedProcess,
    VerifiedProcessArgument, VerifiedProcessLaunch,
};
use crate::provider_bridge::{AuthorizedTool, DurableReplayFilter, ToolResult};
use crate::provider_events::normalized_codex_terminal_event_type;
use crate::qualified_launch::verify_launch_artifact;
use crate::question_response::validate_question_response;

pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const QUALIFIED_OPENCODE_VERSION: &str = "1.18.17";
const DEFAULT_PROVIDER_TRACE_MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_BUFFERED_MESSAGES: usize = 1_024;
const MAX_BUFFERED_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const OPENCODE_PROVIDER_ENVIRONMENT_KEYS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "PAPERCLIP_NATIVE_MCP_NAME",
    "PAPERCLIP_NATIVE_MCP_URL",
    "PAPERCLIP_NATIVE_MCP_TOKEN",
    "PAPERCLIP_OPENCODE_PERMISSION_MODE",
    "PAPERCLIP_OPENCODE_RUNTIME_DIR",
    "PAPERCLIP_RUNNER_INSTANCE_ID",
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_NORMALIZED_SESSION_ID",
    "PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH",
];
const TRUSTED_OPENCODE_EXECUTABLE_ARG: &str = "--paperclip-trusted-opencode-executable";
const MAX_PROVIDER_STDERR_LINES: usize = 32;
const MAX_PROVIDER_STDERR_BYTES: usize = 8 * 1024;
const MAX_INSTRUCTIONS_BYTES: usize = 1024 * 1024;
const MAX_PENDING_TOOL_REQUESTS: usize = 4_096;
const MAX_PENDING_TOOL_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMPLETED_TOOL_CALL_IDS: usize = 4_096;
const MAX_PENDING_RUNTIME_REQUESTS: usize = 128;
const MAX_PENDING_RUNTIME_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const OPENCODE_RUNTIME_REQUEST_METHOD: &str = "paperclip/runtimeRequest";
pub(crate) const MAX_SETTLED_PROVIDER_TURN_IDS: usize = 4_096;
type QuestionOptionLabels = BTreeMap<String, BTreeMap<String, String>>;
type QuestionSetMapping = (String, Value, QuestionOptionLabels);

#[derive(Clone)]
struct ProviderCompletionContract {
    revision: String,
    criterion_ids: Vec<String>,
}

fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    encoded
}

struct ProviderTraceSink {
    sender: Option<mpsc::SyncSender<String>>,
    writer: Option<thread::JoinHandle<()>>,
    writer_error: Arc<Mutex<Option<String>>>,
    next_frame_id: u64,
    next_debug_sequence: u64,
    captured_bytes: usize,
    max_bytes: usize,
    truncated: bool,
    incomplete_reason: Option<String>,
}

impl ProviderTraceSink {
    fn from_environment() -> Option<Self> {
        let trace_path = std::env::var_os("PAPERCLIP_PROVIDER_TRACE_PATH")?;
        let max_bytes = std::env::var("PAPERCLIP_PROVIDER_TRACE_MAX_BYTES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PROVIDER_TRACE_MAX_BYTES);
        Some(Self::at_path(trace_path.into(), max_bytes))
    }

    fn at_path(trace_path: PathBuf, max_bytes: usize) -> Self {
        // Trace delivery is deliberately bounded and lossy. A full spool or a
        // failed debug writer can mark evidence incomplete, but can never
        // backpressure provider execution or the durable PRP channel.
        let (sender, receiver) = mpsc::sync_channel::<String>(1_024);
        let writer_error = Arc::new(Mutex::new(None));
        let thread_error = Arc::clone(&writer_error);
        let writer = thread::spawn(move || {
            let result = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&trace_path)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut permissions = file.metadata()?.permissions();
                    permissions.set_mode(0o600);
                    fs::set_permissions(&trace_path, permissions)?;
                }
                for line in receiver {
                    file.write_all(line.as_bytes())?;
                    file.write_all(b"\n")?;
                }
                file.flush()
            })();
            if let Err(error) = result {
                if let Ok(mut slot) = thread_error.lock() {
                    *slot = Some(format!("trace_sidecar_write_failed:{error}"));
                }
            }
        });
        Self {
            sender: Some(sender),
            writer: Some(writer),
            writer_error,
            next_frame_id: 1,
            next_debug_sequence: 1,
            captured_bytes: 0,
            max_bytes,
            truncated: false,
            incomplete_reason: None,
        }
    }

    fn send_record(&mut self, mut value: Value) {
        let Some(sender) = self.sender.as_ref().cloned() else {
            return;
        };
        if let Some(object) = value.as_object_mut() {
            object.insert("debugChannel".to_owned(), json!("rust_native"));
            object.insert("debugSequence".to_owned(), json!(self.next_debug_sequence));
            self.next_debug_sequence += 1;
        }
        match sender.try_send(value.to_string()) {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                self.incomplete_reason = Some("trace_sidecar_spool_full".to_owned());
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.incomplete_reason = Some("trace_sidecar_channel_closed".to_owned());
                self.sender = None;
            }
        }
    }

    fn frame(&mut self, direction: &str, raw: &[u8]) -> Option<u64> {
        if self.captured_bytes.saturating_add(raw.len()) > self.max_bytes {
            self.truncated = true;
            return None;
        }
        let frame_id = self.next_frame_id;
        self.next_frame_id += 1;
        self.captured_bytes += raw.len();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string();
        self.send_record(json!({
            "kind": "frame",
            "schema": "paperclip.provider_trace_frame.v1",
            "frameId": frame_id,
            "timestamp": timestamp,
            "direction": direction,
            "transport": "stdio_jsonl",
            "provider": "codex",
            "byteLength": raw.len(),
            "digest": format!("sha256:{:x}", Sha256::digest(raw)),
            "rawBase64": base64_encode(raw),
        }));
        Some(frame_id)
    }

    fn interpretation(
        &mut self,
        frame_id: u64,
        stage: &str,
        rule_id: &str,
        disposition: &str,
        emitted_event_ids: Vec<String>,
        reason: &str,
    ) {
        self.send_record(json!({
            "kind": "interpretation",
            "schema": "paperclip.provider_trace_interpretation.v1",
            "frameId": frame_id,
            "stage": stage,
            "ruleId": rule_id,
            "disposition": disposition,
            "emittedEventIds": emitted_event_ids,
            "droppedFields": [],
            "fieldMappings": [],
            "reason": reason,
        }));
    }

    fn finish(&mut self) {
        if self.sender.is_none() && self.writer.is_none() {
            return;
        }
        let writer_reason = self
            .writer_error
            .lock()
            .ok()
            .and_then(|value| value.clone());
        let reason = self.incomplete_reason.clone().or(writer_reason);
        let status = if reason.is_some() {
            "incomplete"
        } else if self.truncated {
            "truncated"
        } else {
            "complete"
        };
        let acknowledged_debug_sequence = self.next_debug_sequence.saturating_sub(1);
        self.send_record(json!({
            "kind": "trace_status",
            "status": status,
            "acknowledgedDebugSequence": acknowledged_debug_sequence,
            "reason": reason.or_else(|| self.truncated.then(|| "provider_trace_max_bytes_exceeded".to_owned())),
        }));
        self.sender.take();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

impl Drop for ProviderTraceSink {
    fn drop(&mut self) {
        self.finish();
    }
}

fn default_approval_policy() -> String {
    "never".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    pub provider: String,
    pub driver: String,
    pub provider_version: String,
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub instructions: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
}

impl CodexProviderConfig {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if !matches!(
            (self.provider.as_str(), self.driver.as_str()),
            ("codex", "codex_app_server") | ("opencode", "opencode_server")
        ) {
            return Err(LocalRunnerError::invalid(
                "local runner provider must be codex through codex_app_server or opencode through opencode_server",
            ));
        }
        if self.provider_version.trim().is_empty() || self.provider_version.len() > 120 {
            return Err(LocalRunnerError::invalid(
                "Codex providerVersion is empty or oversized",
            ));
        }
        if self.provider == "opencode" && self.provider_version != QUALIFIED_OPENCODE_VERSION {
            return Err(LocalRunnerError::invalid(format!(
                "OpenCode providerVersion must equal the qualified {QUALIFIED_OPENCODE_VERSION} release",
            )));
        }
        if self.command.as_os_str().is_empty() {
            return Err(LocalRunnerError::invalid("Codex command is required"));
        }
        let cwd = Path::new(&self.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(LocalRunnerError::invalid(
                "Codex cwd must be an existing absolute directory",
            ));
        }
        if self.args.len() > 64
            || self.args.iter().any(|argument| {
                argument.len() > 4096 || argument.chars().any(|character| character == '\0')
            })
        {
            return Err(LocalRunnerError::invalid(
                "Codex arguments exceed the bounded launch contract",
            ));
        }
        if self
            .model
            .as_ref()
            .is_some_and(|model| model.is_empty() || model.len() > 240)
        {
            return Err(LocalRunnerError::invalid("Codex model is invalid"));
        }
        if self.provider == "opencode"
            && self
                .model
                .as_ref()
                .is_none_or(|model| !model.contains('/') || model.chars().any(char::is_control))
        {
            return Err(LocalRunnerError::invalid(
                "OpenCode model must be a qualified provider/model identifier",
            ));
        }
        if self.provider_session_id.as_ref().is_some_and(|session_id| {
            session_id.is_empty()
                || session_id.len() > 240
                || session_id.chars().any(char::is_control)
        }) {
            return Err(LocalRunnerError::invalid(
                "Codex providerSessionId is invalid",
            ));
        }
        if self.instructions.len() > MAX_INSTRUCTIONS_BYTES {
            return Err(LocalRunnerError::invalid(
                "Codex instructions exceed the 1 MiB limit",
            ));
        }
        if self.approval_policy != "never" {
            return Err(LocalRunnerError::invalid(
                "the initial Codex runner requires approvalPolicy=never; governed actions use PRP",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexProviderEvent {
    ToolCall {
        call_id: String,
        operation_id: String,
        input: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    RuntimeRequest {
        request_id: String,
        question_set: Value,
    },
    Exited {
        exit_code: Option<i32>,
        success: bool,
        completed_turn_authoritative: bool,
        completed_turn_observed_by_process: bool,
        completion_reconciles_exit: bool,
        process_generation: u64,
        completed_turn_process_generation: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CompletedTurnAuthority {
    process_generation: u64,
    provider_turn_id: String,
}

#[derive(Default)]
struct SettledProviderTurnIds {
    ids: BTreeSet<String>,
    filter: DurableReplayFilter,
}

impl SettledProviderTurnIds {
    fn insert(&mut self, provider_turn_id: String) -> bool {
        if self.contains(&provider_turn_id) {
            return true;
        }
        if self.ids.len() >= MAX_SETTLED_PROVIDER_TURN_IDS {
            return false;
        }
        self.ids.insert(provider_turn_id)
    }

    fn contains(&self, provider_turn_id: &str) -> bool {
        self.ids.contains(provider_turn_id)
    }

    fn at_capacity(&self) -> bool {
        self.ids.len() >= MAX_SETTLED_PROVIDER_TURN_IDS || !self.filter.is_empty()
    }

    fn restore(&mut self, provider_turn_id: String) -> Result<(), LocalRunnerError> {
        if !self.insert(provider_turn_id) {
            return Err(LocalRunnerError::invalid(
                "Codex restored provider turn identity epoch exceeded its exact capacity",
            ));
        }
        Ok(())
    }

    fn restore_all(
        &mut self,
        provider_turn_ids: impl IntoIterator<Item = String>,
        replay_filter: DurableReplayFilter,
    ) -> Result<(), LocalRunnerError> {
        replay_filter
            .validate()
            .map_err(|error| LocalRunnerError::invalid(error.to_string()))?;
        self.filter = replay_filter;
        for provider_turn_id in provider_turn_ids {
            if !self.insert(provider_turn_id) {
                return Err(LocalRunnerError::invalid(
                    "Codex restored provider turn identity epoch exceeded its exact capacity",
                ));
            }
        }
        Ok(())
    }
}

enum ProviderRequestError {
    Rejected(LocalRunnerError),
    Ambiguous(LocalRunnerError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RejectedAcceptedTurn {
    ReusedIdentity(String),
    InvalidIdentity,
}

impl ProviderRequestError {
    fn into_inner(self) -> LocalRunnerError {
        match self {
            Self::Rejected(error) | Self::Ambiguous(error) => error,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct PendingToolRequest {
    rpc_id: Value,
    operation_id: String,
    input: Value,
    retained_bytes: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct PendingRuntimeRequest {
    rpc_id: Value,
    turn_id: String,
    method: String,
    params: Value,
    question_set: Value,
    option_labels: QuestionOptionLabels,
    retained_bytes: usize,
}

struct BufferedProviderMessage {
    value: Value,
    trace_frame_id: Option<u64>,
}

enum AmbiguousTurnMessage {
    Ready,
    Deferred,
    ReconciledWithStart,
    ReconciledNeedsStart { provider_turn_id: String },
}

pub struct CodexProvider {
    process: SupervisedProcess,
    stderr_tail: BoundedLogBuffer,
    config: CodexProviderConfig,
    authorized_tools: Vec<AuthorizedTool>,
    next_request_id: u64,
    thread_id: String,
    provider_session_id: Option<String>,
    active_provider_turn_id: Option<String>,
    pending_messages: VecDeque<BufferedProviderMessage>,
    deferred_ambiguous_messages: VecDeque<BufferedProviderMessage>,
    pending_message_bytes: usize,
    authorized_tool_ids: BTreeSet<String>,
    pending_tool_requests: BTreeMap<String, PendingToolRequest>,
    completed_tool_call_ids: BTreeSet<String>,
    durable_tool_call_replays: bool,
    pending_tool_request_bytes: usize,
    pending_runtime_requests: BTreeMap<String, PendingRuntimeRequest>,
    pending_runtime_request_bytes: usize,
    runtime_request_scope: [u8; 16],
    next_runtime_request_sequence: u64,
    expected_shutdown: bool,
    process_generation: u64,
    completed_turn_authority: Option<CompletedTurnAuthority>,
    completion_reconciliation_pending: bool,
    ambiguous_turn_start_pending: bool,
    settled_provider_turn_ids: SettledProviderTurnIds,
    rejected_accepted_turn: Option<RejectedAcceptedTurn>,
    quarantined: bool,
    trace: Option<ProviderTraceSink>,
    last_trace_frame_id: Option<u64>,
    opencode_launch_profile: Option<OpenCodeLaunchProfile>,
    completion_contract: Option<ProviderCompletionContract>,
}

impl CodexProvider {
    pub fn start(
        config: &CodexProviderConfig,
        resume_thread_id: Option<&str>,
    ) -> Result<Self, LocalRunnerError> {
        Self::start_with_tools_for_generation(
            config,
            std::iter::empty(),
            resume_thread_id,
            1,
            None,
            None,
        )
    }

    pub fn start_with_tools(
        config: &CodexProviderConfig,
        authorized_tools: impl IntoIterator<Item = AuthorizedTool>,
        resume_thread_id: Option<&str>,
    ) -> Result<Self, LocalRunnerError> {
        Self::start_with_tools_for_generation(
            config,
            authorized_tools,
            resume_thread_id,
            1,
            None,
            None,
        )
    }

    pub(crate) fn start_with_tools_for_generation(
        config: &CodexProviderConfig,
        authorized_tools: impl IntoIterator<Item = AuthorizedTool>,
        resume_thread_id: Option<&str>,
        process_generation: u64,
        opencode_launch_profile: Option<&OpenCodeLaunchProfile>,
        completion_contract: Option<(&str, &[String])>,
    ) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        if process_generation == 0 {
            return Err(LocalRunnerError::invalid(
                "Codex process generation must be positive",
            ));
        }
        let authorized_tools = authorized_tools.into_iter().collect::<Vec<_>>();
        let (dynamic_tools, authorized_tool_ids) =
            codex_dynamic_tools(authorized_tools.iter().cloned())?;
        let common_environment_keys = [
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
        ];
        let provider_environment_keys = if config.provider == "opencode" {
            OPENCODE_PROVIDER_ENVIRONMENT_KEYS
        } else {
            &["CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"][..]
        };
        let environment_keys = common_environment_keys
            .iter()
            .copied()
            .chain(provider_environment_keys.iter().copied())
            .collect::<Vec<_>>();
        let process = if config.provider == "opencode" {
            let profile = opencode_launch_profile.ok_or_else(|| {
                LocalRunnerError::invalid(
                    "OpenCode runner startup omitted its qualified launch profile",
                )
            })?;
            let proxy_script = profile.proxy_script.path.to_string_lossy();
            if config.command != profile.command.path
                || config.args.as_slice() != [proxy_script.as_ref()]
            {
                return Err(LocalRunnerError::invalid(
                    "OpenCode launch does not match the runner-owned qualified profile",
                ));
            }
            let launch = verified_opencode_launch(profile)?;
            SupervisedProcess::spawn_verified_with_environment_keys(
                &launch,
                Duration::from_secs(2),
                CODEX_APP_SERVER_MAX_FRAME_BYTES,
                &environment_keys,
            )?
        } else {
            SupervisedProcess::spawn_with_environment_keys(
                &config.command,
                &config.args,
                Duration::from_secs(2),
                CODEX_APP_SERVER_MAX_FRAME_BYTES,
                &environment_keys,
            )?
        };
        let mut provider = Self {
            process,
            stderr_tail: BoundedLogBuffer::new(
                MAX_PROVIDER_STDERR_LINES,
                MAX_PROVIDER_STDERR_BYTES,
            ),
            config: config.clone(),
            authorized_tools,
            next_request_id: 1,
            thread_id: String::new(),
            provider_session_id: None,
            active_provider_turn_id: None,
            pending_messages: VecDeque::new(),
            deferred_ambiguous_messages: VecDeque::new(),
            pending_message_bytes: 0,
            authorized_tool_ids,
            pending_tool_requests: BTreeMap::new(),
            completed_tool_call_ids: BTreeSet::new(),
            durable_tool_call_replays: false,
            pending_tool_request_bytes: 0,
            pending_runtime_requests: BTreeMap::new(),
            pending_runtime_request_bytes: 0,
            runtime_request_scope: new_runtime_request_scope()?,
            next_runtime_request_sequence: 1,
            expected_shutdown: false,
            process_generation,
            completed_turn_authority: None,
            completion_reconciliation_pending: false,
            ambiguous_turn_start_pending: false,
            settled_provider_turn_ids: SettledProviderTurnIds::default(),
            rejected_accepted_turn: None,
            quarantined: false,
            trace: ProviderTraceSink::from_environment(),
            last_trace_frame_id: None,
            opencode_launch_profile: opencode_launch_profile.cloned(),
            completion_contract: completion_contract.map(|(revision, criterion_ids)| {
                ProviderCompletionContract {
                    revision: revision.to_owned(),
                    criterion_ids: criterion_ids.to_vec(),
                }
            }),
        };
        let initialized = provider.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "paperclip-runnerd",
                    "title": "Paperclip Runner",
                    "version": "1",
                },
                "capabilities": {
                    "experimentalApi": true,
                    "requestAttestation": false,
                },
            }),
        )?;
        provider.send_frame(&json!({"method": "initialized"}))?;

        let mut params = json!({
            "cwd": config.cwd,
            "model": config.model,
            "approvalPolicy": config.approval_policy,
            "permissions": "paperclip-runner-workspace-only",
            "runtimeWorkspaceRoots": [config.cwd],
            "baseInstructions": config.instructions,
            "dynamicTools": dynamic_tools,
        });
        let params_object = params
            .as_object_mut()
            .expect("Codex thread parameters are an object");
        if config.provider == "opencode" {
            if let Some(contract) = provider.completion_contract.as_ref() {
                params_object.insert(
                    "completionContract".to_owned(),
                    json!({
                        "revision": contract.revision,
                        "criterionIds": contract.criterion_ids,
                    }),
                );
            }
        }
        let method = if let Some(thread_id) = resume_thread_id {
            params_object.insert("threadId".to_owned(), json!(thread_id));
            "thread/resume"
        } else {
            params_object.insert("experimentalRawEvents".to_owned(), json!(false));
            "thread/start"
        };
        let opened = provider.request(method, params)?;
        provider.thread_id = opened
            .pointer("/thread/id")
            .or_else(|| opened.get("threadId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LocalRunnerError::invalid(format!("Codex {method} omitted thread.id")))?
            .to_owned();
        if resume_thread_id.is_some_and(|expected| expected != provider.thread_id) {
            return Err(LocalRunnerError::invalid(
                "Codex resumed a different provider thread",
            ));
        }
        provider.provider_session_id = opened
            .pointer("/thread/sessionId")
            .or_else(|| initialized.pointer("/user/sessionId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);

        if resume_thread_id.is_some() {
            let snapshot = provider.read_thread()?;
            provider.active_provider_turn_id = latest_active_turn_id(&snapshot)
                .map(|provider_turn_id| bounded_provider_turn_id(Some(&provider_turn_id)))
                .transpose()?;
        }
        Ok(provider)
    }

    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub(crate) fn process_generation(&self) -> u64 {
        self.process_generation
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn provider_session_id(&self) -> Option<&str> {
        self.provider_session_id.as_deref()
    }

    pub(crate) fn take_provider_trace_frame_id(&mut self) -> Option<u64> {
        self.last_trace_frame_id.take()
    }

    pub(crate) fn record_provider_trace_interpretation(
        &mut self,
        frame_id: u64,
        rule_id: &str,
        disposition: &str,
        emitted_event_ids: Vec<String>,
        reason: &str,
    ) {
        if let Some(trace) = self.trace.as_mut() {
            trace.interpretation(
                frame_id,
                "rust_durable_normalization",
                rule_id,
                disposition,
                emitted_event_ids,
                reason,
            );
        }
    }

    pub fn active_provider_turn_id(&self) -> Option<&str> {
        self.active_provider_turn_id.as_deref()
    }

    pub(crate) fn ambiguous_turn_start_pending(&self) -> bool {
        self.ambiguous_turn_start_pending
    }

    pub(crate) fn enable_durable_tool_call_replays(&mut self) {
        // The durable backend validates the call id, operation, and input
        // against its persisted receipt before returning a stored result.
        // Direct provider consumers retain the stricter one-shot behavior.
        self.durable_tool_call_replays = true;
    }

    pub(crate) fn restore_completed_turn_authority(
        &mut self,
        authoritative: bool,
        process_generation: Option<u64>,
        provider_turn_id: Option<&str>,
    ) -> Result<(), LocalRunnerError> {
        self.completed_turn_authority = authoritative.then(|| CompletedTurnAuthority {
            // Legacy state did not record the generation. Generation zero is
            // deliberately older than every supervised process generation.
            process_generation: process_generation.unwrap_or(0),
            provider_turn_id: provider_turn_id
                .unwrap_or("durable-completed-turn")
                .to_owned(),
        });
        if let Some(authority) = self.completed_turn_authority.as_ref() {
            self.settled_provider_turn_ids
                .restore(authority.provider_turn_id.clone())?;
        }
        // Resuming a completed durable thread and reading its provider state
        // is recovery, not new turn work. Keep the prior terminal authoritative
        // until start_turn explicitly revokes it.
        self.expected_shutdown = authoritative;
        // Completion authority is durable across provider generations. Output,
        // probes, and process restarts are session-liveness observations; none
        // of them supersedes a completed result. Only accepting a replacement
        // turn identity revokes this authority.
        self.completion_reconciliation_pending = false;
        Ok(())
    }

    pub(crate) fn restore_settled_turn_identities(
        &mut self,
        provider_turn_ids: impl IntoIterator<Item = String>,
        replay_filter: DurableReplayFilter,
    ) -> Result<(), LocalRunnerError> {
        self.settled_provider_turn_ids
            .restore_all(provider_turn_ids, replay_filter)
    }

    pub(crate) fn completed_turn_authority(&self) -> Option<(u64, &str)> {
        self.completed_turn_authority.as_ref().map(|authority| {
            (
                authority.process_generation,
                authority.provider_turn_id.as_str(),
            )
        })
    }

    pub(crate) fn take_rejected_accepted_turn(&mut self) -> Option<RejectedAcceptedTurn> {
        self.rejected_accepted_turn.take()
    }

    pub(crate) fn restart_idle_identity_epoch(&mut self) -> Result<(), LocalRunnerError> {
        if self.active_provider_turn_id.is_some() || self.ambiguous_turn_start_pending {
            return Err(LocalRunnerError::invalid(
                "Codex provider identity epoch cannot rotate while work is active",
            ));
        }

        let next_generation = self.process_generation.checked_add(1).ok_or_else(|| {
            LocalRunnerError::invalid("Codex process generation exhausted during epoch rollover")
        })?;
        let config = self.config.clone();
        let authorized_tools = self.authorized_tools.clone();
        let thread_id = self.thread_id.clone();
        let completed_turn_authority = self.completed_turn_authority.clone();
        let completion_reconciliation_pending = self.completion_reconciliation_pending;
        let durable_tool_call_replays = self.durable_tool_call_replays;
        let completion_contract = self.completion_contract.clone();

        // Exact turn identities may be forgotten only after the provider
        // process that could emit them is gone. Resume the same thread in a
        // fresh process generation, then preserve prior completion authority
        // until a replacement turn identity is actually accepted.
        self.shutdown()?;
        let mut replacement = Self::start_with_tools_for_generation(
            &config,
            authorized_tools,
            Some(&thread_id),
            next_generation,
            self.opencode_launch_profile.as_ref(),
            completion_contract.as_ref().map(|contract| {
                (
                    contract.revision.as_str(),
                    contract.criterion_ids.as_slice(),
                )
            }),
        )?;
        replacement.durable_tool_call_replays = durable_tool_call_replays;
        if replacement.active_provider_turn_id.is_some() {
            // A terminal can race the provider's own durable idle-state write.
            // This process has work Paperclip never dispatched in the new
            // epoch, so revoke its request authority and reap it. Retain the
            // exact ledger for diagnostics, but never expose the unexpected
            // turn as ordinary active work or admit a replacement.
            replacement.settled_provider_turn_ids =
                std::mem::take(&mut self.settled_provider_turn_ids);
            replacement.active_provider_turn_id = None;
            replacement.ambiguous_turn_start_pending = true;
            replacement.rejected_accepted_turn = Some(RejectedAcceptedTurn::InvalidIdentity);
            replacement.quarantined = true;
            replacement.pending_messages.clear();
            replacement.deferred_ambiguous_messages.clear();
            replacement.pending_message_bytes = 0;
            let _ = replacement.cancel_pending_requests();
            let _ = replacement.process.terminate_group();
            replacement.expected_shutdown = false;
            *self = replacement;
            return Err(LocalRunnerError::invalid(
                "Codex provider epoch rollover resumed unowned active work; the provider was terminated",
            ));
        }
        if let Some(authority) = completed_turn_authority.as_ref() {
            replacement.restore_completed_turn_authority(
                true,
                Some(authority.process_generation),
                Some(&authority.provider_turn_id),
            )?;
        }
        replacement.completion_reconciliation_pending = completion_reconciliation_pending;
        *self = replacement;
        Ok(())
    }

    fn rollover_settled_turn_epoch_if_needed(&mut self) -> Result<(), LocalRunnerError> {
        if !self.settled_provider_turn_ids.at_capacity() {
            return Ok(());
        }
        self.restart_idle_identity_epoch()
    }

    pub fn start_turn(&mut self, message: &str, cwd: &str) -> Result<Value, LocalRunnerError> {
        if self.quarantined {
            return Err(LocalRunnerError::invalid(
                "Codex provider is quarantined after unsafe recovered work",
            ));
        }
        if self.active_provider_turn_id.is_some() {
            return Err(LocalRunnerError::invalid(
                "Codex already has an active provider turn",
            ));
        }
        if self.ambiguous_turn_start_pending {
            return Err(LocalRunnerError::invalid(
                "Codex has an unresolved ambiguous provider turn start",
            ));
        }
        if message.is_empty() || message.len() > MAX_INSTRUCTIONS_BYTES {
            return Err(LocalRunnerError::invalid(
                "Codex turn text is empty or exceeds the 1 MiB limit",
            ));
        }
        self.rollover_settled_turn_epoch_if_needed()?;
        // Preserve the prior durable result until a replacement turn identity
        // is accepted. A rejected, ambiguous, or transport-failed attempt does
        // not prove that replacement work superseded the completed turn.
        let prior_reconciliation_pending = self.completion_reconciliation_pending;
        self.completion_reconciliation_pending = false;
        let prior_buffered_message_count = self.pending_messages.len();
        self.ambiguous_turn_start_pending = true;
        let runtime_request_scope = new_runtime_request_scope()?;
        let result = match self.request_classified(
            "turn/start",
            json!({
                "threadId": self.thread_id,
                "cwd": cwd,
                "permissions": "paperclip-runner-workspace-only",
                "runtimeWorkspaceRoots": [cwd],
                "input": [{"type": "text", "text": message, "text_elements": []}],
            }),
        ) {
            Ok(result) => result,
            Err(ProviderRequestError::Rejected(error)) => {
                // A definite rejection proves no replacement work began.
                // Only diagnostics without provider-work identity belong to
                // that rejected request. Contradictory turn/item evidence or a
                // server request leaves the start ambiguous until a validated
                // replacement identity is observed.
                let definite_rejection = self
                    .pending_messages
                    .iter()
                    .skip(prior_buffered_message_count)
                    .all(|buffered| is_unbound_rejected_turn_diagnostic(&buffered.value));
                if definite_rejection {
                    self.ambiguous_turn_start_pending = false;
                    self.completion_reconciliation_pending = prior_reconciliation_pending;
                }
                return Err(error);
            }
            Err(ProviderRequestError::Ambiguous(error)) => return Err(error),
        };
        let provider_turn_id = result
            .pointer("/turn/id")
            .or_else(|| result.get("turnId"))
            .and_then(Value::as_str);
        let provider_turn_id = match bounded_provider_turn_id(provider_turn_id) {
            Ok(provider_turn_id) => provider_turn_id,
            Err(error) => {
                // A successful turn/start response means the provider may
                // already be executing the work. Without a bounded identity,
                // runnerd cannot durably bind, interrupt, or reconcile it.
                // Terminate the process and let the durable backend close the
                // run before returning the protocol error.
                self.rejected_accepted_turn = Some(RejectedAcceptedTurn::InvalidIdentity);
                self.expected_shutdown = true;
                self.completed_turn_authority = None;
                let _ = self.cancel_pending_requests();
                let _ = self.process.terminate_group();
                return Err(error);
            }
        };
        if self.settled_provider_turn_ids.contains(&provider_turn_id) {
            return Err(self.reject_accepted_reused_turn_identity(provider_turn_id));
        }
        // Only a validated provider turn identity proves that replacement
        // work exists and supersedes the prior completed result.
        self.accept_replacement_turn(provider_turn_id, runtime_request_scope);
        Ok(result)
    }

    fn classify_ambiguous_turn_message(
        &mut self,
        message: &Value,
    ) -> Result<AmbiguousTurnMessage, LocalRunnerError> {
        if !self.ambiguous_turn_start_pending {
            return Ok(AmbiguousTurnMessage::Ready);
        }

        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return Ok(AmbiguousTurnMessage::Deferred);
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let provider_turn_id = notification_turn_id(&params);
        let identity_required = matches!(method, "turn/started" | "turn/completed");
        if provider_turn_id.is_none() && !identity_required {
            return Ok(AmbiguousTurnMessage::Deferred);
        }
        validate_notification_binding(&self.thread_id, None, &params)?;
        let provider_turn_id =
            bounded_identifier(provider_turn_id, "Codex turn id").map_err(|_| {
                LocalRunnerError::invalid(format!(
                    "Codex {method} cannot resolve an ambiguous turn start without a valid turn id"
                ))
            })?;

        if self.settled_provider_turn_ids.contains(&provider_turn_id) {
            return Err(self.reject_accepted_reused_turn_identity(provider_turn_id));
        }

        let runtime_request_scope = new_runtime_request_scope()?;
        self.accept_replacement_turn(provider_turn_id.clone(), runtime_request_scope);
        if method == "turn/started" && message.get("id").is_none() {
            Ok(AmbiguousTurnMessage::ReconciledWithStart)
        } else {
            Ok(AmbiguousTurnMessage::ReconciledNeedsStart { provider_turn_id })
        }
    }

    fn accept_replacement_turn(
        &mut self,
        provider_turn_id: String,
        runtime_request_scope: [u8; 16],
    ) {
        self.ambiguous_turn_start_pending = false;
        self.expected_shutdown = false;
        self.completed_turn_authority = None;
        self.completion_reconciliation_pending = false;
        self.completed_tool_call_ids.clear();
        // Retain the prior settled identity while the next turn runs. Besides
        // recognizing delayed prior-turn requests, this fails closed if a
        // provider ambiguously reuses the same turn id for fresh work.
        self.active_provider_turn_id = Some(provider_turn_id);
        self.runtime_request_scope = runtime_request_scope;
    }

    fn reject_accepted_reused_turn_identity(
        &mut self,
        provider_turn_id: String,
    ) -> LocalRunnerError {
        // Both a successful response and identity-bearing evidence after an
        // ambiguous response prove the provider accepted work. A settled
        // identity cannot durably own that work, so terminate its process
        // before returning instead of leaving an untracked turn alive.
        self.rejected_accepted_turn = Some(RejectedAcceptedTurn::ReusedIdentity(provider_turn_id));
        self.expected_shutdown = true;
        self.completed_turn_authority = None;
        let _ = self.cancel_pending_requests();
        let _ = self.process.terminate_group();
        LocalRunnerError::invalid(
            "Codex reused a settled provider turn identity after accepting work; the provider was terminated",
        )
    }

    pub fn steer_turn(&mut self, message: &str) -> Result<Value, LocalRunnerError> {
        let turn_id = self
            .active_provider_turn_id
            .clone()
            .ok_or_else(|| LocalRunnerError::invalid("Codex has no active provider turn"))?;
        if message.is_empty() || message.len() > MAX_INSTRUCTIONS_BYTES {
            return Err(LocalRunnerError::invalid(
                "Codex steering text is empty or oversized",
            ));
        }
        self.request(
            "turn/steer",
            json!({
                "threadId": self.thread_id,
                "expectedTurnId": turn_id,
                "input": [{"type": "text", "text": message, "text_elements": []}],
            }),
        )
    }

    pub fn interrupt_turn(&mut self) -> Result<Value, LocalRunnerError> {
        let turn_id = self
            .active_provider_turn_id
            .clone()
            .ok_or_else(|| LocalRunnerError::invalid("Codex has no active provider turn"))?;
        self.cancel_pending_requests()?;
        self.request(
            "turn/interrupt",
            json!({"threadId": self.thread_id, "turnId": turn_id}),
        )
    }

    pub fn read_thread(&mut self) -> Result<Value, LocalRunnerError> {
        // Probing provider state does not supersede an authoritative terminal.
        // A later replacement turn must still establish its own identity.
        // It does prove the provider remained live after that terminal, so a
        // subsequent nonzero exit is a separate idle-session failure.
        self.completion_reconciliation_pending = false;
        self.request(
            "thread/read",
            json!({"threadId": self.thread_id, "includeTurns": true}),
        )
    }

    pub fn resolve_runtime_request(
        &mut self,
        request_id: &str,
        response: &Value,
    ) -> Result<(), LocalRunnerError> {
        let pending = self
            .pending_runtime_requests
            .get(request_id)
            .cloned()
            .ok_or_else(|| {
                LocalRunnerError::invalid("runtime response has no pending Codex request")
            })?;
        if self.active_provider_turn_id.as_deref() != Some(pending.turn_id.as_str()) {
            return Err(LocalRunnerError::invalid(
                "runtime response belongs to another Codex turn",
            ));
        }
        let result = codex_question_response(&pending, response)?;
        self.process
            .send(&json!({"id": pending.rpc_id, "result": result}))?;
        if let Some(completed) = self.pending_runtime_requests.remove(request_id) {
            self.pending_runtime_request_bytes = self
                .pending_runtime_request_bytes
                .saturating_sub(completed.retained_bytes);
        }
        Ok(())
    }

    fn reject_post_terminal_request(
        &mut self,
        rpc_id: Value,
        method: &str,
    ) -> Result<Option<CodexProviderEvent>, LocalRunnerError> {
        let message = format!(
            "ignored delayed {} request after the Codex turn terminated",
            bounded_method(method)
        );
        let response = if method == "item/tool/call" {
            json!({
                "id": rpc_id,
                "result": codex_tool_failure("the Codex turn has already terminated"),
            })
        } else if method == OPENCODE_RUNTIME_REQUEST_METHOD {
            json!({
                "id": rpc_id,
                "result": {"resolution": {"action": "cancel"}},
            })
        } else {
            json!({
                "id": rpc_id,
                "error": {"code": -32000, "message": "the Codex turn has already terminated"},
            })
        };
        // The terminal notification is already authoritative and may be
        // waiting in the durable outbox. A courtesy rejection must not turn a
        // provider that has closed stdin into a fatal polling error.
        let _ = self.send_frame(&response);
        Ok(Some(CodexProviderEvent::Notification {
            method: "warning".to_owned(),
            params: json!({"message": message, "providerMethod": bounded_method(method)}),
        }))
    }

    pub fn poll(&mut self) -> Result<Option<CodexProviderEvent>, LocalRunnerError> {
        if self.quarantined {
            // Never interpret provider-originated requests after fail-closed
            // quarantine. Drain output only so process termination cannot
            // deadlock on a full pipe, then surface an unequivocal failure.
            if self
                .process
                .receive_stdout_line(Duration::from_millis(1))?
                .is_some()
            {
                return Ok(None);
            }
            return Ok(self
                .process
                .try_wait()?
                .map(|exit| CodexProviderEvent::Exited {
                    exit_code: exit.exit_code,
                    success: false,
                    completed_turn_authoritative: false,
                    completed_turn_observed_by_process: false,
                    completion_reconciles_exit: false,
                    process_generation: self.process_generation,
                    completed_turn_process_generation: None,
                }));
        }
        let buffered = self.pending_messages.pop_front();
        if let Some(buffered) = buffered.as_ref() {
            self.pending_message_bytes = self.pending_message_bytes.saturating_sub(json_size(
                &buffered.value,
                "buffered Codex provider message",
            )?);
        }
        let (message, trace_frame_id) = if let Some(buffered) = buffered {
            (buffered.value, buffered.trace_frame_id)
        } else {
            let Some(line) = self.process.receive_stdout_line(Duration::from_millis(1))? else {
                let exit = self.process.try_wait()?;
                return if let Some(exit) = exit {
                    let completed_turn_authoritative = self.completed_turn_authority.is_some()
                        && self.active_provider_turn_id.is_none();
                    let completed_turn_observed_by_process = self
                        .completed_turn_authority
                        .as_ref()
                        .is_some_and(|authority| {
                            authority.process_generation == self.process_generation
                        });
                    // A durable terminal remains the run outcome, but it only
                    // reconciles the process generation that produced it. A
                    // later recovered provider can fail independently while
                    // leaving the already-recorded turn result intact.
                    let completion_reconciles_exit = completed_turn_authoritative
                        && completed_turn_observed_by_process
                        && self.completion_reconciliation_pending;
                    Ok(Some(CodexProviderEvent::Exited {
                        exit_code: exit.exit_code,
                        // A clean idle exit after a terminal is healthy. A
                        // nonzero exit still makes the provider unavailable,
                        // but the durable terminal reconciles it instead of
                        // allowing the session to fail retroactively. Fresh
                        // turn work explicitly revokes the prior authority.
                        // An unresolved start may already have created fresh
                        // work, so even a clean exit must fail that session.
                        success: exit.success
                            && !self.ambiguous_turn_start_pending
                            && (self.expected_shutdown || completed_turn_authoritative),
                        completed_turn_authoritative,
                        completed_turn_observed_by_process,
                        completion_reconciles_exit,
                        process_generation: self.process_generation,
                        completed_turn_process_generation: self
                            .completed_turn_authority
                            .as_ref()
                            .map(|authority| authority.process_generation),
                    }))
                } else {
                    Ok(None)
                };
            };
            let trace_frame_id = self.trace_inbound(&line);
            let message = parse_provider_message(&line).map_err(|error| {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), trace_frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.invalid",
                        "rejected",
                        Vec::new(),
                        "Provider frame was not valid JSON-RPC",
                    );
                }
                error
            })?;
            (message, trace_frame_id)
        };
        self.last_trace_frame_id = trace_frame_id;
        if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), trace_frame_id) {
            let method = message.get("method").and_then(Value::as_str);
            trace.interpretation(
                frame_id,
                "rust_jsonrpc_parse",
                if method == Some("item/tool/call") {
                    "codex.tool_call"
                } else if method.is_some() {
                    "codex.notification"
                } else {
                    "codex.unroutable"
                },
                if method.is_some() {
                    "mapped"
                } else {
                    "ignored"
                },
                Vec::new(),
                if method.is_some() {
                    "JSON-RPC frame parsed and routed to provider normalization"
                } else {
                    "JSON-RPC frame had no routable method"
                },
            );
        }

        if self.completed_turn_authority.is_some()
            && self.active_provider_turn_id.is_none()
            && message.get("method").and_then(Value::as_str) != Some("turn/completed")
        {
            // Output after the terminal proves the provider entered an idle
            // liveness phase. Keep the result authoritative, but do not let it
            // hide a later process failure.
            self.completion_reconciliation_pending = false;
        }

        match self.classify_ambiguous_turn_message(&message)? {
            AmbiguousTurnMessage::Ready => {}
            AmbiguousTurnMessage::Deferred => {
                if self
                    .pending_messages
                    .len()
                    .saturating_add(self.deferred_ambiguous_messages.len())
                    >= MAX_BUFFERED_MESSAGES
                {
                    return Err(LocalRunnerError::invalid(
                        "Codex emitted too many messages before resolving an ambiguous turn start",
                    ));
                }
                let retained_bytes = json_size(&message, "buffered Codex provider message")?;
                self.pending_message_bytes =
                    retain_buffered_message_bytes(self.pending_message_bytes, retained_bytes)
                        .ok_or_else(|| {
                            LocalRunnerError::invalid(
                                "Codex buffered messages exceed the 16 MiB aggregate limit",
                            )
                        })?;
                self.deferred_ambiguous_messages
                    .push_back(BufferedProviderMessage {
                        value: message,
                        trace_frame_id,
                    });
                return Ok(None);
            }
            AmbiguousTurnMessage::ReconciledWithStart => {
                let mut replay = std::mem::take(&mut self.deferred_ambiguous_messages);
                replay.append(&mut self.pending_messages);
                self.pending_messages = replay;
            }
            AmbiguousTurnMessage::ReconciledNeedsStart { provider_turn_id } => {
                let mut replay = std::mem::take(&mut self.deferred_ambiguous_messages);
                let retained_bytes = json_size(&message, "buffered Codex provider message")?;
                self.pending_message_bytes =
                    retain_buffered_message_bytes(self.pending_message_bytes, retained_bytes)
                        .ok_or_else(|| {
                            LocalRunnerError::invalid(
                                "Codex buffered messages exceed the 16 MiB aggregate limit",
                            )
                        })?;
                replay.push_back(BufferedProviderMessage {
                    value: message,
                    trace_frame_id,
                });
                replay.append(&mut self.pending_messages);
                self.pending_messages = replay;
                return Ok(Some(CodexProviderEvent::Notification {
                    method: "turn/started".to_owned(),
                    params: json!({
                        "threadId": self.thread_id,
                        "turn": {"id": provider_turn_id, "status": "inProgress"},
                        "reconciled": true,
                    }),
                }));
            }
        }

        if let (Some(rpc_id), Some(method)) = (
            message.get("id").cloned(),
            message.get("method").and_then(Value::as_str),
        ) {
            if method == "item/tool/call" {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id.as_str()) {
                    return Err(LocalRunnerError::invalid(
                        "Codex tool call named another thread",
                    ));
                }
                if request_targets_non_active_turn(
                    self.active_provider_turn_id.as_deref(),
                    &self.settled_provider_turn_ids,
                    &params,
                ) {
                    return self.reject_post_terminal_request(rpc_id, method);
                }
                let active_turn_id = self.active_provider_turn_id.as_deref().ok_or_else(|| {
                    LocalRunnerError::invalid("Codex tool call arrived outside an active turn")
                })?;
                if params.get("turnId").and_then(Value::as_str) != Some(active_turn_id) {
                    return Err(LocalRunnerError::invalid(
                        "Codex tool call named another turn",
                    ));
                }
                let call_id = bounded_identifier(
                    params.get("callId").and_then(Value::as_str),
                    "Codex tool callId",
                )?;
                let operation_id = bounded_identifier(
                    params.get("tool").and_then(Value::as_str),
                    "Codex tool name",
                )?;
                if !self.authorized_tool_ids.contains(&operation_id) {
                    self.send_frame(&json!({
                        "id": rpc_id,
                        "result": codex_tool_failure("Paperclip did not authorize this tool for the run"),
                    }))?;
                    return Err(LocalRunnerError::invalid(format!(
                        "Codex requested unauthorized tool {}",
                        bounded_method(&operation_id)
                    )));
                }
                let input = params.get("arguments").cloned().unwrap_or(Value::Null);
                let input_bytes = serde_json::to_vec(&input)
                    .map_err(|error| {
                        LocalRunnerError::invalid(format!(
                            "Codex tool arguments are not serializable: {error}"
                        ))
                    })?
                    .len();
                let rpc_id_bytes = serde_json::to_vec(&rpc_id)
                    .map_err(|error| {
                        LocalRunnerError::invalid(format!(
                            "Codex JSON-RPC id is not serializable: {error}"
                        ))
                    })?
                    .len();
                let retained_bytes = pending_tool_request_size([
                    input_bytes,
                    rpc_id_bytes,
                    call_id.len(),
                    operation_id.len(),
                ])?;
                let pending = PendingToolRequest {
                    rpc_id: rpc_id.clone(),
                    operation_id: operation_id.clone(),
                    input: input.clone(),
                    retained_bytes,
                };
                let completed_replay = self.completed_tool_call_ids.contains(&call_id);
                if completed_replay && !self.durable_tool_call_replays {
                    return Err(LocalRunnerError::invalid(
                        "Codex reused a completed tool call id",
                    ));
                }
                if let Some(existing) = self.pending_tool_requests.get(&call_id) {
                    if existing != &pending {
                        return Err(LocalRunnerError::invalid(
                            "Codex reused a tool call id with different input",
                        ));
                    }
                    return Ok(None);
                }
                if self
                    .pending_tool_requests
                    .values()
                    .any(|existing| existing.rpc_id == rpc_id)
                {
                    return Err(LocalRunnerError::invalid(
                        "Codex reused a pending JSON-RPC id for another tool call",
                    ));
                }
                if self.pending_tool_requests.len() >= MAX_PENDING_TOOL_REQUESTS {
                    return Err(LocalRunnerError::invalid(
                        "Codex emitted too many pending tool calls",
                    ));
                }
                if !completed_replay
                    && self.completed_tool_call_ids.len() >= MAX_COMPLETED_TOOL_CALL_IDS
                {
                    return Err(LocalRunnerError::invalid(
                        "Codex emitted too many completed tool calls in one turn",
                    ));
                }
                let retained_request_bytes = retain_pending_tool_request_bytes(
                    self.pending_tool_request_bytes,
                    retained_bytes,
                )?;
                self.pending_tool_requests.insert(call_id.clone(), pending);
                self.pending_tool_request_bytes = retained_request_bytes;
                return Ok(Some(CodexProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }));
            }
            if matches!(
                method,
                "item/tool/requestUserInput" | OPENCODE_RUNTIME_REQUEST_METHOD
            ) {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if method == "item/tool/requestUserInput"
                    && params.get("threadId").and_then(Value::as_str)
                        != Some(self.thread_id.as_str())
                {
                    return Err(LocalRunnerError::invalid(
                        "Codex runtime request named another thread",
                    ));
                }
                if request_targets_non_active_turn(
                    self.active_provider_turn_id.as_deref(),
                    &self.settled_provider_turn_ids,
                    &params,
                ) {
                    return self.reject_post_terminal_request(rpc_id, method);
                }
                let active_turn_id = self.active_provider_turn_id.clone().ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "Codex runtime request arrived outside an active turn",
                    )
                })?;
                if runtime_request_turn_id(&params) != Some(active_turn_id.as_str()) {
                    return Err(LocalRunnerError::invalid(
                        "Codex runtime request named another turn",
                    ));
                }
                let (provider_request_id, question_set, option_labels) =
                    if method == OPENCODE_RUNTIME_REQUEST_METHOD {
                        opencode_question_set(&params)?
                    } else {
                        codex_question_set(&rpc_id, &params)?
                    };
                let retained_bytes = pending_runtime_request_size(
                    &rpc_id,
                    &active_turn_id,
                    method,
                    &params,
                    &question_set,
                    &option_labels,
                )?;
                let pending = PendingRuntimeRequest {
                    rpc_id: rpc_id.clone(),
                    turn_id: active_turn_id.clone(),
                    method: method.to_owned(),
                    params,
                    question_set: question_set.clone(),
                    option_labels,
                    retained_bytes,
                };
                if let Some(existing) = self
                    .pending_runtime_requests
                    .values()
                    .find(|existing| existing.rpc_id == rpc_id)
                {
                    if existing != &pending {
                        return Err(LocalRunnerError::invalid(
                            "Codex reused a runtime request id with different input",
                        ));
                    }
                    return Ok(None);
                }
                let retained_request_bytes = retain_pending_runtime_request_bytes(
                    self.pending_runtime_request_bytes,
                    retained_bytes,
                );
                if self.pending_runtime_requests.len() >= MAX_PENDING_RUNTIME_REQUESTS
                    || retained_request_bytes.is_none()
                {
                    self.send_frame(&json!({
                        "id": rpc_id,
                        "error": {
                            "code": -32000,
                            "message": "Paperclip rejected this runtime request because the pending input capacity was reached",
                        },
                    }))?;
                    return Ok(Some(CodexProviderEvent::Notification {
                        method: "warning".to_owned(),
                        params: json!({
                            "message": "rejected a Codex runtime request at the bounded pending-input limit",
                            "providerMethod": bounded_method(method),
                        }),
                    }));
                }
                let request_sequence = self.next_runtime_request_sequence;
                self.next_runtime_request_sequence = self
                    .next_runtime_request_sequence
                    .checked_add(1)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid("Codex runtime request sequence overflowed")
                    })?;
                let request_id = scoped_runtime_request_id(
                    &self.runtime_request_scope,
                    &active_turn_id,
                    &provider_request_id,
                    request_sequence,
                );
                self.pending_runtime_requests
                    .insert(request_id.clone(), pending);
                self.pending_runtime_request_bytes =
                    retained_request_bytes.expect("bounded runtime request bytes checked above");
                return Ok(Some(CodexProviderEvent::RuntimeRequest {
                    request_id,
                    question_set,
                }));
            }
            self.send_frame(&json!({
                "id": rpc_id,
                "error": {"code": -32601, "message": "provider request is unavailable in this runner layer"},
            }))?;
            return Ok(Some(CodexProviderEvent::Notification {
                method: "warning".to_owned(),
                params: json!({"message": format!("unsupported Codex request {}", bounded_method(method))}),
            }));
        }

        if let Some(method) = message.get("method").and_then(Value::as_str) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let terminal_event_type = normalized_codex_terminal_event_type(method, &params);
            let notification_turn_id = params
                .get("turnId")
                .or_else(|| params.pointer("/turn/id"))
                .and_then(Value::as_str);
            if terminal_event_type.is_some()
                && notification_turn_id.is_some()
                && notification_turn_id != self.active_provider_turn_id.as_deref()
                && notification_turn_id
                    .is_some_and(|turn_id| self.settled_provider_turn_ids.contains(turn_id))
            {
                return Ok(Some(CodexProviderEvent::Notification {
                    method: "warning".to_owned(),
                    params: json!({
                        "message": "ignored a terminal notification for a non-active Codex turn",
                        "providerMethod": bounded_method(method),
                    }),
                }));
            }
            validate_notification_binding(
                &self.thread_id,
                self.active_provider_turn_id.as_deref(),
                &params,
            )?;
            if let Some(terminal_event_type) = terminal_event_type {
                if self.active_provider_turn_id.is_none() {
                    return Err(LocalRunnerError::invalid(
                        "Codex terminal arrived outside an active provider turn",
                    ));
                }
                let provider_turn_id = self
                    .active_provider_turn_id
                    .clone()
                    .expect("active provider turn checked above");
                let completed_turn_authority = if terminal_event_type == "turn.completed" {
                    Some(CompletedTurnAuthority {
                        process_generation: self.process_generation,
                        provider_turn_id: provider_turn_id.clone(),
                    })
                } else {
                    None
                };
                if !self
                    .settled_provider_turn_ids
                    .insert(provider_turn_id.clone())
                {
                    return Err(LocalRunnerError::invalid(
                        "Codex provider turn identity epoch reached its exact capacity",
                    ));
                }
                self.active_provider_turn_id = None;
                self.expected_shutdown = true;
                self.completed_turn_authority = completed_turn_authority;
                self.completion_reconciliation_pending = terminal_event_type == "turn.completed";
                // The provider terminal is authoritative once received. Clear
                // local request ownership and attempt courtesy responses, but
                // a provider that already closed stdin must not turn the
                // completed turn back into a transport failure.
                let _ = self.cancel_pending_requests();
                self.completed_tool_call_ids.clear();
            }
            return Ok(Some(CodexProviderEvent::Notification {
                method: method.to_owned(),
                params,
            }));
        }
        Ok(None)
    }

    pub fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let pending = self
            .pending_tool_requests
            .get(&result.call_id)
            .cloned()
            .ok_or_else(|| {
                LocalRunnerError::invalid("Codex tool result has no pending JSON-RPC request")
            })?;
        if pending.operation_id != result.operation_id {
            return Err(LocalRunnerError::invalid(
                "Codex tool result operation does not match its call",
            ));
        }
        let result_bytes = serde_json::to_vec(&result.result).map_err(|error| {
            LocalRunnerError::invalid(format!("Codex tool result is not serializable: {error}"))
        })?;
        if result_bytes.len() > 1024 * 1024 {
            return Err(LocalRunnerError::invalid(
                "Codex tool result exceeds the 1 MiB limit",
            ));
        }
        let text = String::from_utf8(result_bytes)
            .expect("serde_json always serializes JSON values as valid UTF-8");
        self.send_frame(&json!({
            "id": pending.rpc_id,
            "result": {
                "success": !result.is_error,
                "contentItems": [{"type": "inputText", "text": text}],
            },
        }))?;
        if let Some(completed) = self.pending_tool_requests.remove(&result.call_id) {
            self.pending_tool_request_bytes = self
                .pending_tool_request_bytes
                .saturating_sub(completed.retained_bytes);
            self.completed_tool_call_ids.insert(result.call_id.clone());
        }
        Ok(())
    }

    pub fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.expected_shutdown = true;
        self.cancel_pending_requests()?;
        let result = self.process.terminate_group().map(|_| ());
        if let Some(trace) = self.trace.as_mut() {
            trace.finish();
        }
        result
    }

    fn cancel_pending_requests(&mut self) -> Result<(), LocalRunnerError> {
        let pending_runtime = std::mem::take(&mut self.pending_runtime_requests);
        let pending = std::mem::take(&mut self.pending_tool_requests);
        self.pending_runtime_request_bytes = 0;
        self.pending_tool_request_bytes = 0;
        let mut first_error = None;
        for request in pending_runtime.into_values() {
            let result = if request.method == OPENCODE_RUNTIME_REQUEST_METHOD {
                json!({"resolution": {"action": "cancel"}})
            } else {
                json!({"answers": {}})
            };
            if let Err(error) = self.send_frame(&json!({
                "id": request.rpc_id,
                "result": result,
            })) {
                first_error.get_or_insert(error);
            }
        }
        for request in pending.into_values() {
            if let Err(error) = self.send_frame(&json!({
                "id": request.rpc_id,
                "result": codex_tool_failure("Paperclip stopped the active provider turn"),
            })) {
                first_error.get_or_insert(error);
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, LocalRunnerError> {
        self.request_classified(method, params)
            .map_err(ProviderRequestError::into_inner)
    }

    fn send_frame(&mut self, value: &Value) -> Result<(), LocalRunnerError> {
        if let Some(trace) = self.trace.as_mut() {
            let raw = serde_json::to_vec(value).unwrap_or_default();
            if let Some(frame_id) = trace.frame("client_to_provider", &raw) {
                trace.interpretation(
                    frame_id,
                    "rust_native_transport",
                    "codex.jsonrpc.outbound",
                    "operator_only",
                    Vec::new(),
                    "Outbound provider command does not enter the canonical PRP outbox",
                );
            }
        }
        self.process.send(value)
    }

    fn trace_inbound(&mut self, line: &str) -> Option<u64> {
        let trace = self.trace.as_mut()?;
        let frame_id = trace.frame("provider_to_client", line.as_bytes())?;
        trace.interpretation(
            frame_id,
            "rust_native_transport",
            "codex.jsonrpc.inbound",
            "mapped",
            Vec::new(),
            "Inbound provider frame entered the bounded JSON-RPC parser",
        );
        Some(frame_id)
    }

    fn request_classified(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, ProviderRequestError> {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).ok_or_else(|| {
            ProviderRequestError::Rejected(LocalRunnerError::invalid("Codex request id exhausted"))
        })?;
        self.send_frame(&json!({"id": request_id, "method": method, "params": params}))
            .map_err(ProviderRequestError::Ambiguous)?;
        loop {
            let line = self
                .receive_provider_stdout_line(Duration::from_secs(30))
                .map_err(ProviderRequestError::Ambiguous)?;
            let Some(line) = line else {
                let exit = self
                    .process
                    .try_wait()
                    .map_err(ProviderRequestError::Ambiguous)?;
                if exit.is_some() {
                    self.drain_provider_diagnostics(Duration::from_millis(50));
                }
                let diagnostic_suffix = self.provider_diagnostic_suffix();
                let message = if let Some(exit) = exit {
                    format!(
                        "Codex {method} process exited before responding (exitCode={:?}, signal={:?}){diagnostic_suffix}",
                        exit.exit_code, exit.signal
                    )
                } else {
                    format!("Codex {method} response timed out{diagnostic_suffix}")
                };
                return Err(ProviderRequestError::Ambiguous(LocalRunnerError::invalid(
                    message,
                )));
            };
            let trace_frame_id = self.trace_inbound(&line);
            let message = parse_provider_message(&line).map_err(|error| {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), trace_frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.invalid",
                        "rejected",
                        Vec::new(),
                        "Provider frame was not valid JSON-RPC",
                    );
                }
                ProviderRequestError::Ambiguous(error)
            })?;
            if message.get("id").and_then(Value::as_u64) == Some(request_id)
                && message.get("method").is_none()
            {
                if let (Some(trace), Some(frame_id)) = (self.trace.as_mut(), trace_frame_id) {
                    trace.interpretation(
                        frame_id,
                        "rust_jsonrpc_parse",
                        "codex.jsonrpc.response",
                        "operator_only",
                        Vec::new(),
                        "Matched synchronous app-server response",
                    );
                }
                if let Some(error) = message.get("error") {
                    let well_formed_rejection = error.get("code").and_then(Value::as_i64).is_some()
                        && error.get("message").and_then(Value::as_str).is_some();
                    if !well_formed_rejection || message.get("result").is_some() {
                        return Err(ProviderRequestError::Ambiguous(LocalRunnerError::invalid(
                            format!("Codex {method} returned an invalid error response"),
                        )));
                    }
                    return Err(ProviderRequestError::Rejected(LocalRunnerError::invalid(
                        format!("Codex {method} failed: {}", redact_text(&error.to_string())),
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if self
                .pending_messages
                .len()
                .saturating_add(self.deferred_ambiguous_messages.len())
                >= MAX_BUFFERED_MESSAGES
            {
                return Err(ProviderRequestError::Ambiguous(LocalRunnerError::invalid(
                    "Codex emitted too many messages before a request response",
                )));
            }
            let retained_bytes = json_size(&message, "buffered Codex provider message")
                .map_err(ProviderRequestError::Ambiguous)?;
            let next_retained_bytes =
                retain_buffered_message_bytes(self.pending_message_bytes, retained_bytes)
                    .ok_or_else(|| {
                        ProviderRequestError::Ambiguous(LocalRunnerError::invalid(
                            "Codex buffered messages exceed the 16 MiB aggregate limit",
                        ))
                    })?;
            self.pending_messages.push_back(BufferedProviderMessage {
                value: message,
                trace_frame_id,
            });
            self.pending_message_bytes = next_retained_bytes;
        }
    }

    fn receive_provider_stdout_line(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<String>, LocalRunnerError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.process.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_text(&line));
                }
                Ok(ProcessOutput::StdoutError(message)) => {
                    return Err(LocalRunnerError::invalid(message));
                }
                Ok(ProcessOutput::StdoutClosed) => return Ok(None),
                Ok(ProcessOutput::StderrClosed) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }

    fn drain_provider_diagnostics(&mut self, max_wait: Duration) {
        let deadline = std::time::Instant::now() + max_wait;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.process.recv_timeout(remaining) {
                Ok(ProcessOutput::Stderr(line)) => {
                    self.stderr_tail.push(redact_text(&line));
                }
                Ok(ProcessOutput::StderrClosed)
                | Err(mpsc::RecvTimeoutError::Timeout)
                | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(ProcessOutput::Stdout(_))
                | Ok(ProcessOutput::StdoutError(_))
                | Ok(ProcessOutput::StdoutClosed) => {}
            }
        }
    }

    fn provider_diagnostic_suffix(&self) -> String {
        let diagnostics = self.stderr_tail.snapshot().lines.join("\n");
        if diagnostics.is_empty() {
            String::new()
        } else {
            format!(" stderrTail={diagnostics:?}")
        }
    }
}

fn verified_opencode_launch(
    profile: &OpenCodeLaunchProfile,
) -> Result<VerifiedProcessLaunch, LocalRunnerError> {
    let command = verify_launch_artifact(&profile.command, "OpenCode proxy command")
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))?;
    let proxy = verify_launch_artifact(&profile.proxy_script, "OpenCode proxy script")
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))?;
    let executable = verify_launch_artifact(&profile.executable, "OpenCode provider executable")
        .map_err(|error| LocalRunnerError::invalid(error.to_string()))?;
    let proxy = if is_node_interpreter(&profile.command.path) {
        VerifiedProcessArgument::CommonJsArtifact(proxy)
    } else {
        // Qualified test and alternate proxy commands own their ordinary
        // argv contract. Only Node understands the runner-owned CommonJS
        // descriptor loader flags.
        VerifiedProcessArgument::Artifact(proxy)
    };
    let args = vec![
        proxy,
        VerifiedProcessArgument::Literal(TRUSTED_OPENCODE_EXECUTABLE_ARG.to_owned()),
        VerifiedProcessArgument::ExecutableArtifact(executable),
    ];
    Ok(VerifiedProcessLaunch::new(command, args))
}

fn json_size(value: &Value, label: &str) -> Result<usize, LocalRunnerError> {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .map_err(|error| LocalRunnerError::invalid(format!("{label} is not serializable: {error}")))
}

fn retain_buffered_message_bytes(current: usize, incoming: usize) -> Option<usize> {
    current
        .checked_add(incoming)
        .filter(|total| *total <= MAX_BUFFERED_MESSAGE_BYTES)
}

fn pending_tool_request_size(
    parts: impl IntoIterator<Item = usize>,
) -> Result<usize, LocalRunnerError> {
    parts.into_iter().try_fold(0usize, |total, part| {
        total
            .checked_add(part)
            .ok_or_else(|| LocalRunnerError::invalid("Codex pending tool request size overflowed"))
    })
}

fn retain_pending_tool_request_bytes(
    current: usize,
    incoming: usize,
) -> Result<usize, LocalRunnerError> {
    current
        .checked_add(incoming)
        .filter(|total| *total <= MAX_PENDING_TOOL_REQUEST_BYTES)
        .ok_or_else(|| {
            LocalRunnerError::invalid(
                "Codex pending tool requests exceed the 16 MiB aggregate limit",
            )
        })
}

fn pending_runtime_request_size(
    rpc_id: &Value,
    turn_id: &str,
    method: &str,
    params: &Value,
    question_set: &Value,
    option_labels: &QuestionOptionLabels,
) -> Result<usize, LocalRunnerError> {
    serde_json::to_vec(&(rpc_id, turn_id, method, params, question_set, option_labels))
        .map(|encoded| encoded.len())
        .map_err(|error| {
            LocalRunnerError::invalid(format!(
                "Codex pending runtime request is not serializable: {error}"
            ))
        })
}

fn retain_pending_runtime_request_bytes(current: usize, incoming: usize) -> Option<usize> {
    current
        .checked_add(incoming)
        .filter(|total| *total <= MAX_PENDING_RUNTIME_REQUEST_BYTES)
}

fn codex_dynamic_tools(
    authorized_tools: impl IntoIterator<Item = AuthorizedTool>,
) -> Result<(Vec<Value>, BTreeSet<String>), LocalRunnerError> {
    let mut dynamic_tools = Vec::new();
    let mut operation_ids = BTreeSet::new();
    for tool in authorized_tools {
        if dynamic_tools.len() >= 256 {
            return Err(LocalRunnerError::invalid(
                "Codex authorized tool set exceeds the operation limit",
            ));
        }
        let operation_id = bounded_identifier(Some(&tool.operation_id), "Codex tool name")?;
        let mut characters = operation_id.chars();
        let valid_first = characters
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric());
        let valid_rest = characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
        });
        if !valid_first || !valid_rest {
            return Err(LocalRunnerError::invalid(
                "Codex tool name is not a valid operation id",
            ));
        }
        if tool.version != 1
            || tool.description.trim().is_empty()
            || tool.description.len() > 16 * 1024
            || tool.description.contains('\0')
            || !tool.input_schema.is_object()
            || !tool.response_schema.is_object()
        {
            return Err(LocalRunnerError::invalid(format!(
                "Codex tool {} has an incomplete provider contract",
                bounded_method(&operation_id)
            )));
        }
        let input_schema_bytes = serde_json::to_vec(&tool.input_schema).map_err(|error| {
            LocalRunnerError::invalid(format!("Codex tool input schema is invalid: {error}"))
        })?;
        if input_schema_bytes.len() > 1024 * 1024 {
            return Err(LocalRunnerError::invalid(
                "Codex tool input schema exceeds the 1 MiB limit",
            ));
        }
        jsonschema::validator_for(&tool.input_schema).map_err(|_| {
            LocalRunnerError::invalid(format!(
                "Codex tool {} has an invalid input JSON Schema",
                bounded_method(&operation_id)
            ))
        })?;
        if !operation_ids.insert(operation_id.clone()) {
            return Err(LocalRunnerError::invalid(
                "Codex authorized tool names must be unique",
            ));
        }
        dynamic_tools.push(json!({
            "name": operation_id,
            "description": tool.description,
            "inputSchema": tool.input_schema,
        }));
    }
    if serde_json::to_vec(&dynamic_tools)
        .map_err(|error| {
            LocalRunnerError::invalid(format!("Codex dynamic tool set is invalid: {error}"))
        })?
        .len()
        > 4 * 1024 * 1024
    {
        return Err(LocalRunnerError::invalid(
            "Codex dynamic tool set exceeds the 4 MiB limit",
        ));
    }
    Ok((dynamic_tools, operation_ids))
}

fn bounded_identifier(value: Option<&str>, label: &str) -> Result<String, LocalRunnerError> {
    let value = value.ok_or_else(|| LocalRunnerError::invalid(format!("{label} is required")))?;
    let mut characters = value.chars();
    let valid_first = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphanumeric());
    let valid_rest = characters.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
    });
    if value.len() > 160 || !valid_first || !valid_rest {
        return Err(LocalRunnerError::invalid(format!("{label} is invalid")));
    }
    Ok(value.to_owned())
}

fn bounded_provider_turn_id(value: Option<&str>) -> Result<String, LocalRunnerError> {
    let value = value
        .filter(|value| !value.is_empty())
        .ok_or_else(|| LocalRunnerError::invalid("Codex turn/start omitted turn.id"))?;
    if value.len() > 240 || value.chars().any(char::is_control) {
        return Err(LocalRunnerError::invalid(
            "Codex turn/start returned an invalid turn.id",
        ));
    }
    Ok(value.to_owned())
}

fn codex_tool_failure(message: &str) -> Value {
    json!({
        "success": false,
        "contentItems": [{"type": "inputText", "text": message}],
    })
}

fn parse_provider_message(line: &str) -> Result<Value, LocalRunnerError> {
    let value: Value = serde_json::from_str(line).map_err(|error| {
        LocalRunnerError::invalid(format!("Codex emitted invalid JSON-RPC: {error}"))
    })?;
    if !value.is_object() {
        return Err(LocalRunnerError::invalid(
            "Codex emitted a non-object JSON-RPC frame",
        ));
    }
    Ok(value)
}

fn is_unbound_rejected_turn_diagnostic(message: &Value) -> bool {
    message.get("id").is_none()
        && message.get("method").and_then(Value::as_str) == Some("warning")
        && message
            .get("params")
            .is_none_or(|params| !contains_provider_work_binding(params))
}

fn contains_provider_work_binding(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_provider_work_binding),
        Value::Object(fields) => fields.iter().any(|(key, child)| {
            (matches!(key.as_str(), "threadId" | "turnId" | "itemId" | "requestId")
                && !child.is_null())
                || (matches!(key.as_str(), "thread" | "turn" | "item" | "request")
                    && child.get("id").is_some_and(|id| !id.is_null()))
                || contains_provider_work_binding(child)
        }),
        _ => false,
    }
}

fn validate_notification_binding(
    thread_id: &str,
    active_turn_id: Option<&str>,
    params: &Value,
) -> Result<(), LocalRunnerError> {
    let notification_thread_id = params
        .get("threadId")
        .or_else(|| params.pointer("/thread/id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if notification_thread_id.is_some_and(|value| value != thread_id) {
        return Err(LocalRunnerError::invalid(
            "Codex notification named another thread",
        ));
    }
    let notification_turn_id = notification_turn_id(params);
    if let Some(active_turn_id) = active_turn_id {
        if notification_turn_id.is_some_and(|value| value != active_turn_id) {
            return Err(LocalRunnerError::invalid(
                "Codex notification named another active turn",
            ));
        }
    }
    Ok(())
}

fn notification_turn_id(params: &Value) -> Option<&str> {
    params
        .get("turnId")
        .or_else(|| params.pointer("/turn/id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn request_targets_non_active_turn(
    active_turn_id: Option<&str>,
    settled_turn_ids: &SettledProviderTurnIds,
    params: &Value,
) -> bool {
    let requested_turn_id = runtime_request_turn_id(params);
    requested_turn_id.is_some_and(|requested| {
        settled_turn_ids.contains(requested) || active_turn_id != Some(requested)
    })
}

fn runtime_request_turn_id(params: &Value) -> Option<&str> {
    params
        .get("turnId")
        .or_else(|| params.pointer("/request/turnId"))
        .and_then(Value::as_str)
}

fn latest_active_turn_id(snapshot: &Value) -> Option<String> {
    snapshot
        .pointer("/thread/turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .find(|turn| {
            matches!(
                turn.get("status").and_then(Value::as_str),
                Some("inProgress" | "running" | "pending")
            )
        })
        .and_then(|turn| turn.get("id").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn bounded_method(method: &str) -> String {
    method
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "._/-".contains(*character))
        .take(160)
        .collect()
}

fn opencode_question_set(params: &Value) -> Result<QuestionSetMapping, LocalRunnerError> {
    let params = params
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode runtime request params are invalid"))?;
    if params.keys().any(|key| key != "request") {
        return Err(LocalRunnerError::invalid(
            "OpenCode runtime request params contain an unknown field",
        ));
    }
    let request = params
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode runtime request is required"))?;
    if request.keys().any(|key| {
        !matches!(
            key.as_str(),
            "schema"
                | "requestKind"
                | "requestId"
                | "type"
                | "status"
                | "prompt"
                | "input"
                | "origin"
                | "turnId"
                | "itemId"
        )
    }) {
        return Err(LocalRunnerError::invalid(
            "OpenCode runtime request contains an unknown field",
        ));
    }
    if request.get("schema").and_then(Value::as_str) != Some("paperclip.runtime_request.v2")
        || request.get("requestKind").and_then(Value::as_str) != Some("runtime")
        || request.get("status").and_then(Value::as_str) != Some("pending")
    {
        return Err(LocalRunnerError::invalid(
            "OpenCode runtime request discriminator is invalid",
        ));
    }
    if request.get("type").and_then(Value::as_str) != Some("input") {
        return Err(LocalRunnerError::invalid(
            "OpenCode runnerd bridge currently supports structured input requests only",
        ));
    }
    let request_id = request
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|request_id| {
            !request_id.is_empty()
                && request_id.chars().count() <= 160
                && !request_id.chars().any(char::is_control)
        })
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode runtime requestId is invalid"))?
        .to_owned();
    bounded_provider_turn_id(request.get("turnId").and_then(Value::as_str))
        .map_err(|_| LocalRunnerError::invalid("OpenCode runtime request turnId is invalid"))?;
    request
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.is_empty() && prompt.chars().count() <= 4_000)
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode runtime request prompt is invalid"))?;
    if let Some(item_id) = request.get("itemId") {
        bounded_provider_turn_id(item_id.as_str())
            .map_err(|_| LocalRunnerError::invalid("OpenCode runtime request itemId is invalid"))?;
    }
    if let Some(origin) = request.get("origin") {
        let origin = origin.as_object().ok_or_else(|| {
            LocalRunnerError::invalid("OpenCode runtime request origin is invalid")
        })?;
        if origin
            .keys()
            .any(|key| !matches!(key.as_str(), "adapter" | "provider" | "method"))
            || origin.get("adapter").and_then(Value::as_str) != Some("opencode-server")
            || origin.get("provider").and_then(Value::as_str) != Some("opencode")
            || origin
                .get("method")
                .and_then(Value::as_str)
                .is_none_or(|method| method.is_empty() || method.chars().count() > 500)
        {
            return Err(LocalRunnerError::invalid(
                "OpenCode runtime request origin is invalid",
            ));
        }
    }
    let question_set = request
        .get("input")
        .cloned()
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode runtime request input is required"))?;
    validate_opencode_question_set(&question_set)?;
    Ok((request_id, question_set, BTreeMap::new()))
}

fn validate_opencode_question_set(question_set: &Value) -> Result<(), LocalRunnerError> {
    let schema: Value = serde_json::from_str(include_str!(
        "../../../../protocol/schemas/question-set.schema.json"
    ))
    .map_err(|_| LocalRunnerError::invalid("embedded question-set schema is invalid"))?;
    let validator = jsonschema::validator_for(&schema)
        .map_err(|_| LocalRunnerError::invalid("embedded question-set schema cannot compile"))?;
    if !validator.is_valid(question_set) {
        return Err(LocalRunnerError::invalid(
            "OpenCode runtime request input failed the Paperclip question-set schema",
        ));
    }
    let questions = question_set
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalRunnerError::invalid("OpenCode question set is malformed"))?;
    let mut question_ids = BTreeSet::new();
    for question in questions {
        let question_id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| LocalRunnerError::invalid("OpenCode question id is malformed"))?;
        if !question_ids.insert(question_id) {
            return Err(LocalRunnerError::invalid(
                "OpenCode question ids must be unique",
            ));
        }
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        let mut option_ids = BTreeSet::new();
        for option in options {
            let option_id = option
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| LocalRunnerError::invalid("OpenCode option id is malformed"))?;
            if !option_ids.insert(option_id) {
                return Err(LocalRunnerError::invalid(
                    "OpenCode question option ids must be unique",
                ));
            }
        }
        if let Some(validation) = question.get("textValidation") {
            if validation
                .get("minLength")
                .and_then(Value::as_u64)
                .zip(validation.get("maxLength").and_then(Value::as_u64))
                .is_some_and(|(minimum, maximum)| minimum > maximum)
                || validation
                    .get("minimum")
                    .and_then(Value::as_f64)
                    .zip(validation.get("maximum").and_then(Value::as_f64))
                    .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err(LocalRunnerError::invalid(
                    "OpenCode question constraints are inverted",
                ));
            }
            if let Some(pattern) = validation.get("pattern").and_then(Value::as_str) {
                let pattern_schema = json!({"type": "string", "pattern": pattern});
                jsonschema::validator_for(&pattern_schema).map_err(|_| {
                    LocalRunnerError::invalid("OpenCode question pattern cannot compile")
                })?;
            }
        }
    }
    Ok(())
}

fn codex_question_set(
    rpc_id: &Value,
    params: &Value,
) -> Result<QuestionSetMapping, LocalRunnerError> {
    let request_id = match rpc_id {
        Value::String(value) if !value.is_empty() && value.len() <= 160 => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => {
            return Err(LocalRunnerError::invalid(
                "Codex user-input request id is invalid",
            ))
        }
    };
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalRunnerError::invalid("Codex user-input request omitted questions"))?;
    if questions.is_empty() || questions.len() > 3 {
        return Err(LocalRunnerError::invalid(
            "Codex user-input request must contain one to three questions",
        ));
    }
    let mut canonical = Vec::new();
    let mut option_labels = BTreeMap::new();
    for question in questions {
        if question.get("isSecret").and_then(Value::as_bool) == Some(true) {
            return Err(LocalRunnerError::invalid(
                "Codex secret input cannot use the persisted question channel",
            ));
        }
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 160)
            .ok_or_else(|| LocalRunnerError::invalid("Codex question id is invalid"))?;
        if option_labels.contains_key(id) {
            return Err(LocalRunnerError::invalid(
                "Codex question ids must be unique",
            ));
        }
        let prompt = question
            .get("question")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LocalRunnerError::invalid("Codex question prompt is required"))?;
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut labels = BTreeMap::new();
        let canonical_options = options
            .iter()
            .take(64)
            .enumerate()
            .filter_map(|(index, option)| {
                let label = option.get("label")?.as_str()?.trim();
                if label.is_empty() {
                    return None;
                }
                let option_id = format!("option-{}", index + 1);
                labels.insert(option_id.clone(), label.chars().take(240).collect());
                Some(json!({
                    "id": option_id,
                    "label": label.chars().take(240).collect::<String>(),
                    "description": option.get("description").and_then(Value::as_str).map(|value| value.chars().take(1000).collect::<String>()),
                }))
            })
            .collect::<Vec<_>>();
        if !options.is_empty() && canonical_options.len() != options.len() {
            return Err(LocalRunnerError::invalid(
                "Codex question contains an invalid option",
            ));
        }
        option_labels.insert(id.to_owned(), labels);
        let mut canonical_question = json!({
            "id": id,
            "header": question.get("header").and_then(Value::as_str).unwrap_or("Question").chars().take(80).collect::<String>(),
            "prompt": prompt.chars().take(4000).collect::<String>(),
            "required": true,
            "answerMode": if canonical_options.is_empty() { "text" } else { "single_select" },
            "options": canonical_options,
        });
        if question.get("isOther").and_then(Value::as_bool) == Some(true) {
            canonical_question
                .as_object_mut()
                .expect("canonical question is an object")
                .insert(
                    "customAnswer".to_owned(),
                    json!({
                        "enabled": true,
                        "label": "Other",
                        "placeholder": "Enter another answer",
                    }),
                );
        }
        canonical.push(canonical_question);
    }
    Ok((
        request_id,
        json!({
            "schema": "paperclip.question_set.v1",
            "title": params.get("title").and_then(Value::as_str).unwrap_or("Codex input").chars().take(240).collect::<String>(),
            "submitLabel": "Submit answers",
            "questions": canonical,
        }),
        option_labels,
    ))
}

fn new_runtime_request_scope() -> Result<[u8; 16], LocalRunnerError> {
    let mut scope = [0u8; 16];
    getrandom::fill(&mut scope).map_err(|error| {
        LocalRunnerError::invalid(format!(
            "failed to mint Codex runtime request scope: {error}"
        ))
    })?;
    Ok(scope)
}

fn scoped_runtime_request_id(
    scope: &[u8; 16],
    turn_id: &str,
    provider_request_id: &str,
    request_sequence: u64,
) -> String {
    let mut digest = Sha256::new();
    digest.update(scope);
    digest.update([0]);
    digest.update(turn_id.as_bytes());
    digest.update([0]);
    digest.update(provider_request_id.as_bytes());
    digest.update([0]);
    digest.update(request_sequence.to_be_bytes());
    format!("runtime-request-{:x}", digest.finalize())
}

fn codex_question_response(
    pending: &PendingRuntimeRequest,
    response: &Value,
) -> Result<Value, LocalRunnerError> {
    if pending.method == OPENCODE_RUNTIME_REQUEST_METHOD {
        validate_question_response(&pending.question_set, response)?;
        return Ok(json!({
            "resolution": {
                "action": "submit",
                "response": response,
            },
        }));
    }
    let response_object = response
        .as_object()
        .ok_or_else(|| LocalRunnerError::invalid("runtime response must be an object"))?;
    if response_object
        .keys()
        .any(|key| !matches!(key.as_str(), "schema" | "answers"))
    {
        return Err(LocalRunnerError::invalid(
            "runtime response contains an unknown top-level field",
        ));
    }
    if response.get("schema").and_then(Value::as_str) != Some("paperclip.question_response.v1") {
        return Err(LocalRunnerError::invalid(
            "runtime response requires paperclip.question_response.v1",
        ));
    }
    let answers = response
        .get("answers")
        .and_then(Value::as_object)
        .ok_or_else(|| LocalRunnerError::invalid("runtime response answers are required"))?;
    let questions = pending
        .question_set
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| LocalRunnerError::invalid("pending question set is malformed"))?;
    let mut native = serde_json::Map::new();
    for question in questions {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| LocalRunnerError::invalid("pending question id is malformed"))?;
        let answer = answers
            .get(id)
            .ok_or_else(|| LocalRunnerError::invalid(format!("missing answer for {id}")))?;
        let answer = answer.as_object().ok_or_else(|| {
            LocalRunnerError::invalid(format!("answer for {id} must be an object"))
        })?;
        if answer
            .keys()
            .any(|key| !matches!(key.as_str(), "selectedOptionIds" | "text" | "customText"))
        {
            return Err(LocalRunnerError::invalid(format!(
                "answer for {id} contains an unknown field"
            )));
        }
        let selected = answer.get("selectedOptionIds");
        let text = answer.get("text");
        let custom = answer.get("customText");
        let values = if question.get("answerMode").and_then(Value::as_str) == Some("single_select")
        {
            if text.is_some() || (selected.is_some() && custom.is_some()) {
                return Err(LocalRunnerError::invalid(format!(
                    "{id} must contain one selected option or one custom answer"
                )));
            }
            if let Some(custom_text) = custom {
                if question
                    .pointer("/customAnswer/enabled")
                    .and_then(Value::as_bool)
                    != Some(true)
                {
                    return Err(LocalRunnerError::invalid(format!(
                        "{id} does not allow a custom answer"
                    )));
                }
                vec![custom_text
                    .as_str()
                    .filter(|value| !value.is_empty() && value.len() <= 4000)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid(format!(
                            "{id} custom answer must be non-empty and bounded"
                        ))
                    })?
                    .to_owned()]
            } else {
                let selected = selected
                    .and_then(Value::as_array)
                    .filter(|values| values.len() == 1)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid(format!("{id} requires one selected option"))
                    })?;
                let option_id = selected[0]
                    .as_str()
                    .ok_or_else(|| LocalRunnerError::invalid("selected option id is invalid"))?;
                vec![pending
                    .option_labels
                    .get(id)
                    .and_then(|labels| labels.get(option_id))
                    .cloned()
                    .ok_or_else(|| LocalRunnerError::invalid("selected option is not available"))?]
            }
        } else {
            if selected.is_some() || custom.is_some() {
                return Err(LocalRunnerError::invalid(format!(
                    "{id} text answer cannot contain select or custom fields"
                )));
            }
            vec![text
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 4000)
                .ok_or_else(|| LocalRunnerError::invalid(format!("{id} requires text")))?
                .to_owned()]
        };
        native.insert(id.to_owned(), json!({"answers": values}));
    }
    if answers.keys().any(|id| !native.contains_key(id)) {
        return Err(LocalRunnerError::invalid(
            "runtime response contains an unknown question id",
        ));
    }
    Ok(json!({"answers": native}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qualified_artifact(path: &Path) -> QualifiedLaunchArtifact {
        QualifiedLaunchArtifact {
            path: path.to_owned(),
            sha256: format!("sha256:{:x}", Sha256::digest(fs::read(path).unwrap())),
        }
    }

    #[test]
    fn verified_opencode_proxy_executes_the_descriptor_safe_commonjs_bundle() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "paperclip-opencode-launch-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let command = directory.join("node");
        let proxy = directory.join("proxy.cjs");
        let executable = directory.join("opencode");
        fs::write(&command, b"qualified node").unwrap();
        fs::write(&proxy, b"module.exports = {};\n").unwrap();
        fs::write(&executable, b"qualified opencode").unwrap();
        let profile = OpenCodeLaunchProfile {
            command: qualified_artifact(&command),
            proxy_script: qualified_artifact(&proxy),
            executable: qualified_artifact(&executable),
        };

        let launch = verified_opencode_launch(&profile).unwrap();
        assert!(matches!(
            launch.arguments().first(),
            Some(VerifiedProcessArgument::CommonJsArtifact(_))
        ));
        assert!(matches!(
            launch.arguments().get(1),
            Some(VerifiedProcessArgument::Literal(argument))
                if argument == TRUSTED_OPENCODE_EXECUTABLE_ARG
        ));
        assert!(matches!(
            launch.arguments().get(2),
            Some(VerifiedProcessArgument::ExecutableArtifact(_))
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn admits_only_exact_local_facade_provider_driver_pairs() {
        let mut config = CodexProviderConfig {
            provider: "opencode".to_owned(),
            driver: "opencode_server".to_owned(),
            provider_version: QUALIFIED_OPENCODE_VERSION.to_owned(),
            command: PathBuf::from("node"),
            args: Vec::new(),
            cwd: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            model: Some("openrouter/model".to_owned()),
            provider_session_id: None,
            instructions: String::new(),
            approval_policy: "never".to_owned(),
        };
        config.validate().unwrap();
        config.provider_version = "1.18.18".to_owned();
        let error = config.validate().unwrap_err();
        assert!(error.to_string().contains(QUALIFIED_OPENCODE_VERSION));
        config.provider_version = QUALIFIED_OPENCODE_VERSION.to_owned();
        config.driver = "codex_app_server".to_owned();
        assert!(config.validate().is_err());
        config.driver = "opencode_server".to_owned();
        config.model = Some("unqualified".to_owned());
        assert!(config.validate().is_err());
    }

    #[test]
    fn does_not_forward_an_ambient_opencode_command_override() {
        assert!(!OPENCODE_PROVIDER_ENVIRONMENT_KEYS.contains(&"PAPERCLIP_OPENCODE_COMMAND"));
    }

    #[test]
    fn converts_codex_questions_and_responses_without_provider_leakage() {
        let (request_id, question_set, labels) = codex_question_set(
            &json!(41),
            &json!({
                "requestId": "request-1",
                "questions": [{
                    "id": "environment",
                    "header": "Environment",
                    "question": "Where should we deploy?",
                    "options": [{"label": "Staging", "description": "Deploy safely."}],
                }],
            }),
        )
        .unwrap();
        assert_eq!(request_id, "41");
        assert_eq!(question_set["schema"], "paperclip.question_set.v1");
        let pending = PendingRuntimeRequest {
            rpc_id: json!(41),
            turn_id: "turn-1".to_owned(),
            method: "item/tool/requestUserInput".to_owned(),
            params: Value::Null,
            question_set,
            option_labels: labels,
            retained_bytes: 0,
        };
        let native = codex_question_response(
            &pending,
            &json!({
                "schema": "paperclip.question_response.v1",
                "answers": {"environment": {"selectedOptionIds": ["option-1"]}},
            }),
        )
        .unwrap();
        assert_eq!(native["answers"]["environment"]["answers"][0], "Staging");
        assert!(codex_question_response(
            &pending,
            &json!({
                "schema": "paperclip.question_response.v1",
                "answers": {"environment": {
                    "selectedOptionIds": ["option-1"],
                    "customText": "Production",
                }},
            }),
        )
        .is_err());
        let scope = [7u8; 16];
        assert_eq!(
            scoped_runtime_request_id(&scope, "turn-1", "41", 1),
            scoped_runtime_request_id(&scope, "turn-1", "41", 1),
        );
        assert_ne!(
            scoped_runtime_request_id(&scope, "turn-1", "41", 1),
            scoped_runtime_request_id(&scope, "turn-2", "41", 1),
        );
        assert_ne!(
            scoped_runtime_request_id(&scope, "turn-1", "41", 1),
            scoped_runtime_request_id(&[8u8; 16], "turn-1", "41", 1),
        );
        assert_ne!(
            scoped_runtime_request_id(&scope, "turn-1", "41", 1),
            scoped_runtime_request_id(&scope, "turn-1", "41", 2),
        );
        assert!(codex_question_response(
            &pending,
            &json!({
                "schema": "paperclip.question_response.v1",
                "answers": {"environment": {"selectedOptionIds": ["option-1"]}},
                "providerEnvelope": {},
            }),
        )
        .is_err());
    }

    #[test]
    fn preserves_canonical_opencode_questions_and_wraps_the_validated_resolution() {
        let params = json!({
            "request": {
                "schema": "paperclip.runtime_request.v2",
                "requestKind": "runtime",
                "requestId": "opencode-question-1",
                "type": "input",
                "status": "pending",
                "prompt": "OpenCode requests user input.",
                "input": {
                    "schema": "paperclip.question_set.v1",
                    "questions": [{
                        "id": "regions",
                        "prompt": "Which regions should receive the deployment?",
                        "required": true,
                        "answerMode": "multi_select",
                        "options": [
                            {"id": "east", "label": "us-east-1"},
                            {"id": "west", "label": "us-west-2"}
                        ]
                    }]
                },
                "origin": {
                    "adapter": "opencode-server",
                    "provider": "opencode",
                    "method": "question.asked"
                },
                "turnId": "turn-1",
                "itemId": "opencode-question-1"
            }
        });
        let (request_id, question_set, option_labels) =
            opencode_question_set(&params).expect("accept the proxy's canonical request");
        assert_eq!(request_id, "opencode-question-1");
        assert_eq!(question_set, params["request"]["input"]);
        assert!(option_labels.is_empty());

        let pending = PendingRuntimeRequest {
            rpc_id: json!("proxy-rpc-1"),
            turn_id: "turn-1".to_owned(),
            method: OPENCODE_RUNTIME_REQUEST_METHOD.to_owned(),
            params,
            question_set,
            option_labels,
            retained_bytes: 0,
        };
        let response = json!({
            "schema": "paperclip.question_response.v1",
            "answers": {
                "regions": {"selectedOptionIds": ["east", "west"]}
            }
        });
        assert_eq!(
            codex_question_response(&pending, &response)
                .expect("wrap the validated response for the OpenCode proxy"),
            json!({
                "resolution": {
                    "action": "submit",
                    "response": response,
                }
            })
        );
    }

    #[test]
    fn rejects_non_input_and_malformed_opencode_runtime_requests() {
        let permission = json!({
            "request": {
                "schema": "paperclip.runtime_request.v2",
                "requestKind": "runtime",
                "requestId": "permission-1",
                "type": "permission",
                "status": "pending",
                "prompt": "Approve this operation?",
                "turnId": "turn-1"
            }
        });
        assert!(opencode_question_set(&permission)
            .unwrap_err()
            .to_string()
            .contains("structured input"));

        let duplicate_options = json!({
            "request": {
                "schema": "paperclip.runtime_request.v2",
                "requestKind": "runtime",
                "requestId": "question-1",
                "type": "input",
                "status": "pending",
                "prompt": "Choose.",
                "input": {
                    "schema": "paperclip.question_set.v1",
                    "questions": [{
                        "id": "target",
                        "prompt": "Choose a target.",
                        "required": true,
                        "answerMode": "single_select",
                        "options": [
                            {"id": "same", "label": "One"},
                            {"id": "same", "label": "Two"}
                        ]
                    }]
                },
                "turnId": "turn-1"
            }
        });
        assert!(opencode_question_set(&duplicate_options)
            .unwrap_err()
            .to_string()
            .contains("option ids must be unique"));
    }

    #[test]
    fn finds_only_active_turns_during_resume() {
        let snapshot = json!({"thread": {"turns": [
            {"id": "done", "status": "completed"},
            {"id": "active", "status": "inProgress"}
        ]}});
        assert_eq!(latest_active_turn_id(&snapshot).as_deref(), Some("active"));
    }

    #[test]
    fn rejects_notifications_bound_to_another_thread_or_active_turn() {
        assert!(validate_notification_binding(
            "thread-1",
            Some("turn-1"),
            &json!({"threadId": "thread-2", "turnId": "turn-1"}),
        )
        .is_err());
        assert!(validate_notification_binding(
            "thread-1",
            Some("turn-1"),
            &json!({"threadId": "thread-1", "turnId": "turn-2"}),
        )
        .is_err());
        assert!(validate_notification_binding(
            "thread-1",
            Some("turn-1"),
            &json!({"threadId": "thread-1", "turnId": "turn-1"}),
        )
        .is_ok());
    }

    #[test]
    fn rejects_requests_bound_to_any_non_active_turn_nonfatally() {
        let mut turn_one_settled = SettledProviderTurnIds::default();
        turn_one_settled.insert("turn-1".to_owned());
        let mut turn_two_settled = SettledProviderTurnIds::default();
        turn_two_settled.insert("turn-2".to_owned());
        let no_settled_turns = SettledProviderTurnIds::default();
        assert!(request_targets_non_active_turn(
            Some("turn-2"),
            &turn_one_settled,
            &json!({"turnId": "turn-1"}),
        ));
        assert!(request_targets_non_active_turn(
            Some("turn-2"),
            &turn_one_settled,
            &json!({"turnId": "turn-0"}),
        ));
        assert!(request_targets_non_active_turn(
            None,
            &turn_two_settled,
            &json!({"turnId": "turn-1"}),
        ));
        assert!(request_targets_non_active_turn(
            Some("turn-1"),
            &turn_one_settled,
            &json!({"turnId": "turn-1"}),
        ));
        assert!(!request_targets_non_active_turn(
            Some("turn-2"),
            &turn_one_settled,
            &json!({"turnId": "turn-2"}),
        ));
        assert!(!request_targets_non_active_turn(
            None,
            &no_settled_turns,
            &json!({}),
        ));
        assert!(request_targets_non_active_turn(
            Some("turn-2"),
            &turn_one_settled,
            &json!({"request": {"turnId": "turn-1"}}),
        ));
        assert!(!request_targets_non_active_turn(
            Some("turn-2"),
            &turn_one_settled,
            &json!({"request": {"turnId": "turn-2"}}),
        ));
    }

    #[test]
    fn settled_provider_turn_history_never_evicts_exact_identities() {
        let mut settled = SettledProviderTurnIds::default();
        for index in 0..MAX_SETTLED_PROVIDER_TURN_IDS {
            assert!(settled.insert(format!("turn-{index}")));
        }

        assert_eq!(settled.ids.len(), MAX_SETTLED_PROVIDER_TURN_IDS);
        assert!(settled.contains("turn-0"));
        assert!(settled.contains("turn-1"));
        assert!(settled.at_capacity());
        assert!(!settled.insert(format!("turn-{MAX_SETTLED_PROVIDER_TURN_IDS}")));
        assert!(!settled.contains(&format!("turn-{MAX_SETTLED_PROVIDER_TURN_IDS}")));
        assert_eq!(settled.ids.len(), MAX_SETTLED_PROVIDER_TURN_IDS);
        assert!(settled.contains("turn-0"));
        assert!(settled.filter.is_empty());
    }

    #[test]
    fn restored_provider_turn_identity_is_retained_in_release_builds() {
        let mut settled = SettledProviderTurnIds::default();

        settled.restore("turn-restored".to_owned()).unwrap();

        assert!(settled.contains("turn-restored"));
    }

    #[test]
    fn restores_the_complete_durable_provider_turn_ledger() {
        let mut settled = SettledProviderTurnIds::default();

        settled
            .restore_all(
                ["turn-older".to_owned(), "turn-latest".to_owned()],
                DurableReplayFilter::default(),
            )
            .unwrap();

        assert!(settled.contains("turn-older"));
        assert!(settled.contains("turn-latest"));
    }

    #[test]
    fn bounds_all_retained_pending_tool_request_data_in_aggregate() {
        let request_bytes = pending_tool_request_size([1, 2, 3, 4]).unwrap();
        assert_eq!(request_bytes, 10);
        assert_eq!(
            retain_pending_tool_request_bytes(MAX_PENDING_TOOL_REQUEST_BYTES - 10, request_bytes)
                .unwrap(),
            MAX_PENDING_TOOL_REQUEST_BYTES
        );
        assert!(retain_pending_tool_request_bytes(MAX_PENDING_TOOL_REQUEST_BYTES, 1).is_err());
        assert!(retain_pending_tool_request_bytes(usize::MAX, 1).is_err());
        assert!(pending_tool_request_size([usize::MAX, 1]).is_err());
    }

    #[test]
    fn bounds_all_retained_runtime_request_data_in_aggregate() {
        assert_eq!(
            retain_pending_runtime_request_bytes(MAX_PENDING_RUNTIME_REQUEST_BYTES - 10, 10,),
            Some(MAX_PENDING_RUNTIME_REQUEST_BYTES)
        );
        assert_eq!(
            retain_pending_runtime_request_bytes(MAX_PENDING_RUNTIME_REQUEST_BYTES, 1),
            None
        );
        assert_eq!(retain_pending_runtime_request_bytes(usize::MAX, 1), None);
    }

    #[test]
    fn bounds_messages_buffered_while_waiting_for_a_response() {
        assert_eq!(
            retain_buffered_message_bytes(MAX_BUFFERED_MESSAGE_BYTES - 10, 10),
            Some(MAX_BUFFERED_MESSAGE_BYTES)
        );
        assert_eq!(
            retain_buffered_message_bytes(MAX_BUFFERED_MESSAGE_BYTES, 1),
            None
        );
        assert_eq!(retain_buffered_message_bytes(usize::MAX, 1), None);
    }
}
