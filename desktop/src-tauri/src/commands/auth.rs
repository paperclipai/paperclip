use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AdapterAuthStatus {
    pub adapter_type: String,
    pub cli_installed: bool,
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub email: Option<String>,
    pub subscription_type: Option<String>,
    pub api_key_configured: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LoginResult {
    pub success: bool,
    pub login_url: Option<String>,
    pub message: String,
}

fn adapter_cli_command(adapter_type: &str) -> Option<&str> {
    match adapter_type {
        "claude_local" => Some("claude"),
        "codex_local" => Some("codex"),
        "cursor_local" => Some("cursor"),
        "gemini_local" => Some("gemini"),
        "opencode_local" => Some("opencode"),
        _ => None,
    }
}

async fn is_cli_installed(cmd: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(cmd)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn has_api_key_in_keychain(adapter_type: &str) -> bool {
    let key_name = match adapter_type {
        "claude_local" => "ANTHROPIC_API_KEY",
        "codex_local" => "OPENAI_API_KEY",
        "cursor_local" => "CURSOR_API_KEY",
        "gemini_local" => "GEMINI_API_KEY",
        _ => return false,
    };
    crate::commands::secrets::get_secret_internal(key_name)
        .await
        .is_ok()
}

#[tauri::command]
pub async fn check_adapter_auth(adapter_type: String) -> Result<AdapterAuthStatus, String> {
    // Ollama has its own flow — no CLI command mapping needed
    if adapter_type == "ollama_local" {
        return check_ollama_auth(adapter_type).await;
    }

    let cmd = adapter_cli_command(&adapter_type)
        .ok_or_else(|| format!("Unknown adapter: {}", adapter_type))?;
    let cmd = cmd.to_string();

    let cli_installed = is_cli_installed(&cmd).await;
    let api_key_configured = has_api_key_in_keychain(&adapter_type).await;

    if !cli_installed {
        return Ok(AdapterAuthStatus {
            adapter_type,
            cli_installed: false,
            logged_in: false,
            auth_method: None,
            email: None,
            subscription_type: None,
            api_key_configured,
            error: Some(format!("CLI '{}' not found on PATH", cmd)),
        });
    }

    // Per-adapter login detection
    match adapter_type.as_str() {
        "claude_local" => check_claude_auth(adapter_type, api_key_configured).await,
        "codex_local" => check_codex_auth(adapter_type, api_key_configured).await,
        "cursor_local" => check_cursor_auth(adapter_type, api_key_configured).await,
        "gemini_local" => check_gemini_auth(adapter_type, api_key_configured).await,
        _ => Ok(AdapterAuthStatus {
            adapter_type,
            cli_installed: true,
            logged_in: api_key_configured,
            auth_method: if api_key_configured {
                Some("api".into())
            } else {
                None
            },
            email: None,
            subscription_type: None,
            api_key_configured,
            error: None,
        }),
    }
}

async fn check_ollama_auth(
    adapter_type: String,
) -> Result<AdapterAuthStatus, String> {
    let cli_installed = is_cli_installed("ollama").await;
    if !cli_installed {
        return Ok(AdapterAuthStatus {
            adapter_type,
            cli_installed: false,
            logged_in: false,
            auth_method: None,
            email: None,
            subscription_type: None,
            api_key_configured: false,
            error: Some("CLI 'ollama' not found on PATH. Install from https://ollama.com".into()),
        });
    }

    // Check if Ollama server is running
    let server_running = reqwest::get("http://localhost:11434/api/tags")
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    if !server_running {
        return Ok(AdapterAuthStatus {
            adapter_type,
            cli_installed: true,
            logged_in: false,
            auth_method: None,
            email: None,
            subscription_type: None,
            api_key_configured: false,
            error: Some("Ollama server not running. Start it with `ollama serve` or launch the Ollama app.".into()),
        });
    }

    // Check if any models are pulled
    let has_models = tokio::process::Command::new("ollama")
        .arg("list")
        .output()
        .await
        .map(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // Header line + at least one model line = more than 1 line
            stdout.lines().count() > 1
        })
        .unwrap_or(false);

    Ok(AdapterAuthStatus {
        adapter_type,
        cli_installed: true,
        logged_in: has_models,
        auth_method: Some("local".into()),
        email: None,
        subscription_type: Some("free".into()),
        api_key_configured: false,
        error: if !has_models {
            Some("No models pulled. Click 'Login' to pull the default model.".into())
        } else {
            None
        },
    })
}

async fn check_claude_auth(
    adapter_type: String,
    api_key_configured: bool,
) -> Result<AdapterAuthStatus, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("claude")
            .args(["auth", "status"])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(o)) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                let logged_in = parsed
                    .get("loggedIn")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let auth_method = parsed
                    .get("authMethod")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let sub_type = parsed
                    .get("subscriptionType")
                    .and_then(|v| v.as_str())
                    .map(String::from);

                let effective_method = if api_key_configured {
                    Some("api".into())
                } else {
                    auth_method
                };

                Ok(AdapterAuthStatus {
                    adapter_type,
                    cli_installed: true,
                    logged_in: logged_in || api_key_configured,
                    auth_method: effective_method,
                    email: None,
                    subscription_type: sub_type,
                    api_key_configured,
                    error: None,
                })
            } else {
                Ok(AdapterAuthStatus {
                    adapter_type,
                    cli_installed: true,
                    logged_in: api_key_configured,
                    auth_method: if api_key_configured {
                        Some("api".into())
                    } else {
                        None
                    },
                    email: None,
                    subscription_type: None,
                    api_key_configured,
                    error: Some("Could not parse auth status".into()),
                })
            }
        }
        _ => Ok(AdapterAuthStatus {
            adapter_type,
            cli_installed: true,
            logged_in: api_key_configured,
            auth_method: if api_key_configured {
                Some("api".into())
            } else {
                None
            },
            email: None,
            subscription_type: None,
            api_key_configured,
            error: if !api_key_configured {
                Some(
                    "Not logged in. Click 'Login' or run `claude login` in terminal.".into(),
                )
            } else {
                None
            },
        }),
    }
}

