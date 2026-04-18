#[tauri::command]
pub async fn set_secret(key: String, value: String) -> Result<(), String> {
    // Delete existing first (ignore error)
    let _ = tokio::process::Command::new("security")
        .args(["delete-generic-password", "-a", "archonos", "-s", &key])
        .output()
        .await;

    let output = tokio::process::Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            "archonos",
            "-s",
            &key,
            "-w",
            &value,
        ])
        .output()
        .await
        .map_err(|e| format!("Keychain error: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to store secret: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn get_secret(key: String) -> Result<String, String> {
    let output = tokio::process::Command::new("security")
        .args(["find-generic-password", "-a", "archonos", "-s", &key, "-w"])
        .output()
        .await
        .map_err(|e| format!("Keychain error: {}", e))?;

    if !output.status.success() {
        return Err(format!("Secret '{}' not found", key));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string())
}

#[tauri::command]
pub async fn delete_secret(key: String) -> Result<(), String> {
    let _ = tokio::process::Command::new("security")
        .args(["delete-generic-password", "-a", "archonos", "-s", &key])
        .output()
        .await;
    Ok(())
}

#[tauri::command]
pub async fn list_secret_keys() -> Result<Vec<String>, String> {
    // Return well-known secret key names that are configured
    let known_keys = vec![
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GITHUB_TOKEN",
    ];

    let mut found = Vec::new();
    for key in known_keys {
        let output = tokio::process::Command::new("security")
            .args(["find-generic-password", "-a", "archonos", "-s", key, "-w"])
            .output()
            .await;
        if let Ok(o) = output {
            if o.status.success() {
                found.push(key.to_string());
            }
        }
    }
    Ok(found)
}

/// Internal helper for use by other services (not a Tauri command)
pub async fn get_secret_internal(key: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("security")
        .args(["find-generic-password", "-a", "archonos", "-s", key, "-w"])
        .output()
        .await
        .map_err(|e| format!("Keychain error: {}", e))?;

    if !output.status.success() {
        return Err(format!("Secret '{}' not found", key));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_string())
}
