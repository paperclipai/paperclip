use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Issue {
    pub id: String,
    pub company_id: String,
    pub project_id: Option<String>,
    pub issue_number: i64,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub assignee_agent_id: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateIssueInput {
    pub title: String,
    pub description: Option<String>,
    pub project_id: Option<String>,
    pub priority: Option<String>,
    pub assignee_agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateIssueInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee_agent_id: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct IssueComment {
    pub id: String,
    pub issue_id: String,
    pub author_agent_id: Option<String>,
    pub author_user_id: Option<String>,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
}

const ISSUE_SELECT: &str = "SELECT id, company_id, project_id, issue_number, identifier, title, description, status, priority, assignee_agent_id, started_at, completed_at, created_at, updated_at FROM issues";

#[tauri::command]
pub async fn list_issues(pool: State<'_, DbPool>, company_id: String, status: Option<String>) -> Result<Vec<Issue>, String> {
    let p = &pool.0;

    let issues = if let Some(s) = status {
        sqlx::query_as::<_, Issue>(&format!("{} WHERE company_id = ? AND status = ? AND hidden_at IS NULL ORDER BY created_at DESC", ISSUE_SELECT))
            .bind(&company_id).bind(&s).fetch_all(p).await
    } else {
        sqlx::query_as::<_, Issue>(&format!("{} WHERE company_id = ? AND hidden_at IS NULL ORDER BY created_at DESC", ISSUE_SELECT))
            .bind(&company_id).fetch_all(p).await
    };

    issues.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_issue(pool: State<'_, DbPool>, id: String) -> Result<Issue, String> {
    let p = &pool.0;

    sqlx::query_as::<_, Issue>(&format!("{} WHERE id = ?", ISSUE_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Issue not found".to_string())
}

#[tauri::command]
pub async fn create_issue(pool: State<'_, DbPool>, company_id: String, data: CreateIssueInput) -> Result<Issue, String> {
    let p = &pool.0;

    let id = Uuid::new_v4().to_string();
    let priority = data.priority.unwrap_or_else(|| "medium".to_string());

    // Get next issue number
    let next_num: i64 = sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE company_id = ?")
        .bind(&company_id).fetch_one(p).await.map_err(|e| e.to_string())?;

    // Get company prefix for identifier
    let prefix: String = sqlx::query_scalar::<_, String>("SELECT issue_prefix FROM companies WHERE id = ?")
        .bind(&company_id).fetch_one(p).await.map_err(|e| e.to_string())?;

    let identifier = format!("{}-{}", prefix, next_num);

    sqlx::query(
        "INSERT INTO issues (id, company_id, project_id, issue_number, identifier, title, description, priority, assignee_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&company_id).bind(&data.project_id).bind(next_num)
    .bind(&identifier).bind(&data.title).bind(&data.description)
    .bind(&priority).bind(&data.assignee_agent_id)
    .execute(p).await.map_err(|e| e.to_string())?;

    let _ = crate::services::activity::log_activity(p, &company_id, "board", "issue.created", "issue", Some(&id)).await;

    sqlx::query_as::<_, Issue>(&format!("{} WHERE id = ?", ISSUE_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_issue(pool: State<'_, DbPool>, id: String, data: UpdateIssueInput) -> Result<Issue, String> {
    let p = &pool.0;

    let existing = sqlx::query_as::<_, Issue>(&format!("{} WHERE id = ?", ISSUE_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Issue not found".to_string())?;

    // Validate status transition if status is changing
    if let Some(ref requested) = data.status {
        if *requested != existing.status {
            crate::services::execution_policy::validate_transition(&existing.status, requested)?;
        }
    }

    let title = data.title.unwrap_or(existing.title);
    let status = data.status.unwrap_or(existing.status);
    let priority = data.priority.unwrap_or(existing.priority);

    sqlx::query("UPDATE issues SET title=?, description=?, status=?, priority=?, assignee_agent_id=?, project_id=?, updated_at=datetime('now') WHERE id=?")
        .bind(&title).bind(&data.description).bind(&status).bind(&priority)
        .bind(&data.assignee_agent_id).bind(&data.project_id).bind(&id)
        .execute(p).await.map_err(|e| e.to_string())?;

    let _ = crate::services::activity::log_activity(p, &existing.company_id, "board", "issue.updated", "issue", Some(&id)).await;

    sqlx::query_as::<_, Issue>(&format!("{} WHERE id = ?", ISSUE_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_issue(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("UPDATE issues SET hidden_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_issue_comments(pool: State<'_, DbPool>, issue_id: String) -> Result<Vec<IssueComment>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, IssueComment>("SELECT id, issue_id, author_agent_id, author_user_id, body, created_at, updated_at FROM issue_comments WHERE issue_id = ? ORDER BY created_at")
        .bind(&issue_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_issue_comment(pool: State<'_, DbPool>, company_id: String, issue_id: String, body: String) -> Result<IssueComment, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO issue_comments (id, company_id, issue_id, author_user_id, body) VALUES (?, ?, ?, 'board', ?)")
        .bind(&id).bind(&company_id).bind(&issue_id).bind(&body)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, IssueComment>("SELECT id, issue_id, author_agent_id, author_user_id, body, created_at, updated_at FROM issue_comments WHERE id = ?")
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_issues(pool: State<'_, DbPool>, company_id: String, query: String) -> Result<Vec<Issue>, String> {
    let p = &pool.0;
    let pattern = format!("%{}%", query);
    sqlx::query_as::<_, Issue>(&format!("{} WHERE company_id = ? AND hidden_at IS NULL AND (title LIKE ? OR identifier LIKE ?) ORDER BY created_at DESC LIMIT 50", ISSUE_SELECT))
        .bind(&company_id).bind(&pattern).bind(&pattern)
        .fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn checkout_issue(pool: State<'_, DbPool>, id: String, agent_id: String, _run_id: String) -> Result<Issue, String> {
    let p = &pool.0;
    sqlx::query("UPDATE issues SET status = 'in_progress', assignee_agent_id = ?, started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now') WHERE id = ?")
        .bind(&agent_id).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Issue>(&format!("{} WHERE id = ?", ISSUE_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_issue_comment(pool: State<'_, DbPool>, comment_id: String, body: String) -> Result<IssueComment, String> {
    let p = &pool.0;
    sqlx::query("UPDATE issue_comments SET body = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(&body).bind(&comment_id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, IssueComment>("SELECT id, issue_id, author_agent_id, author_user_id, body, created_at, updated_at FROM issue_comments WHERE id = ?")
        .bind(&comment_id).fetch_one(p).await.map_err(|e| e.to_string())
}
