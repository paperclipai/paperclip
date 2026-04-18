use crate::events::{self, AppEvent};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub backend: String,
    pub available: bool,
}

pub fn get_models_dir() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.archonos.app")
        .join("models")
}

pub async fn generate_text(
    _model_path: &str,
    prompt: &str,
    app: &AppHandle,
) -> Result<String, String> {
    // Placeholder: simulate token-by-token generation
    let response = format!("[local-ai placeholder] Received prompt of {} chars", prompt.len());
    let words: Vec<&str> = response.split_whitespace().collect();

    for word in &words {
        events::emit(
            app,
            AppEvent::LocalAiToken {
                text: format!("{word} "),
            },
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    Ok(response)
}

pub fn detect_gpu() -> GpuInfo {
    #[cfg(target_os = "macos")]
    {
        GpuInfo {
            backend: "metal".to_string(),
            available: true,
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        GpuInfo {
            backend: "cpu".to_string(),
            available: false,
        }
    }
}
