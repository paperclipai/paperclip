use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Routine {
    pub id: String,
    pub company_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub priority: String,
    pub status: String,
    pub concurrency_policy: String,
    pub catch_up_policy: String,
    pub variables: String,
    pub last_triggered_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct RoutineTrigger {
    pub id: String,
    pub routine_id: String,
    pub kind: String,
    pub label: Option<String>,
    pub cron_expression: Option<String>,
    pub timezone: String,
    pub next_run_at: Option<String>,
    pub last_fired_at: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct RoutineRun {
    pub id: String,
    pub routine_id: String,
    pub source: String,
    pub status: String,
    pub triggered_at: String,
    pub linked_issue_id: Option<String>,
    pub failure_reason: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateRoutineInput {
    pub title: String,
    pub description: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub priority: Option<String>,
    pub concurrency_policy: Option<String>,
    pub catch_up_policy: Option<String>,
}

const ROUTINE_SELECT: &str = "SELECT id, company_id, project_id, title, description, assignee_agent_id, priority, status, concurrency_policy, catch_up_policy, variables, last_triggered_at, created_at, updated_at FROM routines";

#[tauri::command]
pub async fn list_routines(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<Routine>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Routine>(&format!("{} WHERE company_id = ? AND status != 'archived' ORDER BY created_at", ROUTINE_SELECT))
        .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_routine(pool: State<'_, DbPool>, id: String) -> Result<Routine, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Routine>(&format!("{} WHERE id = ?", ROUTINE_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Routine not found".to_string())
}

#[tauri::command]
pub async fn create_routine(pool: State<'_, DbPool>, company_id: String, data: CreateRoutineInput) -> Result<Routine, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let priority = data.priority.unwrap_or_else(|| "medium".to_string());
    let concurrency = data.concurrency_policy.unwrap_or_else(|| "coalesce_if_active".to_string());
    let catch_up = data.catch_up_policy.unwrap_or_else(|| "skip_missed".to_string());

    sqlx::query("INSERT INTO routines (id, company_id, title, description, assignee_agent_id, priority, concurrency_policy, catch_up_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&data.title).bind(&data.description)
        .bind(&data.assignee_agent_id).bind(&priority).bind(&concurrency).bind(&catch_up)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Routine>(&format!("{} WHERE id = ?", ROUTINE_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_routine(pool: State<'_, DbPool>, id: String, title: Option<String>, status: Option<String>) -> Result<Routine, String> {
    let p = &pool.0;

    let existing = sqlx::query_as::<_, Routine>(&format!("{} WHERE id = ?", ROUTINE_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Routine not found".to_string())?;

    let t = title.unwrap_or(existing.title);
    let s = status.unwrap_or(existing.status);
    sqlx::query("UPDATE routines SET title=?, status=?, updated_at=datetime('now') WHERE id=?")
        .bind(&t).bind(&s).bind(&id).execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Routine>(&format!("{} WHERE id = ?", ROUTINE_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_routine(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE routines SET status='archived', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_routine_runs(pool: State<'_, DbPool>, routine_id: String) -> Result<Vec<RoutineRun>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, RoutineRun>(
        "SELECT id, routine_id, source, status, triggered_at, linked_issue_id, failure_reason, completed_at, created_at FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(&routine_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn trigger_routine(pool: State<'_, DbPool>, company_id: String, routine_id: String) -> Result<RoutineRun, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO routine_runs (id, company_id, routine_id, source) VALUES (?, ?, ?, 'manual')")
        .bind(&id).bind(&company_id).bind(&routine_id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query("UPDATE routines SET last_triggered_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&routine_id).execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, RoutineRun>(
        "SELECT id, routine_id, source, status, triggered_at, linked_issue_id, failure_reason, completed_at, created_at FROM routine_runs WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

// ── Routine Triggers ──

#[derive(Debug, Deserialize)]
pub struct CreateTriggerInput {
    pub kind: String,
    pub label: Option<String>,
    pub cron_expression: Option<String>,
    pub timezone: Option<String>,
}

#[tauri::command]
pub async fn list_routine_triggers(pool: State<'_, DbPool>, routine_id: String) -> Result<Vec<RoutineTrigger>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, RoutineTrigger>(
        "SELECT id, routine_id, kind, label, cron_expression, timezone, next_run_at, last_fired_at, enabled, created_at FROM routine_triggers WHERE routine_id = ? ORDER BY created_at"
    ).bind(&routine_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_routine_trigger(pool: State<'_, DbPool>, company_id: String, routine_id: String, data: CreateTriggerInput) -> Result<RoutineTrigger, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let tz = data.timezone.unwrap_or_else(|| "UTC".to_string());
    sqlx::query("INSERT INTO routine_triggers (id, company_id, routine_id, kind, label, cron_expression, timezone) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&routine_id).bind(&data.kind).bind(&data.label).bind(&data.cron_expression).bind(&tz)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, RoutineTrigger>(
        "SELECT id, routine_id, kind, label, cron_expression, timezone, next_run_at, last_fired_at, enabled, created_at FROM routine_triggers WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_routine_trigger(pool: State<'_, DbPool>, id: String, enabled: Option<bool>, cron_expression: Option<String>) -> Result<RoutineTrigger, String> {
    let p = &pool.0;
    if let Some(e) = enabled {
        sqlx::query("UPDATE routine_triggers SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(e).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    }
    if let Some(cron) = &cron_expression {
        sqlx::query("UPDATE routine_triggers SET cron_expression = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(cron).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    }
    sqlx::query_as::<_, RoutineTrigger>(
        "SELECT id, routine_id, kind, label, cron_expression, timezone, next_run_at, last_fired_at, enabled, created_at FROM routine_triggers WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_routine_trigger(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM routine_triggers WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}