async fn check_codex_auth(
    adapter_type: String,
    api_key_configured: bool,
) -> Result<AdapterAuthStatus, String> {
    let auth_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".codex")
        .join("auth.json");
    let logged_in = if auth_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&auth_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                parsed
                    .get("tokens")
                    .and_then(|t| t.get("access_token"))
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
                    || parsed
                        .get("accessToken")
                        .and_then(|v| v.as_str())
                        .map(|s| !s.is_empty())
                        .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        }
    } else {
        false
    };

    let sub_type = if auth_path.exists() {
        std::fs::read_to_string(&auth_path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| {
                v.get("chatgpt_plan_type")
                    .and_then(|p| p.as_str())
                    .map(String::from)
            })
    } else {
        None
    };

    Ok(AdapterAuthStatus {
        adapter_type,
        cli_installed: true,
        logged_in: logged_in || api_key_configured,
        auth_method: if api_key_configured {
            Some("api".into())
        } else if logged_in {
            Some("subscription".into())
        } else {
            None
        },
        email: None,
        subscription_type: sub_type,
        api_key_configured,
        error: None,
    })
}

async fn check_cursor_auth(
    adapter_type: String,
    api_key_configured: bool,
) -> Result<AdapterAuthStatus, String> {
    let config_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".cursor")
        .join("cli-config.json");
    let (logged_in, email) = if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                let email = parsed
                    .get("authInfo")
                    .and_then(|a| a.get("email"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                (email.is_some(), email)
            } else {
                (false, None)
            }
        } else {
            (false, None)
        }
    } else {
        (false, None)
    };

    Ok(AdapterAuthStatus {
        adapter_type,
        cli_installed: true,
        logged_in: logged_in || api_key_configured,
        auth_method: if api_key_configured {
            Some("api".into())
        } else if logged_in {
            Some("subscription".into())
        } else {
            None
        },
        email,
        subscription_type: None,
        api_key_configured,
        error: None,
    })
}

async fn check_gemini_auth(
    adapter_type: String,
    api_key_configured: bool,
) -> Result<AdapterAuthStatus, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new("gemini")
            .args(["auth", "status"])
            .output(),
    )
    .await;

    let logged_in = matches!(output, Ok(Ok(o)) if o.status.success());

    Ok(AdapterAuthStatus {
        adapter_type,
        cli_installed: true,
        logged_in: logged_in || api_key_configured,
        auth_method: if api_key_configured {
            Some("api".into())
        } else if logged_in {
            Some("subscription".into())
        } else {
            None
        },
        email: None,
        subscription_type: None,
        api_key_configured,
        error: None,
    })
}

