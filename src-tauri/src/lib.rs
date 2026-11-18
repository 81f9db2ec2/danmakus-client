use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

mod live_session_outbox;

const PROXY_CONFIG_FILE_NAME: &str = "proxy-config.json";

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredProxyConfig {
    proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyStatusDto {
    startup_proxy_url: Option<String>,
    configured_proxy_url: Option<String>,
}

struct ProxyRuntimeState {
    startup_proxy_url: Option<String>,
    configured_proxy_url: Mutex<Option<String>>,
}

fn proxy_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(PROXY_CONFIG_FILE_NAME))
}

fn normalize_proxy_url(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(text) = raw else {
        return Ok(None);
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let parsed = tauri::Url::parse(trimmed).map_err(|e| format!("无效的代理地址: {e}"))?;
    match parsed.scheme() {
        "http" | "socks5" => {}
        scheme => return Err(format!("不支持的代理协议: {scheme}，仅支持 http 或 socks5")),
    }
    if parsed.host_str().is_none() || parsed.port().is_none() {
        return Err("代理地址必须包含主机与端口".to_owned());
    }

    Ok(Some(trimmed.to_owned()))
}

fn load_stored_proxy_url(app: &AppHandle) -> Option<String> {
    let path = proxy_config_path(app).ok()?;
    let content = fs::read_to_string(path).ok()?;
    let parsed: StoredProxyConfig = serde_json::from_str(&content).ok()?;
    normalize_proxy_url(parsed.proxy_url).ok().flatten()
}

fn save_stored_proxy_url(app: &AppHandle, proxy_url: Option<&str>) -> Result<(), String> {
    let path = proxy_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = StoredProxyConfig {
        proxy_url: proxy_url.map(ToOwned::to_owned),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_proxy_status(state: State<'_, ProxyRuntimeState>) -> Result<ProxyStatusDto, String> {
    let configured = state
        .configured_proxy_url
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    Ok(ProxyStatusDto {
        startup_proxy_url: state.startup_proxy_url.clone(),
        configured_proxy_url: configured,
    })
}

#[tauri::command]
fn set_proxy_config(
    app: AppHandle,
    state: State<'_, ProxyRuntimeState>,
    proxy_url: Option<String>,
) -> Result<ProxyStatusDto, String> {
    let normalized = normalize_proxy_url(proxy_url)?;
    save_stored_proxy_url(&app, normalized.as_deref())?;
    {
        let mut guard = state.configured_proxy_url.lock().map_err(|e| e.to_string())?;
        *guard = normalized.clone();
    }
    Ok(ProxyStatusDto {
        startup_proxy_url: state.startup_proxy_url.clone(),
        configured_proxy_url: normalized,
    })
}

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
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "tray.quit" {
                app.exit(0);
            }
        })
        .manage(live_session_outbox::LiveSessionOutboxState::default())
        .setup(|app| {
            let startup_proxy_url = load_stored_proxy_url(app.handle());
            app.manage(ProxyRuntimeState {
                startup_proxy_url: startup_proxy_url.clone(),
                configured_proxy_url: Mutex::new(startup_proxy_url.clone()),
            });

            if let Some(window_config) = app.config().app.windows.first().cloned() {
                let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
                if let Some(proxy_url) = startup_proxy_url
                    .as_deref()
                    .and_then(|value| tauri::Url::parse(value).ok())
                {
                    builder = builder.proxy_url(proxy_url);
                }
                builder.build()?;
            }

            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Err(error) = restore_main_window(app) {
                eprintln!("failed to restore main window: {error}");
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            show_main_window,
            hide_main_window,
            get_proxy_status,
            set_proxy_config,
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
