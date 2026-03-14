use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder};

// ── Constants ─────────────────────────────────────────────────────────────────────

const PORT_SCAN_TIMEOUT_MS: u64 = 150;
const PORT_SCAN_START_DELAY_SEC: u64 = 2;
const SERVER_START_TIMEOUT_SEC: u32 = 90;
const WINDOW_INITIAL_WIDTH: f64 = 640.0;
const WINDOW_INITIAL_HEIGHT: f64 = 580.0;
const WINDOW_NORMAL_WIDTH: f64 = 1280.0;
const WINDOW_NORMAL_HEIGHT: f64 = 800.0;
const WINDOW_MIN_WIDTH: f64 = 800.0;
const WINDOW_MIN_HEIGHT: f64 = 600.0;

const COMMON_PORTS: &[u16] = &[3000, 3001, 3100, 4000, 4200, 5173, 5174, 8000, 8080, 8888, 9000];

const SYSTEM_PATHS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const PNPM_CANDIDATES: &[(&str, &str)] = &[
    ("Library/pnpm", "/opt/homebrew/bin"),
    (".local/share/pnpm", "/usr/local/bin"),
];

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Config {
    project_root: String,
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .expect("no home dir")
        .join(".config/paperclip-desktop/config.json")
}

fn load_config() -> Option<Config> {
    let content = fs::read_to_string(config_path()).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_config(config: &Config) -> std::io::Result<()> {
    let path = config_path();
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(path, serde_json::to_string_pretty(config).unwrap())
}

// ── Server process state ──────────────────────────────────────────────────────

struct ServerState(Arc<Mutex<Option<Child>>>);

impl Drop for ServerState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                kill_process_group(&mut child);
            }
        }
    }
}

/// Kill the entire process group spawned for the server child.
/// Because we use `.process_group(0)`, the child's PGID equals its PID,
/// so `kill -- -<pgid>` terminates all descendants (pnpm, tsx, node, postgres…).
fn kill_process_group(child: &mut Child) {
    let pgid = child.id();
    let _ = Command::new("kill")
        .args(["-9", &format!("-{pgid}")])
        .status();
    let _ = child.kill(); // belt-and-suspenders for the direct child
    let _ = child.wait();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn detect_default_path() -> Option<String> {
    let home = dirs::home_dir()?;
    [
        home.join("Documents/projects/personal/paperclip"),
        home.join("Developer/paperclip"),
        home.join("projects/paperclip"),
        home.join("paperclip"),
    ]
    .into_iter()
    .find(|p| p.join("package.json").exists())
    .map(|p| p.to_string_lossy().into_owned())
}

/// Build a PATH string that includes pnpm and the current NVM node,
/// so the server can be started without a login shell.
fn build_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let mut dirs_list: Vec<String> = vec![];

    // pnpm
    for (rel_path, fallback) in PNPM_CANDIDATES {
        let candidate = home.join(rel_path);
        if candidate.join("pnpm").exists() {
            dirs_list.push(candidate.to_string_lossy().into_owned());
            break;
        }
        // Also try fallback system path
        let fallback_path = PathBuf::from(fallback);
        if fallback_path.join("pnpm").exists() {
            dirs_list.push(fallback_path.to_string_lossy().into_owned());
            break;
        }
    }

    // NVM node — read ~/.nvm/alias/default to find the active version
    if let Some(node_bin) = find_nvm_node_bin(&home) {
        dirs_list.push(node_bin.to_string_lossy().into_owned());
    }

    // Standard system paths
    dirs_list.extend(SYSTEM_PATHS.iter().map(|s| s.to_string()));

    dirs_list.join(":")
}

