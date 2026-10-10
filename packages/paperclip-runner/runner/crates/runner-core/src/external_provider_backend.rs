//! Dot is an external service. This executor owns the durable turn and tool
//! receipts; the authenticated controller owns OAuth, the mailbox and policy.
//! No network credential or callback address enters this provider descriptor.
use std::collections::{BTreeMap, VecDeque};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory, Command,
    CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError, EventPriority,
    PolledEvent,
};
use crate::provider_bridge::{
    semantic_value_digest, AuthorizedToolSet, ProviderToolBridge, ToolResult,
};

pub const DOT_PROVIDER_STATE_FILE: &str = "dot-provider-state.json";
const SCHEMA: &str = "paperclip.runner.dot-provider-state.v1";
pub const MUSE_PROVIDER_STATE_FILE: &str = "muse-provider-state.json";
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExternalProviderCodec {
    Dot,
    Muse,
}
impl ExternalProviderCodec {
    fn kind(self) -> &'static str {
        match self {
            Self::Dot => "openai_dot",
            Self::Muse => "muse",
        }
    }
    fn driver(self) -> &'static str {
        match self {
            Self::Dot => "openai_dot_mcp",
            Self::Muse => "muse_external",
        }
    }
    fn revision(self) -> &'static str {
        match self {
            Self::Dot => "dot-mcp-v1",
            Self::Muse => "muse-v1",
        }
    }
    fn file(self) -> &'static str {
        match self {
            Self::Dot => DOT_PROVIDER_STATE_FILE,
            Self::Muse => MUSE_PROVIDER_STATE_FILE,
        }
    }
    fn schema(self) -> &'static str {
        match self {
            Self::Dot => SCHEMA,
            Self::Muse => "paperclip.runner.muse-provider-state.v1",
        }
    }
    fn event_prefix(self) -> &'static str {
        match self {
            Self::Dot => "dot_",
            Self::Muse => "muse_",
        }
    }
}
pub type DotCommandExecutor = ExternalCommandExecutor;
const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OPERATIONS: usize = 4096;
const MAX_EVENTS: usize = 8192;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalProviderDescriptor {
    pub kind: String,
    pub company_id: String,
    pub agent_id: String,
    pub binding_id: String,
    pub binding_generation: u64,
    pub accept_by_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub instructions: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompletionContract {
    revision: String,
    criterion_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    request_id: String,
    binding_id: String,
    binding_generation: u64,
    run_id: String,
    normalized_session_id: String,
    turn_id: String,
    assignment_revision: u64,
    digest: String,
    action: String,
    input: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    operation: Operation,
    outcome: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeInput {
    request: Value,
    response: Option<Value>,
    input_digest: Option<String>,
    consumed: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema: String,
    run_id: String,
    session_id: String,
    turn_id: String,
    descriptor: ExternalProviderDescriptor,
    completion_contract: CompletionContract,
    tools: ProviderToolBridge,
    lifecycle: String,
    assignment_revision: u64,
    text: Option<String>,
    operations: BTreeMap<String, Receipt>,
    completion: Option<Value>,
    #[serde(default)]
    completion_input: Option<Value>,
    events: VecDeque<PolledEvent>,
    next_event: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    runtime_inputs: BTreeMap<String, RuntimeInput>,
}

fn invalid(message: impl Into<String>) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}

fn bounded_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}

impl State {
    fn codec(&self) -> Result<ExternalProviderCodec, DurableRunnerError> {
        match self.descriptor.kind.as_str() {
            "openai_dot" => Ok(ExternalProviderCodec::Dot),
            "muse" => Ok(ExternalProviderCodec::Muse),
            _ => Err(invalid("external provider kind is invalid")),
        }
    }
    fn validate(&self, config: &DurableRunnerConfig) -> Result<(), DurableRunnerError> {
        let d = &self.descriptor;
        let codec = self.codec()?;
        if self.schema != codec.schema()
            || self.run_id != config.run_id
            || self.session_id != config.normalized_session_id
            || self.turn_id != config.turn_id
            || !bounded_id(&d.company_id)
            || !bounded_id(&d.agent_id)
            || !bounded_id(&d.binding_id)
            || d.binding_generation == 0
            || d.instructions.len() > 1024 * 1024
            || d.instructions.contains('\0')
            || d.accept_by_unix_ms >= d.expires_at_unix_ms
            || d.expires_at_unix_ms - d.accept_by_unix_ms > 24 * 60 * 60 * 1000
            || self.operations.len() > MAX_OPERATIONS
            || self.events.len() > MAX_EVENTS
            || self.next_event == 0
            || !matches!(
                self.lifecycle.as_str(),
                "prepared" | "open" | "offered" | "running" | "completed" | "fenced" | "closed"
            )
            || self.completion_contract.revision.is_empty()
            || self.completion_contract.criterion_ids.is_empty()
            || self.completion_contract.criterion_ids.len() > 256
            || self
                .completion_contract
                .criterion_ids
                .iter()
                .any(|id| !bounded_id(id))
        {
            return Err(invalid(
                "Dot durable state or immutable authority is invalid",
            ));
        }
        self.tools
            .validate_recovered()
            .map_err(|e| invalid(e.to_string()))?;
        let mut previous = 0;
        for event in &self.events {
            let n = event
                .executor_event_id
                .strip_prefix(codec.event_prefix())
                .and_then(|n| n.parse::<u64>().ok())
                .ok_or_else(|| invalid("Dot event identity is invalid"))?;
            if n <= previous || n >= self.next_event {
                return Err(invalid("Dot event order is invalid"));
            }
            previous = n;
        }
        if codec == ExternalProviderCodec::Dot && !self.runtime_inputs.is_empty() {
            return Err(invalid("Dot cannot recover runtime input"));
        }
        if self.runtime_inputs.len() > 256 {
            return Err(invalid("Muse runtime input capacity exceeded"));
        }
        for (id, input) in &self.runtime_inputs {
            if !bounded_id(id)
                || id.len() > 160
                || input.request["requestId"] != json!(id)
                || input.request["turnId"] != json!(self.turn_id)
                || input.request["schema"] != json!("paperclip.runtime_request.v2")
                || input.request["status"] != json!("pending")
            {
                return Err(invalid("Muse runtime input checkpoint identity mismatch"));
            }
            crate::acpx_event_payload::validate_question_set(&input.request["input"])
                .map_err(|e| invalid(e.to_string()))?;
            match &input.response {
                Some(response) => {
                    crate::question_response::validate_question_response(
                        &input.request["input"],
                        response,
                    )
                    .map_err(|e| invalid(e.to_string()))?;
                    let digest = semantic_value_digest(
                        &json!({"requestId":id,"turnId":self.turn_id,"response":response}),
                    );
                    if input.input_digest.as_deref() != Some(&digest) {
                        return Err(invalid("Muse answer checkpoint digest mismatch"));
                    }
                }
                None if input.input_digest.is_some() || input.consumed => {
                    return Err(invalid("Muse answer checkpoint receipt missing"))
                }
                None => (),
            }
        }
        for (id, receipt) in &self.operations {
            if id != &receipt.operation.request_id {
                return Err(invalid("Dot receipt identity mismatch"));
            }
            self.validate_operation(&receipt.operation)?;
        }
        Ok(())
    }

