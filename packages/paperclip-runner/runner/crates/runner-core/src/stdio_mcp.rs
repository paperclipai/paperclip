use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::durable::QualifiedLaunchArtifact;
use crate::local_runner::LocalRunnerError;
use crate::process_supervisor::{VerifiedProcessArgument, VerifiedProcessLaunch};
use crate::qualified_launch::verify_executable_launch_artifact;

pub const BINDINGS_ENV: &str = "PAPERCLIP_NATIVE_MCP_STDIO";
pub const PROXY_ENV: &str = "PAPERCLIP_NATIVE_MCP_PROXY";
const MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StdioMcpBinding {
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub sha256: String,
    pub serial_resource: PathBuf,
}

type McpResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn invalid(message: impl Into<String>) -> Box<dyn std::error::Error + Send + Sync> {
    LocalRunnerError::invalid(message).into()
}

#[cfg(unix)]
impl StdioMcpBinding {
    pub fn validate(&self) -> McpResult<()> {
        if self.name.is_empty()
            || self.name.len() > 128
            || self.name == "paperclip"
            || self.name.starts_with("paperclip_runner_")
            || !self
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || !self.command.is_absolute()
            || !self.serial_resource.is_absolute()
            || self.args.len() > 64
            || self.args.iter().any(|s| s.len() > 4096 || s.contains('\0'))
            || self.env.len() > 64
            || self.env.iter().any(|(k, v)| {
                k.is_empty()
                    || !k.bytes().enumerate().all(|(i, b)| {
                        b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit())
                    })
                    || k.starts_with("LD_")
                    || k.starts_with("DYLD_")
                    || ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"].contains(&k.as_str())
                    || v.contains('\0')
            })
        {
            return Err(invalid("invalid assigned stdio MCP binding"));
        }
        verify_executable_launch_artifact(
            &QualifiedLaunchArtifact {
                path: self.command.clone(),
                sha256: self.sha256.clone(),
            },
            "stdio MCP executable",
        )?;
        Ok(())
    }
}

#[cfg(unix)]
pub fn assigned_bindings() -> McpResult<Vec<StdioMcpBinding>> {
    let Some(raw) = std::env::var_os(BINDINGS_ENV) else {
        return Ok(vec![]);
    };
    let raw = raw
        .to_str()
        .ok_or_else(|| invalid("invalid stdio MCP environment"))?;
    if raw.len() > 64 * 1024 {
        return Err(invalid("oversized stdio MCP binding"));
    }
    let bindings: Vec<StdioMcpBinding> =
        serde_json::from_str(raw).map_err(|_| invalid("invalid stdio MCP binding JSON"))?;
    if bindings.len() > 8 {
        return Err(invalid("too many stdio MCP bindings"));
    }
    let mut names = BTreeSet::new();
    if let Ok(gateway) = std::env::var("PAPERCLIP_NATIVE_MCP_NAME") {
        names.insert(gateway);
    }
    for binding in &bindings {
        binding.validate()?;
        if !names.insert(binding.name.clone()) {
            return Err(invalid("duplicate assigned MCP name"));
        }
    }
    Ok(bindings)
}

