use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppSettings {
    pub theme: String,
    pub sidebar_open: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            sidebar_open: true,
        }
    }
}

#[tauri::command]
pub async fn get_settings(pool: State<'_, DbPool>) -> Result<AppSettings, String> {
    let pool = &pool.0;

    let theme = get_setting(pool, "theme").await.unwrap_or_else(|| "system".to_string());
    let sidebar_open = get_setting(pool, "sidebar_open")
        .await
        .map(|v| v == "true")
        .unwrap_or(true);

    Ok(AppSettings { theme, sidebar_open })
}

#[tauri::command]
pub async fn update_settings(
    pool: State<'_, DbPool>,
    settings: AppSettings,
) -> Result<(), String> {
    let pool = &pool.0;

    set_setting(pool, "theme", &settings.theme).await.map_err(|e| e.to_string())?;
    set_setting(pool, "sidebar_open", &settings.sidebar_open.to_string())
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn get_setting(pool: &SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}