    fn validate_operation(&self, op: &Operation) -> Result<(), DurableRunnerError> {
        let allowed: &[&str] = match op.action.as_str() {
            "accept" => &[],
            "tool" => &["name", "arguments"],
            "progress" => &["text"],
            "finish" => &["result"],
            "renew" => &["expiresAtUnixMs"],
            "request_user_input" if self.codec()? == ExternalProviderCodec::Muse => {
                &["requestId", "questionSet"]
            }
            "consume_input" if self.codec()? == ExternalProviderCodec::Muse => {
                &["requestId", "inputDigest"]
            }
            _ => return Err(invalid("Dot action is unsupported")),
        };
        if op.input.as_object().is_none_or(|input| {
            input.len() != allowed.len() || allowed.iter().any(|key| !input.contains_key(*key))
        }) {
            return Err(invalid("Dot action input must match its closed contract"));
        }
        if !bounded_id(&op.request_id)
            || op.binding_id != self.descriptor.binding_id
            || op.binding_generation != self.descriptor.binding_generation
            || op.run_id != self.run_id
            || op.normalized_session_id != self.session_id
            || op.turn_id != self.turn_id
            || op.assignment_revision != self.assignment_revision
            || op.digest != semantic_value_digest(&json!({"action":op.action,"input":op.input}))
            || !op.input.is_object()
            || serde_json::to_vec(&op.input)
                .map_err(|_| invalid("invalid Dot input"))?
                .len()
                > 256 * 1024
        {
            return Err(invalid("Dot operation authority or digest mismatch"));
        }
        Ok(())
    }

    fn push(&mut self, kind: &str, payload: Value) -> Result<(), DurableRunnerError> {
        if self.events.len() >= MAX_EVENTS {
            return Err(invalid("Dot durable event capacity reached"));
        }
        self.events.push_back(PolledEvent {
            executor_event_id: format!("{}{:016}", self.codec()?.event_prefix(), self.next_event),
            event_type: kind.to_owned(),
            priority: EventPriority::P0,
            payload,
        });
        self.next_event = self
            .next_event
            .checked_add(1)
            .ok_or_else(|| invalid("Dot event sequence overflow"))?;
        Ok(())
    }

    fn binding(&self) -> Value {
        json!({"companyId":self.descriptor.company_id,"agentId":self.descriptor.agent_id,
            "bindingId":self.descriptor.binding_id,"bindingGeneration":self.descriptor.binding_generation,
            "runId":self.run_id,"normalizedSessionId":self.session_id,"turnId":self.turn_id,
            "assignmentRevision":self.assignment_revision})
    }

    fn settle(&mut self, id: &str, outcome: Value) -> Result<(), DurableRunnerError> {
        self.operations
            .get_mut(id)
            .ok_or_else(|| invalid("Dot receipt missing"))?
            .outcome = outcome.clone();
        self.push(
            "external_provider.operation_settled",
            json!({"binding":self.binding(),"requestId":id,"outcome":outcome}),
        )
    }
}

pub struct ExternalCommandExecutor {
    state_dir: PathBuf,
    config: DurableRunnerConfig,
    state: Option<State>,
    restored: bool,
    codec: ExternalProviderCodec,
}

