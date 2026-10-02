//! OpenAI Agents API transport. Paperclip remains the authority for every function.
//!
//! Saved items and turn records, not stream closure or session idleness, are the
//! recovery oracle. Polling also works when an SSE subscription misses events.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io::Read;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local_runner::LocalRunnerError;
use crate::managed_provider::{
    OpenAiManagedProviderConfig, Provider, ProviderEvent, ProviderKind, ProviderRuntimeIdentity,
};
use crate::provider_bridge::{AuthorizedTool, ToolResult};

const ORIGIN: &str = "https://api.openai.com/v1/agents";
const MAX_RESPONSE: u64 = 8 * 1024 * 1024;
const MAX_PAGES: usize = 100;
const MAX_SEEN: usize = 10_000;

type Result<T> = std::result::Result<T, LocalRunnerError>;
fn invalid(message: &str) -> LocalRunnerError {
    LocalRunnerError::invalid(message)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| valid_id(s))
        .map(str::to_owned)
        .ok_or_else(|| invalid("OpenAI returned a missing or invalid resource identity"))
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

#[derive(Clone)]
struct Api {
    client: Client,
    origin: String,
}
impl Api {
    fn new(key: &str, origin: &str) -> Result<Self> {
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| invalid("OPENAI_API_KEY is invalid"))?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);
        headers.insert("OpenAI-Beta", HeaderValue::from_static("agents=v1"));
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| invalid("could not initialize OpenAI API client"))?;
        Ok(Self {
            client,
            origin: origin.into(),
        })
    }
    fn request(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.origin));
        if let Some(body) = body {
            request = request.json(body);
        }
        // Never automatically replay a mutation after a transport error.
        let response = request.send().map_err(|_| {
            invalid("OpenAI API transport failed; mutation outcome may require reconciliation")
        })?;
        if !response.status().is_success() {
            return Err(invalid(&format!(
                "OpenAI Agents API returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("OpenAI API response could not be read"))?;
        if bytes.len() as u64 > MAX_RESPONSE {
            return Err(invalid(
                "OpenAI API response exceeds the bounded response limit",
            ));
        }
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid("OpenAI API response is not valid JSON"))
    }
    fn get(&self, path: &str) -> Result<Value> {
        self.request(reqwest::Method::GET, path, None)
    }
    fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.request(reqwest::Method::POST, path, Some(&body))
    }
    fn list(&self, path: &str) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut after = None;
        let mut cursors = BTreeSet::new();
        for _ in 0..MAX_PAGES {
            let suffix = after
                .as_ref()
                .map(|v| format!("&after={v}"))
                .unwrap_or_default();
            let page = self.get(&format!("{path}?order=asc&limit=100{suffix}"))?;
            let data = page
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| invalid("OpenAI list response has no data"))?;
            if data.len() > 100 || out.len() + data.len() > MAX_SEEN {
                return Err(invalid("OpenAI history exceeds the reconciliation limit"));
            }
            out.extend(data.iter().cloned());
            if page.get("has_more").and_then(Value::as_bool) == Some(false) {
                return Ok(out);
            }
            let next = id(&page, "last_id")?;
            if !cursors.insert(next.clone()) {
                return Err(invalid("OpenAI pagination did not advance"));
            }
            after = Some(next);
        }
        Err(invalid("OpenAI history exceeds the page limit"))
    }
    fn snapshot(&self, session: &str) -> Result<Snapshot> {
        // Read accounting and authoritative required actions after turn/history
        // reads. A turn can complete between requests; reading its session first
        // would pair that terminal with stale (often null) usage.
        let turns = self.list(&format!("/sessions/{session}/turns"))?;
        let items = self.list(&format!("/sessions/{session}/items"))?;
        Ok(Snapshot {
            session: self.get(&format!("/sessions/{session}"))?,
            turns,
            items,
        })
    }
}
struct Snapshot {
    session: Value,
    turns: Vec<Value>,
    items: Vec<Value>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    last_turn_id: Option<String>,
    remote_turn_id: Option<String>,
    local_turn_id: Option<String>,
    deadline_ms: Option<u64>,
    cancel_requested: bool,
    #[serde(default)]
    cancel_deadline_ms: Option<u64>,
    #[serde(default)]
    terminal_observed_at_ms: Option<u64>,
    seen_items: BTreeSet<String>,
    delivered_calls: BTreeSet<String>,
    #[serde(default)]
    events: VecDeque<ProviderEvent>,
}

pub struct OpenAiManagedProvider {
    api: Api,
    config: OpenAiManagedProviderConfig,
    owner: String,
    session_id: String,
    tools: Vec<AuthorizedTool>,
    names: BTreeMap<String, AuthorizedTool>,
    pending: BTreeMap<String, Value>,
    checkpoint: Checkpoint,
    cursor: String,
    usage: Option<Value>,
    snapshot: Option<Receiver<Result<Snapshot>>>,
    next_poll: Instant,
    read_failures: u8,
}

