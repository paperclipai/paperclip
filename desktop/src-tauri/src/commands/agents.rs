use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

const AGENT_SELECT: &str = r#"
    SELECT id, company_id, name, role, title, icon, status, reports_to,
    adapter_type, adapter_config, budget_monthly_cents, spent_monthly_cents,
    pause_reason, last_heartbeat_at, created_at, updated_at
    FROM agents
"#;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Agent {
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub role: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub status: String,
    pub reports_to: Option<String>,
    pub adapter_type: String,
    pub adapter_config: String,
    pub budget_monthly_cents: i64,
    pub spent_monthly_cents: i64,
    pub pause_reason: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateAgentInput {
    pub name: String,
    pub role: Option<String>,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub adapter_type: Option<String>,
    pub adapter_config: Option<String>,
    pub reports_to: Option<String>,
    pub budget_monthly_cents: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAgentInput {
    pub name: Option<String>,
    pub role: Option<String>,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub adapter_type: Option<String>,
    pub adapter_config: Option<String>,
    pub reports_to: Option<String>,
    pub budget_monthly_cents: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct OrgNode {
    pub id: String,
    pub name: String,
    pub role: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub status: String,
    pub adapter_type: String,
    pub reports_to: Option<String>,
    pub children: Vec<OrgNode>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct HeartbeatRun {
    pub id: String,
    pub company_id: String,
    pub agent_id: String,
    pub invocation_source: String,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub usage_json: String,
    pub stdout_excerpt: Option<String>,
    pub created_at: String,
}

// ── Agent CRUD ──

#[tauri::command]
pub async fn list_agents(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<Agent>, String> {
    let p = &pool.0;

    let q = format!("{} WHERE company_id = ? AND status != 'terminated' ORDER BY created_at", AGENT_SELECT);
    sqlx::query_as::<_, Agent>(&q)
        .bind(&company_id)
        .fetch_all(p)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_agent(pool: State<'_, DbPool>, id: String) -> Result<Agent, String> {
    let p = &pool.0;
    fetch_agent(p, &id).await
}

#[tauri::command]
pub async fn create_agent(
    pool: State<'_, DbPool>,
    company_id: String,
    data: CreateAgentInput,
) -> Result<Agent, String> {
    let p = &pool.0;

    let id = Uuid::new_v4().to_string();
    let role = data.role.unwrap_or_else(|| "general".to_string());
    let adapter_type = data.adapter_type.unwrap_or_else(|| "claude_local".to_string());
    let adapter_config = data.adapter_config.unwrap_or_else(|| "{}".to_string());
    let budget = data.budget_monthly_cents.unwrap_or(0);

    sqlx::query(
        "INSERT INTO agents (id, company_id, name, role, title, icon, adapter_type, adapter_config, reports_to, budget_monthly_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&company_id).bind(&data.name).bind(&role)
    .bind(&data.title).bind(&data.icon).bind(&adapter_type)
    .bind(&adapter_config).bind(&data.reports_to).bind(budget)
    .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query("INSERT INTO agent_runtime_state (agent_id, company_id, adapter_type) VALUES (?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&adapter_type)
        .execute(p).await.map_err(|e| e.to_string())?;

    let _ = crate::services::activity::log_activity(p, &company_id, "board", "agent.created", "agent", Some(&id)).await;

    fetch_agent(p, &id).await
}

#[tauri::command]
pub async fn update_agent(pool: State<'_, DbPool>, id: String, data: UpdateAgentInput) -> Result<Agent, String> {
    let p = &pool.0;

    let existing = fetch_agent(p, &id).await?;
    let name = data.name.unwrap_or(existing.name);
    let role = data.role.unwrap_or(existing.role);
    let adapter_type = data.adapter_type.unwrap_or(existing.adapter_type);
    let adapter_config = data.adapter_config.unwrap_or(existing.adapter_config);
    let budget = data.budget_monthly_cents.unwrap_or(existing.budget_monthly_cents);

    sqlx::query(
        "UPDATE agents SET name=?, role=?, title=?, icon=?, adapter_type=?, adapter_config=?, reports_to=?, budget_monthly_cents=?, updated_at=datetime('now') WHERE id=?",
    )
    .bind(&name).bind(&role).bind(&data.title).bind(&data.icon)
    .bind(&adapter_type).bind(&adapter_config).bind(&data.reports_to)
    .bind(budget).bind(&id)
    .execute(p).await.map_err(|e| e.to_string())?;

    let _ = crate::services::activity::log_activity(p, &existing.company_id, "board", "agent.updated", "agent", Some(&id)).await;

    fetch_agent(p, &id).await
}

#[tauri::command]
pub async fn delete_agent(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE agents SET status='terminated', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pause_agent(pool: State<'_, DbPool>, id: String, reason: Option<String>) -> Result<Agent, String> {
    let p = &pool.0;
    let r = reason.unwrap_or_else(|| "manual".to_string());
    sqlx::query("UPDATE agents SET status='paused', pause_reason=?, paused_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&r).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    let agent = fetch_agent(p, &id).await?;
    let _ = crate::services::activity::log_activity(p, &agent.company_id, "board", "agent.paused", "agent", Some(&id)).await;
    Ok(agent)
}

#[tauri::command]
pub async fn resume_agent(pool: State<'_, DbPool>, id: String) -> Result<Agent, String> {
    let p = &pool.0;
    sqlx::query("UPDATE agents SET status='idle', pause_reason=NULL, paused_at=NULL, updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    let agent = fetch_agent(p, &id).await?;
    let _ = crate::services::activity::log_activity(p, &agent.company_id, "board", "agent.resumed", "agent", Some(&id)).await;
    Ok(agent)
}

#[tauri::command]
pub async fn terminate_agent(pool: State<'_, DbPool>, id: String) -> Result<Agent, String> {
    let p = &pool.0;
    sqlx::query("UPDATE agents SET status='terminated', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    let agent = fetch_agent(p, &id).await?;
    let _ = crate::services::activity::log_activity(p, &agent.company_id, "board", "agent.terminated", "agent", Some(&id)).await;
    Ok(agent)
}

// ── Heartbeat Runs ──

#[tauri::command]
pub async fn list_heartbeat_runs(pool: State<'_, DbPool>, agent_id: String) -> Result<Vec<HeartbeatRun>, String> {
    let p = &pool.0;

    sqlx::query_as::<_, HeartbeatRun>(
        "SELECT id, company_id, agent_id, invocation_source, status, started_at, finished_at, error, exit_code, usage_json, stdout_excerpt, created_at FROM heartbeat_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .bind(&agent_id)
    .fetch_all(p)
    .await
    .map_err(|e| e.to_string())
}

// ── Org Tree ──

#[tauri::command]
pub async fn get_org_tree(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<OrgNode>, String> {
    let p = &pool.0;

    let q = format!("{} WHERE company_id = ? AND status != 'terminated' ORDER BY created_at", AGENT_SELECT);
    let agents: Vec<Agent> = sqlx::query_as::<_, Agent>(&q)
        .bind(&company_id)
        .fetch_all(p)
        .await
        .map_err(|e| e.to_string())?;

    Ok(build_org_tree(&agents))
}

// ── Wake / Runtime / Config ──

#[tauri::command]
pub async fn wake_agent(pool: State<'_, DbPool>, id: String, source: String, reason: Option<String>, payload: Option<String>) -> Result<String, String> {
    let p = &pool.0;
    let wakeup_id = Uuid::new_v4().to_string();
    let payload_str = payload.unwrap_or_else(|| "{}".to_string());
    sqlx::query("INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, reason, payload) VALUES (?, (SELECT company_id FROM agents WHERE id = ?), ?, ?, ?, ?)")
        .bind(&wakeup_id).bind(&id).bind(&id).bind(&source).bind(&reason).bind(&payload_str)
        .execute(p).await.map_err(|e| e.to_string())?;
    Ok(wakeup_id)
}

#[tauri::command]
pub async fn get_runtime_state(pool: State<'_, DbPool>, agent_id: String) -> Result<serde_json::Value, String> {
    let p = &pool.0;
    let row = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, i64, i64, i64, Option<String>,)>(
        "SELECT company_id, adapter_type, session_id, last_run_status, total_input_tokens, total_output_tokens, total_cost_cents, last_error FROM agent_runtime_state WHERE agent_id = ?"
    ).bind(&agent_id).fetch_optional(p).await.map_err(|e| e.to_string())?;
    match row {
        Some(r) => Ok(serde_json::json!({
            "agent_id": agent_id, "company_id": r.0, "adapter_type": r.1,
            "session_id": r.2, "last_run_status": r.3,
            "total_input_tokens": r.4, "total_output_tokens": r.5,
            "total_cost_cents": r.6, "last_error": r.7
        })),
        None => Err("Runtime state not found".to_string()),
    }
}

#[tauri::command]
pub async fn get_agent_config(pool: State<'_, DbPool>, id: String) -> Result<serde_json::Value, String> {
    let p = &pool.0;
    let agent = fetch_agent(p, &id).await?;
    let config: serde_json::Value = serde_json::from_str(&agent.adapter_config).unwrap_or(serde_json::json!({}));
    Ok(config)
}

#[tauri::command]
pub async fn list_config_revisions(pool: State<'_, DbPool>, agent_id: String) -> Result<Vec<serde_json::Value>, String> {
    let p = &pool.0;
    let rows = sqlx::query_as::<_, (String, String, String, String, String,)>(
        "SELECT id, source, changed_keys, before_config, created_at FROM agent_config_revisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(&agent_id).fetch_all(p).await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| serde_json::json!({"id": r.0, "source": r.1, "changed_keys": r.2, "before_config": r.3, "created_at": r.4})).collect())
}

#[tauri::command]
pub async fn rollback_config(pool: State<'_, DbPool>, agent_id: String, revision_id: String) -> Result<Agent, String> {
    let p = &pool.0;
    let rev = sqlx::query_as::<_, (String,)>("SELECT before_config FROM agent_config_revisions WHERE id = ? AND agent_id = ?")
        .bind(&revision_id).bind(&agent_id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or("Revision not found")?;
    sqlx::query("UPDATE agents SET adapter_config = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(&rev.0).bind(&agent_id).execute(p).await.map_err(|e| e.to_string())?;
    fetch_agent(p, &agent_id).await
}

#[tauri::command]
pub async fn get_heartbeat_run(pool: State<'_, DbPool>, run_id: String) -> Result<HeartbeatRun, String> {
    let p = &pool.0;
    sqlx::query_as::<_, HeartbeatRun>(
        "SELECT id, company_id, agent_id, invocation_source, status, started_at, finished_at, error, exit_code, usage_json, stdout_excerpt, created_at FROM heartbeat_runs WHERE id = ?"
    ).bind(&run_id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Run not found".to_string())
}

#[tauri::command]
pub async fn cancel_heartbeat_run(pool: State<'_, DbPool>, run_id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE heartbeat_runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'running')")
        .bind(&run_id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_live_runs(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<HeartbeatRun>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, HeartbeatRun>(
        "SELECT id, company_id, agent_id, invocation_source, status, started_at, finished_at, error, exit_code, usage_json, stdout_excerpt, created_at FROM heartbeat_runs WHERE company_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_adapter_models(adapter_type: String) -> Result<Vec<serde_json::Value>, String> {
    let models = match adapter_type.as_str() {
        "claude_local" => vec![
            serde_json::json!({"id": "claude-opus-4-6", "name": "Claude Opus 4.6"}),
            serde_json::json!({"id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6"}),
            serde_json::json!({"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"}),
        ],
        "codex_local" => vec![serde_json::json!({"id": "codex", "name": "Codex"})],
        "gemini_local" => vec![serde_json::json!({"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro"})],
        "ollama_local" => vec![
            serde_json::json!({"id": "gemma4:e2b", "name": "Gemma 4 2.3B (7GB, fast)"}),
            serde_json::json!({"id": "gemma4:e4b", "name": "Gemma 4 4.5B (10GB, balanced)"}),
            serde_json::json!({"id": "gemma4:12b", "name": "Gemma 4 12B (20GB, capable)"}),
            serde_json::json!({"id": "llama3.2:3b", "name": "Llama 3.2 3B (2GB, lightweight)"}),
            serde_json::json!({"id": "qwen3:8b", "name": "Qwen 3 8B (5GB, multilingual)"}),
            serde_json::json!({"id": "deepseek-coder-v2:16b", "name": "DeepSeek Coder V2 16B (coding)"}),
        ],
        _ => vec![],
    };
    Ok(models)
}

// ── Instructions ──

#[tauri::command]
pub async fn get_agent_instructions(pool: State<'_, DbPool>, agent_id: String) -> Result<String, String> {
    let p = &pool.0;
    let agent = fetch_agent(p, &agent_id).await?;
    crate::services::instructions::read_instructions(&agent.company_id, &agent_id)
}

#[tauri::command]
pub async fn save_agent_instructions(pool: State<'_, DbPool>, agent_id: String, content: String) -> Result<(), String> {
    let p = &pool.0;
    let agent = fetch_agent(p, &agent_id).await?;
    crate::services::instructions::write_instructions(&agent.company_id, &agent_id, &content)
}

// ── Instruction Files ──

#[tauri::command]
pub async fn list_instruction_files(pool: State<'_, DbPool>, agent_id: String) -> Result<Vec<String>, String> {
    let p = &pool.0;
    let agent = fetch_agent(p, &agent_id).await?;
    Ok(crate::services::instructions::list_files(&agent.company_id, &agent_id))
}

// ── Helpers ──

async fn fetch_agent(pool: &sqlx::SqlitePool, id: &str) -> Result<Agent, String> {
    let q = format!("{} WHERE id = ?", AGENT_SELECT);
    sqlx::query_as::<_, Agent>(&q)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Agent not found".to_string())
}

// ── Agent API Keys ──

use sha2::{Sha256, Digest};

#[derive(Debug, serde::Serialize)]
pub struct AgentKeyCreated {
    pub id: String,
    pub name: String,
    pub key_prefix: String,
    pub key: String,  // Full key, shown ONCE
}

#[derive(Debug, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct AgentKeyInfo {
    pub id: String,
    pub name: String,
    pub key_prefix: String,
    pub status: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn create_agent_key(pool: State<'_, DbPool>, agent_id: String, name: String) -> Result<AgentKeyCreated, String> {
    let p = &pool.0;
    let agent = fetch_agent(p, &agent_id).await?;

    // Generate key: aos_ + 32 hex chars
    let key = format!("aos_{}", Uuid::new_v4().to_string().replace("-", ""));
    let key_prefix = key[..12].to_string();
    let key_hash = format!("{:x}", Sha256::digest(key.as_bytes()));
    let id = Uuid::new_v4().to_string();

    sqlx::query("INSERT INTO agent_api_keys (id, company_id, agent_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&agent.company_id).bind(&agent_id).bind(&name).bind(&key_prefix).bind(&key_hash)
        .execute(p).await.map_err(|e| e.to_string())?;

    // Also store in Keychain for heartbeat retrieval
    let keychain_key = format!("AGENT_KEY_{}", agent_id);
    let _ = tokio::process::Command::new("security")
        .args(["delete-generic-password", "-a", "archonos", "-s", &keychain_key])
        .output().await;
    let _ = tokio::process::Command::new("security")
        .args(["add-generic-password", "-a", "archonos", "-s", &keychain_key, "-w", &key])
        .output().await;

    Ok(AgentKeyCreated { id, name, key_prefix, key })
}

#[tauri::command]
pub async fn list_agent_keys(pool: State<'_, DbPool>, agent_id: String) -> Result<Vec<AgentKeyInfo>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, AgentKeyInfo>(
        "SELECT id, name, key_prefix, status, created_at FROM agent_api_keys WHERE agent_id = ? ORDER BY created_at DESC"
    ).bind(&agent_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_agent_key(pool: State<'_, DbPool>, key_id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE agent_api_keys SET status = 'revoked' WHERE id = ?")
        .bind(&key_id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn build_org_tree(agents: &[Agent]) -> Vec<OrgNode> {
    agents.iter()
        .filter(|a| a.reports_to.is_none())
        .map(|root| build_node(root, agents))
        .collect()
}

fn build_node(agent: &Agent, all: &[Agent]) -> OrgNode {
    let children = all.iter()
        .filter(|a| a.reports_to.as_deref() == Some(&agent.id))
        .map(|child| build_node(child, all))
        .collect();

    OrgNode {
        id: agent.id.clone(),
        name: agent.name.clone(),
        role: agent.role.clone(),
        title: agent.title.clone(),
        icon: agent.icon.clone(),
        status: agent.status.clone(),
        adapter_type: agent.adapter_type.clone(),
        reports_to: agent.reports_to.clone(),
        children,
    }
}