impl ExternalCommandExecutor {
    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        Self::with_codec(state_dir, config, ExternalProviderCodec::Dot)
    }
    pub fn with_codec(
        state_dir: impl Into<PathBuf>,
        config: &DurableRunnerConfig,
        codec: ExternalProviderCodec,
    ) -> Self {
        Self {
            state_dir: state_dir.into(),
            config: config.clone(),
            state: None,
            restored: false,
            codec,
        }
    }

    fn restore(&mut self) -> Result<(), DurableRunnerError> {
        if self.restored {
            return Ok(());
        }
        let path = self.state_dir.join(self.codec.file());
        if path
            .try_exists()
            .map_err(|_| invalid("Dot state cannot be inspected"))?
        {
            verify_private_directory(&self.state_dir)?;
            let mut file = open_private_regular_file(&path)
                .map_err(|_| invalid("Dot state cannot be opened"))?;
            if file
                .metadata()
                .map_err(|_| invalid("Dot state metadata is unavailable"))?
                .len()
                > MAX_STATE_BYTES
            {
                return Err(invalid("Dot state is oversized"));
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|_| invalid("Dot state cannot be read"))?;
            let state: State =
                serde_json::from_slice(&bytes).map_err(|_| invalid("Dot state is malformed"))?;
            state.validate(&self.config)?;
            if state.codec()? != self.codec {
                return Err(invalid("external checkpoint provider mismatch"));
            }
            self.state = Some(state);
        }
        self.restored = true;
        Ok(())
    }

    fn save(&self) -> Result<(), DurableRunnerError> {
        let Some(state) = &self.state else {
            return Ok(());
        };
        state.validate(&self.config)?;
        verify_private_directory(&self.state_dir)?;
        let path = self.state_dir.join(self.codec.file());
        let bytes =
            serde_json::to_vec(state).map_err(|_| invalid("Dot state cannot be encoded"))?;
        if bytes.len() as u64 > MAX_STATE_BYTES {
            return Err(invalid("Dot state capacity reached"));
        }
        let (temporary, mut file) = create_private_temporary_file(&path)?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            #[cfg(unix)]
            File::open(&self.state_dir)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
            return Err(invalid("Dot state cannot be committed"));
        }
        Ok(())
    }

    fn prepare(&mut self, payload: &Value) -> Result<Value, DurableRunnerError> {
        let descriptor: ExternalProviderDescriptor =
            serde_json::from_value(payload["provider"].clone())
                .map_err(|_| invalid("Dot requires a closed provider descriptor"))?;
        let contract: CompletionContract =
            serde_json::from_value(payload["completionContract"].clone())
                .map_err(|_| invalid("Dot requires a completion contract"))?;
        let catalog: AuthorizedToolSet = serde_json::from_value(payload["authorizedTools"].clone())
            .map_err(|_| invalid("Dot requires an authorized tool catalog"))?;
        if let Some(state) = &self.state {
            if state.descriptor != descriptor || state.completion_contract != contract {
                return Err(invalid("Dot immutable provider authority changed"));
            }
            state
                .tools
                .verify_tool_set(&catalog)
                .map_err(|e| invalid(e.to_string()))?;
        } else {
            let mut tools = ProviderToolBridge::default();
            tools.prepare(catalog).map_err(|e| invalid(e.to_string()))?;
            self.state = Some(State {
                schema: self.codec.schema().to_owned(),
                run_id: self.config.run_id.clone(),
                session_id: self.config.normalized_session_id.clone(),
                turn_id: self.config.turn_id.clone(),
                descriptor,
                completion_contract: contract,
                tools,
                lifecycle: "prepared".to_owned(),
                assignment_revision: 1,
                text: None,
                operations: BTreeMap::new(),
                completion: None,
                completion_input: None,
                events: VecDeque::new(),
                next_event: 1,
                runtime_inputs: BTreeMap::new(),
            });
        }
        if self.state.as_ref().unwrap().codec()? != self.codec {
            return Err(invalid("external provider descriptor mismatch"));
        }
        Ok(json!({"status":"prepared","provider":self.codec.kind(),"driver":self.codec.driver()}))
    }

    fn operation(&mut self, value: &Value) -> Result<Value, DurableRunnerError> {
        let op: Operation = serde_json::from_value(value.clone())
            .map_err(|_| invalid("Dot operation is malformed"))?;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| invalid("Dot is not prepared"))?;
        state.validate_operation(&op)?;
        // Current authority is checked before replay, so a receipt cannot revive a fenced turn.
        let now = crate::durable::current_unix_ms()?;
        if now >= state.descriptor.expires_at_unix_ms
            || matches!(state.lifecycle.as_str(), "fenced" | "closed")
        {
            return Err(invalid("Dot assignment authority is fenced or expired"));
        }
        if let Some(existing) = state.operations.get(&op.request_id) {
            if existing.operation != op {
                return Err(invalid("Dot requestId was reused with different input"));
            }
            return Ok(existing.outcome.clone());
        }
        if state.operations.len() >= MAX_OPERATIONS {
            return Err(invalid("Dot operation capacity reached"));
        }
        let id = op.request_id.clone();
        state.operations.insert(
            id.clone(),
            Receipt {
                operation: op.clone(),
                outcome: json!({"status":"pending"}),
            },
        );
        let outcome = match op.action.as_str() {
            "accept" => {
                if state.lifecycle != "offered" || now >= state.descriptor.accept_by_unix_ms {
                    return Err(invalid("Dot assignment is unavailable for acceptance"));
                }
                state.lifecycle = "running".to_owned();
                state.push("turn.started", json!({"provider":state.descriptor.kind,"providerTurnId":state.turn_id,"turnId":state.turn_id}))?;
                json!({"status":"accepted"})
            }
            "tool" => {
                if state.lifecycle != "running" {
                    return Err(invalid("Dot must accept before using tools"));
                }
                if state.completion.is_some() {
                    return Err(invalid("Dot completion was already accepted"));
                }
                let tool = op.input["name"]
                    .as_str()
                    .ok_or_else(|| invalid("Dot tool name is missing"))?;
                let args = op.input["arguments"].clone();
                if matches!(tool, "paperclip_finish" | "paperclip_block")
                    && state.runtime_inputs.values().any(|input| !input.consumed)
                {
                    return Err(invalid(
                        "external completion requires ingested runtime input",
                    ));
                }
                state
                    .tools
                    .begin_call(id.clone(), tool.to_owned(), args.clone())
                    .map_err(|e| invalid(e.to_string()))?;
                state.push("semantic_tool.input", json!({"semantic_tool":{
                    "schema":"paperclip.prp.semantic_tool.v1","schemaVersion":1,"phase":"input",
                    "operationId":tool,"callId":id,"idempotencyKey":id,
                    "correlation":{"runId":state.run_id,"normalizedSessionId":state.session_id,"turnId":state.turn_id,"itemId":self.config.item_id},
                    "content":{"digest":semantic_value_digest(&args),"redactionDisposition":"digest_only","references":[]},"input":args}}))?;
                // ACK releases the command lane. semantic_tool.result settles this operation later.
                return Ok(json!({"status":"pending","requestId":id}));
            }
            "request_user_input" => {
                if state.lifecycle != "running" || state.completion.is_some() {
                    return Err(invalid(
                        "Muse runtime input requires an active uncompleted turn",
                    ));
                }
                let request_id = op.input["requestId"]
                    .as_str()
                    .filter(|id| bounded_id(id) && id.len() <= 160)
                    .ok_or_else(|| invalid("Muse native request identity is invalid"))?
                    .to_owned();
                let question_set = op.input["questionSet"].clone();
                crate::acpx_event_payload::validate_question_set(&question_set)
                    .map_err(|e| invalid(e.to_string()))?;
                if state.runtime_inputs.len() >= 256
                    || state.runtime_inputs.contains_key(&request_id)
                {
                    return Err(invalid(
                        "Muse native request identity already exists or capacity reached",
                    ));
                }
                let request = json!({"schema":"paperclip.runtime_request.v2","requestKind":"runtime",
                    "requestId":request_id,"type":"input","status":"pending","prompt":"Muse requests user input.",
                    "input":question_set,"origin":{"adapter":"muse-v1","provider":"muse","method":"request_user_input"},
                    "turnId":state.turn_id,"itemId":self.config.item_id});
                state.runtime_inputs.insert(
                    request_id.clone(),
                    RuntimeInput {
                        request: request.clone(),
                        response: None,
                        input_digest: None,
                        consumed: false,
                    },
                );
                state.push("runtime_request.created", json!({"request":request}))?;
                json!({"status":"pending","requestId":request_id})
            }
            "consume_input" => {
                if state.lifecycle != "running" {
                    return Err(invalid("Muse input ingestion requires active turn"));
                }
                let request_id = op.input["requestId"]
                    .as_str()
                    .ok_or_else(|| invalid("Muse native request missing"))?;
                let input = state
                    .runtime_inputs
                    .get_mut(request_id)
                    .ok_or_else(|| invalid("Muse input not found"))?;
                if input.response.is_none()
                    || input.input_digest.as_deref() != op.input["inputDigest"].as_str()
                {
                    return Err(invalid("Muse input digest does not match available answer"));
                }
                input.consumed = true;
                json!({"status":"consumed","requestId":request_id,"inputDigest":input.input_digest})
            }
            "renew" => {
                let expiry = op.input["expiresAtUnixMs"]
                    .as_u64()
                    .ok_or_else(|| invalid("Dot renewal expiry missing"))?;
                if state.lifecycle != "running"
                    || expiry <= now
                    || expiry > now + 2 * 60 * 60 * 1000
                    || expiry > state.descriptor.accept_by_unix_ms + 24 * 60 * 60 * 1000
                {
                    return Err(invalid("Dot renewal exceeds current authority bounds"));
                }
                state.descriptor.expires_at_unix_ms = expiry;
                json!({"status":"renewed","expiresAtUnixMs":expiry})
            }
            "progress" => {
                if state.lifecycle != "running" {
                    return Err(invalid("Dot turn is not running"));
                }
                let text = op.input["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 12000)
                    .ok_or_else(|| invalid("Dot progress must be bounded text"))?;
                state.push("item.completed", json!({"provider":state.descriptor.kind,"item":{"id":id,"type":"agentMessage","text":text,"phase":"commentary"}}))?;
                json!({"status":"completed"})
            }
            "finish" => {
                if state.lifecycle != "running"
                    || state.tools.pending_calls().next().is_some()
                    || state.runtime_inputs.values().any(|input| !input.consumed)
                {
                    return Err(invalid("Dot cannot finish with unsettled tool calls"));
                }
                let submitted = &op.input["result"];
                if state.completion.as_ref() != Some(submitted)
                    && state.completion_input.as_ref() != Some(submitted)
                {
                    return Err(invalid("Dot must successfully invoke paperclip_finish or paperclip_block with this result first"));
                }
                let result = state
                    .completion
                    .clone()
                    .ok_or_else(|| invalid("Dot completion is missing"))?;
                state.lifecycle = "completed".to_owned();
                state
                    .tools
                    .settle_turn("completed")
                    .map_err(|e| invalid(e.to_string()))?;
                state.push("run.result.proposed", result.clone())?;
                state.push("item.completed", json!({"provider":state.descriptor.kind,"item":{"id":id,"type":"agentMessage","text":result["summary"],"phase":"final_answer"}}))?;
                state.push("turn.completed", json!({"provider":state.descriptor.kind,"providerTurnId":state.turn_id,"status":"completed"}))?;
                state.push("run.terminal", json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"completed","runTerminalState":"succeeded","reportedWorkDisposition":result["reportedWorkDisposition"]}))?;
                json!({"status":"completed"})
            }
            _ => return Err(invalid("Dot action is unsupported")),
        };
        state.settle(&id, outcome.clone())?;
        Ok(outcome)
    }

    fn apply_tool_result(&mut self, payload: &Value) -> Result<Value, DurableRunnerError> {
        let result: ToolResult = serde_json::from_value(payload.clone())
            .map_err(|_| invalid("Dot semantic result is invalid"))?;
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| invalid("Dot is not prepared"))?;
        state
            .tools
            .apply_result(result.clone())
            .map_err(|e| invalid(e.to_string()))?;
        let receipt = state
            .operations
            .get(&result.call_id)
            .ok_or_else(|| invalid("Dot semantic receipt is missing"))?;
        if receipt.operation.action != "tool"
            || receipt.operation.input["name"] != result.operation_id
        {
            return Err(invalid("Dot semantic receipt does not match the tool call"));
        }
        if matches!(
            result.operation_id.as_str(),
            "paperclip_finish" | "paperclip_block"
        ) && !result.is_error
            && result
                .result
                .get("outcome")
                .and_then(Value::as_str)
                .is_none_or(|o| matches!(o, "completed" | "succeeded" | "success"))
        {
            // The control plane normalizes provider aliases and optional fields.
            // Persist that exact accepted report; do not revalidate raw arguments
            // against a different contract. Legacy canonical receipts still work.
            let accepted_input = receipt.operation.input["arguments"].clone();
            let mut completion = result
                .result
                .get("completionReport")
                .cloned()
                .unwrap_or_else(|| accepted_input.clone());
            completion["schema"] = json!("paperclip.run_result.v1");
            let schema: Value = serde_json::from_str(include_str!(
                "../../../../protocol/schemas/result.schema.json"
            ))
            .map_err(|_| invalid("Dot result schema is unavailable"))?;
            let validator = jsonschema::validator_for(&schema)
                .map_err(|_| invalid("Dot result schema is invalid"))?;
            let criterion_ids = completion
                .pointer("/completionClaim/criteria")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| i["criterionId"].as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let mut expected = state.completion_contract.criterion_ids.clone();
            let mut actual = criterion_ids.clone();
            expected.sort();
            actual.sort();
            if !validator.is_valid(&completion)
                || completion.pointer("/completionClaim/contractRevision")
                    != Some(&json!(state.completion_contract.revision))
                || actual != expected
            {
                return Err(invalid(
                    "Dot completion does not match the admitted contract",
                ));
            }
            state.completion = Some(completion);
            state.completion_input = Some(accepted_input);
        }
        let outcome =
            json!({"status":"completed","isError":result.is_error,"result":result.result});
        // Identical semantic result retries do not produce another mailbox wakeup.
        if state.operations[&result.call_id].outcome != outcome {
            state.settle(&result.call_id, outcome)?;
        }
        Ok(json!({"status":"delivered","callId":result.call_id}))
    }

    fn resolve_input(&mut self, payload: &Value) -> Result<Value, DurableRunnerError> {
        if self.codec != ExternalProviderCodec::Muse {
            return Err(invalid("Dot runtime input is unavailable"));
        }
        let state = self
            .state
            .as_mut()
            .ok_or_else(|| invalid("Muse is not prepared"))?;
        if state.lifecycle != "running"
            || crate::durable::current_unix_ms()? >= state.descriptor.expires_at_unix_ms
        {
            return Err(invalid("Muse runtime input authority is fenced or expired"));
        }
        let id = payload["requestId"]
            .as_str()
            .ok_or_else(|| invalid("Muse native request identity missing"))?
            .to_owned();
        let response = payload["response"].clone();
        let input = state
            .runtime_inputs
            .get_mut(&id)
            .ok_or_else(|| invalid("Muse runtime request not pending"))?;
        crate::question_response::validate_question_response(&input.request["input"], &response)
            .map_err(|e| invalid(e.to_string()))?;
        if let Some(saved) = &input.response {
            if saved != &response {
                return Err(invalid("Muse runtime response changed after delivery"));
            }
            return Ok(
                json!({"status":"delivered","requestId":id,"inputDigest":input.input_digest}),
            );
        }
        let digest = semantic_value_digest(
            &json!({"requestId":id,"turnId":state.turn_id,"response":response}),
        );
        input.response = Some(response.clone());
        input.input_digest = Some(digest.clone());
        let mut resolved = input.request.clone();
        resolved["status"] = json!("resolved");
        state.push("runtime_request.resolved", json!({"request":resolved}))?;
        state.push(
            "external_provider.input_available",
            json!({"binding":state.binding(),"requestId":id,
            "turnId":state.turn_id,"inputDigest":digest,"response":response}),
        )?;
        Ok(json!({"status":"delivered","requestId":id,"inputDigest":digest}))
    }

    fn execute_inner(&mut self, command: &Command) -> Result<Value, DurableRunnerError> {
        match command.command_type.as_str() {
            "run.prepare" => self.prepare(&command.payload),
            "run.attach" => {
                self.prepare(&command.payload)?;
                self.execute_inner(&Command {
                    command_type: "session.open".to_owned(),
                    ..command.clone()
                })
            }
            "external_provider.operation" => self.operation(&command.payload),
            "semantic_tool.result" => self.apply_tool_result(&command.payload),
            "request.resolve" => self.resolve_input(&command.payload),
            "session.open" => {
                let s = self
                    .state
                    .as_mut()
                    .ok_or_else(|| invalid("Dot is not prepared"))?;
                if s.lifecycle == "prepared" {
                    s.lifecycle = "open".to_owned();
                    s.push("session.started", json!({"provider":s.descriptor.kind,"driver":s.codec()?.driver(),"providerVersion":s.codec()?.revision(),
                        "driverSessionId":s.session_id,"providerSessionId":null,"sessionId":s.session_id,"model":null,
                        "providerDescriptor":{"provider":s.descriptor.kind,"driver":s.codec()?.driver(),"executionKind":"remote_service","service":s.descriptor.kind,"model":null,"providerVersion":"unknown","providerSessionId":null,"processId":null}}))?;
                }
                Ok(
                    json!({"status":"started","driverSessionId":s.session_id,"providerSessionId":null}),
                )
            }
            "turn.start" => {
                let s = self
                    .state
                    .as_mut()
                    .ok_or_else(|| invalid("Dot is not prepared"))?;
                let text = command.payload["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 1024 * 1024)
                    .ok_or_else(|| invalid("Dot task text must be bounded"))?;
                if s.lifecycle == "offered" && s.text.as_deref() == Some(text) {
                    return Ok(json!({"status":"offered","providerTurnId":s.turn_id}));
                }
                if s.lifecycle != "open" {
                    return Err(invalid("Dot cannot start another active assignment"));
                }
                s.tools.prepare_turn().map_err(|e| invalid(e.to_string()))?;
                s.lifecycle = "offered".to_owned();
                s.text = Some(text.to_owned());
                s.push("external_provider.dispatch_requested", json!({"binding":s.binding(),"text":text,
                    "instructions":s.descriptor.instructions,"acceptByUnixMs":s.descriptor.accept_by_unix_ms,
                    "expiresAtUnixMs":s.descriptor.expires_at_unix_ms,"completionContract":s.completion_contract,
                    "tools":s.tools.authorized_tools().collect::<Vec<_>>()}))?;
                Ok(json!({"status":"offered","providerTurnId":s.turn_id}))
            }
            "session.snapshot" => {
                let s = self
                    .state
                    .as_ref()
                    .ok_or_else(|| invalid("Dot is not prepared"))?;
                Ok(
                    json!({"status":s.lifecycle,"provider":s.descriptor.kind,"driver":s.codec()?.driver(),"driverSessionId":s.session_id,
                    "providerSessionId":null,"activeProviderTurnId":if matches!(s.lifecycle.as_str(), "offered" | "running") {Some(&s.turn_id)} else {None},
                    "operationCount":s.operations.len(),"pendingTools":s.tools.pending_calls().count(),"binding":s.binding(),
                    "pendingRuntimeRequests":s.runtime_inputs.values().filter(|input| input.response.is_none()).map(|input| input.request.clone()).collect::<Vec<_>>(),
                    "unconsumedInputs":s.runtime_inputs.values().filter(|input| !input.consumed).count()}),
                )
            }
            "turn.stop" | "turn.interrupt" | "run.cancel" => {
                let s = self
                    .state
                    .as_mut()
                    .ok_or_else(|| invalid("Dot is not prepared"))?;
                if !matches!(s.lifecycle.as_str(), "completed" | "fenced" | "closed") {
                    s.lifecycle = "fenced".to_owned();
                    s.tools
                        .settle_turn("authority_revoked")
                        .map_err(|e| invalid(e.to_string()))?;
                    s.push("external_provider.dispatch_requested", json!({"binding":s.binding(),"kind":"authority_revoked","externalStopConfirmed":false}))?;
                    s.push("turn.cancelled", json!({"provider":s.descriptor.kind,"providerTurnId":s.turn_id,"externalStopConfirmed":false}))?;
                    s.push("run.terminal", json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"cancelled","runTerminalState":"cancelled","reportedWorkDisposition":"needs_review"}))?;
                }
                Ok(
                    json!({"status":"authority_revoked","externalStopConfirmed":false,"unsettledTools":s.tools.pending_calls().count()}),
                )
            }
            "session.close" | "session.destroy" => {
                let s = self
                    .state
                    .as_mut()
                    .ok_or_else(|| invalid("Dot is not prepared"))?;
                if !matches!(
                    s.lifecycle.as_str(),
                    "completed" | "fenced" | "open" | "closed"
                ) || s.tools.pending_calls().next().is_some()
                {
                    return Err(invalid("Dot session has unsettled work"));
                }
                s.lifecycle = "closed".to_owned();
                Ok(json!({"status":"closed","externalStopConfirmed":false}))
            }
            "runner.suspend" | "runner.shutdown" | "runner.drain" => {
                Ok(json!({"status":"completed","externalStopConfirmed":false}))
            }
            _ => Ok(json!({"status":"rejected","code":"provider_command_unavailable"})),
        }
    }
}

