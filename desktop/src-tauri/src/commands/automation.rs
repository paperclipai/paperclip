use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub cpu_count: usize,
    pub hostname: String,
}

#[tauri::command]
pub async fn run_applescript(script: String) -> Result<String, String> {
    let output = tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub async fn list_shortcuts() -> Result<Vec<String>, String> {
    let output = tokio::process::Command::new("shortcuts")
        .arg("list")
        .output()
        .await
        .map_err(|e| format!("Failed to list shortcuts: {}", e))?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
pub async fn run_shortcut(name: String) -> Result<String, String> {
    let output = tokio::process::Command::new("shortcuts")
        .arg("run")
        .arg(&name)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
pub fn get_automation_system_info() -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_count: std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1),
        hostname: "unknown".to_string(),
    }
}

// I3: Automation Rules CRUD

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct AutomationRule {
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub trigger_type: String,
    pub trigger_config: String,
    pub action_type: String,
    pub action_config: String,
    pub enabled: bool,
    pub last_triggered_at: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_automation_rules(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<AutomationRule>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, AutomationRule>(
        "SELECT id, company_id, name, trigger_type, trigger_config, action_type, action_config, enabled, last_triggered_at, created_at FROM automation_rules WHERE company_id = ? ORDER BY created_at"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_automation_rule(pool: State<'_, DbPool>, company_id: String, name: String, trigger_type: String, trigger_config: String, action_type: String, action_config: String) -> Result<AutomationRule, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO automation_rules (id, company_id, name, trigger_type, trigger_config, action_type, action_config) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&name).bind(&trigger_type).bind(&trigger_config).bind(&action_type).bind(&action_config)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, AutomationRule>(
        "SELECT id, company_id, name, trigger_type, trigger_config, action_type, action_config, enabled, last_triggered_at, created_at FROM automation_rules WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_automation_rule(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM automation_rules WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_automation_rule(pool: State<'_, DbPool>, id: String, enabled: bool) -> Result<AutomationRule, String> {
    let p = &pool.0;
    sqlx::query("UPDATE automation_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(enabled).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, AutomationRule>(
        "SELECT id, company_id, name, trigger_type, trigger_config, action_type, action_config, enabled, last_triggered_at, created_at FROM automation_rules WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}