pub fn validate_config(config: &OpenAiManagedProviderConfig) -> Result<()> {
    if config.model != "gpt-6-astra"
        || config.api_revision != "agents=v1"
        || !matches!(
            config.reasoning_effort.as_str(),
            "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
        || config.profile_id.is_empty()
        || config.profile_id.len() > 512
        || config.profile_id.chars().any(char::is_control)
        || config.instructions.is_empty()
        || config.instructions.len() > 1024 * 1024
        || config.instructions.contains('\0')
        || !(1..=3600).contains(&config.timeout_seconds)
        || !config.max_estimated_session_cost_usd.is_finite()
        || config.max_estimated_session_cost_usd <= 0.0
        || config
            .runtime_context
            .as_ref()
            .is_some_and(|v| !v.is_object())
    {
        return Err(invalid("OpenAI managed provider configuration is invalid"));
    }
    validate_environment(&config.environment)
}

fn validate_environment(env: &Value) -> Result<()> {
    let object = env
        .as_object()
        .ok_or_else(|| invalid("OpenAI environment must be an object"))?;
    match env.get("type").and_then(Value::as_str) {
        Some("none") if object.len() == 1 => Ok(()),
        Some("openai_hosted") => {
            if object.keys().any(|k| {
                ![
                    "type",
                    "container_size",
                    "network",
                    "files",
                    "setup_commands",
                    "packages",
                ]
                .contains(&k.as_str())
            }) || !matches!(
                env.get("container_size").and_then(Value::as_str),
                Some("small" | "medium" | "large")
            ) {
                return Err(invalid(
                    "OpenAI hosted environment contains unsupported settings",
                ));
            }
            let network = env
                .get("network")
                .and_then(Value::as_object)
                .ok_or_else(|| invalid("OpenAI hosted network policy must be explicit"))?;
            let access = network.get("access").and_then(Value::as_str);
            if network
                .keys()
                .any(|k| k != "access" && k != "allowed_domains")
            {
                return Err(invalid("OpenAI network policy is invalid"));
            }
            match access {
                Some("disabled" | "enabled") if network.len() == 1 => (),
                Some("restricted") => {
                    let domains = network
                        .get("allowed_domains")
                        .and_then(Value::as_array)
                        .ok_or_else(|| invalid("OpenAI network allowlist is required"))?;
                    if domains.is_empty()
                        || domains.len() > 100
                        || domains.iter().any(|v| {
                            v.as_str().is_none_or(|s| {
                                s.is_empty()
                                    || s.len() > 253
                                    || s.starts_with('.')
                                    || s.ends_with('.')
                                    || s.contains("..")
                                    || !s.bytes().all(|c| {
                                        c.is_ascii_alphanumeric() || c == b'.' || c == b'-'
                                    })
                            })
                        })
                    {
                        return Err(invalid("OpenAI network allowlist requires exact hostnames"));
                    }
                }
                _ => return Err(invalid("OpenAI network policy is invalid")),
            }
            // Inputs are controller-authored; the sandbox never receives API credentials.
            if let Some(files) = env.get("files") {
                let files = files
                    .as_array()
                    .ok_or_else(|| invalid("OpenAI input files must be an array"))?;
                if files.len() > 50
                    || files.iter().any(|f| {
                        f.get("path").and_then(Value::as_str).is_none_or(|p| {
                            !p.starts_with("/workspace/")
                                || p.split('/').any(|c| c == ".." || c == ".")
                                || p.contains('\0')
                        })
                    })
                {
                    return Err(invalid("OpenAI input file path is outside the workspace"));
                }
            }
            let mut total = 0usize;
            let mut paths = BTreeSet::new();
            if let Some(files) = env.get("files").and_then(Value::as_array) {
                for file in files {
                    let object = file
                        .as_object()
                        .ok_or_else(|| invalid("OpenAI file must be an object"))?;
                    if object
                        .keys()
                        .any(|k| !["type", "path", "data", "file_id"].contains(&k.as_str()))
                        || !paths.insert(file.get("path").and_then(Value::as_str))
                    {
                        return Err(invalid(
                            "OpenAI file contains unsupported or duplicate settings",
                        ));
                    }
                    match file.get("type").and_then(Value::as_str) {
                        Some("inline") if !object.contains_key("file_id") => {
                            let encoded =
                                file.get("data").and_then(Value::as_str).ok_or_else(|| {
                                    invalid("OpenAI inline file requires base64 data")
                                })?;
                            if encoded.len() > 7 * 1024 * 1024 {
                                return Err(invalid("OpenAI inline file exceeds 5 MiB"));
                            }
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(encoded)
                                .map_err(|_| invalid("OpenAI inline data is not base64"))?;
                            if bytes.len() > 5 * 1024 * 1024 {
                                return Err(invalid("OpenAI inline file exceeds 5 MiB"));
                            }
                            total += bytes.len();
                        }
                        Some("file_id") if !object.contains_key("data") => {
                            id(file, "file_id")?;
                        }
                        _ => return Err(invalid("OpenAI file source is invalid")),
                    }
                }
            }
            if total > 10 * 1024 * 1024 {
                return Err(invalid("OpenAI inline files exceed 10 MiB"));
            }
            if let Some(commands) = env.get("setup_commands") {
                let commands = commands
                    .as_array()
                    .ok_or_else(|| invalid("OpenAI setup commands must be an array"))?;
                if commands.len() > 50
                    || commands.iter().any(|command| {
                        command
                            .as_object()
                            .is_none_or(|o| o.keys().any(|k| k != "command" && k != "cwd"))
                            || command
                                .get("command")
                                .and_then(Value::as_str)
                                .is_none_or(|s| {
                                    s.trim().is_empty() || s.len() > 64_000 || s.contains('\0')
                                })
                            || command.get("cwd").is_some_and(|v| {
                                v.as_str().is_none_or(|p| {
                                    p != "/workspace"
                                        && (!p.starts_with("/workspace/")
                                            || p.split('/').any(|s| s == ".." || s == ".")
                                            || p.contains('\0'))
                                })
                            })
                    })
                {
                    return Err(invalid("OpenAI setup command is invalid"));
                }
            }
            if let Some(packages) = env.get("packages") {
                let packages = packages
                    .as_object()
                    .ok_or_else(|| invalid("OpenAI packages must be an object"))?;
                if packages.iter().any(|(key, value)| {
                    !["python", "npm", "system"].contains(&key.as_str())
                        || value.as_array().is_none_or(|list| {
                            list.len() > 100
                                || list.iter().any(|v| {
                                    v.as_str().is_none_or(|s| {
                                        s.trim().is_empty()
                                            || s.len() > 512
                                            || s.chars().any(char::is_control)
                                    })
                                })
                        })
                }) {
                    return Err(invalid("OpenAI package specification is invalid"));
                }
            }
            Ok(())
        }
        _ => Err(invalid("OpenAI environment must be none or openai_hosted")),
    }
}

impl OpenAiManagedProvider {
    pub fn start(
        config: &OpenAiManagedProviderConfig,
        tools: Vec<AuthorizedTool>,
        ownership: &str,
        session_id: Option<&str>,
        cursor: Option<&str>,
        usage: Option<&Value>,
    ) -> Result<Self> {
        let key = std::env::var("OPENAI_API_KEY")
            .map_err(|_| invalid("OPENAI_API_KEY is required for OpenAI managed agents"))?;
        if key.trim().is_empty() {
            return Err(invalid(
                "OPENAI_API_KEY is required for OpenAI managed agents",
            ));
        }
        Self::with_api(
            config,
            tools,
            ownership,
            session_id,
            cursor,
            usage,
            Api::new(&key, ORIGIN)?,
        )
    }
    fn with_api(
        config: &OpenAiManagedProviderConfig,
        tools: Vec<AuthorizedTool>,
        ownership: &str,
        session_id: Option<&str>,
        cursor: Option<&str>,
        usage: Option<&Value>,
        api: Api,
    ) -> Result<Self> {
        validate_config(config)?;
        let stable_owner = ownership
            .split_once(':')
            .map(|(_, session)| session)
            .unwrap_or(ownership);
        let owner = format!("{:x}", Sha256::digest(stable_owner.as_bytes()));
        let session_id = session_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("pending_{owner}"));
        if !valid_id(&session_id) {
            return Err(invalid("OpenAI session identity is invalid"));
        }
        let checkpoint: Checkpoint = match cursor {
            Some(cursor) if cursor.len() <= 2 * 1024 * 1024 => serde_json::from_str(cursor)
                .map_err(|_| invalid("OpenAI checkpoint is malformed"))?,
            Some(_) => return Err(invalid("OpenAI checkpoint exceeds its limit")),
            None => Checkpoint::default(),
        };
        if checkpoint.seen_items.len() > MAX_SEEN
            || checkpoint.delivered_calls.len() > MAX_SEEN
            || checkpoint.events.len() > MAX_SEEN
            || checkpoint
                .remote_turn_id
                .as_ref()
                .is_some_and(|v| !valid_id(v))
            || checkpoint
                .last_turn_id
                .as_ref()
                .is_some_and(|v| !valid_id(v))
        {
            return Err(invalid("OpenAI checkpoint contains invalid identities"));
        }
        let mut provider = Self {
            api,
            config: config.clone(),
            owner,
            session_id,
            tools: Vec::new(),
            names: BTreeMap::new(),
            pending: BTreeMap::new(),
            checkpoint,
            cursor: String::new(),
            usage: usage.cloned(),
            snapshot: None,
            next_poll: Instant::now(),
            read_failures: 0,
        };
        provider.configure_tools(tools)?;
        provider.save_checkpoint()?;
        Ok(provider)
    }
    fn provisional(&self) -> bool {
        self.session_id.starts_with("pending_")
    }
    fn save_checkpoint(&mut self) -> Result<()> {
        self.cursor = serde_json::to_string(&self.checkpoint)
            .map_err(|_| invalid("OpenAI checkpoint encoding failed"))?;
        Ok(())
    }
    fn remap_hosted_paths(&self, text: &str) -> String {
        if self.config.environment.get("type").and_then(Value::as_str) != Some("openai_hosted") {
            return text.to_owned();
        }
        let mut result = text.to_owned();
        if let Some(context) = &self.config.runtime_context {
            if let Some(root) = context
                .pointer("/instructions/bundle/rootPath")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                result = result.replace(
                    root,
                    "/workspace/project/.paperclip-runtime/openai-hosted/instructions",
                );
            }
            if let Some(skills) = context.get("skills").and_then(Value::as_array) {
                for (index, skill) in skills.iter().enumerate() {
                    if let Some(root) = skill
                        .pointer("/bundle/rootPath")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        result = result.replace(
                            root,
                            &format!(
                                "/workspace/project/.paperclip-runtime/openai-hosted/skill-{index}"
                            ),
                        );
                    }
                }
            }
        }
        result
    }
    fn create_body(&self, message: &str) -> Value {
        let tools: Vec<_> = self.names.iter().map(|(name, tool)| json!({
            "type":"function", "name":name, "description":tool.description, "parameters":tool.input_schema
        })).collect();
        let has_export = self
            .config
            .environment
            .get("files")
            .and_then(Value::as_array)
            .is_some_and(|files| {
                files.iter().any(|file| {
                    file.get("path").and_then(Value::as_str)
                        == Some("/workspace/paperclip-export.py")
                })
            });
        let instructions = if has_export {
            format!("{}\nYour task workspace is /workspace/project. Assigned skills are under /workspace/project/.paperclip-runtime/openai-hosted/. Before paperclip_finish or paperclip_block, run python3 /workspace/paperclip-export.py. Save other deliverables under /workspace/outputs. Paperclip imports outputs after the turn ends; do not call upload_file for unpublished files. Do not push or create a pull request. Report export failures explicitly.", self.config.instructions)
        } else {
            self.config.instructions.clone()
        };
        json!({
            "agent": {"model": self.config.model, "instructions": self.remap_hosted_paths(&instructions),
                "reasoning":{"effort":self.config.reasoning_effort}, "tools":tools, "multi_agent":{"enabled":false}},
            "environment":self.config.environment, "input":self.remap_hosted_paths(message), "stream":false,
            "metadata":{"paperclip_owner":self.owner}
        })
    }
    fn event(&self, event: Value) -> Result<Value> {
        self.api.post(
            &format!("/sessions/{}/events", self.session_id),
            json!({"events":[event]}),
        )
    }
    fn verify_session(&self, session: &Value) -> Result<()> {
        if id(session, "id")? != self.session_id
            || session
                .pointer("/metadata/paperclip_owner")
                .and_then(Value::as_str)
                != Some(self.owner.as_str())
        {
            return Err(invalid(
                "OpenAI session ownership does not match the durable runner",
            ));
        }
        Ok(())
    }
    fn reconcile_created_session(&mut self) -> Result<()> {
        let sessions = self.api.list("/sessions")?;
        let matches: Vec<_> = sessions
            .iter()
            .filter(|s| {
                s.pointer("/metadata/paperclip_owner")
                    .and_then(Value::as_str)
                    == Some(self.owner.as_str())
            })
            .collect();
        if matches.len() != 1 {
            return Err(invalid(
                "OpenAI session creation is ambiguous; inspect owned sessions before retrying",
            ));
        }
        self.session_id = id(matches[0], "id")?;
        Ok(())
    }
    fn apply_snapshot(&mut self, snapshot: Snapshot) -> Result<()> {
        self.verify_session(&snapshot.session)?;
        self.usage = reconcile_usage(&snapshot, &self.session_id);
        if self.checkpoint.last_turn_id.as_ref().is_some_and(|last| {
            !snapshot
                .turns
                .iter()
                .any(|t| t.get("id").and_then(Value::as_str) == Some(last))
        }) {
            return Err(invalid(
                "OpenAI recovery history lost the completed-turn boundary",
            ));
        }
        let candidates: Vec<_> = snapshot
            .turns
            .iter()
            .filter(|t| {
                t.get("subagent_id").is_none_or(Value::is_null)
                    && match self.checkpoint.remote_turn_id.as_deref() {
                        Some(expected) => t.get("id").and_then(Value::as_str) == Some(expected),
                        None => self.checkpoint.last_turn_id.as_ref().is_none_or(|last| {
                            snapshot
                                .turns
                                .iter()
                                .position(|x| {
                                    x.get("id").and_then(Value::as_str) == Some(last.as_str())
                                })
                                .is_some_and(|i| {
                                    snapshot
                                        .turns
                                        .iter()
                                        .position(|x| x == *t)
                                        .is_some_and(|j| j > i)
                                })
                        }),
                    }
            })
            .collect();
        if candidates.len() > 1 {
            return Err(invalid(
                "OpenAI has multiple unbound root turns; recovery requires review",
            ));
        }
        let Some(turn) = candidates.first() else {
            if snapshot.session.get("status").and_then(Value::as_str) == Some("failed") {
                return Err(invalid("OpenAI managed session failed"));
            }
            return Ok(());
        };
        let remote_turn = id(turn, "id")?;
        if turn.get("session_id").and_then(Value::as_str) != Some(self.session_id.as_str()) {
            return Err(invalid("OpenAI turn belongs to another session"));
        }
        if self.checkpoint.remote_turn_id.is_none() {
            // Admit the exact local turn before exposing its calls or completion.
            // Persisting this event with the remote binding makes replay ordered
            // and prevents repeated snapshots from announcing another start.
            self.checkpoint
                .events
                .push_back(ProviderEvent::Notification {
                    method: "turn/started".into(),
                    params: json!({"turnId":self.checkpoint.local_turn_id,
                    "turn":{"id":self.checkpoint.local_turn_id,"status":"inProgress"}}),
                });
        }
        self.checkpoint.remote_turn_id = Some(remote_turn.clone());
        for item in &snapshot.items {
            if item.get("turn_id").and_then(Value::as_str) != Some(remote_turn.as_str())
                || item.get("type").and_then(Value::as_str) != Some("message")
                || item.get("role").and_then(Value::as_str) != Some("assistant")
                || item.get("status").and_then(Value::as_str) != Some("completed")
            {
                continue;
            }
            let item_id = id(item, "id")?;
            if self.checkpoint.seen_items.insert(item_id.clone()) {
                let text = item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|v| v.get("type").and_then(Value::as_str) == Some("output_text"))
                    .filter_map(|v| v.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.len() > 1_000_000 {
                    return Err(invalid("OpenAI assistant message exceeds the output limit"));
                }
                self.checkpoint.events.push_back(ProviderEvent::Notification {method:"item/completed".into(),params:json!({
                    "turnId":self.checkpoint.local_turn_id, "item":{"id":item_id,"type":"agentMessage","text":text,"phase":item.get("phase"),"authoritative":true}
                })});
            }
        }
        for action in snapshot
            .session
            .get("required_actions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if action.get("type").and_then(Value::as_str) != Some("function_call") {
                return Err(invalid("OpenAI requested an unsupported action"));
            }
            if action.get("turn_id").and_then(Value::as_str) != Some(remote_turn.as_str()) {
                return Err(invalid("OpenAI required action belongs to an unbound turn"));
            }
            let call = id(action, "call_id")?;
            if self.checkpoint.delivered_calls.contains(&call) {
                continue;
            }
            let name = id(action, "name")?;
            let tool = self
                .names
                .get(&name)
                .ok_or_else(|| invalid("OpenAI requested an unauthorized function"))?;
            let input = action
                .get("arguments")
                .ok_or_else(|| invalid("OpenAI function arguments are missing"))?;
            let validator = jsonschema::validator_for(&tool.input_schema)
                .map_err(|_| invalid("Paperclip function schema is invalid"))?;
            if !input.is_object() || !validator.is_valid(input) {
                let paths = validator
                    .iter_errors(input)
                    .take(4)
                    .map(|error| format!("{} at {}", error.schema_path(), error.instance_path()))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(invalid(&format!(
                    "OpenAI function arguments failed schema validation for {name}: {paths}"
                )));
            }
            if let Some(previous) = self.pending.get(&call) {
                if previous != action {
                    return Err(invalid(
                        "OpenAI reused a function call identity with different arguments",
                    ));
                }
            } else {
                self.pending.insert(call.clone(), action.clone());
                self.checkpoint.events.push_back(ProviderEvent::ToolCall {
                    call_id: call,
                    operation_id: tool.operation_id.clone(),
                    input: input.clone(),
                });
            }
        }
        let status = turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(status, "completed" | "failed" | "cancelled") {
            if !self.pending.is_empty() {
                return Err(invalid(
                    "OpenAI turn ended with unsettled Paperclip function calls",
                ));
            }
            // The API can publish the terminal outcome before token accounting.
            // Keep polling that same completed turn (never rerun it) for a bounded
            // grace period. Unknown accounting remains unknown when it expires.
            let observed = *self
                .checkpoint
                .terminal_observed_at_ms
                .get_or_insert(now_ms());
            self.checkpoint.deadline_ms = None;
            self.checkpoint.cancel_deadline_ms = None;
            if self.usage.is_none() && now_ms().saturating_sub(observed) < 30_000 {
                return self.save_checkpoint();
            }
            if let Some(usage) = self.usage.as_ref() {
                self.checkpoint
                    .events
                    .push_back(ProviderEvent::Notification {
                        method: "thread/tokenUsage/updated".into(),
                        params: json!({"usage":normalize_usage(usage)}),
                    });
            }
            self.checkpoint.events.push_back(ProviderEvent::Notification {method:"turn/completed".into(),params:json!({
                "turnId":self.checkpoint.local_turn_id,"turn":{"id":self.checkpoint.local_turn_id,"status":status},
                "providerTurnId":remote_turn,"error":turn.get("error")
            })});
            self.checkpoint.last_turn_id = Some(remote_turn);
            self.checkpoint.local_turn_id = None;
            self.checkpoint.remote_turn_id = None;
            self.checkpoint.deadline_ms = None;
        }
        self.save_checkpoint()
    }
}

