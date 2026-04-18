use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Project {
    pub id: String,
    pub company_id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub color: Option<String>,
    pub target_date: Option<String>,
    pub lead_agent_id: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub lead_agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub color: Option<String>,
    pub target_date: Option<String>,
    pub lead_agent_id: Option<String>,
}

const PROJECT_SELECT: &str = "SELECT id, company_id, name, description, status, color, target_date, lead_agent_id, archived_at, created_at, updated_at FROM projects";

#[tauri::command]
pub async fn list_projects(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<Project>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Project>(&format!("{} WHERE company_id = ? AND archived_at IS NULL ORDER BY created_at", PROJECT_SELECT))
        .bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_project(pool: State<'_, DbPool>, id: String) -> Result<Project, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Project>(&format!("{} WHERE id = ?", PROJECT_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string())
}

#[tauri::command]
pub async fn create_project(pool: State<'_, DbPool>, company_id: String, data: CreateProjectInput) -> Result<Project, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, company_id, name, description, color, lead_agent_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&data.name).bind(&data.description)
        .bind(&data.color).bind(&data.lead_agent_id)
        .execute(p).await.map_err(|e| e.to_string())?;

    let _ = crate::services::activity::log_activity(p, &company_id, "board", "project.created", "project", Some(&id)).await;

    sqlx::query_as::<_, Project>(&format!("{} WHERE id = ?", PROJECT_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_project(pool: State<'_, DbPool>, id: String, data: UpdateProjectInput) -> Result<Project, String> {
    let p = &pool.0;

    let existing = sqlx::query_as::<_, Project>(&format!("{} WHERE id = ?", PROJECT_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string())?;

    let name = data.name.unwrap_or(existing.name);
    let status = data.status.unwrap_or(existing.status);

    sqlx::query("UPDATE projects SET name=?, description=?, status=?, color=?, target_date=?, lead_agent_id=?, updated_at=datetime('now') WHERE id=?")
        .bind(&name).bind(&data.description).bind(&status).bind(&data.color)
        .bind(&data.target_date).bind(&data.lead_agent_id).bind(&id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Project>(&format!("{} WHERE id = ?", PROJECT_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_project(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE projects SET archived_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ── Project Workspaces ──

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct ProjectWorkspace {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub source_type: String,
    pub cwd: Option<String>,
    pub repo_url: Option<String>,
    pub is_primary: bool,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_project_workspaces(pool: State<'_, DbPool>, project_id: String) -> Result<Vec<ProjectWorkspace>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, ProjectWorkspace>(
        "SELECT id, project_id, name, source_type, cwd, repo_url, is_primary, created_at FROM project_workspaces WHERE project_id = ? ORDER BY created_at"
    ).bind(&project_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_project_workspace(pool: State<'_, DbPool>, company_id: String, project_id: String, name: String, cwd: Option<String>, repo_url: Option<String>) -> Result<ProjectWorkspace, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO project_workspaces (id, company_id, project_id, name, cwd, repo_url) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&project_id).bind(&name).bind(&cwd).bind(&repo_url)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, ProjectWorkspace>(
        "SELECT id, project_id, name, source_type, cwd, repo_url, is_primary, created_at FROM project_workspaces WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn inspect_workspace(pool: State<'_, DbPool>, workspace_id: String) -> Result<crate::services::execution_workspaces::WorkspaceReadiness, String> {
    let p = &pool.0;
    let cwd = sqlx::query_scalar::<_, String>(
        "SELECT cwd FROM execution_workspaces WHERE id = ?"
    ).bind(&workspace_id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or("Workspace not found")?;

    crate::services::execution_workspaces::inspect_workspace_readiness(&cwd).await
}
