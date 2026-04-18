use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder},
    Manager,
};

pub fn create_tray(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let _tray = TrayIconBuilder::new()
        .tooltip("ArchonOS")
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
