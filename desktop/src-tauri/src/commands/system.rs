#[tauri::command]
pub fn health_check() -> String {
    "ok".to_string()
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, serde::Serialize)]
pub struct AdapterTestResult {
    pub available: bool,
    pub version: Option<String>,
    pub command: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_adapter(adapter_type: String) -> Result<AdapterTestResult, String> {
    let cmd = match adapter_type.as_str() {
        "claude_local" => "claude",
        "codex_local" => "codex",
        "cursor_local" => "cursor",
        "gemini_local" => "gemini",
        "opencode_local" => "opencode",
        _ => {
            return Ok(AdapterTestResult {
                available: false,
                version: None,
                command: adapter_type,
                error: Some("Unknown adapter type".into()),
            })
        }
    };

    // Check if command exists
    let which = tokio::process::Command::new("which")
        .arg(cmd)
        .output()
        .await;
    match which {
        Ok(output) if output.status.success() => {
            // Try to get version
            let version_output = tokio::process::Command::new(cmd)
                .arg("--version")
                .output()
                .await;
            let version = version_output
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
            Ok(AdapterTestResult {
                available: true,
                version,
                command: cmd.to_string(),
                error: None,
            })
        }
        _ => Ok(AdapterTestResult {
            available: false,
            version: None,
            command: cmd.to_string(),
            error: Some(format!(
                "CLI tool '{}' not found on PATH. Install it first.",
                cmd
            )),
        }),
    }
}

#[tauri::command]
pub fn get_mcp_config() -> Result<String, String> {
    // Try to find the archonos-mcp binary
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe_path.parent().unwrap_or(std::path::Path::new("."));
    let mcp_path = dir.join("archonos-mcp");

    let path_str = if mcp_path.exists() {
        mcp_path.to_string_lossy().to_string()
    } else {
        // Fallback: check if it's on PATH
        "archonos-mcp".to_string()
    };

    let config = serde_json::json!({
        "mcpServers": {
            "archonos": {
                "command": path_str,
                "args": []
            }
        }
    });

    serde_json::to_string_pretty(&config).map_err(|e| e.to_string())
}