/// Find the NVM node binary directory.
/// Tries the default alias first (with and without 'v' prefix),
/// then falls back to the highest version available.
fn find_nvm_node_bin(home: &PathBuf) -> Option<PathBuf> {
    let nvm_dir = home.join(".nvm");
    let alias = fs::read_to_string(nvm_dir.join("alias/default"))
        .ok()?
        .trim()
        .to_string();

    let node_versions_dir = nvm_dir.join("versions/node");

    // Try without 'v' prefix first (e.g., "22.15.0" -> "22.15.0/bin")
    let without_v = node_versions_dir.join(&alias).join("bin");
    if without_v.exists() {
        return Some(without_v);
    }

    // Try with 'v' prefix (e.g., "22.15.0" -> "v22.15.0/bin")
    let with_v = node_versions_dir.join(format!("v{alias}")).join("bin");
    if with_v.exists() {
        return Some(with_v);
    }

    // Fall back: pick the highest version available
    let mut versions: Vec<PathBuf> = fs::read_dir(&node_versions_dir)
        .ok()?
        .flatten()
        .map(|e| e.path().join("bin"))
        .filter(|p| p.exists())
        .collect();
    versions.sort();
    versions.pop()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for inner in chars.by_ref() {
                if inner.is_alphabetic() { break; }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_url_with_http_prefix() {
        assert_eq!(
            extract_url("Server started at http://localhost:3100"),
            Some("http://localhost:3100".to_string())
        );
        assert_eq!(
            extract_url("Visit http://127.0.0.1:3000 for the app"),
            Some("http://localhost:3000".to_string())
        );
    }

    #[test]
    fn test_extract_url_without_http_prefix() {
        assert_eq!(
            extract_url("Server listening on 127.0.0.1:3100"),
            Some("http://127.0.0.1:3100".to_string())
        );
        assert_eq!(
            extract_url("[32mINFO[39m: Server listening on 127.0.0.1:3100"),
            Some("http://127.0.0.1:3100".to_string())
        );
        assert_eq!(
            extract_url("Listening on localhost:3000"),
            Some("http://localhost:3000".to_string())
        );
        assert_eq!(
            extract_url("0.0.0.0:8080 - Server ready"),
            Some("http://localhost:8080".to_string())
        );
    }

    #[test]
    fn test_extract_url_no_match() {
        assert_eq!(extract_url("Some random log message"), None);
        assert_eq!(extract_url("Error: something went wrong"), None);
    }

    #[test]
    fn test_extract_url_prefers_ui_over_api() {
        // When both UI and API URLs are present, prefer the UI URL (without /api)
        let line = "[2mAPI             [0m http://127.0.0.1:3100/api [2m(health: http://127.0.0.1:3100/api/health)[0m
[2mUI              [0m http://127.0.0.1:3100";
        assert_eq!(
            extract_url(line),
            Some("http://localhost:3100".to_string()) // 127.0.0.1 is normalized to localhost
        );
    }

    #[test]
    fn test_extract_api_url_only() {
        // When only API URL is present, it should be extracted
        // (but the scanner logic will skip navigation to it)
        let line = "[2mAPI             [0m http://127.0.0.1:3100/api [2m(health: http://127.0.0.1:3100/api/health)[0m";
        assert_eq!(
            extract_url(line),
            Some("http://localhost:3100/api".to_string())
        );
    }
}

/// Try to extract a localhost URL from a log line.
/// Handles http:// URLs as well as bare host:port patterns (e.g., "Server listening on 127.0.0.1:3100").
/// Prefers UI URLs (without /api path) over API URLs.
fn extract_url(line: &str) -> Option<String> {
    let clean = strip_ansi(line);

    // Collect all matching URLs from the line
    let mut urls: Vec<String> = Vec::new();

    // First, try to match explicit http(s):// URLs
    for prefix in &["http://localhost:", "https://localhost:", "http://127.0.0.1:", "http://0.0.0.0:"] {
        let mut search_start = 0;
        while let Some(start) = clean[search_start..].find(prefix) {
            let actual_start = search_start + start;
            let rest = &clean[actual_start..];
            let end = rest
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '>' | ')' | ']'))
                .unwrap_or(rest.len());
            let url = rest[..end].trim_end_matches('/');
            if url.len() > prefix.len() {
                let normalized = url.replace("127.0.0.1", "localhost").replace("0.0.0.0", "localhost");
                urls.push(normalized);
            }
            search_start = actual_start + end;
        }
    }

    // Fallback: match "Server listening on HOST:PORT" or similar patterns
    let clean_lower = clean.to_lowercase();
    if clean_lower.contains("listening") || clean_lower.contains("server") {
        let patterns = [
            ("127.0.0.1:", "http://127.0.0.1:"),
            ("localhost:", "http://localhost:"),
            ("0.0.0.0:", "http://localhost:"), // 0.0.0.0 -> localhost for browser access
        ];

        for (host_pattern, url_prefix) in &patterns {
            if let Some(start) = clean.find(host_pattern) {
                let rest = &clean[start..];
                // Extract port number (digits until whitespace or end)
                let port_start = host_pattern.len();
                let port_end = rest[port_start..]
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(rest.len() - port_start);
                let port = &rest[port_start..port_start + port_end];

                if !port.is_empty() {
                    urls.push(format!("{}{}", url_prefix, port));
                }
            }
        }
    }

    // Prefer URLs without /api path (UI URLs over API URLs)
    urls.sort_by(|a, b| {
        let a_has_api = a.contains("/api");
        let b_has_api = b.contains("/api");
        if a_has_api && !b_has_api {
            std::cmp::Ordering::Greater
        } else if !a_has_api && b_has_api {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Equal
        }
    });

    urls.into_iter().next()
}

/// Probe a single port with a short timeout (non-blocking feel).
fn port_open(port: u16) -> bool {
    let addr: std::net::SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(PORT_SCAN_TIMEOUT_MS)).is_ok()
}

