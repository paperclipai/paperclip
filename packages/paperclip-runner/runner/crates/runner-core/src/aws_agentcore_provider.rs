//! Amazon Bedrock AgentCore Harness provider.
//!
//! The Harness owns the remote model loop. Paperclip supplies only caller-side
//! inline functions, then executes those functions through the durable PRP
//! bridge. No Paperclip credential or callback address enters AgentCore.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use aws_config::sts::AssumeRoleProvider;
use aws_sdk_bedrockagentcore::error::SdkError;
use aws_sdk_bedrockagentcore::types::{
    HarnessContentBlock, HarnessContentBlockDelta, HarnessContentBlockStart,
    HarnessConversationRole, HarnessInlineFunctionConfig, HarnessMessage, HarnessSkill,
    HarnessSkillS3Source, HarnessSystemContentBlock, HarnessTool, HarnessToolConfiguration,
    HarnessToolResultBlock, HarnessToolResultContentBlock, HarnessToolType, HarnessToolUseBlock,
    HarnessToolUseStatus, HarnessToolUseType, InvokeHarnessStreamOutput,
};
use aws_smithy_types::byte_stream::ByteStream;
use aws_smithy_types::error::metadata::ProvideErrorMetadata;
use aws_smithy_types::{Document, Number};
use aws_types::region::Region;
use jsonschema::validator_for;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::local_runner::LocalRunnerError;
use crate::managed_provider::{
    AwsAgentCoreProviderConfig, Provider, ProviderEvent, ProviderKind, ProviderRuntimeIdentity,
};
use crate::provider_bridge::{AuthorizedTool, ToolResult};

const MAX_AGENTCORE_TOOLS: usize = 64;
// Harness invocations can spend substantial time starting a new runtime before
// response headers (and therefore the event stream) are available. Allow a
// bounded cold start, but leave enough of the eval's outer deadline for the
// durable runner to classify the failure and service runner.shutdown cleanly.
const AGENTCORE_INVOCATION_DELIVERY_TIMEOUT: Duration = Duration::from_secs(120);
// InvokeHarness accepts at most 50 HarnessSkill entries. Paperclip reserves one
// for the generated instruction companion, leaving at most 49 assigned skills.
const MAX_CONTEXT_SKILL_SOURCES: usize = 50;
const MAX_CONTEXT_UPLOAD_FILES: usize = 10_000;
const MAX_CONTEXT_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_MEMORY_HISTORY_PAGES: usize = 1_000;
const MAX_MEMORY_HISTORY_EVENTS: usize = 100_000;
const MAX_INTERRUPT_DRAIN_EVENTS: usize = 256;
#[cfg(not(test))]
const AGENTCORE_INTERRUPT_USAGE_RECONCILIATION_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(test)]
const AGENTCORE_INTERRUPT_USAGE_RECONCILIATION_TIMEOUT: Duration = Duration::from_millis(75);
pub(crate) const AGENTCORE_USAGE_RECONCILIATION_OBSERVED: &str = "authoritative_metadata_observed";
pub(crate) const AGENTCORE_USAGE_RECONCILIATION_PENDING: &str =
    "latest_cumulative_estimate_pending_metadata";
pub(crate) const AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE: &str =
    "interrupted_invocation_charged_to_session_ceiling";
pub(crate) const AGENTCORE_USAGE_RECONCILIATION_FIELD: &str = "usageReconciliation";
pub(crate) const AGENTCORE_PENDING_INVOCATION_FIELD: &str = "pendingInvocationId";
pub(crate) const AGENTCORE_PENDING_CEILING_FIELD: &str = "pendingEstimatedCeilingUsd";
pub(crate) const AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD: &str = "conservativeCostFloorUsd";
#[cfg(test)]
const AGENTCORE_INLINE_TOOL_ALLOWLIST: &str = "@*/pc_*";
#[derive(Clone, Debug)]
struct RemoteToolUse {
    remote_name: String,
    operation_id: String,
    input: Value,
}

fn restored_usage_snapshot(snapshot: Option<&Value>) -> Result<Value, LocalRunnerError> {
    let Some(snapshot) = snapshot else {
        return Ok(json!({
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadInputTokens": 0,
            "cacheWriteInputTokens": 0,
            "requestCount": 0,
            "estimatedCostUsd": 0.0,
            "costSource": "paperclip_estimate"
        }));
    };
    let object = snapshot.as_object().ok_or_else(|| {
        LocalRunnerError::invalid("AgentCore durable usage snapshot must be an object")
    })?;
    for field in [
        "inputTokens",
        "outputTokens",
        "cacheReadInputTokens",
        "cacheWriteInputTokens",
        "requestCount",
    ] {
        if object.get(field).and_then(Value::as_u64).is_none() {
            return Err(LocalRunnerError::invalid(format!(
                "AgentCore durable usage snapshot has invalid {field}"
            )));
        }
    }
    let estimated = object
        .get("estimatedCostUsd")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| {
            LocalRunnerError::invalid(
                "AgentCore durable usage snapshot has invalid estimatedCostUsd",
            )
        })?;
    if object.get("costSource").and_then(Value::as_str) != Some("paperclip_estimate") {
        return Err(LocalRunnerError::invalid(
            "AgentCore durable usage snapshot has invalid costSource",
        ));
    }
    let pending_ceiling = match object.get(AGENTCORE_PENDING_CEILING_FIELD) {
        None => None,
        Some(value) => Some(
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "AgentCore durable usage snapshot has invalid pending estimated ceiling",
                    )
                })?,
        ),
    };
    let conservative_floor = match object.get(AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD) {
        None => None,
        Some(value) => Some(
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "AgentCore durable usage snapshot has invalid conservative cost floor",
                    )
                })?,
        ),
    };
    if conservative_floor.is_some_and(|floor| estimated < floor) {
        return Err(LocalRunnerError::invalid(
            "AgentCore durable usage snapshot undercuts its conservative cost floor",
        ));
    }
    match (
        object.get(AGENTCORE_USAGE_RECONCILIATION_FIELD),
        object.get(AGENTCORE_PENDING_INVOCATION_FIELD),
        pending_ceiling,
    ) {
        (None, None, None) if conservative_floor.is_none() => {}
        (Some(reconciliation), None, None)
            if reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_OBSERVED) => {}
        (Some(reconciliation), None, None)
            if reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE)
                && conservative_floor.is_some() => {}
        (Some(reconciliation), Some(invocation_id), _)
            if reconciliation.as_str() == Some(AGENTCORE_USAGE_RECONCILIATION_PENDING)
                && invocation_id.as_str().is_some_and(|invocation_id| {
                    !invocation_id.is_empty()
                        && invocation_id.len() <= 512
                        && !invocation_id.chars().any(char::is_control)
                }) => {}
        _ => {
            return Err(LocalRunnerError::invalid(
                "AgentCore durable usage snapshot has invalid pending reconciliation state",
            ));
        }
    }
    let mut restored = snapshot.clone();
    restored["estimatedCostUsd"] = json!(estimated);
    Ok(restored)
}

#[derive(Clone, Debug)]
struct NetworkEvent {
    invocation_id: String,
    kind: NetworkEventKind,
}

impl NetworkEvent {
    fn new(invocation_id: &str, kind: NetworkEventKind) -> Self {
        Self {
            invocation_id: invocation_id.to_owned(),
            kind,
        }
    }
}

#[derive(Clone, Debug)]
enum NetworkEventKind {
    TextDelta(String),
    ReasoningProgress,
    ToolUse {
        call_id: String,
        remote_name: String,
        input: Value,
    },
    Usage {
        input_tokens: i64,
        output_tokens: i64,
        cache_read_input_tokens: i64,
        cache_write_input_tokens: i64,
        latency_ms: i64,
    },
    Stop(String),
    InvocationComplete,
    MemoryCursor(String),
    Failure(String),
}

enum NetworkCommand {
    Invoke {
        messages: Vec<HarnessMessage>,
        tools: Vec<HarnessTool>,
        allowed_tools: Vec<String>,
        invocation_id: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    StopRuntime {
        token: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    DeleteMemory {
        reply: mpsc::Sender<Result<(), String>>,
    },
    Shutdown,
}

struct NetworkWorker {
    commands: SyncSender<NetworkCommand>,
    events: Receiver<NetworkEvent>,
    join: Option<JoinHandle<()>>,
}

fn stop_runtime_target(config: &AwsAgentCoreProviderConfig) -> (&str, &str) {
    (
        config.agent_runtime_arn.as_str(),
        config.endpoint_qualifier.as_str(),
    )
}

impl NetworkWorker {
    fn start(
        config: AwsAgentCoreProviderConfig,
        session_id: String,
        actor_id: String,
    ) -> Result<Self, LocalRunnerError> {
        let (command_tx, command_rx) = mpsc::sync_channel(32);
        let (event_tx, event_rx) = mpsc::sync_channel(256);
        let (ready_tx, ready_rx) = mpsc::channel();
        let join = thread::Builder::new()
            .name("paperclip-aws-agentcore-network".to_owned())
            .spawn(move || {
                network_loop(config, session_id, actor_id, command_rx, event_tx, ready_tx)
            })
            .map_err(|error| {
                LocalRunnerError::invalid(format!(
                    "failed to start AgentCore network worker: {error}"
                ))
            })?;
        ready_rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| LocalRunnerError::invalid("AgentCore credential setup timed out"))?
            .map_err(LocalRunnerError::invalid)?;
        Ok(Self {
            commands: command_tx,
            events: event_rx,
            join: Some(join),
        })
    }

    fn invoke(
        &self,
        messages: Vec<HarnessMessage>,
        tools: Vec<HarnessTool>,
        allowed_tools: Vec<String>,
        invocation_id: String,
    ) -> Result<(), LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::Invoke {
                messages,
                tools,
                allowed_tools,
                invocation_id,
                reply: reply_tx,
            })
            .map_err(|_| LocalRunnerError::invalid("AgentCore network worker stopped"))?;
        reply_rx
            .recv_timeout(AGENTCORE_INVOCATION_DELIVERY_TIMEOUT)
            .map_err(|_| {
                LocalRunnerError::invalid(
                    "AgentCore invocation delivery is ambiguous and requires Memory reconciliation",
                )
            })?
            .map_err(LocalRunnerError::invalid)
    }

    fn stop_runtime(&self, token: String) -> Result<(), LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::StopRuntime {
                token,
                reply: reply_tx,
            })
            .map_err(|_| LocalRunnerError::invalid("AgentCore network worker stopped"))?;
        reply_rx
            .recv_timeout(Duration::from_secs(45))
            .map_err(|_| LocalRunnerError::invalid("AgentCore runtime stop timed out"))?
            .map_err(LocalRunnerError::invalid)
    }

    fn delete_memory(&self) -> Result<(), LocalRunnerError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.commands
            .send(NetworkCommand::DeleteMemory { reply: reply_tx })
            .map_err(|_| LocalRunnerError::invalid("AgentCore network worker stopped"))?;
        reply_rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| LocalRunnerError::invalid("AgentCore Memory purge timed out"))?
            .map_err(LocalRunnerError::invalid)
    }

    fn try_event(&self) -> Option<NetworkEvent> {
        self.events.try_recv().ok()
    }

    fn receive_event_until(&self, deadline: Instant) -> Option<NetworkEvent> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match self.events.recv_timeout(remaining) {
            Ok(event) => Some(event),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        }
    }

    fn shutdown(&mut self) {
        let _ = self.commands.send(NetworkCommand::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for NetworkWorker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn context_text<'a>(value: &'a Value, pointer: &str) -> Result<&'a str, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("runtimeContext {pointer} is missing"))
}

fn collect_context_files(root: &Path) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    fn visit(
        root: &Path,
        current: &Path,
        files: &mut Vec<(PathBuf, Vec<u8>)>,
        total: &mut usize,
    ) -> Result<(), String> {
        let mut entries = fs::read_dir(current)
            .map_err(|error| format!("failed to read runtime context asset: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to enumerate runtime context asset: {error}"))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("failed to inspect runtime context asset: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("AgentCore context bundles may not contain symlinks".to_owned());
            }
            if metadata.is_dir() {
                visit(root, &path, files, total)?;
            } else if metadata.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "runtime context asset escaped its root".to_owned())?
                    .to_path_buf();
                let bytes = fs::read(&path)
                    .map_err(|error| format!("failed to read runtime context file: {error}"))?;
                *total = total.saturating_add(bytes.len());
                if *total > MAX_CONTEXT_UPLOAD_BYTES {
                    return Err("AgentCore context upload exceeded its size limit".to_owned());
                }
                if files.len() >= MAX_CONTEXT_UPLOAD_FILES {
                    return Err("AgentCore context upload exceeded its file limit".to_owned());
                }
                files.push((relative, bytes));
            }
        }
        Ok(())
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("runtime context asset is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("runtime context asset root must be a real directory".to_owned());
    }
    let mut files = Vec::new();
    let mut total = 0;
    visit(root, root, &mut files, &mut total)?;
    Ok(files)
}

