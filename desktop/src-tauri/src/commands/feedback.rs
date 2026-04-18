use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;
use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct FeedbackVote {
    pub id: String,
    pub company_id: String,
    pub target_type: String,
    pub target_id: String,
    pub vote: String,
    pub reason: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn vote_on_target(
    pool: State<'_, DbPool>,
    company_id: String,
    target_type: String,
    target_id: String,
    vote: String,
    reason: Option<String>,
) -> Result<FeedbackVote, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();

    // Upsert: delete existing vote then insert new one
    let _ = sqlx::query("DELETE FROM feedback_votes WHERE target_type = ? AND target_id = ?")
        .bind(&target_type).bind(&target_id).execute(p).await;

    sqlx::query("INSERT INTO feedback_votes (id, company_id, target_type, target_id, vote, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&company_id).bind(&target_type).bind(&target_id).bind(&vote).bind(&reason)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, FeedbackVote>(
        "SELECT id, company_id, target_type, target_id, vote, reason, created_at FROM feedback_votes WHERE id = ?"
    ).bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_vote_for_target(
    pool: State<'_, DbPool>,
    target_type: String,
    target_id: String,
) -> Result<Option<FeedbackVote>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, FeedbackVote>(
        "SELECT id, company_id, target_type, target_id, vote, reason, created_at FROM feedback_votes WHERE target_type = ? AND target_id = ?"
    ).bind(&target_type).bind(&target_id)
        .fetch_optional(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_votes(pool: State<'_, DbPool>, company_id: String) -> Result<Vec<FeedbackVote>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, FeedbackVote>(
        "SELECT id, company_id, target_type, target_id, vote, reason, created_at FROM feedback_votes WHERE company_id = ? ORDER BY created_at DESC"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_feedback_json(pool: State<'_, DbPool>, company_id: String) -> Result<String, String> {
    let p = &pool.0;
    let votes = sqlx::query_as::<_, FeedbackVote>(
        "SELECT id, company_id, target_type, target_id, vote, reason, created_at FROM feedback_votes WHERE company_id = ? ORDER BY created_at"
    ).bind(&company_id).fetch_all(p).await.map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&votes).map_err(|e| e.to_string())
}