// Session accounting can lag completed turns. Derive a cumulative snapshot only
// from complete, unique, owned root turns (this provider disables subagents).
// Never combine session and turn totals, or treat missing turn usage as zero.
fn reconcile_usage(snapshot: &Snapshot, session_id: &str) -> Option<Value> {
    fn complete(usage: &Value) -> bool {
        usage.get("input_tokens").and_then(Value::as_u64).is_some()
            && usage.get("output_tokens").and_then(Value::as_u64).is_some()
    }
    if let Some(usage) = snapshot
        .session
        .get("usage")
        .filter(|usage| complete(usage))
    {
        return Some(usage.clone());
    }
    if snapshot.turns.is_empty() {
        return None;
    }
    let mut seen = BTreeSet::new();
    let (mut input, mut output, mut cached) = (0u64, 0u64, Some(0u64));
    for turn in &snapshot.turns {
        if turn.get("session_id").and_then(Value::as_str) != Some(session_id)
            || !turn.get("subagent_id").is_none_or(Value::is_null)
            || !seen.insert(id(turn, "id").ok()?)
        {
            return None;
        }
        let usage = turn.get("usage").filter(|usage| complete(usage))?;
        let turn_input = usage["input_tokens"].as_u64()?;
        input = input.checked_add(turn_input)?;
        output = output.checked_add(usage["output_tokens"].as_u64()?)?;
        cached = cached
            .zip(
                usage
                    .pointer("/input_tokens_details/cached_tokens")
                    .and_then(Value::as_u64)
                    .filter(|value| *value <= turn_input),
            )
            .and_then(|(sum, value)| sum.checked_add(value));
    }
    Some(json!({"input_tokens":input,"output_tokens":output,
        "input_tokens_details":{"cached_tokens":cached}}))
}

