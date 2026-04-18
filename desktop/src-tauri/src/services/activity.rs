use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn log_activity(
    pool: &SqlitePool,
    company_id: &str,
    actor_type: &str,
    action: &str,
    entity_type: &str,
    entity_id: Option<&str>,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO activity_log (id, company_id, actor_type, action, entity_type, entity_id) VALUES (?,?,?,?,?,?)"
    )
    .bind(&id).bind(company_id).bind(actor_type).bind(action).bind(entity_type).bind(entity_id)
    .execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}
