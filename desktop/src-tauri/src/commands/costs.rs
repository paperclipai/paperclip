use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CostSummary {
    pub total_cost_cents: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub event_count: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CostByAgent {
    pub agent_id: String,
    pub total_cost_cents: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CostByModel {
    pub model: String,
    pub total_cost_cents: i64,
    pub event_count: i64,
}

#[tauri::command]
pub async fn get_cost_summary(pool: State<'_, DbPool>, company_id: String) -> Result<CostSummary, String> {
    let p = &pool.0;

    sqlx::query_as::<_, CostSummary>(
        "SELECT COALESCE(SUM(cost_cents), 0) as total_cost_cents, COALESCE(SUM(input_tokens), 0) as total_input_tokens, COALESCE(SUM(output_tokens), 0) as total_output_tokens, COUNT(*) as event_count FROM cost_events WHERE company_id = ?"
    )
    .bind(&company_id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_costs_by_agent(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<CostByAgent>, String> {
    let p = &pool.0;

    sqlx::query_as::<_, CostByAgent>(
        "SELECT agent_id, COALESCE(SUM(cost_cents), 0) as total_cost_cents, COALESCE(SUM(input_tokens), 0) as total_input_tokens, COALESCE(SUM(output_tokens), 0) as total_output_tokens FROM cost_events WHERE company_id = ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY total_cost_cents DESC"
    )
    .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_costs_by_model(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<CostByModel>, String> {
    let p = &pool.0;

    sqlx::query_as::<_, CostByModel>(
        "SELECT COALESCE(model, 'unknown') as model, COALESCE(SUM(cost_cents), 0) as total_cost_cents, COUNT(*) as event_count FROM cost_events WHERE company_id = ? GROUP BY model ORDER BY total_cost_cents DESC"
    )
    .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

// I1: Dashboard Analytics Commands

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct CostTrendPoint {
    pub date: String,
    pub cost_cents: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RunStats {
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub timed_out: i64,
    pub cancelled: i64,
    pub success_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct AgentUtilization {
    pub agent_id: String,
    pub total_runs: i64,
    pub last_run_at: Option<String>,
}

#[tauri::command]
pub async fn get_cost_trend(pool: State<'_, DbPool>, company_id: String, days: i32) -> Result<Vec<CostTrendPoint>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, CostTrendPoint>(
        "SELECT date(occurred_at) as date, SUM(cost_cents) as cost_cents FROM cost_events WHERE company_id = ? AND occurred_at >= datetime('now', '-' || ? || ' days') GROUP BY date(occurred_at) ORDER BY date"
    ).bind(&company_id).bind(days).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_run_stats(pool: State<'_, DbPool>, company_id: String, days: i32) -> Result<RunStats, String> {
    let p = &pool.0;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = ? AND created_at >= datetime('now', '-' || ? || ' days')")
        .bind(&company_id).bind(days).fetch_one(p).await.map_err(|e| e.to_string())?;
    let succeeded: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = ? AND status = 'succeeded' AND created_at >= datetime('now', '-' || ? || ' days')")
        .bind(&company_id).bind(days).fetch_one(p).await.map_err(|e| e.to_string())?;
    let failed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = ? AND status = 'failed' AND created_at >= datetime('now', '-' || ? || ' days')")
        .bind(&company_id).bind(days).fetch_one(p).await.map_err(|e| e.to_string())?;
    let timed_out: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = ? AND status = 'timed_out' AND created_at >= datetime('now', '-' || ? || ' days')")
        .bind(&company_id).bind(days).fetch_one(p).await.map_err(|e| e.to_string())?;
    let cancelled: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM heartbeat_runs WHERE company_id = ? AND status = 'cancelled' AND created_at >= datetime('now', '-' || ? || ' days')")
        .bind(&company_id).bind(days).fetch_one(p).await.map_err(|e| e.to_string())?;
    let success_rate = if total > 0 { succeeded as f64 / total as f64 } else { 0.0 };
    Ok(RunStats { total, succeeded, failed, timed_out, cancelled, success_rate })
}

#[tauri::command]
pub async fn get_agent_utilization(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<AgentUtilization>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, AgentUtilization>(
        "SELECT agent_id, COUNT(*) as total_runs, MAX(started_at) as last_run_at FROM heartbeat_runs WHERE company_id = ? GROUP BY agent_id ORDER BY total_runs DESC"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

// J2: Budget Policy CRUD

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct BudgetPolicy {
    pub id: String,
    pub company_id: String,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub metric: String,
    pub window_kind: String,
    pub amount: i64,
    pub warn_percent: i32,
    pub hard_stop_enabled: bool,
    pub is_active: bool,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_budget_policies(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<BudgetPolicy>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, BudgetPolicy>(
        "SELECT id, company_id, scope_type, scope_id, metric, window_kind, amount, warn_percent, hard_stop_enabled, is_active, created_at FROM budget_policies WHERE company_id = ? ORDER BY created_at"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_budget_policy(pool: State<'_, DbPool>, company_id: String, scope_type: String, scope_id: Option<String>, amount: i64, warn_percent: Option<i32>, hard_stop: Option<bool>) -> Result<BudgetPolicy, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let warn = warn_percent.unwrap_or(80);
    let hard = hard_stop.unwrap_or(false);
    sqlx::query("INSERT INTO budget_policies (id, company_id, scope_type, scope_id, metric, window_kind, amount, warn_percent, hard_stop_enabled) VALUES (?, ?, ?, ?, 'billed_cents', 'monthly', ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&scope_type).bind(&scope_id).bind(amount).bind(warn).bind(hard)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, BudgetPolicy>(
        "SELECT id, company_id, scope_type, scope_id, metric, window_kind, amount, warn_percent, hard_stop_enabled, is_active, created_at FROM budget_policies WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_budget_policy(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM budget_policies WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}
