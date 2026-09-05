use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

pub struct BackendHandle(pub Mutex<Option<CommandChild>>);

impl Default for BackendHandle {
    fn default() -> Self {
        BackendHandle(Mutex::new(None))
    }
}

/// Starts the bundled API server as a Tauri sidecar (see
/// scripts/build-api-sidecar.mjs -- a standalone executable with the
/// Node runtime baked in, no separate Node install or node_modules
/// needed). Runs on this machine's real app-data directory, not a
/// hardcoded repo path, so this now works on any machine the installer
/// runs on -- the previous version shelled out to `npx tsx` from a path
/// only the original dev machine had.
///
/// The database (SQLite, see packages/database) needs no separate server
/// or Docker -- it's just a file, created automatically on first launch
/// inside the app's data directory.
///
/// Known gap: provider API keys (Groq, GitHub PAT, Tavily) still come
/// from a `.env` file, now read from the app's config directory instead
/// of a repo checkout -- but nothing creates that file for a first-time
/// user who isn't the original developer. Until there's a real in-app
/// settings UI for entering a Groq key, a fresh install has a working
/// knowledge base/UI but no LLM-powered features unless the user places
/// a `.env` there themselves or runs Ollama locally.
#[cfg(target_os = "windows")]
pub fn start_backend(app: &AppHandle) -> Option<CommandChild> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let app_config_dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&app_data_dir).ok()?;
    std::fs::create_dir_all(&app_config_dir).ok()?;

    let database_path = app_data_dir.join("interview-copilot.db");
    let env_file_path = app_config_dir.join(".env");

    let (_rx, child) = app
        .shell()
        .sidecar("interview-copilot-api")
        .ok()?
        .env("DATABASE_PATH", database_path.to_string_lossy().to_string())
        .env("ENV_FILE_PATH", env_file_path.to_string_lossy().to_string())
        .spawn()
        .ok()?;

    Some(child)
}

#[cfg(target_os = "windows")]
pub fn stop_backend(child: CommandChild) {
    let _ = child.kill();
}

/// Non-Windows builds don't auto-start the backend at all yet -- the
/// bundled sidecar binary is only built for Windows today (see
/// scripts/build-api-sidecar.mjs). Start apps/api manually (see the
/// README's Setup section).
#[cfg(not(target_os = "windows"))]
pub fn start_backend(_app: &AppHandle) -> Option<CommandChild> {
    log::warn!(
        "[backend] sidecar auto-start isn't implemented on this platform yet -- start apps/api \
         manually (see the README's Setup section)."
    );
    None
}

#[cfg(not(target_os = "windows"))]
pub fn stop_backend(_child: CommandChild) {}