fn scan_ports() -> Option<u16> {
    COMMON_PORTS.iter().copied().find(|&p| port_open(p))
}

/// Navigate the main window using JavaScript (more reliable than Rust navigate()).
fn navigate_to(handle: &AppHandle, url: &str) {
    eprintln!("[desktop] navigating to {url}");
    let h = handle.clone();
    let url = url.to_string();
    let _ = handle.run_on_main_thread(move || {
        if let Some(w) = h.get_webview_window("main") {
            let js = format!(
                "window.location.replace({})",
                serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".to_string()),
            );
            let _ = w.eval(&js);
            let _ = w.set_size(LogicalSize::new(WINDOW_NORMAL_WIDTH, WINDOW_NORMAL_HEIGHT));
            let _ = w.set_min_size(Some(LogicalSize::new(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)));
            let _ = w.set_resizable(true);
            let _ = w.center();
        }
    });
}

/// Send a short status line to the loading screen.
fn emit_log(handle: &AppHandle, msg: &str) {
    let _ = handle.emit("server-log", msg.to_string());
}

fn emit_error(handle: &AppHandle, msg: &str) {
    eprintln!("[desktop] error: {msg}");
    let _ = handle.emit("server-error", msg.to_string());
}

fn spawn_server(project_root: &str, handle: AppHandle) -> Result<Child, String> {
    let root = PathBuf::from(project_root);
    if !root.exists() {
        return Err(format!("Directory not found: {project_root}"));
    }
    if !root.join("package.json").exists() {
        return Err(format!("No package.json found in:\n{project_root}"));
    }

    let path_env = build_path();
    let safe_root = project_root.replace('\'', r"'\''");
    let cmd = format!("cd '{safe_root}' && pnpm dev");

    eprintln!("[desktop] project: {project_root}");
    eprintln!("[desktop] PATH:    {path_env}");
    eprintln!("[desktop] cmd:     {cmd}");

    let mut child = Command::new("/bin/sh")
        .args(["-c", &cmd])
        .env("PATH", &path_env)
        .env("PAPERCLIP_MIGRATION_PROMPT", "never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // new process group so we can kill all descendants
        .spawn()
        .map_err(|e| format!("Failed to start server: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let done = Arc::new(AtomicBool::new(false));

    // Scan stdout + stderr for a localhost URL
    let make_scanner = |stream: Box<dyn std::io::Read + Send>,
                        handle: AppHandle,
                        done: Arc<AtomicBool>| {
        thread::spawn(move || {
            for raw in BufReader::new(stream).lines().flatten() {
                eprintln!("[server] {raw}");
                emit_log(&handle, &raw);

                if !done.load(Ordering::Relaxed) {
                    if let Some(url) = extract_url(&raw) {
                        // Only mark as done and navigate if it's not an API URL
                        // (API URLs may appear before UI URLs in logs)
                        if !url.contains("/api") {
                            if done
                                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                                .is_ok()
                            {
                                navigate_to(&handle, &url);
                            }
                        }
                    }
                }
            }
        })
    };

    make_scanner(Box::new(stdout), handle.clone(), Arc::clone(&done));
    make_scanner(Box::new(stderr), handle.clone(), Arc::clone(&done));

    // Fallback: poll common ports every second, starting after delay
    let done_fb = Arc::clone(&done);
    let handle_fb = handle.clone();
    thread::spawn(move || {
        let mut elapsed = 0u32;
        thread::sleep(Duration::from_secs(PORT_SCAN_START_DELAY_SEC));

        loop {
            if done_fb.load(Ordering::Relaxed) { return; }

            if let Some(port) = scan_ports() {
                if done_fb
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    eprintln!("[desktop] port scanner found :{port}");
                    navigate_to(&handle_fb, &format!("http://localhost:{port}"));
                }
                return;
            }

            elapsed += 1;
            emit_log(&handle_fb, &format!("Waiting for server… ({elapsed}s)"));

            if elapsed >= SERVER_START_TIMEOUT_SEC {
                if !done_fb.load(Ordering::Relaxed) {
                    emit_error(&handle_fb, &format!("Server did not start within {SERVER_START_TIMEOUT_SEC} seconds."));
                }
                return;
            }
            thread::sleep(Duration::from_secs(1));
        }
    });

    Ok(child)
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct AppStatus {
    has_config: bool,
    default_path: Option<String>,
}

#[tauri::command]
fn get_status() -> AppStatus {
    let config = load_config();
    let has_config = config.is_some();
    AppStatus {
        has_config,
        default_path: config.map(|c| c.project_root).or_else(detect_default_path),
    }
}

#[tauri::command]
async fn launch(
    path: String,
    state: State<'_, ServerState>,
    app: AppHandle,
) -> Result<(), String> {
    save_config(&Config { project_root: path.clone() }).map_err(|e| e.to_string())?;
    let child = spawn_server(&path, app)?;
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(mut old) = guard.take() {
            kill_process_group(&mut old);
        }
        *guard = Some(child);
    }
    Ok(())
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServerState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![get_status, launch])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Paperclip")
                .inner_size(WINDOW_INITIAL_WIDTH, WINDOW_INITIAL_HEIGHT)
                .resizable(false)
                .center()
                .on_navigation(|url| {
                    let host = url.host_str().unwrap_or("");
                    let is_local = matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "");
                    if !is_local {
                        let _ = open::that(url.as_str());
                        false // prevent webview navigation, open in system browser
                    } else {
                        true
                    }
                })
                .build()?;

            if let Some(config) = load_config() {
                let server_arc = Arc::clone(&app.state::<ServerState>().0);
                match spawn_server(&config.project_root, app.handle().clone()) {
                    Ok(child) => *server_arc.lock().unwrap() = Some(child),
                    Err(e) => {
                        let _ = fs::remove_file(config_path());
                        let handle = app.handle().clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(800));
                            emit_error(&handle, &e);
                        });
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.app_handle().webview_windows().is_empty() {
                    // Explicitly kill the child before exit — exit(0) skips Drop impls.
                    if let Some(state) = window.app_handle().try_state::<ServerState>() {
                        if let Ok(mut guard) = state.0.lock() {
                            if let Some(mut child) = guard.take() {
                                kill_process_group(&mut child);
                            }
                        }
                    }
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
