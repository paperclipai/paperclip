//! Tauri commands exposed to the boot window.
//!
//! The board itself runs on the Paperclip origin, so these commands only serve
//! the pre-boot window: report status and retry a failed start.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State, Wry};

use crate::launch;
use crate::server::{ServerHandle, ServerStatus};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub status: ServerStatus,
    pub log_path: String,
}

#[tauri::command]
pub fn boot_info(handle: State<'_, Arc<ServerHandle<Wry>>>) -> BootInfo {
    BootInfo {
        status: handle.status(),
        log_path: handle.log_path().display().to_string(),
    }
}

#[tauri::command]
pub async fn restart_server(
    app: AppHandle,
    handle: State<'_, Arc<ServerHandle<Wry>>>,
) -> Result<u16, String> {
    let port = handle.restart().await?;
    // The board is served by the server, so the window navigates rather than
    // reloading a bundled asset.
    navigate(&app, &launch::base_url(port));
    Ok(port)
}

/// Reveal the log directory in the system file manager.
///
/// The capability is declared for exactly this, and a startup failure is much
/// easier to act on when the log is one click away.
#[tauri::command]
pub fn open_log_folder(handle: State<'_, Arc<ServerHandle<Wry>>>) -> Result<(), String> {
    let path = handle.log_path().to_path_buf();
    let directory = path
        .parent()
        .ok_or("The log path has no parent directory")?;
    // The log may not exist yet — a user can hit this before the first server
    // write — so reveal the directory rather than the file.
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .or_else(|_| {
            tauri_plugin_opener::open_path(directory.to_string_lossy().to_string(), None::<&str>)
        })
        .map_err(|err| format!("Could not open the log folder: {err}"))
}

/// Point the window at the running board.
pub fn navigate(app: &AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("boot") {
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
    }
}

/// Reveal the window once the board can answer, so startup never shows a blank
/// frame and a failed start leaves the diagnostics visible.
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("boot") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
