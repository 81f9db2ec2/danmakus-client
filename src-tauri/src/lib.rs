use std::fs;
use tauri::Manager;

const LIVE_SESSION_OUTBOX_DATABASE_PATH: &str = "live-session-outbox.sqlite3";

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

#[tauri::command]
fn reset_live_session_outbox(app: tauri::AppHandle) -> Result<(), String> {
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法获取应用配置目录: {error}"))?;

    let database_path = app_config_dir.join(LIVE_SESSION_OUTBOX_DATABASE_PATH);
    let wal_path = app_config_dir.join(format!("{LIVE_SESSION_OUTBOX_DATABASE_PATH}-wal"));
    let shm_path = app_config_dir.join(format!("{LIVE_SESSION_OUTBOX_DATABASE_PATH}-shm"));

    for path in [database_path, wal_path, shm_path] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("删除数据库文件失败 {}: {error}", path.display()));
            }
        }
    }

    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            greet,
            open_devtools,
            reset_live_session_outbox
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
