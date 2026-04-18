use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Approval {
    pub id: String,
    pub company_id: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub approval_type: String,
    pub status: String,
    pub requested_by_agent_id: Option<String>,
    pub decision_note: Option<String>,
    pub decided_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

const APPROVAL_SELECT: &str = "SELECT id, company_id, type, status, requested_by_agent_id, decision_note, decided_at, created_at, updated_at FROM approvals";

#[tauri::command]
pub async fn list_approvals(pool: State<'_, DbPool>, company_id: String, status: Option<String>) -> Result<Vec<Approval>, String> {
    let p = &pool.0;

    let approvals = if let Some(s) = status {
        sqlx::query_as::<_, Approval>(&format!("{} WHERE company_id = ? AND status = ? ORDER BY created_at DESC", APPROVAL_SELECT))
            .bind(&company_id).bind(&s).fetch_all(p).await
    } else {
        sqlx::query_as::<_, Approval>(&format!("{} WHERE company_id = ? ORDER BY created_at DESC", APPROVAL_SELECT))
            .bind(&company_id).fetch_all(p).await
    };
    approvals.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_approval(pool: State<'_, DbPool>, id: String, note: Option<String>) -> Result<Approval, String> {
    let p = &pool.0;
    sqlx::query("UPDATE approvals SET status='approved', decision_note=?, decided_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&note).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    let approval = sqlx::query_as::<_, Approval>(&format!("{} WHERE id = ?", APPROVAL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())?;
    let _ = crate::services::activity::log_activity(p, &approval.company_id, "board", "approval.approved", "approval", Some(&id)).await;
    Ok(approval)
}

#[tauri::command]
pub async fn reject_approval(pool: State<'_, DbPool>, id: String, note: Option<String>) -> Result<Approval, String> {
    let p = &pool.0;
    sqlx::query("UPDATE approvals SET status='rejected', decision_note=?, decided_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .bind(&note).bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    let approval = sqlx::query_as::<_, Approval>(&format!("{} WHERE id = ?", APPROVAL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())?;
    let _ = crate::services::activity::log_activity(p, &approval.company_id, "board", "approval.rejected", "approval", Some(&id)).await;
    Ok(approval)
}

#[tauri::command]
pub async fn create_approval(pool: State<'_, DbPool>, company_id: String, approval_type: String, requested_by: Option<String>) -> Result<Approval, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO approvals (id, company_id, type, requested_by_agent_id) VALUES (?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&approval_type).bind(&requested_by)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Approval>(&format!("{} WHERE id = ?", APPROVAL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}