pub struct StdioMcpSession {
    directory: PathBuf,
    pub entries: Vec<(String, PathBuf)>,
}
impl StdioMcpSession {
    #[cfg(unix)]
    pub fn create() -> McpResult<Option<Self>> {
        let bindings = assigned_bindings()?;
        if bindings.is_empty() {
            return Ok(None);
        }
        let directory =
            std::env::temp_dir().join(format!("paperclip-mcp-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        let mut session = Self {
            directory,
            entries: vec![],
        };
        for (index, binding) in bindings.iter().enumerate() {
            let path = session.directory.join(format!("{index}.json"));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            serde_json::to_writer(&mut file, binding)
                .map_err(|_| invalid("cannot write stdio MCP binding"))?;
            session.entries.push((binding.name.clone(), path));
        }
        Ok(Some(session))
    }
    #[cfg(not(unix))]
    pub fn create() -> McpResult<Option<Self>> {
        if std::env::var_os(BINDINGS_ENV).is_some() {
            return Err(invalid("assigned stdio MCP requires a Unix desktop socket"));
        }
        Ok(None)
    }
    pub fn codex_args(&self) -> McpResult<Vec<String>> {
        let command = std::env::var(PROXY_ENV)
            .map_err(|_| invalid("stdio MCP proxy executable is unassigned"))?;
        if !Path::new(&command).is_absolute() {
            return Err(invalid("stdio MCP proxy command must be absolute"));
        }
        let mut args = vec![];
        for (name, path) in &self.entries {
            let prefix = format!("mcp_servers.{name}");
            let command = serde_json::to_string(&command).unwrap();
            let path = serde_json::to_string(&path.to_string_lossy()).unwrap();
            for value in [
                format!("{prefix}.command={command}"),
                format!("{prefix}.args=[\"--stdio-mcp\",{path},\"--content-images\"]"),
                format!("{prefix}.env={{}}"),
                format!("{prefix}.env_vars=[]"),
                format!("{prefix}.default_tools_approval_mode=\"approve\""),
                format!("{prefix}.required=true"),
            ] {
                args.extend(["-c".into(), value]);
            }
        }
        Ok(args)
    }
}
impl Drop for StdioMcpSession {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[cfg(unix)]
fn resource_lock(resource: &Path) -> McpResult<(File, (u64, u64))> {
    let metadata = fs::symlink_metadata(resource)?;
    let parent = resource
        .parent()
        .ok_or_else(|| invalid("missing MCP socket parent"))?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !metadata.file_type().is_socket()
        || metadata.mode() & 0o077 != 0
        || !parent_metadata.is_dir()
        || parent_metadata.file_type().is_symlink()
        || parent_metadata.mode() & 0o077 != 0
        || metadata.uid() != parent_metadata.uid()
        || fs::canonicalize(resource)? != resource
    {
        return Err(invalid(
            "stdio MCP resource must be a private canonical socket",
        ));
    }
    let identity = format!(
        "{}:{}:{}",
        resource.display(),
        metadata.dev(),
        metadata.ino()
    );
    let digest = format!("{:x}", Sha256::digest(identity));
    let path = parent.join(format!(".paperclip-mcp-{digest}.lock"));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)?;
    if fs::symlink_metadata(&path)?.file_type().is_symlink() || file.metadata()?.mode() & 0o077 != 0
    {
        return Err(invalid("invalid stdio MCP lock"));
    }
    Ok((file, (metadata.dev(), metadata.ino())))
}

enum Event {
    Client(Vec<u8>),
    Server(Vec<u8>),
    ClientClosed,
    ServerClosed,
}
fn reader<R: io::Read + Send + 'static>(input: R, tx: mpsc::SyncSender<Event>, client: bool) {
    thread::spawn(move || {
        let mut input = BufReader::new(input);
        loop {
            let mut line = vec![];
            let result = input
                .by_ref()
                .take(MAX_FRAME as u64 + 1)
                .read_until(b'\n', &mut line);
            match result {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() <= MAX_FRAME && line.last() == Some(&b'\n') => {
                    if tx
                        .send(if client {
                            Event::Client(line)
                        } else {
                            Event::Server(line)
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                _ => break,
            }
        }
        let _ = tx.send(if client {
            Event::ClientClosed
        } else {
            Event::ServerClosed
        });
    });
}

#[cfg(unix)]
pub fn run_proxy(path: &Path, content_images: bool) -> McpResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 64 * 1024
    {
        return Err(invalid("invalid private stdio MCP configuration"));
    }
    let binding: StdioMcpBinding = serde_json::from_slice(&fs::read(path)?)
        .map_err(|_| invalid("invalid stdio MCP configuration"))?;
    binding.validate()?;
    let (mut lock, resource_identity) = resource_lock(&binding.serial_resource)?;
    let program = verify_executable_launch_artifact(
        &QualifiedLaunchArtifact {
            path: binding.command.clone(),
            sha256: binding.sha256.clone(),
        },
        "stdio MCP executable",
    )?;
    let launch = VerifiedProcessLaunch::new(
        program,
        binding
            .args
            .iter()
            .cloned()
            .map(VerifiedProcessArgument::Literal)
            .collect(),
    );
    let mut child = launch.spawn_stdio(&binding.env)?;
    let result: McpResult<()> = (|| {
        let mut input = child.stdin.take().unwrap();
        let (tx, rx) = mpsc::sync_channel(2);
        reader(io::stdin(), tx.clone(), true);
        reader(child.stdout.take().unwrap(), tx, false);
        let mut output = io::stdout().lock();
        let mut queue: VecDeque<(Value, Vec<u8>)> = VecDeque::new();
        let mut active: Option<Value> = None;
        let mut closing = false;
        let mut ids = BTreeSet::new();
        let mut deferred = None;
        loop {
            let ready_event = deferred.take().or_else(|| rx.try_recv().ok());
            if ready_event.is_none() && active.is_none() && !queue.is_empty() {
                let current = fs::symlink_metadata(&binding.serial_resource)?;
                if (current.dev(), current.ino()) != resource_identity
                    || current.mode() & 0o077 != 0
                {
                    return Err(invalid("assigned MCP socket changed; reopen the session"));
                }
                match lock.try_lock() {
                    Ok(()) => {
                        if let Ok(event) = rx.try_recv() {
                            lock.unlock()?;
                            deferred = Some(event);
                            continue;
                        }
                        if lock.metadata()?.len() != 0 {
                            return Err(invalid("previous MCP operation has unknown outcome; restart the assigned resource before retrying"));
                        }
                        let (id, line) = queue.pop_front().unwrap();
                        lock.seek(SeekFrom::Start(0))?;
                        lock.write_all(b"pending")?;
                        lock.sync_data()?;
                        active = Some(id);
                        input.write_all(&line)?;
                        input.flush()?;
                    }
                    Err(fs::TryLockError::WouldBlock) => {}
                    Err(fs::TryLockError::Error(error)) => return Err(error.into()),
                }
            }
            if closing && active.is_none() {
                return Ok(());
            }
            let event = match ready_event {
                Some(event) => event,
                None => match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(event) => event,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => return Err(invalid("stdio MCP transport disconnected")),
                },
            };
            match event {
                Event::Client(line) => {
                    let message: Value =
                        serde_json::from_slice(&line).map_err(|_| invalid("invalid MCP JSON"))?;
                    if message.get("method").is_some() {
                        if let Some(id) = message.get("id") {
                            if id.to_string().len() > 256
                                || ids.len() >= 128
                                || !ids.insert(id.to_string())
                            {
                                return Err(invalid("duplicate pending MCP request id"));
                            }
                        }
                    }
                    if message["method"] == "notifications/cancelled" {
                        let cancelled = &message["params"]["requestId"];
                        if let Some(index) = queue.iter().position(|(id, _)| id == cancelled) {
                            let (id, _) = queue.remove(index).unwrap();
                            ids.remove(&id.to_string());
                            writeln!(
                                output,
                                "{}",
                                serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32800,"message":"MCP call cancelled before dispatch"}})
                            )?;
                            output.flush()?;
                            continue;
                        }
                        if active.as_ref() == Some(cancelled) {
                            continue;
                        }
                    }
                    if message["method"] == "tools/call" {
                        let id = message
                            .get("id")
                            .filter(|id| id.is_string() || id.is_number())
                            .ok_or_else(|| invalid("MCP tool call requires an id"))?;
                        if queue.len() >= 64
                            || queue.iter().map(|(_, line)| line.len()).sum::<usize>() + line.len()
                                > 8 * 1024 * 1024
                        {
                            return Err(invalid("stdio MCP call queue is full"));
                        }
                        queue.push_back((id.clone(), line));
                    } else {
                        input.write_all(&line)?;
                        input.flush()?;
                    }
                }
                Event::Server(mut line) => {
                    let mut message: Value = serde_json::from_slice(&line)
                        .map_err(|_| invalid("invalid MCP server JSON"))?;
                    if active
                        .as_ref()
                        .is_some_and(|id| message.get("id") == Some(id))
                        && (message.get("result").is_some() || message.get("error").is_some())
                    {
                        lock.set_len(0)?;
                        lock.sync_data()?;
                        lock.unlock()?;
                        active = None;
                    }
                    if message.get("result").is_some() || message.get("error").is_some() {
                        if let Some(id) = message.get("id") {
                            ids.remove(&id.to_string());
                        }
                    }
                    if content_images {
                        if let Some(result) =
                            message.get_mut("result").and_then(Value::as_object_mut)
                        {
                            let has_image =
                                result.get("content").and_then(Value::as_array).is_some_and(
                                    |content| content.iter().any(|item| item["type"] == "image"),
                                );
                            if has_image {
                                if let Some(structured) = result.remove("structuredContent") {
                                    let content = result
                                        .get_mut("content")
                                        .and_then(Value::as_array_mut)
                                        .unwrap();
                                    let already_present = content.iter().any(|item| {
                                        item["type"] == "text"
                                            && item["text"]
                                                .as_str()
                                                .and_then(|text| {
                                                    serde_json::from_str::<Value>(text).ok()
                                                })
                                                .as_ref()
                                                == Some(&structured)
                                    });
                                    if !already_present {
                                        content.push(serde_json::json!({"type":"text","text":structured.to_string()}));
                                    }
                                    line = serde_json::to_vec(&message)?;
                                    line.push(b'\n');
                                }
                            }
                        }
                    }
                    output.write_all(&line)?;
                    output.flush()?;
                }
                Event::ClientClosed => {
                    closing = true;
                    queue.clear();
                }
                Event::ServerClosed => return Err(invalid("stdio MCP server exited")),
            }
        }
    })();
    for _ in 0..100 {
        if child.try_wait()?.is_some() {
            return result;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    result
}

pub(crate) fn validate_tool_approval(
    params: &Value,
    assigned_servers: &[&str],
) -> Result<(), LocalRunnerError> {
    let server = params
        .get("serverName")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !assigned_servers.contains(&server)
        || params.get("mode").and_then(Value::as_str) != Some("form")
        || params
            .pointer("/_meta/codex_approval_kind")
            .and_then(Value::as_str)
            != Some("mcp_tool_call")
        || params.get("requestedSchema")
            != Some(&serde_json::json!({"type":"object","properties":{}}))
        || params
            .get("message")
            .and_then(Value::as_str)
            .is_none_or(|s| s.is_empty() || s.chars().count() > 4000)
        || serde_json::to_vec(params)
            .map_err(|_| LocalRunnerError::invalid("invalid MCP approval"))?
            .len()
            > 64 * 1024
    {
        return Err(LocalRunnerError::invalid(
            "MCP approval is not bound to an assigned stdio server",
        ));
    }
    Ok(())
}

pub(crate) fn tool_approval_response(resolution: &Value) -> Result<Value, LocalRunnerError> {
    if resolution.as_object().is_none_or(|v| v.len() != 1)
        || !matches!(
            resolution.get("action").and_then(Value::as_str),
            Some("accept" | "decline" | "cancel")
        )
    {
        return Err(LocalRunnerError::invalid(
            "MCP approval requires an explicit one-time accept, decline or cancel",
        ));
    }
    Ok(serde_json::json!({"action":resolution["action"],"content":null,"_meta":null}))
}

#[cfg(test)]
mod approval_tests {
    use super::*;
    use serde_json::json;
    #[test]
    #[cfg(unix)]
    fn resource_lock_retains_the_socket_identity_it_locked() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::net::UnixListener;
        let root =
            std::env::temp_dir().join(format!("lock-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let socket = root.join("resource.sock");
        let original = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::symlink_metadata(&socket).unwrap();
        let (old_lock, old_identity) = resource_lock(&socket).unwrap();
        fs::remove_file(&socket).unwrap();
        let replacement = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let (new_lock, new_identity) = resource_lock(&socket).unwrap();
        assert_eq!(old_identity, (before.dev(), before.ino()));
        assert_ne!(old_identity, new_identity);
        old_lock.lock().unwrap();
        new_lock.try_lock().unwrap();
        drop((old_lock, new_lock, original, replacement));
        fs::remove_dir_all(root).unwrap();
    }
    fn request() -> Value {
        json!({"serverName":"assigned", "mode":"form", "message":"Allow input?", "_meta":{"codex_approval_kind":"mcp_tool_call"},"requestedSchema":{"type":"object","properties":{}}})
    }
    #[test]
    fn approval_metadata_cannot_widen_server_authority() {
        assert!(validate_tool_approval(&request(), &["assigned"]).is_ok());
        assert!(validate_tool_approval(&request(), &["other"]).is_err());
        for (field, value) in [
            ("mode", json!("url")),
            (
                "requestedSchema",
                json!({"type":"object","properties":{"password":{"type":"string"}}}),
            ),
            ("_meta", json!({})),
            ("message", json!("")),
        ] {
            let mut request = request();
            request[field] = value;
            assert!(validate_tool_approval(&request, &["assigned"]).is_err());
        }
    }
    #[test]
    fn approval_requires_a_one_time_explicit_decision() {
        for action in ["accept", "decline", "cancel"] {
            assert_eq!(
                tool_approval_response(&json!({"action":action})).unwrap(),
                json!({"action":action,"content":null,"_meta":null})
            );
        }
        for invalid in [
            json!({}),
            json!({"action":"accept_for_session"}),
            json!({"action":"submit","content":{}}),
            json!({"action":"accept","permissions":{"all":true}}),
        ] {
            assert!(tool_approval_response(&invalid).is_err());
        }
    }
}

pub(crate) fn codex_approval_policy() -> Value {
    serde_json::json!({"granular":{"sandbox_approval":false,"rules":false,"mcp_elicitations":true,"request_permissions":false,"skill_approval":false}})
}

#[cfg(not(unix))]
pub fn run_proxy(_path: &Path, _content_images: bool) -> McpResult<()> {
    Err(invalid("assigned stdio MCP requires a Unix desktop socket"))
}
