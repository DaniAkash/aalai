mod sidecar;
mod tray;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sidecar::Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar::api_info])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // No dock icon: this lives in the menu bar. The window still
            // shows on launch, because an app that starts with no window and
            // no dock presence is indistinguishable from one that failed to
            // start, which is exactly how it was first reported.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::build(app.handle())?;
            sidecar::spawn(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it. Quitting is a tray decision, so the
            // red button must not kill a factory that is mid run.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the aalai app")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                sidecar::shutdown(app);
            }
        });
}
