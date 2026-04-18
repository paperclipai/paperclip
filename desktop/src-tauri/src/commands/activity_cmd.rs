use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct ActivityEntry {
    pub id: String,
    pub company_id: String,
    pub actor_type: String,
    pub actor_id: Option<String>,
    pub action: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub detail: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_activity(
    pool: State<'_, DbPool>,
    company_id: String,
    entity_type: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ActivityEntry>, String> {
    let p = &pool.0;
    let lim = limit.unwrap_or(100);

    if let Some(et) = entity_type {
        sqlx::query_as::<_, ActivityEntry>(
            "SELECT id, company_id, actor_type, actor_id, action, entity_type, entity_id, detail, created_at FROM activity_log WHERE company_id = ? AND entity_type = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(&company_id).bind(&et).bind(lim).fetch_all(p).await.map_err(|e| e.to_string())
    } else {
        sqlx::query_as::<_, ActivityEntry>(
            "SELECT id, company_id, actor_type, actor_id, action, entity_type, entity_id, detail, created_at FROM activity_log WHERE company_id = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(&company_id).bind(lim).fetch_all(p).await.map_err(|e| e.to_string())
    }
}
