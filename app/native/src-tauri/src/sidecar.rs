use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Where the factory is listening, once it has told us.
#[derive(Clone, Default, serde::Serialize)]
pub struct ApiInfo {
    pub port: Option<u16>,
    pub token: String,
}

#[derive(Default)]
pub struct Sidecar {
    pub info: Mutex<ApiInfo>,
    child: Mutex<Option<CommandChild>>,
}

#[derive(serde::Deserialize)]
struct Ready {
    ready: bool,
    port: u16,
}

/// Hands the frontend the port and token it needs to talk to the factory.
///
/// The frontend cannot know either of them ahead of time: the port is chosen
/// by the OS at launch and the token is fresh per launch.
#[tauri::command]
pub fn api_info(state: State<'_, Sidecar>) -> ApiInfo {
    state.info.lock().expect("sidecar state poisoned").clone()
}

/// Spawns the factory and waits for it to say where it is.
///
/// The port is not chosen here. Asking the OS for one up front and passing it
/// down races: another process can take it between the check and the bind. The
/// sidecar binds port 0 and reports what it actually got.
pub fn spawn(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let token = uuid::Uuid::new_v4().to_string();

    let state = app.state::<Sidecar>();
    state.info.lock().expect("sidecar state poisoned").token = token.clone();

    let (mut rx, child) = app
        .shell()
        .sidecar("aalai-core")?
        .args(["--port", "0", "--token", &token])
        .spawn()?;

    *state.child.lock().expect("sidecar state poisoned") = Some(child);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            // Stderr and an early exit are the only clues when the factory
            // refuses to start. Dropping them on the floor turns a config
            // problem into a window that simply never shows any data.
            let line = match event {
                CommandEvent::Stdout(line) => line,
                CommandEvent::Stderr(line) => {
                    log::warn!("factory: {}", String::from_utf8_lossy(&line).trim_end());
                    continue;
                }
                CommandEvent::Terminated(payload) => {
                    log::error!("factory exited early with {:?}", payload.code);
                    continue;
                }
                _ => continue,
            };
            let text = String::from_utf8_lossy(&line);
            // The ready line is a contract, not a log line. Anything else on
            // stdout is the factory's own logging and is not our business.
            let Ok(ready) = serde_json::from_str::<Ready>(text.trim()) else {
                continue;
            };
            if !ready.ready {
                continue;
            }
            let state = handle.state::<Sidecar>();
            state.info.lock().expect("sidecar state poisoned").port = Some(ready.port);
            log::info!("factory ready on port {}", ready.port);
        }
    });

    Ok(())
}

/// Kills the factory.
///
/// Without this a quit leaves an orphaned process holding SQLite claims, and
/// the next launch finds its own issues already claimed by a ghost.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<Sidecar>();
    let taken = {
        let mut guard = state.child.lock().expect("sidecar state poisoned");
        guard.take()
    };
    if let Some(child) = taken {
        let _ = child.kill();
    }
}