async fn upload_context_directory(
    client: &aws_sdk_s3::Client,
    config: &AwsAgentCoreProviderConfig,
    digest: &str,
    files: Vec<(PathBuf, Vec<u8>)>,
    generated_skill: Option<String>,
) -> Result<HarnessSkill, String> {
    let prefix = config.context_prefix.trim_matches('/');
    let asset_prefix = format!("{prefix}/assets/{digest}");
    let mut files = files;
    if let Some(skill) = generated_skill {
        files.push((PathBuf::from("SKILL.md"), skill.into_bytes()));
    }
    for (relative, bytes) in files {
        let relative = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if relative.is_empty()
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("runtime context upload path is unsafe".to_owned());
        }
        let key = format!("{asset_prefix}/{relative}");
        let content_digest = format!("{:x}", Sha256::digest(&bytes));
        if let Ok(existing) = client
            .head_object()
            .bucket(&config.context_bucket)
            .key(&key)
            .send()
            .await
        {
            let metadata_digest = existing
                .metadata()
                .and_then(|metadata| metadata.get("paperclip-sha256"))
                .map(String::as_str);
            if existing.content_length() != Some(bytes.len() as i64)
                || metadata_digest != Some(content_digest.as_str())
                || existing.server_side_encryption()
                    != Some(&aws_sdk_s3::types::ServerSideEncryption::AwsKms)
                || existing.ssekms_key_id() != Some(config.context_kms_key_arn.as_str())
            {
                return Err(format!(
                    "AgentCore context S3 asset verification failed: {}",
                    sha_hex(&key, 16)
                ));
            }
            continue;
        }
        client
            .put_object()
            .bucket(&config.context_bucket)
            .key(&key)
            .server_side_encryption(aws_sdk_s3::types::ServerSideEncryption::AwsKms)
            .ssekms_key_id(&config.context_kms_key_arn)
            .metadata("paperclip-sha256", content_digest)
            .body(ByteStream::from(bytes))
            .send()
            .await
            .map_err(|error| {
                format!(
                    "AgentCore context S3 upload failed: {}",
                    redact_aws_error(&error.to_string())
                )
            })?;
    }
    let source = HarnessSkillS3Source::builder()
        .uri(format!("s3://{}/{asset_prefix}/", config.context_bucket))
        .build()
        .map_err(|_| "failed to build AgentCore S3 skill source".to_owned())?;
    Ok(HarnessSkill::S3(source))
}

#[derive(Debug)]
struct AgentCoreContextAsset {
    digest: String,
    files: Vec<(PathBuf, Vec<u8>)>,
    generated_skill: Option<String>,
}

fn validate_agentcore_context_aggregate(
    asset_count: usize,
    file_count: usize,
    byte_count: usize,
) -> Result<(), String> {
    if asset_count > MAX_CONTEXT_SKILL_SOURCES {
        return Err("AgentCore context exceeds the Harness skill-source limit".to_owned());
    }
    if file_count > MAX_CONTEXT_UPLOAD_FILES {
        return Err("AgentCore context exceeds the aggregate file limit".to_owned());
    }
    if byte_count > MAX_CONTEXT_UPLOAD_BYTES {
        return Err("AgentCore context exceeds the aggregate byte limit".to_owned());
    }
    Ok(())
}

fn agentcore_context_totals(assets: &[AgentCoreContextAsset]) -> (usize, usize) {
    assets.iter().fold((0_usize, 0_usize), |totals, asset| {
        let generated = asset.generated_skill.as_ref();
        let file_count = totals
            .0
            .saturating_add(asset.files.len())
            .saturating_add(usize::from(generated.is_some()));
        let byte_count = asset
            .files
            .iter()
            .fold(totals.1, |sum, (_, bytes)| sum.saturating_add(bytes.len()))
            .saturating_add(generated.map_or(0, String::len));
        (file_count, byte_count)
    })
}

fn prepare_agentcore_runtime_context_assets(
    config: &AwsAgentCoreProviderConfig,
) -> Result<Vec<AgentCoreContextAsset>, String> {
    let context = config.runtime_context.as_ref().ok_or_else(|| {
        "AgentCore requires paperclip.native-execution-input.v3 runtimeContext".to_owned()
    })?;
    let instruction_digest = context_text(context, "/instructions/bundle/digest")?;
    let instruction_root = Path::new(context_text(context, "/instructions/bundle/rootPath")?);
    let entry_path = context_text(context, "/instructions/entryPath")?;
    let instruction_files = collect_context_files(instruction_root)?
        .into_iter()
        .map(|(path, bytes)| (PathBuf::from("instructions").join(path), bytes))
        .collect();
    let instruction_companion = format!(
        "---\nname: paperclip-instructions-{}\ndescription: Paperclip agent instruction sibling bundle\n---\nRead `instructions/{entry_path}` and its sibling files as read-only context.\n",
        &instruction_digest[..12]
    );
    let instruction_asset_digest = sha_hex(
        &format!("{instruction_digest}\0{entry_path}\0{instruction_companion}"),
        64,
    );
    let mut assets = vec![AgentCoreContextAsset {
        digest: instruction_asset_digest,
        files: instruction_files,
        generated_skill: Some(instruction_companion),
    }];
    let (file_count, byte_count) = agentcore_context_totals(&assets);
    validate_agentcore_context_aggregate(assets.len(), file_count, byte_count)?;
    let assigned = context
        .get("skills")
        .and_then(Value::as_array)
        .ok_or_else(|| "runtimeContext.skills must be an array".to_owned())?;
    validate_agentcore_context_aggregate(assets.len().saturating_add(assigned.len()), 0, 0)?;
    for skill in assigned {
        let digest = context_text(skill, "/bundle/digest")?;
        let root = Path::new(context_text(skill, "/bundle/rootPath")?);
        let files = collect_context_files(root)?;
        if !files.iter().any(|(path, _)| path == Path::new("SKILL.md")) {
            return Err("AgentCore custom skill bundle is missing SKILL.md".to_owned());
        }
        assets.push(AgentCoreContextAsset {
            digest: digest.to_owned(),
            files,
            generated_skill: None,
        });
        let (file_count, byte_count) = agentcore_context_totals(&assets);
        validate_agentcore_context_aggregate(assets.len(), file_count, byte_count)?;
    }
    Ok(assets)
}

async fn upload_agentcore_runtime_context(
    client: &aws_sdk_s3::Client,
    config: &AwsAgentCoreProviderConfig,
) -> Result<Vec<HarnessSkill>, String> {
    let mut skills = Vec::new();
    for asset in prepare_agentcore_runtime_context_assets(config)? {
        skills.push(
            upload_context_directory(
                client,
                config,
                &asset.digest,
                asset.files,
                asset.generated_skill,
            )
            .await?,
        );
    }
    Ok(skills)
}

fn agentcore_system_instructions(config: &AwsAgentCoreProviderConfig) -> Result<String, String> {
    let Some(context) = config.runtime_context.as_ref() else {
        return Ok(config.instructions.clone());
    };
    let instruction_root = context_text(context, "/instructions/bundle/rootPath")?;
    let local_directive = format!("Read-only instruction sibling root: {instruction_root}");
    config
        .instructions
        .strip_suffix(&local_directive)
        .map(|prefix| format!(
            "{prefix}Read-only instruction siblings are in the attached Paperclip HarnessSkill under `instructions/`."
        ))
        .ok_or_else(|| "AgentCore instruction-root directive is missing or inconsistent".to_owned())
}

fn network_loop(
    config: AwsAgentCoreProviderConfig,
    session_id: String,
    actor_id: String,
    commands: Receiver<NetworkCommand>,
    events: SyncSender<NetworkEvent>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready.send(Err(format!(
                "failed to create AgentCore async runtime: {error}"
            )));
            return;
        }
    };
    let clients = runtime.block_on(async {
        let region = Region::new(config.region.clone());
        let base = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(region.clone())
            .load()
            .await;
        let assumed = AssumeRoleProvider::builder(config.invocation_role_arn.clone())
            .session_name(format!(
                "paperclip-{}",
                &session_id[session_id.len().saturating_sub(24)..]
            ))
            .configure(&base)
            .build()
            .await;
        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(region)
            .credentials_provider(assumed)
            .load()
            .await;
        let s3 = aws_sdk_s3::Client::new(&shared);
        let skills = upload_agentcore_runtime_context(&s3, &config).await?;
        let system_instructions = agentcore_system_instructions(&config)?;
        Ok::<_, String>((
            aws_sdk_bedrockagentcore::Client::new(&shared),
            config,
            skills,
            system_instructions,
        ))
    });
    let (client, config, skills, system_instructions) = match clients {
        Ok(clients) => clients,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    while let Ok(command) = commands.recv() {
        match command {
            NetworkCommand::Invoke {
                messages,
                tools,
                allowed_tools,
                invocation_id,
                reply,
            } => {
                let client = client.clone();
                let config = config.clone();
                let session_id = session_id.clone();
                let actor_id = actor_id.clone();
                let events = events.clone();
                let skills = skills.clone();
                let system_instructions = system_instructions.clone();
                runtime.spawn(async move {
                    // The qualified Harness version is the immutable model
                    // authority. Supplying a redundant invocation override
                    // changes AgentCore's authorization path and can require
                    // caller-side Marketplace permissions, bypassing the
                    // execution role qualified during provisioning.
                    let response = client
                        .invoke_harness()
                        .harness_arn(config.harness_arn.clone())
                        .qualifier(config.endpoint_qualifier.clone())
                        .runtime_session_id(session_id.clone())
                        .runtime_user_id(actor_id.clone())
                        .actor_id(actor_id.clone())
                        .set_messages(Some(messages))
                        .set_tools(Some(tools))
                        // Invocation-scoped inline functions live behind an
                        // AgentCore server namespace. Unqualified names are
                        // silently withheld, so admit each authorized tool as
                        // `@*/<collision-resistant pc_ name>` and nothing else.
                        .set_allowed_tools(Some(allowed_tools))
                        .set_system_prompt(Some(vec![HarnessSystemContentBlock::Text(
                            system_instructions,
                        )]))
                        .set_skills(Some(skills))
                        .max_iterations(config.max_iterations as i32)
                        .max_tokens(config.max_output_tokens as i32)
                        .timeout_seconds(config.timeout_seconds as i32)
                        .trace_parent(format!(
                            "00-{}-{}-01",
                            sha_hex(&invocation_id, 32),
                            sha_hex(&(invocation_id.clone() + "span"), 16)
                        ))
                        .send()
                        .await;
                    let mut response = match response {
                        Ok(value) => value,
                        Err(error) => {
                            let detail = classify_aws_sdk_error(&error);
                            let _ = reply.send(Err(detail.clone()));
                            let _ = events.send(NetworkEvent::new(
                                &invocation_id,
                                NetworkEventKind::Failure(detail),
                            ));
                            return;
                        }
                    };
                    let _ = reply.send(Ok(()));
                    let mut tool_blocks: BTreeMap<i32, (String, String, String)> = BTreeMap::new();
                    loop {
                        match response.stream.recv().await {
                            Ok(Some(event)) => normalize_stream_event(
                                event,
                                &mut tool_blocks,
                                &events,
                                &invocation_id,
                            ),
                            Ok(None) => break,
                            Err(error) => {
                                let _ = events.send(NetworkEvent::new(
                                    &invocation_id,
                                    NetworkEventKind::Failure(classify_aws_sdk_error(&error)),
                                ));
                                break;
                            }
                        }
                    }
                    match latest_memory_event_id(&client, &config, &session_id, &actor_id).await {
                        Ok(Some(event_id)) => {
                            let _ = events.send(NetworkEvent::new(
                                &invocation_id,
                                NetworkEventKind::MemoryCursor(event_id),
                            ));
                        }
                        Ok(None) => {}
                        Err(detail) => {
                            let _ = events.send(NetworkEvent::new(
                                &invocation_id,
                                NetworkEventKind::Failure(detail),
                            ));
                            return;
                        }
                    }
                    let _ = events.send(NetworkEvent::new(
                        &invocation_id,
                        NetworkEventKind::InvocationComplete,
                    ));
                });
            }
            NetworkCommand::StopRuntime { token, reply } => {
                let result = runtime.block_on(async {
                    let (runtime_arn, qualifier) = stop_runtime_target(&config);
                    match client
                        .stop_runtime_session()
                        .runtime_session_id(session_id.clone())
                        .agent_runtime_arn(runtime_arn)
                        .qualifier(qualifier)
                        .client_token(token)
                        .send()
                        .await
                    {
                        Ok(_) => Ok(()),
                        Err(error) if is_resource_not_found(&error.to_string()) => Ok(()),
                        Err(error) => Err(redact_aws_error(&error.to_string())),
                    }
                });
                let _ = reply.send(result);
            }
            NetworkCommand::DeleteMemory { reply } => {
                let result = runtime.block_on(delete_all_memory_events(
                    &client,
                    &config,
                    &session_id,
                    &actor_id,
                ));
                let _ = reply.send(result);
            }
            NetworkCommand::Shutdown => break,
        }
    }
}