// === Login / Logout ===

#[tauri::command]
pub async fn adapter_login(adapter_type: String) -> Result<LoginResult, String> {
    // Ollama login: check server then pull default model
    if adapter_type == "ollama_local" {
        if !is_cli_installed("ollama").await {
            return Err("CLI 'ollama' not installed. Install from https://ollama.com".into());
        }
        let server_running = reqwest::get("http://localhost:11434/api/tags")
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !server_running {
            return Err("Ollama server not running. Start it with `ollama serve` or launch the Ollama app.".into());
        }
        let pull_result = tokio::time::timeout(
            std::time::Duration::from_secs(900),
            tokio::process::Command::new("ollama")
                .args(["pull", "gemma4:e4b"])
                .output(),
        )
        .await;
        return match pull_result {
            Ok(Ok(o)) if o.status.success() => Ok(LoginResult {
                success: true,
                login_url: None,
                message: "Model gemma4:e4b pulled successfully!".into(),
            }),
            Ok(Ok(o)) => Ok(LoginResult {
                success: false,
                login_url: None,
                message: format!(
                    "Model pull failed with code {}. {}",
                    o.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&o.stderr)
                ),
            }),
            Ok(Err(e)) => Err(format!("Failed to start model pull: {}", e)),
            Err(_) => Err("Model pull timed out after 15 minutes.".into()),
        };
    }

    let (cmd, args): (&str, Vec<&str>) = match adapter_type.as_str() {
        "claude_local" => ("claude", vec!["login"]),
        "codex_local" => ("codex", vec!["auth"]),
        "cursor_local" => ("cursor", vec!["login"]),
        "gemini_local" => ("gemini", vec!["auth", "login"]),
        _ => return Err(format!("Unknown adapter: {}", adapter_type)),
    };

    if !is_cli_installed(cmd).await {
        return Err(format!("CLI '{}' not installed. Install it first.", cmd));
    }

    // Spawn login process — blocks until user completes browser auth (120s timeout)
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new(cmd).args(&args).output(),
    )
    .await;

    match result {
        Ok(Ok(o)) if o.status.success() => Ok(LoginResult {
            success: true,
            login_url: None,
            message: "Login successful!".into(),
        }),
        Ok(Ok(o)) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            let url = extract_auth_url(&combined);
            Ok(LoginResult {
                success: false,
                login_url: url,
                message: format!(
                    "Login process exited with code {}. Check your browser.",
                    o.status.code().unwrap_or(-1)
                ),
            })
        }
        Ok(Err(e)) => Err(format!("Failed to start login: {}", e)),
        Err(_) => Err(
            "Login timed out after 2 minutes. Try running the login command in your terminal."
                .into(),
        ),
    }
}

#[tauri::command]
pub async fn adapter_logout(adapter_type: String) -> Result<(), String> {
    match adapter_type.as_str() {
        "claude_local" => {
            let _ = tokio::process::Command::new("claude")
                .args(["auth", "logout"])
                .output()
                .await;
        }
        "codex_local" => {
            let path = dirs::home_dir()
                .unwrap_or_default()
                .join(".codex")
                .join("auth.json");
            let _ = std::fs::remove_file(path);
        }
        "cursor_local" => {
            let path = dirs::home_dir()
                .unwrap_or_default()
                .join(".cursor")
                .join("cli-config.json");
            let _ = std::fs::remove_file(path);
        }
        "gemini_local" => {
            let _ = tokio::process::Command::new("gemini")
                .args(["auth", "logout"])
                .output()
                .await;
        }
        "ollama_local" => {
            // No credentials to remove for local Ollama
        }
        _ => return Err("Unknown adapter".into()),
    }
    Ok(())
}

fn extract_auth_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| {
            word.starts_with("http")
                && (word.contains("auth")
                    || word.contains("login")
                    || word.contains("oauth")
                    || word.contains("anthropic")
                    || word.contains("openai")
                    || word.contains("google"))
        })
        .map(|s| {
            s.trim_matches(|c: char| {
                !c.is_alphanumeric()
                    && c != ':'
                    && c != '/'
                    && c != '.'
                    && c != '-'
                    && c != '_'
                    && c != '?'
                    && c != '='
                    && c != '&'
            })
            .to_string()
        })
}