impl CommandExecutor for ExternalCommandExecutor {
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        self.restore()?;
        let prior = self.state.clone();
        let outcome = self.execute_inner(command).and_then(|result| {
            self.save()?;
            Ok(CommandExecution::result(result))
        });
        if outcome.is_err() {
            self.state = prior;
        }
        outcome
    }
    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        self.config = config.clone();
    }
    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.restore()?;
        let now = crate::durable::current_unix_ms()?;
        let expired = self.state.as_ref().is_some_and(|s| {
            (s.lifecycle == "offered" && now >= s.descriptor.accept_by_unix_ms)
                || (s.lifecycle == "running" && now >= s.descriptor.expires_at_unix_ms)
        });
        if expired {
            let prior = self.state.clone();
            let s = self.state.as_mut().unwrap();
            s.lifecycle = "fenced".to_owned();
            let expiry = (|| -> Result<(), DurableRunnerError> {
                s.tools.settle_turn("authority_expired").map_err(|e| invalid(e.to_string()))?;
                s.push("external_provider.dispatch_requested", json!({"binding":s.binding(),"kind":"authority_revoked","reason":"authority_expired","externalStopConfirmed":false}))?;
                s.push("turn.failed", json!({"provider":s.descriptor.kind,"providerTurnId":s.turn_id,"error":{"code":"dot_assignment_expired","message":"Dot assignment acceptance or execution authority expired."}}))?;
                s.push("run.terminal", json!({"schema":"paperclip.prp.terminal.v1","turnTerminalState":"failed","runTerminalState":"failed","reportedWorkDisposition":"needs_review"}))?;
                Ok(())
            })().and_then(|_| self.save());
            if let Err(error) = expiry {
                self.state = prior;
                return Err(error);
            }
        }
        Ok(self
            .state
            .as_ref()
            .map(|s| s.events.iter().take(128).cloned().collect())
            .unwrap_or_default())
    }
    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.restore()?;
        Ok(self
            .state
            .as_ref()
            .map(|s| s.events.iter().cloned().collect())
            .unwrap_or_default())
    }
    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if count == 0 {
            return Ok(());
        }
        let s = self
            .state
            .as_mut()
            .ok_or_else(|| invalid("Dot state is unavailable"))?;
        if count > s.events.len() {
            return Err(invalid(
                "Dot event acknowledgement is outside the pending prefix",
            ));
        }
        s.events.drain(..count);
        self.save()
    }
    fn can_reconcile_result_delivery(&mut self) -> Result<bool, DurableRunnerError> {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_bridge::{authorized_tool_catalog_digest, AuthorizedTool};
    use std::time::Duration;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let p =
                std::env::temp_dir().join(format!("paperclip-dot-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn config(path: &std::path::Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1/runner".into(),
            ca_bundle_path: None,
            state_dir: path.to_owned(),
            runner_instance_id: "runner-1".into(),
            environment_lease_id: "lease-1".into(),
            run_id: "run-1".into(),
            normalized_session_id: "session-1".into(),
            turn_id: "turn-1".into(),
            item_id: "item-1".into(),
            runner_version: "0.0.0".into(),
            runner_digest: "sha256:test".into(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 65536,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(60),
        }
    }
    fn command(kind: &str, payload: Value) -> Command {
        Command {
            schema: "paperclip.prp.command.v3".into(),
            command_id: "test-command".into(),
            controller_seq: 1,
            command_type: kind.into(),
            issued_at: "2026-10-02T00:00:00Z".into(),
            deadline_at: None,
            precondition: None,
            payload,
        }
    }
    fn call(executor: &mut DotCommandExecutor, kind: &str, payload: Value) -> Value {
        executor.execute(&command(kind, payload)).unwrap().result
    }
    fn operation(id: &str, action: &str, input: Value) -> Value {
        json!({"requestId":id,"bindingId":"binding-1","bindingGeneration":1,"runId":"run-1",
            "normalizedSessionId":"session-1","turnId":"turn-1","assignmentRevision":1,
            "digest":semantic_value_digest(&json!({"action":action,"input":input})),"action":action,"input":input})
    }
    fn prepared(path: &std::path::Path) -> DotCommandExecutor {
        prepared_codec(path, ExternalProviderCodec::Dot)
    }
    fn prepared_codec(
        path: &std::path::Path,
        codec: ExternalProviderCodec,
    ) -> ExternalCommandExecutor {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let now = crate::durable::current_unix_ms().unwrap();
        let tools = ["save_report", "paperclip_finish"]
            .into_iter()
            .map(|name| AuthorizedTool {
                operation_id: name.into(),
                version: 1,
                description: "test".into(),
                input_schema: json!({"type":"object"}),
                response_schema: json!({}),
            })
            .collect::<Vec<_>>();
        let catalog = AuthorizedToolSet {
            schema: "paperclip.runner.authorized-tools.v1".into(),
            schema_version: 1,
            catalog_digest: authorized_tool_catalog_digest(&tools).unwrap(),
            operations: tools,
        };
        let mut executor = ExternalCommandExecutor::with_codec(path, &config(path), codec);
        call(
            &mut executor,
            "run.prepare",
            json!({"provider":{"kind":codec.kind(),"companyId":"company-1","agentId":"agent-1",
            "bindingId":"binding-1","bindingGeneration":1,"acceptByUnixMs":now+600000,"expiresAtUnixMs":now+7200000,"instructions":"test"},
            "completionContract":{"revision":"contract-1","criterionIds":["criterion-1"]},"authorizedTools":catalog}),
        );
        call(&mut executor, "session.open", json!({}));
        call(&mut executor, "turn.start", json!({"text":"Save a report"}));
        executor
    }
    fn accept(executor: &mut DotCommandExecutor) {
        call(
            executor,
            "external_provider.operation",
            operation("accept-1", "accept", json!({})),
        );
    }
    #[test]
    fn renewal_is_durable_bounded_and_cannot_revive_fenced_authority() {
        let dir = TestDirectory::new();
        let mut executor = prepared(dir.path());
        call(
            &mut executor,
            "external_provider.operation",
            operation("accept", "accept", json!({})),
        );
        let expiry = crate::durable::current_unix_ms().unwrap() + 60 * 60 * 1000;
        let renew = operation("renew", "renew", json!({"expiresAtUnixMs":expiry}));
        assert_eq!(
            call(&mut executor, "external_provider.operation", renew.clone())["status"],
            "renewed"
        );
        assert_eq!(
            call(&mut executor, "external_provider.operation", renew.clone())["expiresAtUnixMs"],
            expiry
        );
        assert!(executor
            .execute(&command(
                "external_provider.operation",
                operation(
                    "too-long",
                    "renew",
                    json!({"expiresAtUnixMs":expiry + 24 * 60 * 60 * 1000})
                )
            ))
            .is_err());
        drop(executor);
        let mut recovered = DotCommandExecutor::with_runner_config(dir.path(), &config(dir.path()));
        assert_eq!(
            call(&mut recovered, "external_provider.operation", renew)["expiresAtUnixMs"],
            expiry
        );
        recovered.state.as_mut().unwrap().lifecycle = "fenced".into();
        assert!(recovered
            .execute(&command(
                "external_provider.operation",
                operation("fenced", "renew", json!({"expiresAtUnixMs":expiry}))
            ))
            .is_err());
    }

    #[test]
    fn acceptance_is_explicit_and_tool_receipts_survive_restart_without_reexecution() {
        let dir = TestDirectory::new();
        let mut executor = prepared(dir.path());
        assert!(!executor
            .poll_events()
            .unwrap()
            .iter()
            .any(|e| e.event_type == "turn.started"));
        let tool = operation(
            "write-1",
            "tool",
            json!({"name":"save_report","arguments":{"text":"42"}}),
        );
        assert!(executor
            .execute(&command("external_provider.operation", tool.clone()))
            .is_err());
        accept(&mut executor);
        assert_eq!(
            call(&mut executor, "external_provider.operation", tool.clone())["status"],
            "pending"
        );
        let events = executor.retained_events().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.event_type == "semantic_tool.input")
                .count(),
            1
        );
        executor.acknowledge_events(events.len()).unwrap();
        drop(executor);
        let mut recovered = DotCommandExecutor::with_runner_config(dir.path(), &config(dir.path()));
        assert_eq!(
            call(&mut recovered, "external_provider.operation", tool.clone())["status"],
            "pending"
        );
        assert!(recovered.poll_events().unwrap().is_empty());
        assert!(recovered
            .execute(&command(
                "external_provider.operation",
                operation(
                    "write-1",
                    "tool",
                    json!({"name":"save_report","arguments":{"text":"43"}})
                )
            ))
            .is_err());
        let result = json!({"callId":"write-1","operationId":"save_report","result":{"reportId":"one"},"isError":false});
        call(&mut recovered, "semantic_tool.result", result.clone());
        call(&mut recovered, "semantic_tool.result", result);
        assert_eq!(
            recovered
                .poll_events()
                .unwrap()
                .iter()
                .filter(|e| e.event_type == "external_provider.operation_settled")
                .count(),
            1
        );
        assert_eq!(
            call(&mut recovered, "external_provider.operation", tool)["result"]["reportId"],
            "one"
        );
    }
    #[test]
    fn revoked_authority_never_replays_and_late_effect_receipts_remain_settleable() {
        let dir = TestDirectory::new();
        let mut e = prepared(dir.path());
        accept(&mut e);
        let op = operation(
            "write-1",
            "tool",
            json!({"name":"save_report","arguments":{}}),
        );
        call(&mut e, "external_provider.operation", op.clone());
        let stop = call(&mut e, "run.cancel", json!({}));
        assert_eq!(stop["externalStopConfirmed"], false);
        assert_eq!(stop["unsettledTools"], 1);
        assert!(e
            .execute(&command("external_provider.operation", op))
            .is_err());
        assert!(e.execute(&command("session.close", json!({}))).is_err());
        call(
            &mut e,
            "semantic_tool.result",
            json!({"callId":"write-1","operationId":"save_report","result":{},"isError":false}),
        );
        assert_eq!(call(&mut e, "session.close", json!({}))["status"], "closed");
    }
    #[test]
    fn finishing_requires_the_accepted_completion_tool_and_exact_contract() {
        let dir = TestDirectory::new();
        let mut e = prepared(dir.path());
        accept(&mut e);
        let result = json!({"schema":"paperclip.run_result.v1","reportedWorkDisposition":"done","summary":"Saved report",
            "completionClaim":{"contractRevision":"contract-1","objectiveSatisfied":true,"criteria":[{"criterionId":"criterion-1","status":"satisfied","evidenceRefs":[]}],"remainingWork":[]},
            "evidence":[],"verification":[],"attentionRequests":[],"artifacts":[]});
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation("finish-1", "finish", json!({"result":result}))
            ))
            .is_err());
        call(
            &mut e,
            "external_provider.operation",
            operation(
                "completion-1",
                "tool",
                json!({"name":"paperclip_finish","arguments":result}),
            ),
        );
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation("finish-1", "finish", json!({"result":result}))
            ))
            .is_err());
        call(
            &mut e,
            "semantic_tool.result",
            json!({"callId":"completion-1","operationId":"paperclip_finish","result":{"accepted":true},"isError":false}),
        );
        call(
            &mut e,
            "external_provider.operation",
            operation("finish-1", "finish", json!({"result":result})),
        );
        assert_eq!(
            e.poll_events()
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "run.result.proposed")
                .count(),
            1
        );
    }
    #[test]
    fn normalized_completion_survives_restart_and_accepts_the_original_report() {
        let dir = TestDirectory::new();
        let mut e = prepared(dir.path());
        accept(&mut e);
        let input = json!({"reportedWorkDisposition":"completed","summary":"Saved report",
            "completionClaim":{"contractRevision":"contract-1","objectiveSatisfied":true,"criteria":[{"criterionId":"criterion-1","status":"passed","evidenceRefs":[]}],"remainingWork":[]},
            "evidence":[],"verification":[]});
        let mut canonical = input.clone();
        canonical["schema"] = json!("paperclip.run_result.v1");
        canonical["reportedWorkDisposition"] = json!("done");
        canonical["completionClaim"]["criteria"][0]["status"] = json!("satisfied");
        canonical["attentionRequests"] = json!([]);
        canonical["artifacts"] = json!([]);
        call(
            &mut e,
            "external_provider.operation",
            operation(
                "completion-1",
                "tool",
                json!({"name":"paperclip_finish","arguments":input}),
            ),
        );
        call(
            &mut e,
            "semantic_tool.result",
            json!({"callId":"completion-1","operationId":"paperclip_finish","result":{"accepted":true,"completionReport":canonical},"isError":false}),
        );
        drop(e);
        let mut e = DotCommandExecutor::with_runner_config(dir.path(), &config(dir.path()));
        let mut changed = input.clone();
        changed["summary"] = json!("Changed after acceptance");
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation("finish-1", "finish", json!({"result":changed}))
            ))
            .is_err());
        call(
            &mut e,
            "external_provider.operation",
            operation("finish-2", "finish", json!({"result":input})),
        );
        let events = e.poll_events().unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event.event_type == "run.result.proposed")
                .unwrap()
                .payload,
            canonical
        );
    }
    #[test]
    fn wrong_epoch_and_expired_offers_fail_closed() {
        let dir = TestDirectory::new();
        let mut e = prepared(dir.path());
        let mut op = operation("accept-1", "accept", json!({}));
        op["bindingGeneration"] = json!(2);
        assert!(e
            .execute(&command("external_provider.operation", op))
            .is_err());
        e.state.as_mut().unwrap().descriptor.accept_by_unix_ms =
            crate::durable::current_unix_ms().unwrap() - 1;
        assert!(e
            .poll_events()
            .unwrap()
            .iter()
            .any(|event| event.event_type == "turn.failed"));
        assert_eq!(e.state.as_ref().unwrap().lifecycle, "fenced");
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation("accept-2", "accept", json!({}))
            ))
            .is_err());
    }
    fn muse_question() -> Value {
        json!({"schema":"paperclip.question_set.v1","questions":[{"id":"environment","prompt":"Which environment?","required":true,"answerMode":"single_select",
            "options":[{"id":"prod","label":"Production"},{"id":"test","label":"Test"}]}]})
    }
    fn muse_response() -> Value {
        json!({"schema":"paperclip.question_response.v1","answers":{"environment":{"selectedOptionIds":["test"]}}})
    }
    #[test]
    fn muse_question_answer_is_native_durable_and_finish_requires_exact_ingestion() {
        let dir = TestDirectory::new();
        let mut e = prepared_codec(dir.path(), ExternalProviderCodec::Muse);
        accept(&mut e);
        let ask = operation(
            "ask-operation-1",
            "request_user_input",
            json!({"requestId":"native-question-1","questionSet":muse_question()}),
        );
        assert_eq!(
            call(&mut e, "external_provider.operation", ask.clone())["requestId"],
            "native-question-1"
        );
        call(&mut e, "external_provider.operation", ask);
        let created = e
            .poll_events()
            .unwrap()
            .into_iter()
            .filter(|event| event.event_type == "runtime_request.created")
            .collect::<Vec<_>>();
        assert_eq!(created.len(), 1);
        assert_eq!(
            created[0].payload["request"]["schema"],
            "paperclip.runtime_request.v2"
        );
        assert_eq!(created[0].payload["request"]["status"], "pending");
        assert_eq!(created[0].payload["request"]["turnId"], "turn-1");
        assert_ne!(
            created[0].payload["request"]["requestId"],
            "ask-operation-1"
        );
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation("finish-1", "finish", json!({"result":{}}))
            ))
            .is_err());
        let mut resolution = command(
            "request.resolve",
            json!({"requestId":"native-question-1","response":muse_response()}),
        );
        resolution.command_id = "question_interaction-1".into();
        let available = e.execute(&resolution).unwrap().result;
        assert_eq!(available["status"], "delivered");
        assert_eq!(e.execute(&resolution).unwrap().result, available);
        assert_eq!(
            e.poll_events()
                .unwrap()
                .iter()
                .filter(|event| event.event_type == "external_provider.input_available")
                .count(),
            1
        );
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation(
                    "consume-bad",
                    "consume_input",
                    json!({"requestId":"native-question-1","inputDigest":"sha256:wrong"})
                )
            ))
            .is_err());
        assert!(e
            .execute(&command(
                "external_provider.operation",
                operation(
                    "completion-before-ingest",
                    "tool",
                    json!({"name":"paperclip_finish","arguments":{}})
                )
            ))
            .is_err());
        drop(e);
        let mut e = ExternalCommandExecutor::with_codec(
            dir.path(),
            &config(dir.path()),
            ExternalProviderCodec::Muse,
        );
        let snapshot = call(&mut e, "session.snapshot", json!({}));
        assert_eq!(snapshot["unconsumedInputs"], 1);
        assert_eq!(snapshot["pendingRuntimeRequests"], json!([]));
        let consume = operation(
            "consume-1",
            "consume_input",
            json!({"requestId":"native-question-1","inputDigest":available["inputDigest"]}),
        );
        assert_eq!(
            call(&mut e, "external_provider.operation", consume.clone())["status"],
            "consumed"
        );
        assert_eq!(
            call(&mut e, "external_provider.operation", consume)["status"],
            "consumed"
        );
        assert_eq!(
            call(&mut e, "session.snapshot", json!({}))["unconsumedInputs"],
            0
        );
        assert!(dir.path().join(MUSE_PROVIDER_STATE_FILE).exists());
        assert!(!dir.path().join(DOT_PROVIDER_STATE_FILE).exists());
    }
    #[test]
    fn dot_questions_stay_disabled_and_muse_fenced_answers_do_not_revive_authority() {
        let dot_dir = TestDirectory::new();
        let mut dot = prepared(dot_dir.path());
        accept(&mut dot);
        let ask = operation(
            "ask-1",
            "request_user_input",
            json!({"requestId":"native-1","questionSet":muse_question()}),
        );
        assert!(dot
            .execute(&command("external_provider.operation", ask.clone()))
            .is_err());
        let dir = TestDirectory::new();
        let mut muse = prepared_codec(dir.path(), ExternalProviderCodec::Muse);
        accept(&mut muse);
        call(&mut muse, "external_provider.operation", ask);
        call(&mut muse, "run.cancel", json!({}));
        assert!(muse
            .execute(&command(
                "request.resolve",
                json!({"requestId":"native-1","response":muse_response()})
            ))
            .is_err());
        assert_eq!(
            call(&mut muse, "session.snapshot", json!({}))["unconsumedInputs"],
            1
        );
    }
    #[test]
    fn muse_rejects_different_turn_and_checkpoint_answer_tampering() {
        let dir = TestDirectory::new();
        let mut muse = prepared_codec(dir.path(), ExternalProviderCodec::Muse);
        accept(&mut muse);
        let mut ask = operation(
            "ask-1",
            "request_user_input",
            json!({"requestId":"native-1","questionSet":muse_question()}),
        );
        ask["turnId"] = json!("other-turn");
        assert!(muse
            .execute(&command("external_provider.operation", ask))
            .is_err());
        call(
            &mut muse,
            "external_provider.operation",
            operation(
                "ask-2",
                "request_user_input",
                json!({"requestId":"native-1","questionSet":muse_question()}),
            ),
        );
        call(
            &mut muse,
            "request.resolve",
            json!({"requestId":"native-1","response":muse_response()}),
        );
        drop(muse);
        let path = dir.path().join(MUSE_PROVIDER_STATE_FILE);
        let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        saved["runtimeInputs"]["native-1"]["inputDigest"] = json!("sha256:tampered");
        fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let mut muse = ExternalCommandExecutor::with_codec(
            dir.path(),
            &config(dir.path()),
            ExternalProviderCodec::Muse,
        );
        assert!(muse
            .execute(&command("session.snapshot", json!({})))
            .is_err());
    }
}
