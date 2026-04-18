use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct Plugin {
    pub id: String,
    pub plugin_key: String,
    pub package_name: Option<String>,
    pub version: Option<String>,
    pub api_version: i64,
    pub categories: String,
    pub status: String,
    pub package_path: Option<String>,
    pub last_error: Option<String>,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct PluginConfig {
    pub id: String,
    pub plugin_id: String,
    pub config_json: String,
    pub last_error: Option<String>,
}

const PLUGIN_SELECT: &str = "SELECT id, plugin_key, package_name, version, api_version, categories, status, package_path, last_error, installed_at, updated_at FROM plugins";

#[tauri::command]
pub async fn list_plugins(pool: State<'_, DbPool>) -> Result<Vec<Plugin>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, Plugin>(&format!("{} ORDER BY install_order, installed_at", PLUGIN_SELECT))
        .fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_plugin(pool: State<'_, DbPool>, plugin_key: String, package_path: Option<String>) -> Result<Plugin, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();

    sqlx::query("INSERT INTO plugins (id, plugin_key, package_path) VALUES (?, ?, ?)")
        .bind(&id).bind(&plugin_key).bind(&package_path)
        .execute(p).await.map_err(|e| e.to_string())?;

    let config_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO plugin_config (id, plugin_id) VALUES (?, ?)")
        .bind(&config_id).bind(&id)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, Plugin>(&format!("{} WHERE id = ?", PLUGIN_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn uninstall_plugin(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;
    sqlx::query("DELETE FROM plugins WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn enable_plugin(pool: State<'_, DbPool>, id: String) -> Result<Plugin, String> {
    let p = &pool.0;
    sqlx::query("UPDATE plugins SET status='active', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Plugin>(&format!("{} WHERE id = ?", PLUGIN_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disable_plugin(pool: State<'_, DbPool>, id: String) -> Result<Plugin, String> {
    let p = &pool.0;
    sqlx::query("UPDATE plugins SET status='disabled', updated_at=datetime('now') WHERE id=?")
        .bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, Plugin>(&format!("{} WHERE id = ?", PLUGIN_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_plugin_config(pool: State<'_, DbPool>, plugin_id: String) -> Result<PluginConfig, String> {
    let p = &pool.0;
    sqlx::query_as::<_, PluginConfig>("SELECT id, plugin_id, config_json, last_error FROM plugin_config WHERE plugin_id = ?")
        .bind(&plugin_id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Plugin config not found".to_string())
}

#[tauri::command]
pub async fn update_plugin_config(pool: State<'_, DbPool>, plugin_id: String, config_json: String) -> Result<PluginConfig, String> {
    let p = &pool.0;
    sqlx::query("UPDATE plugin_config SET config_json=?, updated_at=datetime('now') WHERE plugin_id=?")
        .bind(&config_json).bind(&plugin_id)
        .execute(p).await.map_err(|e| e.to_string())?;
    sqlx::query_as::<_, PluginConfig>("SELECT id, plugin_id, config_json, last_error FROM plugin_config WHERE plugin_id = ?")
        .bind(&plugin_id).fetch_one(p).await.map_err(|e| e.to_string())
}
