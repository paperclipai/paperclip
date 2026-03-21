#[cfg(desktop)]
mod tray;

use tauri::{Emitter, Listener, Manager};

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init());

    // Auto-updater is desktop-only
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // System tray (desktop only)
            #[cfg(desktop)]
            tray::create_tray(app.handle())?;

            // Listen for deep link events and forward to the webview
            let handle = app.handle().clone();
            app.handle().listen("deep-link://new-url", move |event| {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.emit("deep-link", event.payload());
                }
            });

            // Check for updates on launch (desktop only, non-blocking)
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle).await;
                });
            }

            Ok(())
        })
        .on_window_event(|_window, event| {
            // Hide window instead of closing on macOS (keep in tray)
            if let tauri::WindowEvent::CloseRequested { api: _api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _ = _window.hide();
                    _api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Paperclip");
}

#[cfg(desktop)]
async fn check_for_updates(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return,
    };

    match updater.check().await {
        Ok(Some(update)) => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "update-available",
                    serde_json::json!({
                        "version": update.version,
                        "date": update.date.map(|d| d.to_string()),
                    }),
                );
            }
        }
        Ok(None) => {}
        Err(_) => {}
    }
}