fn normalize_usage(usage: &Value) -> Value {
    json!({"inputTokens":usage.get("input_tokens"),"outputTokens":usage.get("output_tokens"),
        "cacheReadInputTokens":usage.pointer("/input_tokens_details/cached_tokens"),
        "usageSource":"provider_best_effort","requestCount":null,"costSource":"unknown"})
}

impl Provider for OpenAiManagedProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenaiManaged
    }
    fn runtime_identity(&self) -> ProviderRuntimeIdentity {
        ProviderRuntimeIdentity::RemoteService {
            service: "openai_agents_api".into(),
            provider_session_id: self.session_id.clone(),
            process_id: None,
        }
    }
    fn session_identity(&self) -> &str {
        &self.session_id
    }
    fn provider_session_id(&self) -> Option<&str> {
        Some(&self.session_id)
    }
    fn durable_event_cursor(&self) -> Option<&str> {
        Some(&self.cursor)
    }
    fn usage_snapshot(&self) -> Option<Value> {
        self.usage.clone()
    }
    fn configure_tools(&mut self, tools: Vec<AuthorizedTool>) -> Result<()> {
        if !self.provisional() && !self.tools.is_empty() && self.tools != tools {
            return Err(invalid(
                "OpenAI session functions are immutable; start a new session for changed authority",
            ));
        }
        self.names.clear();
        for tool in &tools {
            let operation = &tool.operation_id;
            let name = if operation.len() <= 64
                && operation
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            {
                operation.clone()
            } else {
                let readable: String = operation
                    .chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .take(45)
                    .collect();
                let hash = format!("{:x}", Sha256::digest(operation.as_bytes()));
                format!("{}_{}", readable, &hash[..16])
            };
            self.names.insert(name, tool.clone());
        }
        self.tools = tools;
        Ok(())
    }
    fn restore_active_turn(&mut self, turn_id: &str) -> Result<()> {
        if self.checkpoint.local_turn_id.is_none() && self.checkpoint.events.iter().any(|event| matches!(event, ProviderEvent::Notification { method, params } if method == "turn/completed" && params.get("turnId").and_then(Value::as_str) == Some(turn_id))) {
            return Ok(());
        }
        if self.provisional() {
            self.reconcile_created_session()?;
        }
        if self
            .checkpoint
            .local_turn_id
            .as_deref()
            .is_some_and(|v| v != turn_id)
        {
            return Err(invalid("OpenAI local turn binding changed during recovery"));
        }
        self.checkpoint.local_turn_id = Some(turn_id.into());
        self.checkpoint
            .deadline_ms
            .get_or_insert(now_ms() + u64::from(self.config.timeout_seconds) * 1000);
        self.save_checkpoint()
    }
    fn restore_pending_tool_call(
        &mut self,
        call_id: &str,
        operation_id: &str,
        input: &Value,
    ) -> Result<()> {
        if !valid_id(call_id)
            || !self.tools.iter().any(|t| t.operation_id == operation_id)
            || !input.is_object()
        {
            return Err(invalid("OpenAI recovered function call is invalid"));
        }
        // The backend already holds this call durably; re-observation is deduplicated there.
        Ok(())
    }
    fn preflight_turn(&mut self) -> Result<()> {
        let container_reserve = match self
            .config
            .environment
            .get("container_size")
            .and_then(Value::as_str)
        {
            Some("small") => 0.09,
            Some("medium") => 0.36,
            Some("large") => 1.44,
            _ => 0.0,
        };
        if container_reserve >= self.config.max_estimated_session_cost_usd {
            return Err(invalid(
                "OpenAI estimated budget is below the hosted container reserve",
            ));
        }
        if let Some(usage) = &self.usage {
            // Reserve long-context cache-write rates for input whose billing
            // category is unknown, but use the documented cache-hit rate for
            // the reported subset. Missing/inconsistent cache counts get no discount.
            let input = usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cached = usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
                .filter(|cached| *cached <= input)
                .unwrap_or(0);
            if container_reserve
                + ((input - cached) as f64 * 25.0 + cached as f64 * 2.0 + output as f64 * 75.0)
                    / 1_000_000.0
                >= self.config.max_estimated_session_cost_usd
            {
                return Err(invalid("OpenAI estimated session budget exhausted"));
            }
        }
        Ok(())
    }
    fn start_turn(&mut self, message: &str, _cwd: &str, turn_id: &str) -> Result<Value> {
        if self.checkpoint.local_turn_id.is_some() {
            return Err(invalid("OpenAI already has an active turn"));
        }
        self.checkpoint.local_turn_id = Some(turn_id.into());
        self.checkpoint.deadline_ms =
            Some(now_ms() + u64::from(self.config.timeout_seconds) * 1000);
        self.checkpoint.cancel_requested = false;
        self.checkpoint.cancel_deadline_ms = None;
        self.checkpoint.terminal_observed_at_ms = None;
        self.checkpoint.seen_items.clear();
        self.checkpoint.delivered_calls.clear();
        self.save_checkpoint()?;
        if self.provisional() {
            let session = self.api.post("/sessions", self.create_body(message))?;
            self.session_id = id(&session, "id")?;
            self.verify_session(&session)?;
        } else {
            self.verify_session(&self.api.get(&format!("/sessions/{}", self.session_id))?)?;
            self.event(json!({"type":"agent.session.input.message","input":[{"role":"user","content":[{"type":"input_text","text":self.remap_hosted_paths(message)}]}]}))?;
        }
        self.next_poll = Instant::now();
        Ok(json!({"sessionId":self.session_id,"turnId":turn_id}))
    }
    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value> {
        if self.checkpoint.local_turn_id.as_deref() != Some(turn_id) {
            return Err(invalid("OpenAI cancellation turn does not match"));
        }
        if self.provisional() {
            self.reconcile_created_session()?;
        }
        self.verify_session(&self.api.get(&format!("/sessions/{}", self.session_id))?)?;
        self.event(json!({"type":"agent.session.input.cancel"}))?;
        self.checkpoint.cancel_requested = true;
        self.checkpoint
            .cancel_deadline_ms
            .get_or_insert(now_ms() + 60_000);
        self.save_checkpoint()?;
        Ok(json!({"status":"cancellation_requested"}))
    }
    fn read(&mut self) -> Result<Value> {
        if self.provisional() {
            return Ok(json!({"id":self.session_id,"status":"prepared"}));
        }
        self.api.get(&format!("/sessions/{}", self.session_id))
    }
    fn poll(&mut self) -> Result<Option<ProviderEvent>> {
        if let Some(event) = self.checkpoint.events.pop_front() {
            self.save_checkpoint()?;
            return Ok(Some(event));
        }
        if self.checkpoint.local_turn_id.is_none() {
            return Ok(None);
        }
        if self
            .checkpoint
            .cancel_deadline_ms
            .is_some_and(|d| now_ms() >= d)
        {
            return Err(invalid(
                "OpenAI cancellation remains unconfirmed after 60 seconds",
            ));
        }
        if !self.checkpoint.cancel_requested
            && self.checkpoint.terminal_observed_at_ms.is_none()
            && (self.checkpoint.deadline_ms.is_some_and(|d| now_ms() >= d)
                || self.preflight_turn().is_err())
        {
            let turn = self.checkpoint.local_turn_id.clone().unwrap();
            self.interrupt_turn(&turn)?;
        }
        if let Some(rx) = &self.snapshot {
            match rx.try_recv() {
                Ok(result) => {
                    self.snapshot = None;
                    match result {
                        Ok(snapshot) => {
                            self.read_failures = 0;
                            self.apply_snapshot(snapshot)?;
                        }
                        Err(error) => {
                            self.read_failures += 1;
                            if self.read_failures >= 3 {
                                return Err(error);
                            }
                        }
                    }
                    self.next_poll =
                        Instant::now() + Duration::from_millis(500 * (1u64 << self.read_failures));
                }
                Err(TryRecvError::Disconnected) => {
                    return Err(invalid("OpenAI reconciliation worker stopped"))
                }
                Err(TryRecvError::Empty) => (),
            }
        } else if Instant::now() >= self.next_poll {
            let api = self.api.clone();
            let session = self.session_id.clone();
            let (tx, rx) = mpsc::sync_channel(1);
            std::thread::spawn(move || {
                let _ = tx.send(api.snapshot(&session));
            });
            self.snapshot = Some(rx);
        }
        let event = self.checkpoint.events.pop_front();
        self.save_checkpoint()?;
        Ok(event)
    }
    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<()> {
        let session = self.api.get(&format!("/sessions/{}", self.session_id))?;
        self.verify_session(&session)?;
        let action = session
            .get("required_actions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|a| a.get("call_id").and_then(Value::as_str) == Some(result.call_id.as_str()))
            .ok_or_else(|| {
                invalid("OpenAI function is no longer pending; reconcile its saved result")
            })?;
        let name = id(action, "name")?;
        if self
            .names
            .get(&name)
            .is_none_or(|t| t.operation_id != result.operation_id)
            || action.get("turn_id").and_then(Value::as_str)
                != self.checkpoint.remote_turn_id.as_deref()
        {
            return Err(invalid(
                "OpenAI function result does not match its authorized turn and operation",
            ));
        }
        let mut event = json!({"type":"agent.session.input.tool_result","turn_id":action.get("turn_id"),
            "call_id":result.call_id,"success":!result.is_error});
        event[if result.is_error { "error" } else { "output" }] =
            Value::String(result.result.to_string());
        self.event(event)?;
        self.pending.remove(&result.call_id);
        self.checkpoint
            .delivered_calls
            .insert(result.call_id.clone());
        self.save_checkpoint()
    }
    fn increase_budget(&mut self, maximum: f64) -> Result<Value> {
        if !maximum.is_finite() || maximum <= self.config.max_estimated_session_cost_usd {
            return Err(invalid("OpenAI estimated budget must increase"));
        }
        self.config.max_estimated_session_cost_usd = maximum;
        Ok(json!({"maxEstimatedSessionCostUsd":maximum,"enforcement":"controller_estimate"}))
    }
    fn reconcile_tool_result(&mut self, result: &ToolResult) -> Result<()> {
        let snapshot = self.api.snapshot(&self.session_id)?;
        self.verify_session(&snapshot.session)?;
        let turn = self
            .checkpoint
            .remote_turn_id
            .as_deref()
            .ok_or_else(|| invalid("OpenAI result has no durable turn binding"))?;
        let output = snapshot
            .items
            .iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("turn_id").and_then(Value::as_str) == Some(turn)
                    && item.get("call_id").and_then(Value::as_str) == Some(result.call_id.as_str())
            })
            .ok_or_else(|| {
                invalid("OpenAI result delivery is still ambiguous; no automatic replay")
            })?;
        let expected = result.result.to_string();
        if output
            .get(if result.is_error { "error" } else { "output" })
            .and_then(Value::as_str)
            != Some(expected.as_str())
        {
            return Err(invalid(
                "OpenAI saved function result differs from the durable receipt",
            ));
        }
        self.pending.remove(&result.call_id);
        self.checkpoint
            .delivered_calls
            .insert(result.call_id.clone());
        self.save_checkpoint()
    }
    fn destroy_session(&mut self) -> Result<()> {
        if self.provisional() {
            return Ok(());
        }
        self.api.request(
            reqwest::Method::DELETE,
            &format!("/sessions/{}", self.session_id),
            None,
        )?;
        Ok(())
    }
    fn shutdown(&mut self) -> Result<()> {
        // Closing this controller does not cancel remote work. The durable backend
        // calls interrupt explicitly when authority is revoked; warm suspend resumes it.
        self.snapshot = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> OpenAiManagedProviderConfig {
        OpenAiManagedProviderConfig {
            model: "gpt-6-astra".into(),
            profile_id: "test-profile".into(),
            api_revision: "agents=v1".into(),
            reasoning_effort: "medium".into(),
            environment: json!({"type":"none"}),
            max_estimated_session_cost_usd: 1.0,
            timeout_seconds: 60,
            instructions: "Use authorized Paperclip functions.".into(),
            runtime_context: None,
        }
    }
    fn tools() -> Vec<AuthorizedTool> {
        vec![AuthorizedTool {
            operation_id: "paperclip.task.get".into(),
            version: 1,
            description: "Read task".into(),
            input_schema: json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}),
            response_schema: json!({"type":"object"}),
        }]
    }
    fn provider() -> OpenAiManagedProvider {
        OpenAiManagedProvider::with_api(
            &config(),
            tools(),
            "run:session",
            None,
            None,
            None,
            Api::new("fixture-only", "http://127.0.0.1:1").unwrap(),
        )
        .unwrap()
    }
    fn snapshot(
        p: &OpenAiManagedProvider,
        status: &str,
        actions: Value,
        items: Vec<Value>,
    ) -> Snapshot {
        Snapshot {
            session: json!({"id":"sess_test","metadata":{"paperclip_owner":p.owner},"status":"idle","required_actions":actions,"usage":null}),
            turns: vec![
                json!({"id":"turn_remote","session_id":"sess_test","status":status,"subagent_id":null}),
            ],
            items,
        }
    }
    fn active(p: &mut OpenAiManagedProvider) {
        p.session_id = "sess_test".into();
        p.checkpoint.local_turn_id = Some("local_turn".into());
    }
    #[test]
    fn budget_accounts_for_known_cache_hits_and_reserves_unknown_input() {
        let mut p = provider();
        p.usage = Some(
            json!({"input_tokens":121636,"output_tokens":594,"input_tokens_details":{"cached_tokens":108819}}),
        );
        assert!(p.preflight_turn().is_ok()); // $0.582613 against the $1 fixture ceiling.
        for cached in [Value::Null, json!(-1), json!(121637), json!(0.5)] {
            p.usage.as_mut().unwrap()["input_tokens_details"]["cached_tokens"] = cached;
            assert!(p.preflight_turn().is_err()); // No discount: $3.08545.
        }
    }
    #[test]
    fn prepare_is_offline_and_does_not_start_inference() {
        let p = provider();
        assert!(p.provisional());
        assert!(p.checkpoint.local_turn_id.is_none());
        let body = p.create_body("hello");
        assert_eq!(body["input"], "hello");
        assert_eq!(body["agent"]["multi_agent"]["enabled"], false);
        assert!(body.to_string().find("fixture-only").is_none());
        assert_eq!(body["environment"], json!({"type":"none"}));
        assert_eq!(
            body["agent"]["tools"][0]["parameters"],
            tools()[0].input_schema
        );
    }
    #[test]
    fn network_must_be_explicit_and_controller_env_is_forbidden() {
        let mut c = config();
        c.environment = json!({"type":"openai_hosted","container_size":"medium"});
        assert!(validate_config(&c).is_err());
        c.environment["network"] = json!({"access":"disabled"});
        assert!(validate_config(&c).is_ok());
        c.environment["env"] = json!({"OPENAI_API_KEY":"secret"});
        assert!(validate_config(&c).is_err());
        c.environment.as_object_mut().unwrap().remove("env");
        c.environment["files"] = json!([{"type":"inline","path":"/workspace/../escape","data":""}]);
        assert!(validate_config(&c).is_err());
    }
    #[test]
    fn idle_does_not_mean_completed() {
        let mut p = provider();
        active(&mut p);
        p.apply_snapshot(snapshot(&p, "waiting", json!([]), vec![]))
            .unwrap();
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "turn/started")
        );
        assert!(p.checkpoint.events.is_empty());
        assert!(p.checkpoint.local_turn_id.is_some());
    }
    #[test]
    fn pending_actions_are_authorized_validated_and_deduplicated() {
        let mut p = provider();
        active(&mut p);
        let name = p.names.keys().next().unwrap().clone();
        let action = json!({"type":"function_call","call_id":"call_test","turn_id":"turn_remote","name":name,"arguments":{"id":"task-1"}});
        p.apply_snapshot(snapshot(&p, "waiting", json!([action]), vec![]))
            .unwrap();
        p.apply_snapshot(snapshot(&p, "waiting", json!([action]), vec![]))
            .unwrap();
        assert_eq!(p.checkpoint.events.len(), 2);
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, params }) if method == "turn/started" && params["turn"]["id"] == "local_turn")
        );
        assert!(matches!(
            p.checkpoint.events.front(),
            Some(ProviderEvent::ToolCall { .. })
        ));
        let mut changed = action.clone();
        changed["arguments"] = json!({"id":"task-2"});
        assert!(p
            .apply_snapshot(snapshot(&p, "waiting", json!([changed]), vec![]))
            .is_err());
        let mut unauthorized = action;
        unauthorized["name"] = json!("exec_shell");
        assert!(p
            .apply_snapshot(snapshot(&p, "waiting", json!([unauthorized]), vec![]))
            .is_err());
    }
    #[test]
    fn saved_history_calls_do_not_execute() {
        let mut p = provider();
        active(&mut p);
        let item = json!({"id":"item_call","type":"function_call","turn_id":"turn_remote","name":"untrusted","arguments":{}});
        p.apply_snapshot(snapshot(&p, "in_progress", json!([]), vec![item]))
            .unwrap();
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "turn/started")
        );
        assert!(p.checkpoint.events.is_empty());
    }
    #[test]
    fn checkpoint_preserves_output_backlog_and_turn_binding() {
        let mut p = provider();
        active(&mut p);
        p.checkpoint.terminal_observed_at_ms = Some(now_ms() - 30_001);
        let message = json!({"id":"item_message","type":"message","role":"assistant","status":"completed","turn_id":"turn_remote","content":[{"type":"output_text","text":"Done"}]});
        p.apply_snapshot(snapshot(&p, "completed", json!([]), vec![message]))
            .unwrap();
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "turn/started")
        );
        let first = p.poll().unwrap().unwrap();
        assert!(
            matches!(first,ProviderEvent::Notification{method,..} if method == "item/completed")
        );
        let mut restored = OpenAiManagedProvider::with_api(
            &config(),
            tools(),
            "successor-run:session",
            Some("sess_test"),
            Some(&p.cursor),
            None,
            Api::new("fixture-only", "http://127.0.0.1:1").unwrap(),
        )
        .unwrap();
        assert_eq!(restored.owner, p.owner);
        let terminal = restored.poll().unwrap().unwrap();
        assert!(
            matches!(terminal,ProviderEvent::Notification{method,params} if method == "turn/completed" && params["turnId"] == "local_turn")
        );
    }
    #[test]
    fn wrong_session_and_turn_never_dispatch() {
        let mut p = provider();
        active(&mut p);
        let mut s = snapshot(&p, "completed", json!([]), vec![]);
        s.session["metadata"]["paperclip_owner"] = json!("other-owner");
        assert!(p.apply_snapshot(s).is_err());
        let mut s = snapshot(&p, "completed", json!([]), vec![]);
        s.turns[0]["session_id"] = json!("other_session");
        assert!(p.apply_snapshot(s).is_err());
    }
    #[test]
    fn unknown_usage_stays_unknown() {
        let mut p = provider();
        active(&mut p);
        p.checkpoint.terminal_observed_at_ms = Some(now_ms() - 30_001);
        p.apply_snapshot(snapshot(&p, "completed", json!([]), vec![]))
            .unwrap();
        assert!(p.usage_snapshot().is_none());
        assert!(p.model_request_count().is_none());
        assert_eq!(p.checkpoint.events.len(), 2);
    }
    fn http_fixture(
        responses: Vec<(&'static str, Value)>,
    ) -> (Api, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (expected, response) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert!(first.starts_with(expected), "unexpected request: {first}");
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((key, value)) = line.split_once(':') {
                        if key.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse::<usize>().unwrap();
                        }
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                requests.push(if bytes.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                });
                let body = response.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            requests
        });
        (Api::new("fixture-only", &origin).unwrap(), handle)
    }
    #[test]
    fn http_create_and_result_delivery_bind_the_authoritative_action() {
        let mut p = provider();
        let owner = p.owner.clone();
        let name = p.names.keys().next().unwrap().clone();
        let action = json!({"type":"function_call","call_id":"call_http","turn_id":"turn_remote","name":name,"arguments":{"id":"task-1"}});
        let session = json!({"id":"sess_test","metadata":{"paperclip_owner":owner},"required_actions":[action]});
        let (api, handle) = http_fixture(vec![
            ("POST /sessions ", session.clone()),
            ("GET /sessions/sess_test ", session),
            ("POST /sessions/sess_test/events ", json!({})),
        ]);
        p.api = api;
        p.start_turn("Read task", "", "local_turn").unwrap();
        p.apply_snapshot(snapshot(&p, "waiting", json!([action]), vec![]))
            .unwrap();
        p.deliver_tool_result(&ToolResult {
            call_id: "call_http".into(),
            operation_id: "paperclip.task.get".into(),
            result: json!({"ok":true}),
            is_error: false,
        })
        .unwrap();
        let requests = handle.join().unwrap();
        assert_eq!(requests[0]["environment"], json!({"type":"none"}));
        assert_eq!(requests[2]["events"][0]["turn_id"], "turn_remote");
        assert_eq!(requests[2]["events"][0]["call_id"], "call_http");
        assert!(p.checkpoint.delivered_calls.contains("call_http"));
    }
    #[test]
    fn terminal_snapshot_reads_accounting_after_turn_completion() {
        let mut p = provider();
        active(&mut p);
        let usage = json!({"input_tokens":120,"output_tokens":15,"input_tokens_details":{"cached_tokens":40}});
        let (api, handle) = http_fixture(vec![
            (
                "GET /sessions/sess_test/turns?",
                json!({"data":[{"id":"turn_remote","session_id":"sess_test","status":"completed"}],"has_more":false}),
            ),
            (
                "GET /sessions/sess_test/items?",
                json!({"data":[{"id":"message_final","turn_id":"turn_remote","type":"message","role":"assistant","status":"completed","phase":"final_answer","content":[{"type":"output_text","text":"Done"}]}],"has_more":false}),
            ),
            (
                "GET /sessions/sess_test ",
                json!({"id":"sess_test","metadata":{"paperclip_owner":p.owner},"status":"idle","required_actions":[],"usage":usage}),
            ),
        ]);
        p.apply_snapshot(api.snapshot("sess_test").unwrap())
            .unwrap();
        handle.join().unwrap();
        let events: Vec<_> = p.checkpoint.events.iter().collect();
        assert!(
            matches!(events[1], ProviderEvent::Notification { method, params } if method == "item/completed" && params["item"]["phase"] == "final_answer")
        );
        assert!(
            matches!(events[2], ProviderEvent::Notification { method, params } if method == "thread/tokenUsage/updated" && params["usage"]["inputTokens"] == 120)
        );
        assert!(
            matches!(events[3], ProviderEvent::Notification { method, .. } if method == "turn/completed")
        );
    }
    #[test]
    fn terminal_uses_complete_turn_accounting_when_session_usage_is_missing() {
        let mut p = provider();
        active(&mut p);
        let mut s = snapshot(&p, "completed", json!([]), vec![]);
        s.turns[0]["usage"] =
            json!({"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}});
        p.apply_snapshot(s).unwrap();
        assert_eq!(p.usage_snapshot().unwrap()["input_tokens"], 12);
        assert!(p.checkpoint.local_turn_id.is_none());
        assert!(p.checkpoint.events.iter().any(|event| matches!(event,
            ProviderEvent::Notification { method, params } if method == "thread/tokenUsage/updated"
            && params["usage"]["cacheReadInputTokens"] == 4)));
    }
    #[test]
    fn turn_accounting_is_cumulative_without_double_counting_or_partial_totals() {
        let p = provider();
        let mut s = snapshot(&p, "completed", json!([]), vec![]);
        s.turns[0]["usage"] =
            json!({"input_tokens":12,"output_tokens":3,"input_tokens_details":{"cached_tokens":4}});
        let mut older = s.turns[0].clone();
        older["id"] = json!("turn_older");
        older["usage"] = json!({"input_tokens":20,"output_tokens":5});
        s.turns.insert(0, older);
        let usage = reconcile_usage(&s, "sess_test").unwrap();
        assert_eq!(usage["input_tokens"], 32);
        assert_eq!(usage["output_tokens"], 8);
        assert!(usage["input_tokens_details"]["cached_tokens"].is_null());
        // Re-reading the same full history does not add the previous snapshot.
        assert_eq!(reconcile_usage(&s, "sess_test"), Some(usage));
        s.session["usage"] = json!({"input_tokens":32,"output_tokens":8});
        assert_eq!(
            reconcile_usage(&s, "sess_test"),
            Some(s.session["usage"].clone())
        );
        s.session["usage"] = Value::Null;
        for invalid in [
            Value::Null,
            json!({}),
            json!({"input_tokens":-1,"output_tokens":1}),
        ] {
            s.turns[0]["usage"] = invalid;
            assert!(reconcile_usage(&s, "sess_test").is_none());
        }
    }
    #[test]
    fn turn_accounting_rejects_duplicate_foreign_and_subagent_history() {
        let p = provider();
        let mut s = snapshot(&p, "completed", json!([]), vec![]);
        s.turns[0]["usage"] = json!({"input_tokens":12,"output_tokens":3});
        s.turns.push(s.turns[0].clone());
        assert!(reconcile_usage(&s, "sess_test").is_none());
        s.turns.pop();
        s.turns[0]["session_id"] = json!("other_session");
        assert!(reconcile_usage(&s, "sess_test").is_none());
        s.turns[0]["session_id"] = json!("sess_test");
        s.turns[0]["subagent_id"] = json!("unexpected_subagent");
        assert!(reconcile_usage(&s, "sess_test").is_none());
    }
    #[test]
    fn terminal_waits_for_delayed_usage_without_repeating_messages_or_start() {
        let mut p = provider();
        active(&mut p);
        p.checkpoint.terminal_observed_at_ms = None;
        p.checkpoint.cancel_deadline_ms = Some(now_ms() - 1);
        p.apply_snapshot(snapshot(&p, "completed", json!([]), vec![]))
            .unwrap();
        assert!(p.checkpoint.cancel_deadline_ms.is_none());
        assert!(p.checkpoint.local_turn_id.is_some());
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "turn/started")
        );
        assert!(p.checkpoint.events.is_empty());
        let mut settled = snapshot(&p, "completed", json!([]), vec![]);
        settled.session["usage"] = json!({"input_tokens":12,"output_tokens":3});
        p.apply_snapshot(settled).unwrap();
        assert!(p.checkpoint.local_turn_id.is_none());
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "thread/tokenUsage/updated")
        );
        assert!(
            matches!(p.poll().unwrap(), Some(ProviderEvent::Notification { method, .. }) if method == "turn/completed")
        );
    }
    #[test]
    fn completed_backlog_recovery_does_not_restart_polling_a_finished_turn() {
        let mut p = provider();
        active(&mut p);
        p.checkpoint.terminal_observed_at_ms = Some(now_ms() - 30_001);
        p.apply_snapshot(snapshot(&p, "completed", json!([]), vec![]))
            .unwrap();
        p.restore_active_turn("local_turn").unwrap();
        assert!(p.checkpoint.local_turn_id.is_none());
        assert!(p.poll().unwrap().is_some());
        assert!(p.poll().unwrap().is_some());
        assert!(p.poll().unwrap().is_none());
    }
    #[test]
    fn lost_history_and_expired_cancellation_fail_closed() {
        let mut p = provider();
        active(&mut p);
        p.checkpoint.last_turn_id = Some("lost_turn".into());
        assert!(p
            .apply_snapshot(snapshot(&p, "completed", json!([]), vec![]))
            .is_err());
        p.checkpoint.last_turn_id = None;
        p.checkpoint.cancel_requested = true;
        p.checkpoint.cancel_deadline_ms = Some(now_ms() - 1);
        assert!(p.poll().is_err());
    }
}
