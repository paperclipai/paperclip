//! Paperclip desktop shell.
//!
//! The shape follows unsloth-studio: the native shell owns the backend
//! process, waits for it to become healthy, and then shows the app. What
//! differs is what gets loaded — Paperclip's own server serves its board, so the
//! window navigates to that origin once it answers, and no separate frontend
//! build ships in the bundle.
//!
//! Before that point the window shows a local boot page (`../ui`) carrying the
//! startup status, so a slow first migration or a missing server reads as a
//! sentence instead of a white screen.

mod commands;
mod launch;
mod server;

use std::path::PathBuf;

use tauri::{Manager, RunEvent, WindowEvent};

use server::ServerHandle;

/// Where server output goes. Under the platform app-data directory so an
/// installed build does not try to write next to its own bundle.
fn log_path(app: &tauri::AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("paperclip-desktop"));
    base.join("paperclip-server.log")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let log_path = log_path(&handle);
            server::install(&handle, ServerHandle::new(handle.clone(), log_path));

            let startup_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = startup_handle.state::<std::sync::Arc<ServerHandle<tauri::Wry>>>();
                match state.start().await {
                    Ok(port) => {
                        commands::navigate(&startup_handle, &launch::base_url(port));
                        commands::show(&startup_handle);
                    }
                    Err(err) => {
                        // Retain the failure as well as logging it: the boot
                        // window can load after this runs, and a status nobody
                        // received leaves it spinning with nothing to report.
                        server::record_shell_failure(
                            state.log_path(),
                            &format!("startup failed: {err}"),
                        );
                        state.fail(err);
                        commands::show(&startup_handle);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window quits the app, and quitting must reap the
            // server. The job object / child stop in the exit hook is the
            // backstop for a kill that never reaches here.
            if let WindowEvent::CloseRequested { .. } = event {
                server::stop_on_exit(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot_info,
            commands::restart_server,
            commands::open_log_folder
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Paperclip desktop app")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                server::stop_on_exit(app);
            }
        });
}
