use tauri::Manager;

mod live_session_outbox;

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

fn restore_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_dock_visibility(true)
        .map_err(|error| error.to_string())?;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    restore_main_window(&app)
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle, hide_dock_icon: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    window.hide().map_err(|error| error.to_string())?;

    if hide_dock_icon {
        #[cfg(target_os = "macos")]
        app.set_dock_visibility(false)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(live_session_outbox::LiveSessionOutboxState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Err(error) = restore_main_window(app) {
                eprintln!("failed to restore main window: {error}");
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            show_main_window,
            hide_main_window,
            live_session_outbox::live_session_outbox_append,
            live_session_outbox::live_session_outbox_list_due,
            live_session_outbox::live_session_outbox_ack,
            live_session_outbox::live_session_outbox_reschedule,
            live_session_outbox::live_session_outbox_count_pending,
            live_session_outbox::live_session_outbox_database_info,
            live_session_outbox::live_session_outbox_rebuild_database
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = _event
        {
            if let Err(error) = restore_main_window(_app) {
                eprintln!("failed to reopen main window: {error}");
            }
        }
    });
}
