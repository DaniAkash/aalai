use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

/// Builds the tray, which is the primary surface of this app.
///
/// The window is where you go when a decision needs more than a click. The
/// tray is where you find out that one is waiting.
pub fn build(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Pause is deliberately absent until the factory exposes a control
    // endpoint for it. A tray item that looks live and does nothing is worse
    // than one that is not there.
    let open = MenuItem::with_id(app, "open", "Open aalai", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit aalai", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id("aalai")
        .icon(app.default_window_icon().expect("no default icon").clone())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => {
                crate::sidecar::shutdown(app);
                app.exit(0)
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
