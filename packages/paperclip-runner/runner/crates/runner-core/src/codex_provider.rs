use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::durable::redact_text;
use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::SupervisedProcess;

pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const MAX_BUFFERED_MESSAGES: usize = 1_024;
const MAX_INSTRUCTIONS_BYTES: usize = 1024 * 1024;
type QuestionOptionLabels = BTreeMap<String, BTreeMap<String, String>>;
type QuestionSetMapping = (String, Value, QuestionOptionLabels);

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
    pub instructions: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
}

impl CodexProviderConfig {
    pub fn validate(&self) -> Result<(), LocalRunnerError> {
        if self.provider != "codex" || self.driver != "codex_app_server" {
            return Err(LocalRunnerError::invalid(
                "the initial runner provider must be codex through codex_app_server",
            ));
        }
        if self.provider_version.trim().is_empty() || self.provider_version.len() > 120 {
            return Err(LocalRunnerError::invalid(
                "Codex providerVersion is empty or oversized",
            ));
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
    },
}

#[derive(Clone, Debug, PartialEq)]
struct PendingRuntimeRequest {
    rpc_id: Value,
    method: String,
    params: Value,
    question_set: Value,
    option_labels: QuestionOptionLabels,
}

pub struct CodexProvider {
    process: SupervisedProcess,
    next_request_id: u64,
    thread_id: String,
    provider_session_id: Option<String>,
    active_provider_turn_id: Option<String>,
    pending_messages: VecDeque<Value>,
    pending_runtime_requests: BTreeMap<String, PendingRuntimeRequest>,
    expected_shutdown: bool,
}

impl CodexProvider {
    pub fn start(
        config: &CodexProviderConfig,
        resume_thread_id: Option<&str>,
    ) -> Result<Self, LocalRunnerError> {
        config.validate()?;
        let mut provider = Self {
            process: SupervisedProcess::spawn(
                &config.command,
                &config.args,
                Duration::from_secs(2),
                CODEX_APP_SERVER_MAX_FRAME_BYTES,
            )?,
            next_request_id: 1,
            thread_id: String::new(),
            provider_session_id: None,
            active_provider_turn_id: None,
            pending_messages: VecDeque::new(),
            pending_runtime_requests: BTreeMap::new(),
            expected_shutdown: false,
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
        provider.process.send(&json!({"method": "initialized"}))?;

        let mut params = json!({
            "cwd": config.cwd,
            "model": config.model,
            "approvalPolicy": config.approval_policy,
            "permissions": "paperclip-runner-workspace-only",
            "runtimeWorkspaceRoots": [config.cwd],
            "baseInstructions": config.instructions,
        });
        let params_object = params
            .as_object_mut()
            .expect("Codex thread parameters are an object");
        let method = if let Some(thread_id) = resume_thread_id {
            params_object.insert("threadId".to_owned(), json!(thread_id));
            "thread/resume"
        } else {
            // This PR does not grant any semantic tools. A later catalog and
            // authorization layer can project a run-scoped inventory here.
            params_object.insert("dynamicTools".to_owned(), json!([]));
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
            provider.active_provider_turn_id = latest_active_turn_id(&snapshot);
        }
        Ok(provider)
    }

    pub fn process_id(&self) -> u32 {
        self.process.id()
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn provider_session_id(&self) -> Option<&str> {
        self.provider_session_id.as_deref()
    }

    pub fn active_provider_turn_id(&self) -> Option<&str> {
        self.active_provider_turn_id.as_deref()
    }

    pub fn start_turn(&mut self, message: &str, cwd: &str) -> Result<Value, LocalRunnerError> {
        if self.active_provider_turn_id.is_some() {
            return Err(LocalRunnerError::invalid(
                "Codex already has an active provider turn",
            ));
        }
        if message.is_empty() || message.len() > MAX_INSTRUCTIONS_BYTES {
            return Err(LocalRunnerError::invalid(
                "Codex turn text is empty or exceeds the 1 MiB limit",
            ));
        }
        let result = self.request(
            "turn/start",
            json!({
                "threadId": self.thread_id,
                "cwd": cwd,
                "permissions": "paperclip-runner-workspace-only",
                "runtimeWorkspaceRoots": [cwd],
                "input": [{"type": "text", "text": message, "text_elements": []}],
            }),
        )?;
        let provider_turn_id = result
            .pointer("/turn/id")
            .or_else(|| result.get("turnId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| LocalRunnerError::invalid("Codex turn/start omitted turn.id"))?
            .to_owned();
        self.active_provider_turn_id = Some(provider_turn_id);
        Ok(result)
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
        self.cancel_pending_runtime_requests()?;
        self.request(
            "turn/interrupt",
            json!({"threadId": self.thread_id, "turnId": turn_id}),
        )
    }

    pub fn read_thread(&mut self) -> Result<Value, LocalRunnerError> {
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
        let result = codex_question_response(&pending, response)?;
        self.process
            .send(&json!({"id": pending.rpc_id, "result": result}))?;
        self.pending_runtime_requests.remove(request_id);
        Ok(())
    }

    pub fn poll(&mut self) -> Result<Option<CodexProviderEvent>, LocalRunnerError> {
        let message = if let Some(message) = self.pending_messages.pop_front() {
            message
        } else {
            let Some(line) = self.process.receive_stdout_line(Duration::from_millis(1))? else {
                return if let Some(exit) = self.process.try_wait()? {
                    Ok(Some(CodexProviderEvent::Exited {
                        exit_code: exit.exit_code,
                        success: exit.success && self.expected_shutdown,
                    }))
                } else {
                    Ok(None)
                };
            };
            parse_provider_message(&line)?
        };

        if let (Some(rpc_id), Some(method)) = (
            message.get("id").cloned(),
            message.get("method").and_then(Value::as_str),
        ) {
            if method == "item/tool/requestUserInput" {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                if params.get("threadId").and_then(Value::as_str) != Some(self.thread_id.as_str()) {
                    return Err(LocalRunnerError::invalid(
                        "Codex runtime request named another thread",
                    ));
                }
                let active_turn_id = self.active_provider_turn_id.as_deref().ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "Codex runtime request arrived outside an active turn",
                    )
                })?;
                if params.get("turnId").and_then(Value::as_str) != Some(active_turn_id) {
                    return Err(LocalRunnerError::invalid(
                        "Codex runtime request named another turn",
                    ));
                }
                let (request_id, question_set, option_labels) =
                    codex_question_set(&rpc_id, &params)?;
                let pending = PendingRuntimeRequest {
                    rpc_id,
                    method: method.to_owned(),
                    params,
                    question_set: question_set.clone(),
                    option_labels,
                };
                if let Some(existing) = self.pending_runtime_requests.get(&request_id) {
                    if existing != &pending {
                        return Err(LocalRunnerError::invalid(
                            "Codex reused a runtime request id with different input",
                        ));
                    }
                    return Ok(None);
                } else {
                    self.pending_runtime_requests
                        .insert(request_id.clone(), pending);
                }
                return Ok(Some(CodexProviderEvent::RuntimeRequest {
                    request_id,
                    question_set,
                }));
            }
            self.process.send(&json!({
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
            validate_notification_binding(
                &self.thread_id,
                self.active_provider_turn_id.as_deref(),
                &params,
            )?;
            if method == "turn/completed" {
                self.active_provider_turn_id = None;
            }
            return Ok(Some(CodexProviderEvent::Notification {
                method: method.to_owned(),
                params,
            }));
        }
        Ok(None)
    }

    pub fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.expected_shutdown = true;
        self.cancel_pending_runtime_requests()?;
        self.process.terminate_group().map(|_| ())
    }

    fn cancel_pending_runtime_requests(&mut self) -> Result<(), LocalRunnerError> {
        let pending = std::mem::take(&mut self.pending_runtime_requests);
        for request in pending.into_values() {
            self.process.send(&json!({
                "id": request.rpc_id,
                "result": {"answers": {}},
            }))?;
        }
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, LocalRunnerError> {
        let request_id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or_else(|| LocalRunnerError::invalid("Codex request id exhausted"))?;
        self.process
            .send(&json!({"id": request_id, "method": method, "params": params}))?;
        loop {
            let line = self
                .process
                .receive_stdout_line(Duration::from_secs(30))?
                .ok_or_else(|| {
                    LocalRunnerError::invalid(format!("Codex {method} response timed out"))
                })?;
            let message = parse_provider_message(&line)?;
            if message.get("id").and_then(Value::as_u64) == Some(request_id)
                && message.get("method").is_none()
            {
                if let Some(error) = message.get("error") {
                    return Err(LocalRunnerError::invalid(format!(
                        "Codex {method} failed: {}",
                        redact_text(&error.to_string())
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if self.pending_messages.len() >= MAX_BUFFERED_MESSAGES {
                return Err(LocalRunnerError::invalid(
                    "Codex emitted too many messages before a request response",
                ));
            }
            self.pending_messages.push_back(message);
        }
    }
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
    let notification_turn_id = params
        .get("turnId")
        .or_else(|| params.pointer("/turn/id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(active_turn_id) = active_turn_id {
        if notification_turn_id.is_some_and(|value| value != active_turn_id) {
            return Err(LocalRunnerError::invalid(
                "Codex notification named another active turn",
            ));
        }
    }
    Ok(())
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

fn codex_question_response(
    pending: &PendingRuntimeRequest,
    response: &Value,
) -> Result<Value, LocalRunnerError> {
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
            method: "item/tool/requestUserInput".to_owned(),
            params: Value::Null,
            question_set,
            option_labels: labels,
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
}