fn normalize_stream_event(
    event: InvokeHarnessStreamOutput,
    tool_blocks: &mut BTreeMap<i32, (String, String, String)>,
    events: &SyncSender<NetworkEvent>,
    invocation_id: &str,
) {
    match event {
        InvokeHarnessStreamOutput::ContentBlockStart(value) => {
            if let Some(HarnessContentBlockStart::ToolUse(start)) = value.start() {
                tool_blocks.insert(
                    value.content_block_index(),
                    (
                        start.tool_use_id().to_owned(),
                        start.name().to_owned(),
                        String::new(),
                    ),
                );
            }
        }
        InvokeHarnessStreamOutput::ContentBlockDelta(value) => match value.delta() {
            Some(HarnessContentBlockDelta::Text(text)) => {
                let _ = events.send(NetworkEvent::new(
                    invocation_id,
                    NetworkEventKind::TextDelta(text.clone()),
                ));
            }
            Some(HarnessContentBlockDelta::ReasoningContent(_)) => {
                let _ = events.send(NetworkEvent::new(
                    invocation_id,
                    NetworkEventKind::ReasoningProgress,
                ));
            }
            Some(HarnessContentBlockDelta::ToolUse(delta)) => {
                if let Some((_, _, input)) = tool_blocks.get_mut(&value.content_block_index()) {
                    input.push_str(delta.input());
                }
            }
            _ => {}
        },
        InvokeHarnessStreamOutput::ContentBlockStop(value) => {
            if let Some((call_id, remote_name, input)) =
                tool_blocks.remove(&value.content_block_index())
            {
                let parsed = if input.trim().is_empty() {
                    Ok(json!({}))
                } else {
                    serde_json::from_str::<Value>(&input)
                };
                match parsed {
                    Ok(input) => {
                        let _ = events.send(NetworkEvent::new(
                            invocation_id,
                            NetworkEventKind::ToolUse {
                                call_id,
                                remote_name,
                                input,
                            },
                        ));
                    }
                    Err(_) => {
                        let _ = events.send(NetworkEvent::new(
                            invocation_id,
                            NetworkEventKind::Failure(
                                "AgentCore emitted malformed inline-tool JSON".to_owned(),
                            ),
                        ));
                    }
                }
            }
        }
        InvokeHarnessStreamOutput::Metadata(value) => {
            let usage = value.usage();
            let metrics = value.metrics();
            let _ = events.send(NetworkEvent::new(
                invocation_id,
                NetworkEventKind::Usage {
                    input_tokens: usage.map(|v| v.input_tokens() as i64).unwrap_or(0),
                    output_tokens: usage.map(|v| v.output_tokens() as i64).unwrap_or(0),
                    cache_read_input_tokens: usage
                        .and_then(|v| v.cache_read_input_tokens())
                        .unwrap_or(0) as i64,
                    cache_write_input_tokens: usage
                        .and_then(|v| v.cache_write_input_tokens())
                        .unwrap_or(0) as i64,
                    latency_ms: metrics.map(|v| v.latency_ms()).unwrap_or(0),
                },
            ));
        }
        InvokeHarnessStreamOutput::MessageStop(value) => {
            let _ = events.send(NetworkEvent::new(
                invocation_id,
                NetworkEventKind::Stop(value.stop_reason().as_str().to_owned()),
            ));
        }
        InvokeHarnessStreamOutput::MessageStart(_) => {}
        _ => {
            let _ = events.send(NetworkEvent::new(
                invocation_id,
                NetworkEventKind::Failure(
                    "AgentCore SDK did not recognize an EventStream record".to_owned(),
                ),
            ));
        }
    }
}

fn observe_memory_history_page(
    pages: &mut usize,
    events: &mut usize,
    page_events: usize,
    operation: &str,
) -> Result<(), String> {
    *pages = pages.saturating_add(1);
    *events = events.saturating_add(page_events);
    if *pages > MAX_MEMORY_HISTORY_PAGES {
        return Err(format!(
            "AgentCore Memory {operation} exceeded its page bound"
        ));
    }
    if *events > MAX_MEMORY_HISTORY_EVENTS {
        return Err(format!(
            "AgentCore Memory {operation} exceeded its event bound"
        ));
    }
    Ok(())
}

async fn purge_memory_event_ids<List, ListFuture, Delete, DeleteFuture>(
    mut list_first_page: List,
    mut delete: Delete,
) -> Result<(), String>
where
    List: FnMut() -> ListFuture,
    ListFuture: Future<Output = Result<Vec<String>, String>>,
    Delete: FnMut(String) -> DeleteFuture,
    DeleteFuture: Future<Output = Result<(), String>>,
{
    let mut pages = 0_usize;
    let mut event_count = 0_usize;
    let mut deleted_ids = HashSet::new();
    loop {
        let ids = list_first_page().await?;
        observe_memory_history_page(&mut pages, &mut event_count, ids.len(), "purge")?;
        if ids.is_empty() {
            return Ok(());
        }
        for event_id in ids {
            if !deleted_ids.insert(event_id.clone()) {
                return Err("AgentCore Memory purge made no progress after deletion".to_owned());
            }
            delete(event_id).await?;
        }
    }
}

async fn delete_all_memory_events(
    client: &aws_sdk_bedrockagentcore::Client,
    config: &AwsAgentCoreProviderConfig,
    session_id: &str,
    actor_id: &str,
) -> Result<(), String> {
    let list_client = client.clone();
    let list_memory_id = config.memory_id.clone();
    let list_session_id = session_id.to_owned();
    let list_actor_id = actor_id.to_owned();
    let delete_client = client.clone();
    let delete_memory_id = config.memory_id.clone();
    let delete_session_id = session_id.to_owned();
    let delete_actor_id = actor_id.to_owned();
    purge_memory_event_ids(
        move || {
            let client = list_client.clone();
            let memory_id = list_memory_id.clone();
            let session_id = list_session_id.clone();
            let actor_id = list_actor_id.clone();
            async move {
                client
                    .list_events()
                    .memory_id(memory_id)
                    .session_id(session_id)
                    .actor_id(actor_id)
                    .include_payloads(false)
                    .max_results(100)
                    .send()
                    .await
                    .map(|page| {
                        page.events()
                            .iter()
                            .map(|event| event.event_id().to_owned())
                            .collect()
                    })
                    .map_err(|error| redact_aws_error(&error.to_string()))
            }
        },
        move |event_id| {
            let client = delete_client.clone();
            let memory_id = delete_memory_id.clone();
            let session_id = delete_session_id.clone();
            let actor_id = delete_actor_id.clone();
            async move {
                match client
                    .delete_event()
                    .memory_id(memory_id)
                    .session_id(session_id)
                    .actor_id(actor_id)
                    .event_id(event_id)
                    .send()
                    .await
                {
                    Ok(_) => Ok(()),
                    Err(error) if is_resource_not_found(&error.to_string()) => Ok(()),
                    Err(error) => Err(redact_aws_error(&error.to_string())),
                }
            }
        },
    )
    .await
}

async fn latest_memory_event_id(
    client: &aws_sdk_bedrockagentcore::Client,
    config: &AwsAgentCoreProviderConfig,
    session_id: &str,
    actor_id: &str,
) -> Result<Option<String>, String> {
    let mut next_token: Option<String> = None;
    let mut latest: Option<(i64, String)> = None;
    let mut page_count = 0_usize;
    let mut event_count = 0_usize;
    loop {
        let page = client
            .list_events()
            .memory_id(config.memory_id.clone())
            .session_id(session_id)
            .actor_id(actor_id)
            .include_payloads(false)
            .max_results(100)
            .set_next_token(next_token.take())
            .send()
            .await
            .map_err(|error| redact_aws_error(&error.to_string()))?;
        observe_memory_history_page(
            &mut page_count,
            &mut event_count,
            page.events().len(),
            "history scan",
        )?;
        for event in page.events() {
            let candidate = (event.event_timestamp().secs(), event.event_id().to_owned());
            if latest.as_ref().is_none_or(|current| candidate > *current) {
                latest = Some(candidate);
            }
        }
        next_token = page.next_token().map(str::to_owned);
        if next_token.is_none() {
            break;
        }
    }
    Ok(latest.map(|(_, event_id)| event_id))
}

pub struct AwsAgentCoreHarnessProvider {
    config: AwsAgentCoreProviderConfig,
    session_id: String,
    actor_id: String,
    worker: NetworkWorker,
    tools: Vec<HarnessTool>,
    allowed_tools: Vec<String>,
    remote_to_canonical: BTreeMap<String, String>,
    input_schemas: BTreeMap<String, Value>,
    pending: BTreeMap<String, RemoteToolUse>,
    delivered_results: BTreeMap<String, ToolResult>,
    queue: VecDeque<ProviderEvent>,
    current_turn_id: Option<String>,
    current_text: String,
    invocation_counter: u64,
    active_invocation_id: Option<String>,
    durable_cursor: Option<String>,
    usage: Value,
    pending_stop_reason: Option<String>,
    invocation_usage_observed: bool,
    invocation_budget_reached: bool,
    max_estimated_cost_usd: f64,
}

impl AwsAgentCoreHarnessProvider {
    pub fn start(
        config: &AwsAgentCoreProviderConfig,
        tools: Vec<AuthorizedTool>,
        resume_session_id: Option<&str>,
        resume_event_cursor: Option<&str>,
        resume_usage: Option<&Value>,
    ) -> Result<Self, LocalRunnerError> {
        validate_config(config)?;
        let usage = restored_usage_snapshot(resume_usage)?;
        let session_id = resume_session_id
            .map(str::to_owned)
            .unwrap_or_else(new_runtime_session_id);
        let actor_id = format!("paperclip-{}", sha_hex(&session_id, 32));
        let worker = NetworkWorker::start(config.clone(), session_id.clone(), actor_id.clone())?;
        let (encoded, allowed, reverse, schemas) = encode_tools(&tools)?;
        Ok(Self {
            config: config.clone(),
            session_id,
            actor_id,
            worker,
            tools: encoded,
            allowed_tools: allowed,
            remote_to_canonical: reverse,
            input_schemas: schemas,
            pending: BTreeMap::new(),
            delivered_results: BTreeMap::new(),
            queue: VecDeque::new(),
            current_turn_id: None,
            current_text: String::new(),
            invocation_counter: 0,
            active_invocation_id: None,
            durable_cursor: resume_event_cursor.map(str::to_owned),
            usage,
            pending_stop_reason: None,
            invocation_usage_observed: false,
            invocation_budget_reached: false,
            max_estimated_cost_usd: config.max_estimated_session_cost_usd,
        })
    }

    fn invoke(&mut self, messages: Vec<HarnessMessage>) -> Result<Value, LocalRunnerError> {
        if self.pending_stop_reason.is_some() {
            return Err(LocalRunnerError::invalid(
                "AgentCore prior invocation has not reached its metadata boundary",
            ));
        }
        if self.active_invocation_id.is_some() {
            return Err(LocalRunnerError::invalid(
                "AgentCore prior invocation is still active",
            ));
        }
        self.require_reconciled_interrupt_usage()?;
        self.require_available_budget()?;
        self.invocation_counter = self.invocation_counter.saturating_add(1);
        self.invocation_usage_observed = false;
        self.invocation_budget_reached = false;
        // A runner restart cannot recover the in-memory counter from an
        // AgentCore Memory event id. Include fresh entropy so a resumed
        // session never aliases a prior invocation even when its durable
        // counter restarts from zero.
        let invocation_id = format!(
            "{}-{}-{}",
            self.session_id,
            self.invocation_counter,
            Uuid::new_v4()
        );
        self.durable_cursor = Some(invocation_id.clone());
        // Delivery can time out after AgentCore has accepted the invocation.
        // Retain its identity before crossing that ambiguity boundary so a
        // subsequent interrupt can reconcile (or durably fail closed on) the
        // matching authoritative usage metadata.
        self.active_invocation_id = Some(invocation_id.clone());
        self.worker.invoke(
            messages,
            self.tools.clone(),
            self.allowed_tools.clone(),
            invocation_id.clone(),
        )?;
        Ok(json!({ "runtimeSessionId": self.session_id, "invocationId": invocation_id }))
    }

