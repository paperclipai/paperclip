use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Workflow {
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub graph: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub company_id: String,
    pub status: String,
    pub current_node_id: Option<String>,
    pub state: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkflowInput {
    pub name: String,
    pub description: Option<String>,
    pub graph: Option<String>,
}

const WF_SELECT: &str = "SELECT id, company_id, name, description, status, graph, created_at, updated_at FROM workflows";

#[tauri::command]
pub async fn list_workflows(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<Workflow>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Workflow>(&format!("{} WHERE company_id = ? AND status != 'archived' ORDER BY created_at", WF_SELECT))
        .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workflow(pool: State<'_, DbPool>, id: String) -> Result<Workflow, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Workflow>(&format!("{} WHERE id = ?", WF_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Workflow not found".to_string())
}

#[tauri::command]
pub async fn create_workflow(pool: State<'_, DbPool>, company_id: String, data: CreateWorkflowInput) -> Result<Workflow, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    let graph = data.graph.unwrap_or_else(|| r#"{"nodes":[],"edges":[]}"#.to_string());

    sqlx::query("INSERT INTO workflows (id, company_id, name, description, graph) VALUES (?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&data.name).bind(&data.description).bind(&graph)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Workflow>(&format!("{} WHERE id = ?", WF_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_workflow(pool: State<'_, DbPool>, id: String, name: Option<String>, graph: Option<String>, status: Option<String>) -> Result<Workflow, String> {
    let p = &pool.0;

    let existing = sqlx::query_as::<_, Workflow>(&format!("{} WHERE id = ?", WF_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Workflow not found".to_string())?;

    let n = name.unwrap_or(existing.name);
    let g = graph.unwrap_or(existing.graph);
    let s = status.unwrap_or(existing.status);

    sqlx::query("UPDATE workflows SET name=?, graph=?, status=?, updated_at=datetime('now') WHERE id=?")
        .bind(&n).bind(&g).bind(&s).bind(&id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Workflow>(&format!("{} WHERE id = ?", WF_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_workflow(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE workflows SET status='archived', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn run_workflow(pool: State<'_, DbPool>, company_id: String, workflow_id: String) -> Result<WorkflowRun, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();

    sqlx::query("INSERT INTO workflow_runs (id, workflow_id, company_id) VALUES (?, ?, ?)")
        .bind(&id).bind(&workflow_id).bind(&company_id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, WorkflowRun>(
        "SELECT id, workflow_id, company_id, status, current_node_id, state, started_at, completed_at, error FROM workflow_runs WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workflow_run(pool: State<'_, DbPool>, id: String) -> Result<WorkflowRun, String> {
    let p = &pool.0;
    sqlx::query_as::<_, WorkflowRun>(
        "SELECT id, workflow_id, company_id, status, current_node_id, state, started_at, completed_at, error FROM workflow_runs WHERE id = ?"
    ).bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Workflow run not found".to_string())
}

#[tauri::command]
pub async fn cancel_workflow_run(pool: State<'_, DbPool>, id: String) -> Result<WorkflowRun, String> {
    let p = &pool.0;
    sqlx::query("UPDATE workflow_runs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ? AND status = 'running'")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, WorkflowRun>(
        "SELECT id, workflow_id, company_id, status, current_node_id, state, started_at, completed_at, error FROM workflow_runs WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}
