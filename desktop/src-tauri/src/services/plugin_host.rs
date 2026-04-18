use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufWriter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq)]
pub enum WorkerStatus {
    Starting,
    Ready,
    Error(String),
    Stopped,
    Backoff,
}

struct PluginWorker {
    plugin_id: String,
    plugin_key: String,
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    crash_count: u32,
    status: WorkerStatus,
    pending_requests:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    stdout_task: Option<tokio::task::JoinHandle<()>>,
    supported_methods: Vec<String>,
}

pub struct PluginRuntime {
    workers: Arc<Mutex<HashMap<String, PluginWorker>>>,
}

impl PluginRuntime {
    pub fn new() -> Self {
        Self {
            workers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_plugin(&self, pool: &SqlitePool, plugin_id: &str) -> Result<(), String> {
        // Get plugin from DB
        let plugin = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
            "SELECT plugin_key, package_path, manifest_json FROM plugins WHERE id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Plugin not found")?;

        let (plugin_key, package_path, manifest_json_opt) = plugin;
        let entry_point = package_path.unwrap_or_default();

        if entry_point.is_empty() {
            return Err("Plugin has no package_path configured".to_string());
        }

        // Check Node.js availability
        let node_check = tokio::process::Command::new("which")
            .arg("node")
            .output()
            .await;
        if node_check.map(|o| !o.status.success()).unwrap_or(true) {
            sqlx::query("UPDATE plugins SET status='error', last_error='Node.js not installed. Install it to use plugins.', updated_at=datetime('now') WHERE id=?")
                .bind(plugin_id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            return Err("Node.js not installed".to_string());
        }

        // Spawn node process
        let mut child = tokio::process::Command::new("node")
            .arg(&entry_point)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn plugin: {}", e))?;

        let stdin = child.stdin.take().map(BufWriter::new);
        let stdout = child.stdout.take();

        // Set up bidirectional communication
        let pending_requests: Arc<
            Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
        > = Arc::new(Mutex::new(HashMap::new()));

        // Spawn stdout reader task
        let stdout_task = if let Some(stdout) = stdout {
            let pending_clone = pending_requests.clone();
            Some(tokio::spawn(async move {
                let mut reader = tokio::io::BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break, // EOF or error
                        Ok(_) => {
                            if let Ok(msg) =
                                serde_json::from_str::<serde_json::Value>(line.trim())
                            {
                                // Check if it's a response (has "id" field)
                                if let Some(id) =
                                    msg.get("id").and_then(|v| v.as_str()).map(String::from)
                                {
                                    if let Some(sender) =
                                        pending_clone.lock().await.remove(&id)
                                    {
                                        let _ = sender.send(msg);
                                        continue;
                                    }
                                }
                                // Worker→host notification (has "method" but no "id")
                                if msg.get("method").is_some() && msg.get("id").is_none() {
                                    eprintln!(
                                        "[plugin] Worker notification: {}",
                                        msg.get("method").unwrap()
                                    );
                                }
                            }
                        }
                    }
                }
            }))
        } else {
            None
        };

        {
            let mut workers = self.workers.lock().await;
            workers.insert(
                plugin_id.to_string(),
                PluginWorker {
                    plugin_id: plugin_id.to_string(),
                    plugin_key: plugin_key.clone(),
                    child: Some(child),
                    stdin,
                    crash_count: 0,
                    status: WorkerStatus::Starting,
                    pending_requests: pending_requests.clone(),
                    stdout_task,
                    supported_methods: Vec::new(),
                },
            );
        }

        // Load plugin config from DB
        let config_json = sqlx::query_scalar::<_, String>(
            "SELECT config_json FROM plugin_config WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "{}".to_string());

        let manifest_json = manifest_json_opt.unwrap_or_else(|| "{}".to_string());

        // Send initialize RPC and await response
        let init_params = serde_json::json!({
            "manifest": serde_json::from_str::<serde_json::Value>(&manifest_json).unwrap_or_default(),
            "config": serde_json::from_str::<serde_json::Value>(&config_json).unwrap_or_default(),
            "instanceInfo": {
                "pluginId": plugin_id,
                "pluginKey": plugin_key,
                "hostVersion": "0.1.0",
            },
            "apiVersion": 1,
        });

        let response =
            Self::send_rpc_to_worker(&self.workers, plugin_id, "initialize", init_params, 15)
                .await?;

        // Parse initialize response
        {
            let mut guard = self.workers.lock().await;
            if let Some(worker) = guard.get_mut(plugin_id) {
                if response
                    .get("result")
                    .and_then(|r| r.get("ok"))
                    .and_then(|v| v.as_bool())
                    == Some(true)
                {
                    worker.supported_methods = response
                        .get("result")
                        .and_then(|r| r.get("supportedMethods"))
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    worker.status = WorkerStatus::Ready;
                } else {
                    worker.status = WorkerStatus::Error("Initialize failed".into());
                }
            }
        }

        // Update DB status
        sqlx::query(
            "UPDATE plugins SET status='active', last_error=NULL, updated_at=datetime('now') WHERE id=?",
        )
        .bind(plugin_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn stop_plugin(&self, plugin_id: &str) -> Result<(), String> {
        // Try graceful shutdown via RPC (best-effort, short timeout)
        let _ = Self::send_rpc_to_worker(
            &self.workers,
            plugin_id,
            "shutdown",
            serde_json::json!({}),
            5,
        )
        .await;

        let mut workers = self.workers.lock().await;
        if let Some(worker) = workers.get_mut(plugin_id) {
            // Abort stdout reader task
            if let Some(task) = worker.stdout_task.take() {
                task.abort();
            }

            // Kill the process
            if let Some(ref mut child) = worker.child {
                let _ = child.kill().await;
            }
            worker.status = WorkerStatus::Stopped;
            worker.child = None;
            worker.stdin = None;
        }
        workers.remove(plugin_id);
        Ok(())
    }

    pub async fn send_event(
        &self,
        plugin_id: &str,
        event_type: &str,
        data: serde_json::Value,
    ) -> Result<(), String> {
        // Events are best-effort; ignore errors
        let _ = Self::send_rpc_to_worker(
            &self.workers,
            plugin_id,
            "onEvent",
            serde_json::json!({
                "type": event_type,
                "data": data,
            }),
            5,
        )
        .await;
        Ok(())
    }

    pub async fn run_job(
        &self,
        pool: &SqlitePool,
        plugin_id: &str,
        job_key: &str,
    ) -> Result<(), String> {
        let run_id = Uuid::new_v4().to_string();
        let start = std::time::Instant::now();

        sqlx::query("INSERT INTO plugin_job_runs (id, job_id, plugin_id, status, started_at) VALUES (?, (SELECT id FROM plugin_jobs WHERE plugin_id=? AND job_key=?), ?, 'running', datetime('now'))")
            .bind(&run_id)
            .bind(plugin_id)
            .bind(job_key)
            .bind(plugin_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        let result = Self::send_rpc_to_worker(
            &self.workers,
            plugin_id,
            "runJob",
            serde_json::json!({
                "jobKey": job_key,
            }),
            30,
        )
        .await;

        let duration_ms = start.elapsed().as_millis() as i64;
        let (status, error) = match result {
            Ok(_) => ("completed", None),
            Err(ref e) => ("failed", Some(e.clone())),
        };

        sqlx::query(
            "UPDATE plugin_job_runs SET status=?, duration_ms=?, error=?, finished_at=datetime('now') WHERE id=?",
        )
        .bind(status)
        .bind(duration_ms)
        .bind(&error)
        .bind(&run_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    async fn send_rpc_to_worker(
        workers: &Arc<Mutex<HashMap<String, PluginWorker>>>,
        plugin_id: &str,
        method: &str,
        params: serde_json::Value,
        timeout_secs: u64,
    ) -> Result<serde_json::Value, String> {
        let rpc_id = Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();

        {
            let mut guard = workers.lock().await;
            let worker = guard.get_mut(plugin_id).ok_or("Worker not found")?;

            // Insert pending request
            worker
                .pending_requests
                .lock()
                .await
                .insert(rpc_id.clone(), tx);

            // Write RPC to stdin
            let stdin = worker.stdin.as_mut().ok_or("Stdin unavailable")?;
            let msg = serde_json::json!({
                "jsonrpc": "2.0",
                "id": &rpc_id,
                "method": method,
                "params": params,
            });
            let line = format!("{}\n", serde_json::to_string(&msg).map_err(|e| e.to_string())?);
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            stdin.flush().await.map_err(|e| e.to_string())?;
        } // guard dropped here

        // Await response without holding any locks
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Response channel closed".into()),
            Err(_) => Err(format!("RPC '{}' timed out after {}s", method, timeout_secs)),
        }
    }

    pub async fn initialize_all(&self, pool: &SqlitePool) {
        let plugins =
            sqlx::query_as::<_, (String,)>("SELECT id FROM plugins WHERE status = 'active'")
                .fetch_all(pool)
                .await
                .unwrap_or_default();

        for (id,) in plugins {
            if let Err(e) = self.start_plugin(pool, &id).await {
                eprintln!("[plugins] Failed to start plugin {}: {}", id, e);
            }
        }
    }
}