    fn record_usage(
        &mut self,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_input_tokens: i64,
        cache_write_input_tokens: i64,
        latency_ms: i64,
        enforce_budget: bool,
    ) -> ProviderEvent {
        let prior_input = self
            .usage
            .get("inputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let prior_output = self
            .usage
            .get("outputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let prior_cache_read = self
            .usage
            .get("cacheReadInputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let prior_cache_write = self
            .usage
            .get("cacheWriteInputTokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let total_input = prior_input.saturating_add(input_tokens);
        let total_output = prior_output.saturating_add(output_tokens);
        let total_cache_read = prior_cache_read.saturating_add(cache_read_input_tokens);
        let total_cache_write = prior_cache_write.saturating_add(cache_write_input_tokens);
        let requests = self
            .usage
            .get("requestCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1);
        let model_estimate = estimate_model_token_cost_usd(
            &self.config.model,
            total_input,
            total_output,
            total_cache_read,
            total_cache_write,
        );
        let conservative_floor = self
            .usage
            .get(AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD)
            .and_then(Value::as_f64);
        let estimate = match (model_estimate, conservative_floor) {
            (Some(estimate), Some(floor)) => Some(estimate.max(floor)),
            (Some(estimate), None) => Some(estimate),
            (None, Some(floor)) => Some(floor),
            (None, None) => None,
        };
        let mut usage = json!({
            "inputTokens": total_input,
            "outputTokens": total_output,
            "cacheReadInputTokens": total_cache_read,
            "cacheWriteInputTokens": total_cache_write,
            "requestCount": requests,
            "latencyMs": latency_ms,
            "estimatedCostUsd": estimate,
            "estimateScope": "bedrock_model_tokens_only",
            "costSource": "paperclip_estimate",
            "estimatedCeilingUsd": self.max_estimated_cost_usd,
        });
        if let Some(floor) = conservative_floor {
            usage[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(floor);
            usage[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
                json!(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE);
            usage["tokenCountsLowerBound"] = json!(true);
        }
        self.usage = usage;
        if enforce_budget && estimate.is_some_and(|value| value >= self.max_estimated_cost_usd) {
            self.invocation_budget_reached = true;
            self.queue.push_back(ProviderEvent::Notification {
                method: "provider/budgetReached".to_owned(),
                params: json!({ "turnId": self.current_turn_id, "status": "limit_reached", "stopReason": "estimated_session_cost", "estimatedCostUsd": estimate, "costSource": "paperclip_estimate" }),
            });
        }
        ProviderEvent::Notification {
            method: "thread/tokenUsage/updated".to_owned(),
            params: self.usage.clone(),
        }
    }

    fn pending_usage_reconciliation_invocation_id(&self) -> Option<String> {
        (self
            .usage
            .get(AGENTCORE_USAGE_RECONCILIATION_FIELD)
            .and_then(Value::as_str)
            == Some(AGENTCORE_USAGE_RECONCILIATION_PENDING))
        .then(|| {
            self.usage
                .get(AGENTCORE_PENDING_INVOCATION_FIELD)
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten()
    }

    fn mark_usage_reconciliation_pending(&mut self, invocation_id: &str) {
        self.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_PENDING);
        self.usage[AGENTCORE_PENDING_INVOCATION_FIELD] = json!(invocation_id);
        self.usage[AGENTCORE_PENDING_CEILING_FIELD] = json!(self.max_estimated_cost_usd);
    }

    fn mark_usage_reconciliation_observed(&mut self) {
        self.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_OBSERVED);
        if let Some(usage) = self.usage.as_object_mut() {
            usage.remove(AGENTCORE_PENDING_INVOCATION_FIELD);
            usage.remove(AGENTCORE_PENDING_CEILING_FIELD);
        }
    }

    fn reconcile_pending_usage_to_ceiling(&mut self) {
        if self.pending_usage_reconciliation_invocation_id().is_none() {
            return;
        }
        let pending_ceiling = self
            .usage
            .get(AGENTCORE_PENDING_CEILING_FIELD)
            .and_then(Value::as_f64)
            // Snapshots from the brief fail-closed-only implementation did
            // not persist the ceiling. Charging the current ceiling is the
            // safe backward-compatible fallback.
            .unwrap_or(self.max_estimated_cost_usd);
        let existing_estimate = self
            .usage
            .get("estimatedCostUsd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let existing_floor = self
            .usage
            .get(AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD)
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let conservative_floor = pending_ceiling.max(existing_estimate).max(existing_floor);
        let request_count = self
            .usage
            .get("requestCount")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1);
        self.usage["requestCount"] = json!(request_count);
        self.usage["estimatedCostUsd"] = json!(conservative_floor);
        self.usage["estimatedCeilingUsd"] = json!(self.max_estimated_cost_usd);
        self.usage["estimateScope"] =
            json!("bedrock_model_tokens_with_interrupted_invocation_cost_floor");
        self.usage["tokenCountsLowerBound"] = json!(true);
        self.usage[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(conservative_floor);
        self.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE);
        if let Some(usage) = self.usage.as_object_mut() {
            usage.remove(AGENTCORE_PENDING_INVOCATION_FIELD);
            usage.remove(AGENTCORE_PENDING_CEILING_FIELD);
        }
    }

    fn require_reconciled_interrupt_usage(&self) -> Result<(), LocalRunnerError> {
        if self.pending_usage_reconciliation_invocation_id().is_some() {
            return Err(LocalRunnerError::invalid(
                "AgentCore usage reconciliation remains pending after an interrupted invocation",
            ));
        }
        Ok(())
    }

    fn require_available_budget(&self) -> Result<(), LocalRunnerError> {
        if self
            .usage
            .get("estimatedCostUsd")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            >= self.max_estimated_cost_usd
        {
            return Err(LocalRunnerError::invalid("AgentCore estimated session spend ceiling reached; raise it explicitly before continuing"));
        }
        Ok(())
    }

    fn reconcile_interrupted_usage(&mut self) {
        if self.invocation_usage_observed {
            return;
        }
        let Some(active_invocation_id) = self.active_invocation_id.clone() else {
            return;
        };
        let deadline = Instant::now() + AGENTCORE_INTERRUPT_USAGE_RECONCILIATION_TIMEOUT;
        for _ in 0..MAX_INTERRUPT_DRAIN_EVENTS {
            let Some(event) = self.worker.receive_event_until(deadline) else {
                break;
            };
            if event.invocation_id != active_invocation_id {
                continue;
            }
            if let NetworkEventKind::Usage {
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_write_input_tokens,
                latency_ms,
            } = event.kind
            {
                if !self.invocation_usage_observed {
                    self.record_usage(
                        input_tokens,
                        output_tokens,
                        cache_read_input_tokens,
                        cache_write_input_tokens,
                        latency_ms,
                        false,
                    );
                    self.invocation_usage_observed = true;
                    break;
                }
            }
        }
    }

    fn settle_interrupted_turn(&mut self, turn_id: &str, interrupted_invocation_id: Option<&str>) {
        let usage_observed = self.invocation_usage_observed;
        if usage_observed {
            self.mark_usage_reconciliation_observed();
        } else {
            if let Some(invocation_id) = interrupted_invocation_id {
                self.mark_usage_reconciliation_pending(invocation_id);
            }
        }
        self.active_invocation_id = None;
        self.pending_stop_reason = None;
        self.invocation_usage_observed = false;
        self.invocation_budget_reached = false;
        self.pending.clear();
        self.delivered_results.clear();
        self.queue.retain(|event| {
            !matches!(
                event,
                ProviderEvent::Notification { method, .. }
                    if method == "provider/budgetReached"
            )
        });

        self.queue.push_back(ProviderEvent::Notification {
            method: "thread/tokenUsage/updated".to_owned(),
            params: self.usage.clone(),
        });
        if !self.current_text.is_empty() {
            self.queue.push_back(ProviderEvent::Notification {
                method: "item/completed".to_owned(),
                params: json!({ "turnId": turn_id, "item": { "id": format!("aws-message-{}", self.invocation_counter), "type": "agentMessage", "text": self.current_text, "authoritative": true } }),
            });
        }
        self.current_text.clear();
        self.current_turn_id.take();
        self.queue.push_back(ProviderEvent::Notification {
            method: "turn/completed".to_owned(),
            params: json!({ "turnId": turn_id, "turn": { "id": turn_id, "status": "interrupted" }, "stopReason": "interrupted" }),
        });
    }
}

impl Provider for AwsAgentCoreHarnessProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::AwsAgentcore
    }

    fn runtime_identity(&self) -> ProviderRuntimeIdentity {
        ProviderRuntimeIdentity::RemoteService {
            service: "aws_bedrock_agentcore_harness".to_owned(),
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
        self.durable_cursor.as_deref()
    }

    fn model_request_count(&self) -> Option<u64> {
        self.usage.get("requestCount").and_then(Value::as_u64)
    }

    fn usage_snapshot(&self) -> Option<Value> {
        Some(self.usage.clone())
    }

    fn restore_active_turn(&mut self, turn_id: &str) -> Result<(), LocalRunnerError> {
        match self.current_turn_id.as_deref() {
            None => self.current_turn_id = Some(turn_id.to_owned()),
            Some(current) if current == turn_id => {}
            Some(_) => {
                return Err(LocalRunnerError::invalid(
                    "AgentCore active turn does not match durable recovery state",
                ))
            }
        }
        Ok(())
    }

    fn restore_pending_tool_call(
        &mut self,
        call_id: &str,
        operation_id: &str,
        input: &Value,
    ) -> Result<(), LocalRunnerError> {
        let remote_name = self
            .remote_to_canonical
            .iter()
            .find_map(|(remote, canonical)| (canonical == operation_id).then(|| remote.clone()))
            .ok_or_else(|| {
                LocalRunnerError::invalid(
                    "AgentCore durable tool call is not in the authorized tool catalog",
                )
            })?;
        let restored = RemoteToolUse {
            remote_name,
            operation_id: operation_id.to_owned(),
            input: input.clone(),
        };
        match self.pending.get(call_id) {
            Some(current)
                if current.operation_id != restored.operation_id
                    || current.input != restored.input =>
            {
                Err(LocalRunnerError::invalid(
                    "AgentCore pending tool call conflicts with durable recovery state",
                ))
            }
            _ => {
                self.pending.insert(call_id.to_owned(), restored);
                Ok(())
            }
        }
    }

    fn configure_tools(&mut self, tools: Vec<AuthorizedTool>) -> Result<(), LocalRunnerError> {
        if self.current_turn_id.is_some() {
            return Err(LocalRunnerError::invalid(
                "cannot replace AgentCore tools while a turn is active",
            ));
        }
        let (encoded, allowed, reverse, schemas) = encode_tools(&tools)?;
        self.tools = encoded;
        self.allowed_tools = allowed;
        self.remote_to_canonical = reverse;
        self.input_schemas = schemas;
        Ok(())
    }

    fn increase_budget(&mut self, value: f64) -> Result<Value, LocalRunnerError> {
        if !value.is_finite() || value <= self.max_estimated_cost_usd {
            return Err(LocalRunnerError::invalid(
                "AgentCore estimated spend ceiling may only be raised monotonically",
            ));
        }
        self.max_estimated_cost_usd = value;
        Ok(json!({ "maxEstimatedSessionCostUsd": value, "costSource": "paperclip_estimate" }))
    }

    fn destroy_session(&mut self) -> Result<(), LocalRunnerError> {
        self.worker.stop_runtime(format!(
            "paperclip-delete-{}",
            sha_hex(&self.session_id, 32)
        ))?;
        self.worker.delete_memory()?;
        self.worker.shutdown();
        Ok(())
    }

    fn preflight_turn(&mut self) -> Result<(), LocalRunnerError> {
        // Reconciliation is an idempotent next-turn boundary operation. It
        // never drains or publishes the prior EventStream after its terminal;
        // the durable cost floor is checkpointed before admission instead.
        self.reconcile_pending_usage_to_ceiling();
        self.require_reconciled_interrupt_usage()?;
        self.require_available_budget()
    }

    fn start_turn(
        &mut self,
        message: &str,
        _cwd: &str,
        turn_id: &str,
    ) -> Result<Value, LocalRunnerError> {
        if self.current_turn_id.is_some() {
            return Err(LocalRunnerError::invalid("AgentCore turn already active"));
        }
        self.preflight_turn()?;
        self.current_turn_id = Some(turn_id.to_owned());
        self.current_text.clear();
        self.queue.push_back(ProviderEvent::Notification {
            method: "turn/started".to_owned(),
            params: json!({ "turnId": turn_id, "turn": { "id": turn_id, "status": "inProgress" } }),
        });
        self.invoke(vec![user_text_message(message)?])
    }

    fn interrupt_turn(&mut self, turn_id: &str) -> Result<Value, LocalRunnerError> {
        if self.current_turn_id.as_deref() != Some(turn_id) {
            return Err(LocalRunnerError::invalid(
                "AgentCore interrupt does not match active turn",
            ));
        }
        self.worker.stop_runtime(format!(
            "paperclip-interrupt-{}",
            sha_hex(&(self.session_id.clone() + turn_id), 32)
        ))?;
        let interrupted_invocation_id = self.active_invocation_id.clone();
        self.reconcile_interrupted_usage();
        self.settle_interrupted_turn(turn_id, interrupted_invocation_id.as_deref());
        Ok(json!({ "runtimeSessionId": self.session_id, "stopped": true, "terminalQueued": true }))
    }

    fn read(&mut self) -> Result<Value, LocalRunnerError> {
        Ok(json!({
            "runtimeSessionId": self.session_id,
            "actorId": self.actor_id,
            "harnessArn": self.config.harness_arn,
            "harnessVersion": self.config.harness_version,
            "endpointArn": self.config.endpoint_arn,
            "usage": self.usage,
        }))
    }

    fn poll(&mut self) -> Result<Option<ProviderEvent>, LocalRunnerError> {
        if let Some(event) = self.queue.pop_front() {
            return Ok(Some(event));
        }
        let Some(event) = self.worker.try_event() else {
            return Ok(None);
        };
        let NetworkEvent {
            invocation_id,
            kind,
        } = event;
        if self.active_invocation_id.as_deref() != Some(invocation_id.as_str()) {
            // Once the interrupted terminal is queued, no record from its
            // truncated EventStream may escape after the durable terminal or
            // mutate accounting. A timed-out usage snapshot stays fail closed
            // for the lifetime of this remote session.
            return Ok(None);
        }
        match kind {
            NetworkEventKind::TextDelta(delta) => {
                self.current_text.push_str(&delta);
                Ok(Some(ProviderEvent::Notification {
                    method: "item/delta".to_owned(),
                    params: json!({ "turnId": self.current_turn_id, "itemId": format!("aws-message-{}", self.invocation_counter), "delta": delta, "authoritative": true }),
                }))
            }
            NetworkEventKind::ReasoningProgress => Ok(Some(ProviderEvent::Notification {
                method: "item/started".to_owned(),
                params: json!({ "turnId": self.current_turn_id, "item": { "id": format!("aws-progress-{}", self.invocation_counter), "type": "progress", "phase": "thinking" } }),
            })),
            NetworkEventKind::ToolUse {
                call_id,
                remote_name,
                input,
            } => {
                let operation_id = self
                    .remote_to_canonical
                    .get(&remote_name)
                    .ok_or_else(|| {
                        LocalRunnerError::invalid(
                            "AgentCore requested an unauthorized inline function",
                        )
                    })?
                    .clone();
                let schema = self.input_schemas.get(&operation_id).ok_or_else(|| {
                    LocalRunnerError::invalid("AgentCore tool has no durable input schema")
                })?;
                if !validator_for(schema)
                    .map_err(|_| {
                        LocalRunnerError::invalid(
                            "authorized Paperclip tool has invalid JSON Schema",
                        )
                    })?
                    .is_valid(&input)
                {
                    return Err(LocalRunnerError::invalid(
                        "AgentCore inline-function arguments failed schema validation",
                    ));
                }
                if let Some(previous) = self.pending.get(&call_id) {
                    if previous.operation_id != operation_id || previous.input != input {
                        return Err(LocalRunnerError::invalid(
                            "AgentCore reused a tool-use ID with conflicting content",
                        ));
                    }
                    return Ok(None);
                }
                self.pending.insert(
                    call_id.clone(),
                    RemoteToolUse {
                        remote_name,
                        operation_id: operation_id.clone(),
                        input: input.clone(),
                    },
                );
                Ok(Some(ProviderEvent::ToolCall {
                    call_id,
                    operation_id,
                    input,
                }))
            }
            NetworkEventKind::Usage {
                input_tokens,
                output_tokens,
                cache_read_input_tokens,
                cache_write_input_tokens,
                latency_ms,
            } => {
                self.invocation_usage_observed = true;
                Ok(Some(self.record_usage(
                    input_tokens,
                    output_tokens,
                    cache_read_input_tokens,
                    cache_write_input_tokens,
                    latency_ms,
                    true,
                )))
            }
            NetworkEventKind::Stop(reason) => {
                if self.pending_stop_reason.replace(reason).is_some() {
                    return Err(LocalRunnerError::invalid(
                        "AgentCore emitted more than one stop reason for an invocation",
                    ));
                }
                Ok(None)
            }
            NetworkEventKind::InvocationComplete => {
                self.active_invocation_id = None;
                let reason = self.pending_stop_reason.take().ok_or_else(|| {
                    LocalRunnerError::invalid(
                        "AgentCore invocation ended without an authoritative stop reason",
                    )
                })?;
                if !self.invocation_usage_observed {
                    return Err(LocalRunnerError::invalid(
                        "AgentCore invocation ended before usage metadata was observed",
                    ));
                }
                if self.invocation_budget_reached {
                    self.current_turn_id.take();
                    return Ok(None);
                }
                match reason.as_str() {
                    "tool_use" | "tool_result" | "partial_turn" => {
                        Ok(Some(ProviderEvent::Notification {
                            method: "provider/waitingForToolResult".to_owned(),
                            params: json!({ "turnId": self.current_turn_id, "runtimeSessionId": self.session_id }),
                        }))
                    }
                    "end_turn" | "stop_sequence" | "interrupted" => {
                        let turn_id = self.current_turn_id.take();
                        let status = if reason == "interrupted" {
                            "interrupted"
                        } else {
                            "completed"
                        };
                        if !self.current_text.is_empty() {
                            self.queue.push_back(ProviderEvent::Notification {
                            method: "item/completed".to_owned(),
                            params: json!({ "turnId": turn_id, "item": { "id": format!("aws-message-{}", self.invocation_counter), "type": "agentMessage", "text": self.current_text, "authoritative": true } }),
                        });
                        }
                        self.queue.push_back(ProviderEvent::Notification {
                        method: "turn/completed".to_owned(),
                        params: json!({ "turnId": turn_id, "turn": { "id": turn_id, "status": status }, "stopReason": reason }),
                    });
                        Ok(self.queue.pop_front())
                    }
                    "max_iterations_exceeded"
                    | "max_output_tokens_exceeded"
                    | "max_tokens"
                    | "timeout_exceeded"
                    | "model_context_window_exceeded" => Ok(Some(ProviderEvent::Notification {
                        method: "provider/budgetReached".to_owned(),
                        params: json!({ "turnId": self.current_turn_id, "status": "limit_reached", "stopReason": reason, "costSource": "paperclip_estimate" }),
                    })),
                    "content_filtered" => Err(LocalRunnerError::invalid(
                        "AgentCore model output was filtered",
                    )),
                    "malformed_model_output" | "malformed_tool_use" => Err(
                        LocalRunnerError::invalid("AgentCore returned malformed model output"),
                    ),
                    _ => Err(LocalRunnerError::invalid(
                        "AgentCore returned an unknown stop reason",
                    )),
                }
            }
            NetworkEventKind::MemoryCursor(event_id) => {
                self.durable_cursor = Some(event_id);
                Ok(None)
            }
            NetworkEventKind::Failure(detail) => {
                self.active_invocation_id = None;
                Err(LocalRunnerError::invalid(format!(
                    "AgentCore transport failed: {detail}"
                )))
            }
        }
    }

    fn deliver_tool_result(&mut self, result: &ToolResult) -> Result<(), LocalRunnerError> {
        let pending = self
            .pending
            .get(&result.call_id)
            .ok_or_else(|| {
                LocalRunnerError::invalid("AgentCore tool result does not match a pending tool use")
            })?
            .clone();
        if pending.operation_id != result.operation_id {
            return Err(LocalRunnerError::invalid(
                "AgentCore tool result operation does not match pending tool use",
            ));
        }
        if let Some(previous) = self.delivered_results.get(&result.call_id) {
            if previous != result {
                return Err(LocalRunnerError::invalid(
                    "AgentCore received conflicting results for one tool-use ID",
                ));
            }
            return Ok(());
        }
        self.delivered_results
            .insert(result.call_id.clone(), result.clone());
        if self.delivered_results.len() < self.pending.len() {
            return Ok(());
        }

        // AgentCore requires every toolUse from the assistant message and all
        // matching user toolResults in one continuation. This also guarantees
        // that parallel governed mutations cannot advance separate model turns.
        let mut assistant_builder =
            HarnessMessage::builder().role(HarnessConversationRole::Assistant);
        let mut user_builder = HarnessMessage::builder().role(HarnessConversationRole::User);
        for (call_id, pending) in &self.pending {
            let delivered = self.delivered_results.get(call_id).ok_or_else(|| {
                LocalRunnerError::invalid("AgentCore tool-result batch is incomplete")
            })?;
            let tool_use = HarnessToolUseBlock::builder()
                .name(pending.remote_name.clone())
                .tool_use_id(call_id.clone())
                .input(json_to_document(&pending.input)?)
                .r#type(HarnessToolUseType::ToolUse)
                .build()
                .map_err(|_| {
                    LocalRunnerError::invalid("failed to build AgentCore tool-use continuation")
                })?;
            let tool_result = HarnessToolResultBlock::builder()
                .tool_use_id(call_id.clone())
                // Although the AgentCore data-plane model advertises JSON
                // result blocks, the managed Harness runtime currently
                // rejects them with `content_type=<json_> | unsupported type`.
                // Preserve the complete structured result as compact JSON in
                // the supported text variant.
                .content(encode_tool_result_content(&delivered.result)?)
                .status(if delivered.is_error {
                    HarnessToolUseStatus::Error
                } else {
                    HarnessToolUseStatus::Success
                })
                .r#type(HarnessToolUseType::ToolUse)
                .build()
                .map_err(|_| {
                    LocalRunnerError::invalid("failed to build AgentCore tool-result continuation")
                })?;
            assistant_builder = assistant_builder.content(HarnessContentBlock::ToolUse(tool_use));
            user_builder = user_builder.content(HarnessContentBlock::ToolResult(tool_result));
        }
        let assistant = assistant_builder.build().map_err(|_| {
            LocalRunnerError::invalid("failed to build AgentCore assistant continuation")
        })?;
        let user = user_builder.build().map_err(|_| {
            LocalRunnerError::invalid("failed to build AgentCore user continuation")
        })?;
        // The durable runner records ToolResult before calling this method. A
        // transport ambiguity therefore never repeats the Paperclip mutation;
        // it fails closed with the last authoritative Memory cursor preserved
        // for the control plane's reconciliation workflow.
        self.invoke(vec![assistant, user])?;
        self.pending.clear();
        self.delivered_results.clear();
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), LocalRunnerError> {
        self.worker.stop_runtime(format!(
            "paperclip-suspend-{}",
            sha_hex(&self.session_id, 32)
        ))?;
        self.worker.shutdown();
        Ok(())
    }
}

fn user_text_message(message: &str) -> Result<HarnessMessage, LocalRunnerError> {
    HarnessMessage::builder()
        .role(HarnessConversationRole::User)
        .content(HarnessContentBlock::Text(message.to_owned()))
        .build()
        .map_err(|_| LocalRunnerError::invalid("failed to build AgentCore user message"))
}

fn validate_config(config: &AwsAgentCoreProviderConfig) -> Result<(), LocalRunnerError> {
    if [
        config.model.as_str(),
        config.profile_id.as_str(),
        config.region.as_str(),
        config.account_id.as_str(),
        config.harness_arn.as_str(),
        config.harness_version.as_str(),
        config.endpoint_arn.as_str(),
        config.endpoint_qualifier.as_str(),
        config.agent_runtime_arn.as_str(),
        config.memory_arn.as_str(),
        config.memory_id.as_str(),
        config.invocation_role_arn.as_str(),
        config.context_bucket.as_str(),
        config.context_prefix.as_str(),
        config.context_kms_key_arn.as_str(),
        config.qualification_revision.as_str(),
        config.instructions.as_str(),
    ]
    .iter()
    .any(|value| value.trim().is_empty())
    {
        return Err(LocalRunnerError::invalid(
            "AgentCore profile fields must be non-empty",
        ));
    }
    if config.context_prefix.starts_with('/')
        || config
            .context_prefix
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || !config.context_kms_key_arn.starts_with("arn:aws:kms:")
    {
        return Err(LocalRunnerError::invalid(
            "AgentCore context S3 qualification is unsafe",
        ));
    }
    if config.event_expiry_days != 90 {
        return Err(LocalRunnerError::invalid(
            "AgentCore profile must use the qualified 90-day Memory expiry",
        ));
    }
    if config.max_iterations == 0
        || config.max_iterations > 8
        || config.max_output_tokens == 0
        || config.max_output_tokens > 4096
        || config.timeout_seconds == 0
        || config.timeout_seconds > 300
    {
        return Err(LocalRunnerError::invalid(
            "AgentCore invocation limits exceed the qualified profile",
        ));
    }
    if !config.max_estimated_session_cost_usd.is_finite()
        || config.max_estimated_session_cost_usd <= 0.0
    {
        return Err(LocalRunnerError::invalid(
            "AgentCore estimated spend ceiling must be positive",
        ));
    }
    Ok(())
}

fn encode_tools(
    tools: &[AuthorizedTool],
) -> Result<
    (
        Vec<HarnessTool>,
        Vec<String>,
        BTreeMap<String, String>,
        BTreeMap<String, Value>,
    ),
    LocalRunnerError,
> {
    if tools.len() > MAX_AGENTCORE_TOOLS {
        return Err(LocalRunnerError::invalid(
            "AgentCore supports at most 64 inline functions",
        ));
    }
    let mut encoded = Vec::with_capacity(tools.len());
    let mut allowed = Vec::with_capacity(tools.len());
    let mut reverse = BTreeMap::new();
    let mut schemas = BTreeMap::new();
    for tool in tools {
        validator_for(&tool.input_schema).map_err(|_| {
            LocalRunnerError::invalid("authorized Paperclip tool has invalid JSON Schema")
        })?;
        let remote_name = remote_tool_name(&tool.operation_id);
        if reverse
            .insert(remote_name.clone(), tool.operation_id.clone())
            .is_some()
        {
            return Err(LocalRunnerError::invalid(
                "AgentCore inline-function name collision",
            ));
        }
        schemas.insert(tool.operation_id.clone(), tool.input_schema.clone());
        let inline = HarnessInlineFunctionConfig::builder()
            .description(tool.description.clone())
            .input_schema(json_to_document(&tool.input_schema)?)
            .build()
            .map_err(|_| LocalRunnerError::invalid("failed to build AgentCore inline function"))?;
        let harness_tool = HarnessTool::builder()
            .r#type(HarnessToolType::InlineFunction)
            .name(remote_name.clone())
            .config(HarnessToolConfiguration::InlineFunction(inline))
            .build()
            .map_err(|_| LocalRunnerError::invalid("failed to build AgentCore tool"))?;
        allowed.push(format!("@*/{remote_name}"));
        encoded.push(harness_tool);
    }
    Ok((encoded, allowed, reverse, schemas))
}

fn remote_tool_name(operation_id: &str) -> String {
    let mut slug = operation_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    while slug.contains("__") {
        slug = slug.replace("__", "_");
    }
    slug = slug.trim_matches('_').to_owned();
    if slug.is_empty() {
        slug = "paperclip_tool".to_owned();
    }
    slug.truncate(48);
    format!("pc_{}_{}", slug, sha_hex(operation_id, 12))
}

fn new_runtime_session_id() -> String {
    format!("paperclip-{}-{}", Uuid::new_v4(), Uuid::new_v4())
}

fn estimate_model_token_cost_usd(
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_input_tokens: i64,
    cache_write_input_tokens: i64,
) -> Option<f64> {
    if model != "global.anthropic.claude-sonnet-4-6" {
        return None;
    }
    // Qualified 2026-08-21 Bedrock global standard-tier rates per million
    // tokens. Runtime, Memory, CloudWatch, network, and tax are deliberately
    // excluded and the receipt names that scope explicitly.
    Some(
        input_tokens.max(0) as f64 * 3.00 / 1_000_000.0
            + output_tokens.max(0) as f64 * 15.00 / 1_000_000.0
            + cache_read_input_tokens.max(0) as f64 * 0.30 / 1_000_000.0
            + cache_write_input_tokens.max(0) as f64 * 3.75 / 1_000_000.0,
    )
}

fn sha_hex(value: &str, length: usize) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    digest[..length.min(digest.len())].to_owned()
}

fn redact_aws_error(value: &str) -> String {
    // Smithy errors can embed a serialized request and signed headers. Retain
    // only a closed, useful classification; never attempt field-by-field
    // scrubbing of an open-ended provider error object.
    let lower = value.to_ascii_lowercase();
    if lower.contains("accessdenied")
        || lower.contains("access denied")
        || lower.contains("unauthorized")
    {
        "AWS AgentCore access denied".to_owned()
    } else if lower.contains("resourcenotfound") || lower.contains("not found") {
        "AWS AgentCore resource not found".to_owned()
    } else if lower.contains("throttl") || lower.contains("too many requests") {
        "AWS AgentCore request throttled".to_owned()
    } else if lower.contains("conflict") {
        "AWS AgentCore resource conflict".to_owned()
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "AWS AgentCore request timed out".to_owned()
    } else if lower.contains("validation") {
        "AWS AgentCore request validation failed".to_owned()
    } else {
        "AWS AgentCore request failed".to_owned()
    }
}

fn classify_aws_error_code(code: &str) -> String {
    match code {
        "AccessDeniedException" | "UnauthorizedException" => {
            "AWS AgentCore access denied".to_owned()
        }
        "ResourceNotFoundException" => "AWS AgentCore resource not found".to_owned(),
        "ThrottlingException" | "TooManyRequestsException" => {
            "AWS AgentCore request throttled".to_owned()
        }
        "ConflictException" => "AWS AgentCore resource conflict".to_owned(),
        "RequestTimeoutException" | "TimeoutException" => {
            "AWS AgentCore request timed out".to_owned()
        }
        "ValidationException" => "AWS AgentCore request validation failed".to_owned(),
        "ServiceUnavailableException" | "InternalServerException" => {
            "AWS AgentCore service unavailable".to_owned()
        }
        _ => "AWS AgentCore request failed".to_owned(),
    }
}

fn classify_aws_sdk_error<E, R>(error: &SdkError<E, R>) -> String
where
    E: ProvideErrorMetadata,
{
    if let Some(code) = error
        .as_service_error()
        .and_then(ProvideErrorMetadata::code)
    {
        return classify_aws_error_code(code);
    }
    match error {
        SdkError::ConstructionFailure(_) => "AWS AgentCore request construction failed".to_owned(),
        SdkError::TimeoutError(_) => "AWS AgentCore request timed out".to_owned(),
        SdkError::DispatchFailure(context) if context.is_timeout() => {
            "AWS AgentCore request dispatch timed out".to_owned()
        }
        SdkError::DispatchFailure(context) if context.is_io() => {
            "AWS AgentCore request network I/O failed".to_owned()
        }
        SdkError::DispatchFailure(context) if context.is_user() => {
            "AWS AgentCore request was rejected before dispatch".to_owned()
        }
        SdkError::DispatchFailure(_) => {
            "AWS AgentCore credential or transport setup failed".to_owned()
        }
        SdkError::ResponseError(_) => "AWS AgentCore response decoding failed".to_owned(),
        SdkError::ServiceError(_) => redact_aws_error(&error.to_string()),
        _ => "AWS AgentCore request failed".to_owned(),
    }
}

fn is_resource_not_found(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("resourcenotfound")
        || lower.contains("not found")
        || lower.contains("status code: 404")
}

fn json_to_document(value: &Value) -> Result<Document, LocalRunnerError> {
    Ok(match value {
        Value::Null => Document::Null,
        Value::Bool(value) => Document::Bool(*value),
        Value::String(value) => Document::String(value.clone()),
        Value::Array(values) => Document::Array(
            values
                .iter()
                .map(json_to_document)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        Value::Object(values) => Document::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), json_to_document(value)?)))
                .collect::<Result<HashMap<_, _>, LocalRunnerError>>()?,
        ),
        Value::Number(value) => {
            if let Some(value) = value.as_u64() {
                Document::Number(Number::PosInt(value))
            } else if let Some(value) = value.as_i64() {
                Document::Number(Number::NegInt(value))
            } else if let Some(value) = value.as_f64() {
                Document::Number(Number::Float(value))
            } else {
                return Err(LocalRunnerError::invalid(
                    "JSON number cannot be represented in AgentCore",
                ));
            }
        }
    })
}

fn encode_tool_result_content(
    value: &Value,
) -> Result<HarnessToolResultContentBlock, LocalRunnerError> {
    serde_json::to_string(value)
        .map(HarnessToolResultContentBlock::Text)
        .map_err(|_| LocalRunnerError::invalid("failed to serialize AgentCore tool result"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_bedrockagentcore::types::{
        HarnessContentBlockDeltaEvent, HarnessContentBlockStartEvent, HarnessContentBlockStopEvent,
        HarnessToolUseBlockDelta, HarnessToolUseBlockStart,
    };
    use std::sync::{Arc, Mutex};

    fn config() -> AwsAgentCoreProviderConfig {
        AwsAgentCoreProviderConfig {
            model: "global.anthropic.claude-sonnet-4-6".to_owned(),
            profile_id: "profile-test".to_owned(),
            region: "us-east-1".to_owned(),
            account_id: "123456789012".to_owned(),
            harness_arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/test".to_owned(),
            harness_version: "1".to_owned(),
            endpoint_arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:endpoint/test"
                .to_owned(),
            endpoint_qualifier: "1".to_owned(),
            agent_runtime_arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test"
                .to_owned(),
            memory_arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test".to_owned(),
            memory_id: "memory-test".to_owned(),
            invocation_role_arn: "arn:aws:iam::123456789012:role/paperclip-agentcore".to_owned(),
            context_bucket: "paperclip-context-test".to_owned(),
            context_prefix: "companies/company-test/profiles/profile-test".to_owned(),
            context_kms_key_arn: "arn:aws:kms:us-east-1:123456789012:key/test".to_owned(),
            qualification_revision: "aws-agentcore-harness-v1".to_owned(),
            event_expiry_days: 90,
            max_estimated_session_cost_usd: 1.0,
            max_iterations: 8,
            max_output_tokens: 4096,
            timeout_seconds: 300,
            instructions: "Paperclip test instructions".to_owned(),
            runtime_context: None,
        }
    }

    fn invocation_event(kind: NetworkEventKind) -> NetworkEvent {
        NetworkEvent::new("invocation-1", kind)
    }

    #[test]
    fn stop_runtime_targets_the_runtime_arn_and_endpoint_qualifier() {
        let config = config();
        let (runtime_arn, qualifier) = stop_runtime_target(&config);
        assert_eq!(runtime_arn, config.agent_runtime_arn);
        assert_ne!(runtime_arn, config.harness_arn);
        assert_eq!(qualifier, config.endpoint_qualifier);
    }

    fn provider_with_events(
        events: Vec<NetworkEvent>,
        usage: Value,
    ) -> AwsAgentCoreHarnessProvider {
        let (commands, command_rx) = mpsc::sync_channel(1);
        drop(command_rx);
        let (event_tx, event_rx) = mpsc::sync_channel(events.len().max(1));
        for event in events {
            event_tx.send(event).unwrap();
        }
        drop(event_tx);
        provider_with_worker(
            NetworkWorker {
                commands,
                events: event_rx,
                join: None,
            },
            usage,
        )
    }

    fn provider_with_interrupt_stream(
        interrupt_events: Vec<NetworkEvent>,
        events_before_stop_reply: bool,
        usage: Value,
    ) -> AwsAgentCoreHarnessProvider {
        provider_with_delayed_interrupt_stream(
            interrupt_events,
            events_before_stop_reply,
            Duration::from_millis(10),
            usage,
        )
    }

    fn provider_with_delayed_interrupt_stream(
        interrupt_events: Vec<NetworkEvent>,
        events_before_stop_reply: bool,
        post_stop_delay: Duration,
        usage: Value,
    ) -> AwsAgentCoreHarnessProvider {
        let (commands, command_rx) = mpsc::sync_channel(4);
        let (event_tx, event_rx) = mpsc::sync_channel(interrupt_events.len().max(1));
        let join = thread::spawn(move || {
            while let Ok(command) = command_rx.recv() {
                match command {
                    NetworkCommand::StopRuntime { reply, .. } => {
                        if events_before_stop_reply {
                            for event in &interrupt_events {
                                event_tx.send(event.clone()).unwrap();
                            }
                        }
                        reply.send(Ok(())).unwrap();
                        if !events_before_stop_reply {
                            thread::sleep(post_stop_delay);
                            for event in &interrupt_events {
                                event_tx.send(event.clone()).unwrap();
                            }
                        }
                    }
                    NetworkCommand::Shutdown => break,
                    NetworkCommand::Invoke { reply, .. } => {
                        reply
                            .send(Err("unexpected test invocation".to_owned()))
                            .unwrap();
                    }
                    NetworkCommand::DeleteMemory { reply } => {
                        reply
                            .send(Err("unexpected test deletion".to_owned()))
                            .unwrap();
                    }
                }
            }
        });
        provider_with_worker(
            NetworkWorker {
                commands,
                events: event_rx,
                join: Some(join),
            },
            usage,
        )
    }

    fn provider_with_worker(worker: NetworkWorker, usage: Value) -> AwsAgentCoreHarnessProvider {
        AwsAgentCoreHarnessProvider {
            config: config(),
            session_id: "paperclip-test-session".to_owned(),
            actor_id: "paperclip-test-actor".to_owned(),
            worker,
            tools: Vec::new(),
            allowed_tools: Vec::new(),
            remote_to_canonical: BTreeMap::new(),
            input_schemas: BTreeMap::new(),
            pending: BTreeMap::new(),
            delivered_results: BTreeMap::new(),
            queue: VecDeque::new(),
            current_turn_id: Some("turn-1".to_owned()),
            current_text: String::new(),
            invocation_counter: 1,
            active_invocation_id: Some("invocation-1".to_owned()),
            durable_cursor: None,
            usage,
            pending_stop_reason: None,
            invocation_usage_observed: false,
            invocation_budget_reached: false,
            max_estimated_cost_usd: 1.0,
        }
    }

    #[test]
    fn runtime_session_ids_are_valid_and_unique() {
        let first = new_runtime_session_id();
        let second = new_runtime_session_id();
        assert!(first.len() >= 33);
        assert_ne!(first, second);
    }

    #[test]
    fn durable_usage_restore_preserves_accumulated_spend_and_tokens() {
        let usage = json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": 0.73,
            "costSource": "paperclip_estimate",
            "estimateScope": "bedrock_model_tokens_only"
        });
        assert_eq!(restored_usage_snapshot(Some(&usage)).unwrap(), usage);
        let mut conservative = usage.clone();
        conservative[AGENTCORE_USAGE_RECONCILIATION_FIELD] =
            json!(AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE);
        conservative[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD] = json!(0.73);
        assert_eq!(
            restored_usage_snapshot(Some(&conservative)).unwrap(),
            conservative
        );
    }

    #[test]
    fn durable_usage_restore_rejects_missing_or_untrusted_spend_state() {
        assert!(restored_usage_snapshot(Some(&json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": -1.0,
            "costSource": "paperclip_estimate"
        })))
        .is_err());
        assert!(restored_usage_snapshot(Some(&json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": 0.73,
            "costSource": "paperclip_estimate",
            "pendingEstimatedCeilingUsd": 1.0
        })))
        .is_err());
        assert!(restored_usage_snapshot(Some(&json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": 0.73,
            "costSource": "paperclip_estimate",
            "usageReconciliation": AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE,
            "conservativeCostFloorUsd": 0.74
        })))
        .is_err());
        assert!(restored_usage_snapshot(Some(&json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": 0.73,
            "costSource": "provider_claim"
        })))
        .is_err());
        assert!(restored_usage_snapshot(Some(&json!({
            "inputTokens": 123,
            "outputTokens": 45,
            "cacheReadInputTokens": 67,
            "cacheWriteInputTokens": 8,
            "requestCount": 4,
            "estimatedCostUsd": 0.73,
            "costSource": "paperclip_estimate",
            "usageReconciliation": "unexpected_state",
            "pendingInvocationId": "invocation-1"
        })))
        .is_err());
    }

    #[test]
    fn stop_waits_for_usage_metadata_before_emitting_turn_terminal() {
        let mut provider = provider_with_events(
            vec![
                invocation_event(NetworkEventKind::Stop("end_turn".to_owned())),
                invocation_event(NetworkEventKind::Usage {
                    input_tokens: 3_000,
                    output_tokens: 0,
                    cache_read_input_tokens: 4_000,
                    cache_write_input_tokens: 1_000,
                    latency_ms: 12,
                }),
                invocation_event(NetworkEventKind::InvocationComplete),
            ],
            restored_usage_snapshot(None).unwrap(),
        );
        assert!(provider.poll().unwrap().is_none());
        let usage = provider.poll().unwrap().unwrap();
        assert!(matches!(
            usage,
            ProviderEvent::Notification { ref method, .. }
                if method == "thread/tokenUsage/updated"
        ));
        assert_eq!(provider.usage["requestCount"], 1);
        assert!(
            (provider.usage["estimatedCostUsd"].as_f64().unwrap() - 0.01395).abs() < 0.000_000_001
        );
        let terminal = provider.poll().unwrap().unwrap();
        assert!(matches!(
            terminal,
            ProviderEvent::Notification { ref method, .. } if method == "turn/completed"
        ));
    }

    #[test]
    fn mid_stream_interrupt_waits_for_late_usage_and_suppresses_truncated_completion() {
        let late_usage = NetworkEventKind::Usage {
            input_tokens: 2_000,
            output_tokens: 100,
            cache_read_input_tokens: 500,
            cache_write_input_tokens: 0,
            latency_ms: 25,
        };
        let mut provider = provider_with_interrupt_stream(
            vec![
                invocation_event(NetworkEventKind::TextDelta(
                    "must not escape after stop".to_owned(),
                )),
                invocation_event(late_usage.clone()),
                invocation_event(late_usage),
                invocation_event(NetworkEventKind::Stop("end_turn".to_owned())),
                invocation_event(NetworkEventKind::Failure(
                    "expected truncated event stream".to_owned(),
                )),
                invocation_event(NetworkEventKind::InvocationComplete),
            ],
            false,
            restored_usage_snapshot(None).unwrap(),
        );

        let response = provider.interrupt_turn("turn-1").unwrap();
        assert_eq!(response["terminalQueued"], true);
        assert!(provider.current_turn_id.is_none());

        let snapshot = provider.poll().unwrap().unwrap();
        match snapshot {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "thread/tokenUsage/updated");
                assert_eq!(params["requestCount"], 1);
                assert_eq!(params["inputTokens"], 2_000);
                assert_eq!(
                    params["usageReconciliation"],
                    "authoritative_metadata_observed"
                );
            }
            other => panic!("unexpected interrupted usage snapshot: {other:?}"),
        }
        let terminal = provider.poll().unwrap().unwrap();
        match terminal {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "turn/completed");
                assert_eq!(params.pointer("/turn/status"), Some(&json!("interrupted")));
                assert_eq!(params["stopReason"], "interrupted");
            }
            other => panic!("unexpected interrupted terminal: {other:?}"),
        }

        thread::sleep(Duration::from_millis(20));
        let mut late_usage_updates = 0;
        let mut extra_terminals = 0;
        for _ in 0..10 {
            match provider.poll().unwrap() {
                Some(ProviderEvent::Notification { method, .. })
                    if method == "thread/tokenUsage/updated" =>
                {
                    late_usage_updates += 1;
                }
                Some(ProviderEvent::Notification { method, .. }) if method == "turn/completed" => {
                    extra_terminals += 1;
                }
                Some(_) | None => {}
            }
        }
        assert_eq!(late_usage_updates, 0);
        assert_eq!(extra_terminals, 0);
        assert_eq!(provider.usage["requestCount"], 1);
        assert_eq!(provider.usage["inputTokens"], 2_000);
        assert!(provider.current_text.is_empty());
    }

    #[test]
    fn interrupt_usage_timeout_is_durably_charged_before_next_turn_admission() {
        let mut provider = provider_with_interrupt_stream(
            Vec::new(),
            false,
            restored_usage_snapshot(None).unwrap(),
        );

        provider.interrupt_turn("turn-1").unwrap();
        let snapshot = provider.usage_snapshot().unwrap();
        assert_eq!(
            snapshot[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_PENDING
        );
        assert_eq!(snapshot[AGENTCORE_PENDING_INVOCATION_FIELD], "invocation-1");
        assert_eq!(snapshot[AGENTCORE_PENDING_CEILING_FIELD], 1.0);
        assert_eq!(restored_usage_snapshot(Some(&snapshot)).unwrap(), snapshot);

        match provider.poll().unwrap().unwrap() {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "thread/tokenUsage/updated");
                assert_eq!(params, snapshot);
            }
            other => panic!("unexpected pending usage snapshot: {other:?}"),
        }
        assert!(matches!(
            provider.poll().unwrap().unwrap(),
            ProviderEvent::Notification { ref method, .. } if method == "turn/completed"
        ));

        let error = provider.preflight_turn().unwrap_err();
        assert!(error
            .to_string()
            .contains("estimated session spend ceiling reached"));
        assert!(provider.active_invocation_id.is_none());
        assert!(provider.current_turn_id.is_none());
        assert_eq!(provider.usage["requestCount"], 1);
        assert_eq!(provider.usage["estimatedCostUsd"], 1.0);
        assert_eq!(provider.usage[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD], 1.0);
        assert_eq!(
            provider.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE
        );
        assert!(provider
            .usage
            .get(AGENTCORE_PENDING_INVOCATION_FIELD)
            .is_none());
        assert!(provider.poll().unwrap().is_none());
        let settled = provider.usage_snapshot().unwrap();
        assert_eq!(restored_usage_snapshot(Some(&settled)).unwrap(), settled);

        assert!(provider.preflight_turn().is_err());
        assert_eq!(provider.usage["requestCount"], 1);

        provider.increase_budget(2.0).unwrap();
        provider.preflight_turn().unwrap();
        assert_eq!(provider.usage["estimatedCostUsd"], 1.0);
        provider.record_usage(10, 5, 0, 0, 3, true);
        assert_eq!(provider.usage["requestCount"], 2);
        assert_eq!(provider.usage["estimatedCostUsd"], 1.0);
        assert_eq!(provider.usage[AGENTCORE_CONSERVATIVE_COST_FLOOR_FIELD], 1.0);

        let mut recovered = provider_with_events(Vec::new(), snapshot);
        recovered.active_invocation_id = None;
        recovered.current_turn_id = None;
        let error = recovered.preflight_turn().unwrap_err();
        assert!(error
            .to_string()
            .contains("estimated session spend ceiling reached"));
        assert_eq!(recovered.usage["requestCount"], 1);
        assert_eq!(recovered.usage["estimatedCostUsd"], 1.0);
        recovered.increase_budget(2.0).unwrap();
        recovered.preflight_turn().unwrap();
    }

    #[test]
    fn ambiguous_invoke_delivery_retains_identity_for_interrupt_reconciliation() {
        let mut provider = provider_with_interrupt_stream(
            Vec::new(),
            false,
            restored_usage_snapshot(None).unwrap(),
        );
        provider.current_turn_id = None;
        provider.active_invocation_id = None;

        let error = provider
            .start_turn("ambiguous delivery", "", "turn-ambiguous")
            .unwrap_err();
        assert!(error.to_string().contains("unexpected test invocation"));
        let ambiguous_invocation_id = provider
            .active_invocation_id
            .clone()
            .expect("ambiguous invocation identity is retained");
        assert_eq!(
            provider.durable_cursor.as_deref(),
            Some(ambiguous_invocation_id.as_str())
        );

        provider.interrupt_turn("turn-ambiguous").unwrap();
        let snapshot = provider.usage_snapshot().unwrap();
        assert_eq!(
            snapshot[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_PENDING
        );
        assert_eq!(
            snapshot[AGENTCORE_PENDING_INVOCATION_FIELD],
            ambiguous_invocation_id
        );

        let restored = restored_usage_snapshot(Some(&snapshot)).unwrap();
        let mut recovered = provider_with_events(Vec::new(), restored);
        recovered.active_invocation_id = None;
        recovered.current_turn_id = None;
        let error = recovered.preflight_turn().unwrap_err();
        assert!(error
            .to_string()
            .contains("estimated session spend ceiling reached"));
        assert_eq!(
            recovered.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE
        );
        assert_eq!(recovered.usage["requestCount"], 1);
    }

    #[test]
    fn late_usage_is_suppressed_then_next_turn_boundary_charges_the_ceiling() {
        let mut provider = provider_with_delayed_interrupt_stream(
            vec![
                invocation_event(NetworkEventKind::Usage {
                    input_tokens: 900,
                    output_tokens: 90,
                    cache_read_input_tokens: 30,
                    cache_write_input_tokens: 10,
                    latency_ms: 14,
                }),
                invocation_event(NetworkEventKind::InvocationComplete),
            ],
            false,
            Duration::from_millis(150),
            restored_usage_snapshot(None).unwrap(),
        );

        provider.interrupt_turn("turn-1").unwrap();
        let pending_snapshot = provider.usage_snapshot().unwrap();
        assert_eq!(
            pending_snapshot[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_PENDING
        );
        assert!(matches!(
            provider.poll().unwrap().unwrap(),
            ProviderEvent::Notification { ref method, .. }
                if method == "thread/tokenUsage/updated"
        ));
        assert!(matches!(
            provider.poll().unwrap().unwrap(),
            ProviderEvent::Notification { ref method, .. } if method == "turn/completed"
        ));

        thread::sleep(Duration::from_millis(125));
        assert!(provider.poll().unwrap().is_none());
        assert!(provider.poll().unwrap().is_none());
        assert_eq!(provider.usage, pending_snapshot);
        assert_eq!(provider.usage["requestCount"], 0);
        assert_eq!(provider.usage["inputTokens"], 0);

        let error = provider.preflight_turn().unwrap_err();
        assert!(error
            .to_string()
            .contains("estimated session spend ceiling reached"));
        assert_eq!(provider.usage["requestCount"], 1);
        assert_eq!(provider.usage["estimatedCostUsd"], 1.0);
        assert_eq!(
            provider.usage[AGENTCORE_USAGE_RECONCILIATION_FIELD],
            AGENTCORE_USAGE_RECONCILIATION_CONSERVATIVE
        );
        assert!(provider.poll().unwrap().is_none());
        let restored = restored_usage_snapshot(Some(&pending_snapshot)).unwrap();
        let mut recovered = provider_with_events(Vec::new(), restored);
        recovered.active_invocation_id = None;
        recovered.current_turn_id = None;
        assert!(recovered.preflight_turn().is_err());
        assert_eq!(recovered.usage["requestCount"], 1);
        assert_eq!(recovered.usage["estimatedCostUsd"], 1.0);
    }

    #[test]
    fn interrupted_usage_metadata_is_reconciled_at_most_once() {
        let usage = NetworkEventKind::Usage {
            input_tokens: 400,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_write_input_tokens: 10,
            latency_ms: 8,
        };
        let mut provider = provider_with_interrupt_stream(
            vec![
                invocation_event(usage.clone()),
                invocation_event(NetworkEventKind::InvocationComplete),
            ],
            false,
            restored_usage_snapshot(None).unwrap(),
        );
        provider.record_usage(400, 50, 20, 10, 8, true);
        provider.invocation_usage_observed = true;

        provider.interrupt_turn("turn-1").unwrap();
        let snapshot = provider.poll().unwrap().unwrap();
        match snapshot {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "thread/tokenUsage/updated");
                assert_eq!(params["requestCount"], 1);
                assert_eq!(
                    params["usageReconciliation"],
                    "authoritative_metadata_observed"
                );
            }
            other => panic!("unexpected interrupted usage snapshot: {other:?}"),
        }
        assert!(matches!(
            provider.poll().unwrap().unwrap(),
            ProviderEvent::Notification { ref method, .. } if method == "turn/completed"
        ));

        thread::sleep(Duration::from_millis(20));
        let mut late_usage_updates = 0;
        for _ in 0..4 {
            match provider.poll().unwrap() {
                Some(ProviderEvent::Notification { method, .. })
                    if method == "thread/tokenUsage/updated" =>
                {
                    late_usage_updates += 1;
                }
                Some(_) | None => {}
            }
        }
        assert_eq!(late_usage_updates, 0);
        assert_eq!(provider.usage["requestCount"], 1);
        assert_eq!(provider.usage["inputTokens"], 400);
    }

    #[test]
    fn interrupt_drains_queued_metadata_into_the_preterminal_snapshot() {
        let mut provider = provider_with_interrupt_stream(
            vec![
                invocation_event(NetworkEventKind::TextDelta(
                    "queued output is suppressed".to_owned(),
                )),
                invocation_event(NetworkEventKind::Usage {
                    input_tokens: 700,
                    output_tokens: 80,
                    cache_read_input_tokens: 30,
                    cache_write_input_tokens: 10,
                    latency_ms: 9,
                }),
                invocation_event(NetworkEventKind::Failure(
                    "expected truncated event stream".to_owned(),
                )),
            ],
            true,
            restored_usage_snapshot(None).unwrap(),
        );

        provider.interrupt_turn("turn-1").unwrap();
        match provider.poll().unwrap().unwrap() {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "thread/tokenUsage/updated");
                assert_eq!(params["requestCount"], 1);
                assert_eq!(params["inputTokens"], 700);
                assert_eq!(
                    params["usageReconciliation"],
                    "authoritative_metadata_observed"
                );
            }
            other => panic!("unexpected interrupted usage snapshot: {other:?}"),
        }
        match provider.poll().unwrap().unwrap() {
            ProviderEvent::Notification { method, params } => {
                assert_eq!(method, "turn/completed");
                assert_eq!(params.pointer("/turn/status"), Some(&json!("interrupted")));
            }
            other => panic!("unexpected interrupted terminal: {other:?}"),
        }
        assert!(provider.poll().unwrap().is_none());
        assert!(provider.current_text.is_empty());
    }

    #[test]
    fn restored_cumulative_spend_is_enforced_before_another_invocation() {
        let usage = json!({
            "inputTokens": 100,
            "outputTokens": 100,
            "cacheReadInputTokens": 0,
            "cacheWriteInputTokens": 0,
            "requestCount": 2,
            "estimatedCostUsd": 1.0,
            "costSource": "paperclip_estimate"
        });
        let mut provider = provider_with_events(Vec::new(), usage);
        assert!(provider.invoke(Vec::new()).is_err());
    }

    #[test]
    fn memory_purge_restarts_from_the_first_page_after_mutating_deletes() {
        let remaining = Arc::new(Mutex::new(
            (0..250)
                .map(|index| format!("event-{index}"))
                .collect::<Vec<_>>(),
        ));
        let listed = Arc::new(Mutex::new(0_usize));
        let list_remaining = Arc::clone(&remaining);
        let list_count = Arc::clone(&listed);
        let delete_remaining = Arc::clone(&remaining);
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(purge_memory_event_ids(
                move || {
                    let ids = list_remaining
                        .lock()
                        .unwrap()
                        .iter()
                        .take(100)
                        .cloned()
                        .collect::<Vec<_>>();
                    *list_count.lock().unwrap() += 1;
                    async move { Ok(ids) }
                },
                move |event_id| {
                    let remaining = Arc::clone(&delete_remaining);
                    async move {
                        let mut values = remaining.lock().unwrap();
                        let index = values.iter().position(|value| value == &event_id).unwrap();
                        values.remove(index);
                        Ok(())
                    }
                },
            ))
            .unwrap();
        assert!(remaining.lock().unwrap().is_empty());
        assert_eq!(*listed.lock().unwrap(), 4);
    }

    #[test]
    fn memory_history_scan_fails_closed_at_the_page_bound() {
        let mut pages = 0;
        let mut events = 0;
        for _ in 0..MAX_MEMORY_HISTORY_PAGES {
            observe_memory_history_page(&mut pages, &mut events, 1, "history scan").unwrap();
        }
        assert!(observe_memory_history_page(&mut pages, &mut events, 1, "history scan").is_err());
    }

    #[test]
    fn agentcore_system_replaces_the_local_instruction_path_with_the_harness_skill() {
        let mut config = config();
        let local_root = "/paperclip/runtime/instructions";
        config.instructions = format!(
            "paperclip prompt\n\nAGENTS entry\n\nRead-only instruction sibling root: {local_root}"
        );
        config.runtime_context = Some(json!({
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": { "digest": "abc123", "rootPath": local_root }
            },
            "skills": []
        }));

        let instructions = agentcore_system_instructions(&config).unwrap();
        assert!(instructions.starts_with("paperclip prompt\n\nAGENTS entry\n\n"));
        assert!(instructions.ends_with("attached Paperclip HarnessSkill under `instructions/`."));
        assert!(!instructions.contains(local_root));
    }

    #[test]
    fn agentcore_upload_plan_contains_instruction_siblings_and_complete_assigned_skill_trees() {
        let root = std::env::temp_dir().join(format!(
            "paperclip-agentcore-context-{}",
            uuid::Uuid::new_v4()
        ));
        let instruction_root = root.join("instructions");
        let skill_root = root.join("reviewer");
        fs::create_dir_all(instruction_root.join("references")).unwrap();
        fs::create_dir_all(skill_root.join("references")).unwrap();
        fs::write(instruction_root.join("AGENTS.md"), "Follow the entry.\n").unwrap();
        fs::write(
            instruction_root.join("references/policy.md"),
            "Instruction sibling.\n",
        )
        .unwrap();
        fs::write(skill_root.join("SKILL.md"), "# Reviewer\n").unwrap();
        fs::write(
            skill_root.join("references/checklist.md"),
            "- Verify tests\n",
        )
        .unwrap();
        let mut config = config();
        config.runtime_context = Some(json!({
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": {
                    "digest": "a".repeat(64),
                    "rootPath": instruction_root.display().to_string()
                }
            },
            "skills": [{
                "key": "company-1/reviewer",
                "runtimeName": "reviewer",
                "bundle": {
                    "digest": "b".repeat(64),
                    "rootPath": skill_root.display().to_string()
                }
            }]
        }));

        let assets = prepare_agentcore_runtime_context_assets(&config).unwrap();

        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].digest.len(), 64);
        assert!(assets[0]
            .generated_skill
            .as_ref()
            .is_some_and(|skill| skill.contains("instructions/AGENTS.md")));
        assert!(assets[0]
            .files
            .iter()
            .any(|(path, bytes)| path == Path::new("instructions/AGENTS.md")
                && bytes == b"Follow the entry.\n"));
        assert!(assets[0].files.iter().any(|(path, bytes)| path
            == Path::new("instructions/references/policy.md")
            && bytes == b"Instruction sibling.\n"));
        assert_eq!(assets[1].digest, "b".repeat(64));
        assert!(assets[1].generated_skill.is_none());
        assert!(assets[1]
            .files
            .iter()
            .any(|(path, bytes)| path == Path::new("SKILL.md") && bytes == b"# Reviewer\n"));
        assert!(assets[1]
            .files
            .iter()
            .any(|(path, bytes)| path == Path::new("references/checklist.md")
                && bytes == b"- Verify tests\n"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agentcore_context_aggregate_bounds_are_closed_at_provider_limits() {
        let assets = vec![
            AgentCoreContextAsset {
                digest: "a".repeat(64),
                files: vec![(PathBuf::from("instructions/AGENTS.md"), vec![0; 3])],
                generated_skill: Some("companion".to_owned()),
            },
            AgentCoreContextAsset {
                digest: "b".repeat(64),
                files: vec![(PathBuf::from("SKILL.md"), vec![0; 5])],
                generated_skill: None,
            },
        ];
        assert_eq!(agentcore_context_totals(&assets), (3, 17));
        assert!(validate_agentcore_context_aggregate(
            MAX_CONTEXT_SKILL_SOURCES,
            MAX_CONTEXT_UPLOAD_FILES,
            MAX_CONTEXT_UPLOAD_BYTES,
        )
        .is_ok());
        assert!(
            validate_agentcore_context_aggregate(MAX_CONTEXT_SKILL_SOURCES + 1, 0, 0,)
                .unwrap_err()
                .contains("skill-source limit")
        );
        assert!(
            validate_agentcore_context_aggregate(1, MAX_CONTEXT_UPLOAD_FILES + 1, 0,)
                .unwrap_err()
                .contains("aggregate file limit")
        );
        assert!(
            validate_agentcore_context_aggregate(1, 1, MAX_CONTEXT_UPLOAD_BYTES + 1,)
                .unwrap_err()
                .contains("aggregate byte limit")
        );
    }

    #[test]
    fn agentcore_rejects_too_many_assigned_skills_before_reading_any_skill_root() {
        let root = std::env::temp_dir().join(format!(
            "paperclip-agentcore-context-count-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "Follow the entry.\n").unwrap();
        let assigned = (0..MAX_CONTEXT_SKILL_SOURCES)
            .map(|index| {
                json!({
                    "key": format!("company-1/skill-{index}"),
                    "runtimeName": format!("skill-{index}"),
                    "bundle": {
                        "digest": format!("{index:064x}"),
                        "rootPath": root.join("does-not-exist").display().to_string()
                    }
                })
            })
            .collect::<Vec<_>>();
        let mut config = config();
        config.runtime_context = Some(json!({
            "instructions": {
                "entryPath": "AGENTS.md",
                "bundle": {
                    "digest": "a".repeat(64),
                    "rootPath": root.display().to_string()
                }
            },
            "skills": assigned
        }));

        let error = prepare_agentcore_runtime_context_assets(&config).unwrap_err();
        assert!(error.contains("skill-source limit"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agentcore_rejects_unsafe_context_prefixes_before_cloud_access() {
        for unsafe_prefix in [
            "/absolute",
            "company//profile",
            "company/../profile",
            "company/./profile",
        ] {
            let mut config = config();
            config.context_prefix = unsafe_prefix.to_owned();
            assert!(
                validate_config(&config).is_err(),
                "prefix should fail: {unsafe_prefix}"
            );
        }
    }

    #[test]
    fn tool_names_are_safe_stable_and_collision_resistant() {
        let first = remote_tool_name("issues.comment:create");
        let second = remote_tool_name("issues.comment/create");
        assert!(first
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'));
        assert_ne!(first, second);
        assert_eq!(first, remote_tool_name("issues.comment:create"));
    }

    #[test]
    fn tool_allowlist_is_confined_to_the_paperclip_inline_namespace() {
        let tool = AuthorizedTool {
            operation_id: "get_task_context".to_owned(),
            version: 1,
            description: "Read the assigned task context".to_owned(),
            input_schema: json!({"type":"object"}),
            response_schema: json!({"type":"object"}),
        };
        let (_, allowed, remote, _) = encode_tools(&[tool]).unwrap();
        assert_eq!(AGENTCORE_INLINE_TOOL_ALLOWLIST, "@*/pc_*");
        assert!(remote.keys().all(|name| name.starts_with("pc_")));
        assert_eq!(allowed.len(), 1);
        assert!(allowed[0].starts_with("@*/pc_"));
    }

    #[test]
    fn rejects_more_than_sixty_four_tools() {
        let tool = AuthorizedTool {
            operation_id: "op".to_owned(),
            version: 1,
            description: "op".to_owned(),
            input_schema: json!({"type":"object"}),
            response_schema: json!({"type":"object"}),
        };
        assert!(encode_tools(&vec![tool; 65]).is_err());
    }

    #[test]
    fn redacts_credential_markers_from_remote_errors() {
        let value =
            redact_aws_error("Authorization: AWS_SESSION_TOKEN X-Amz-Signature=secret-value");
        assert!(!value.contains("Authorization"));
        assert!(!value.contains("AWS_SESSION_TOKEN"));
        assert!(!value.contains("secret-value"));
        assert_eq!(
            redact_aws_error("AccessDeniedException: signed request"),
            "AWS AgentCore access denied"
        );
        assert_eq!(
            classify_aws_error_code("ValidationException"),
            "AWS AgentCore request validation failed"
        );
        assert_eq!(
            classify_aws_error_code("UnrecognizedFutureError"),
            "AWS AgentCore request failed"
        );
    }

    #[test]
    fn estimates_only_the_qualified_model_token_component() {
        assert_eq!(
            estimate_model_token_cost_usd("other-model", 1, 1, 0, 0),
            None
        );
        let estimate = estimate_model_token_cost_usd(
            "global.anthropic.claude-sonnet-4-6",
            1_000_000,
            1_000_000,
            0,
            0,
        )
        .unwrap();
        assert!((estimate - 18.0).abs() < f64::EPSILON);
        let cached = estimate_model_token_cost_usd(
            "global.anthropic.claude-sonnet-4-6",
            2_000_000,
            0,
            1_000_000,
            1_000_000,
        )
        .unwrap();
        assert!((cached - 10.05).abs() < f64::EPSILON);
        let mixed = estimate_model_token_cost_usd(
            "global.anthropic.claude-sonnet-4-6",
            3_000,
            0,
            4_000,
            1_000,
        )
        .unwrap();
        assert!((mixed - 0.01395).abs() < 0.000_000_001);
    }

    #[test]
    fn eventstream_text_delta_is_normalized_without_provider_objects() {
        let (sender, receiver) = mpsc::sync_channel(4);
        let mut blocks = BTreeMap::new();
        let event = HarnessContentBlockDeltaEvent::builder()
            .content_block_index(0)
            .delta(HarnessContentBlockDelta::Text("hello".to_owned()))
            .build()
            .unwrap();
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockDelta(event),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        match receiver.try_recv().unwrap() {
            NetworkEvent {
                invocation_id,
                kind: NetworkEventKind::TextDelta(value),
            } => {
                assert_eq!(invocation_id, "invocation-1");
                assert_eq!(value, "hello");
            }
            other => panic!("unexpected normalized event: {other:?}"),
        }
    }

    #[test]
    fn eventstream_tool_json_is_buffered_until_the_block_is_complete() {
        let (sender, receiver) = mpsc::sync_channel(8);
        let mut blocks = BTreeMap::new();
        let start = HarnessToolUseBlockStart::builder()
            .tool_use_id("tool-use-1")
            .name("pc_get_task_abc123")
            .r#type(HarnessToolUseType::ToolUse)
            .build()
            .unwrap();
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockStart(
                HarnessContentBlockStartEvent::builder()
                    .content_block_index(2)
                    .start(HarnessContentBlockStart::ToolUse(start))
                    .build()
                    .unwrap(),
            ),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        for chunk in ["{\"issue", "Id\":\"MCK-1\"}"] {
            normalize_stream_event(
                InvokeHarnessStreamOutput::ContentBlockDelta(
                    HarnessContentBlockDeltaEvent::builder()
                        .content_block_index(2)
                        .delta(HarnessContentBlockDelta::ToolUse(
                            HarnessToolUseBlockDelta::builder()
                                .input(chunk)
                                .build()
                                .unwrap(),
                        ))
                        .build()
                        .unwrap(),
                ),
                &mut blocks,
                &sender,
                "invocation-1",
            );
        }
        assert!(receiver.try_recv().is_err());
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockStop(
                HarnessContentBlockStopEvent::builder()
                    .content_block_index(2)
                    .build()
                    .unwrap(),
            ),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        match receiver.try_recv().unwrap() {
            NetworkEvent {
                invocation_id,
                kind:
                    NetworkEventKind::ToolUse {
                        call_id,
                        remote_name,
                        input,
                    },
            } => {
                assert_eq!(invocation_id, "invocation-1");
                assert_eq!(call_id, "tool-use-1");
                assert_eq!(remote_name, "pc_get_task_abc123");
                assert_eq!(input, json!({"issueId":"MCK-1"}));
            }
            other => panic!("unexpected normalized event: {other:?}"),
        }
    }

    #[test]
    fn eventstream_empty_tool_input_is_normalized_to_an_empty_object() {
        let (sender, receiver) = mpsc::sync_channel(4);
        let mut blocks = BTreeMap::new();
        let start = HarnessToolUseBlockStart::builder()
            .tool_use_id("tool-use-empty")
            .name("pc_get_task_context_abc123")
            .r#type(HarnessToolUseType::ToolUse)
            .build()
            .unwrap();
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockStart(
                HarnessContentBlockStartEvent::builder()
                    .content_block_index(1)
                    .start(HarnessContentBlockStart::ToolUse(start))
                    .build()
                    .unwrap(),
            ),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockDelta(
                HarnessContentBlockDeltaEvent::builder()
                    .content_block_index(1)
                    .delta(HarnessContentBlockDelta::ToolUse(
                        HarnessToolUseBlockDelta::builder()
                            .input("")
                            .build()
                            .unwrap(),
                    ))
                    .build()
                    .unwrap(),
            ),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        normalize_stream_event(
            InvokeHarnessStreamOutput::ContentBlockStop(
                HarnessContentBlockStopEvent::builder()
                    .content_block_index(1)
                    .build()
                    .unwrap(),
            ),
            &mut blocks,
            &sender,
            "invocation-1",
        );
        match receiver.try_recv().unwrap() {
            NetworkEvent {
                invocation_id,
                kind:
                    NetworkEventKind::ToolUse {
                        call_id,
                        remote_name,
                        input,
                    },
            } => {
                assert_eq!(invocation_id, "invocation-1");
                assert_eq!(call_id, "tool-use-empty");
                assert_eq!(remote_name, "pc_get_task_context_abc123");
                assert_eq!(input, json!({}));
            }
            other => panic!("unexpected normalized event: {other:?}"),
        }
    }

    #[test]
    fn tool_results_use_the_harness_supported_text_content_variant() {
        let value = json!({"ok": true, "nested": {"value": 7}});
        let content = encode_tool_result_content(&value).unwrap();
        let text = content
            .as_text()
            .expect("AgentCore managed Harness requires text tool results");
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), value);
    }
}
