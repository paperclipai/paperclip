use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tauri::State;
use uuid::Uuid;

use crate::db::DbPool;

#[derive(Debug, Serialize, Deserialize, Clone, FromRow)]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub family: String,
    pub file_path: String,
    pub file_size_bytes: i64,
    pub quantization: Option<String>,
    pub context_length: Option<i64>,
    pub status: String,
    pub download_progress: f64,
    pub metadata: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub cpu_count: usize,
    pub models_dir: String,
}

const MODEL_SELECT: &str = "SELECT id, name, family, file_path, file_size_bytes, quantization, context_length, status, download_progress, metadata, created_at FROM local_models";

#[tauri::command]
pub async fn list_local_models(pool: State<'_, DbPool>) -> Result<Vec<LocalModel>, String> {
    let p = &pool.0;
    sqlx::query_as::<_, LocalModel>(&format!("{} ORDER BY created_at DESC", MODEL_SELECT))
        .fetch_all(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn register_model(
    pool: State<'_, DbPool>,
    name: String,
    family: String,
    file_path: String,
    file_size_bytes: i64,
    quantization: Option<String>,
    context_length: Option<i64>,
) -> Result<LocalModel, String> {
    let p = &pool.0;
    let id = Uuid::new_v4().to_string();

    sqlx::query("INSERT INTO local_models (id, name, family, file_path, file_size_bytes, quantization, context_length) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id).bind(&name).bind(&family).bind(&file_path)
        .bind(file_size_bytes).bind(&quantization).bind(context_length)
        .execute(p).await.map_err(|e| e.to_string())?;

    sqlx::query_as::<_, LocalModel>(&format!("{} WHERE id = ?", MODEL_SELECT))
        .bind(&id).fetch_one(p).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_model(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    let p = &pool.0;

    let model = sqlx::query_as::<_, LocalModel>(&format!("{} WHERE id = ?", MODEL_SELECT))
        .bind(&id).fetch_optional(p).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Model not found".to_string())?;

    // Remove file
    let _ = std::fs::remove_file(&model.file_path);

    sqlx::query("DELETE FROM local_models WHERE id = ?").bind(&id).execute(p).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    let models_dir = dirs::data_dir()
        .unwrap_or_default()
        .join("com.archonos.app")
        .join("models");

    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_count: std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1),
        models_dir: models_dir.to_string_lossy().to_string(),
    }
}
