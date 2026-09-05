use std::process::Command;
use std::sync::Mutex;

/// Hardcoded to this machine's repo location. The installed app isn't a
/// fully self-contained package yet (the Node API server and Docker
/// Postgres aren't bundled into the installer) — this lets the *installed*
/// app auto-start both anyway, but only works on this machine. A real
/// distributable build would need the API bundled as a sidecar binary and
/// Postgres embedded (e.g. SQLite) instead of relying on a known dev path.
const REPO_ROOT: &str = r"C:\KINGHENRYMORGAN_ANALYTICS\interview-copilot";

pub struct BackendHandle(pub Mutex<Option<u32>>);

impl Default for BackendHandle {
    fn default() -> Self {
        BackendHandle(Mutex::new(None))
    }
}

/// Starts Postgres (via `docker compose up -d`, idempotent — a no-op if
/// already running) and the Node API server, so the installed app works
/// the moment it's opened instead of requiring two manual terminal
/// commands first. Best-effort: failures here just mean the app falls
/// back to needing those commands run manually, same as before — this
/// never blocks the window from showing.
#[cfg(target_os = "windows")]
pub fn start_backend() -> Option<u32> {
    let compose_path = format!("{REPO_ROOT}\\infra\\docker-compose.yml");
    let compose_result = Command::new("cmd")
        .args(["/C", "docker", "compose", "-f", &compose_path, "up", "-d"])
        .output();

    // Docker daemon likely isn't running at all — try launching Docker
    // Desktop and give it a moment, then retry once.
    if compose_result.is_err() || !compose_result.map(|o| o.status.success()).unwrap_or(false) {
        let _ = Command::new("cmd")
            .args(["/C", "start", "", r"C:\Program Files\Docker\Docker\Docker Desktop.exe"])
            .output();
        std::thread::sleep(std::time::Duration::from_secs(20));
        let _ = Command::new("cmd")
            .args(["/C", "docker", "compose", "-f", &compose_path, "up", "-d"])
            .output();
    }

    let api_dir = format!("{REPO_ROOT}\\apps\\api");
    Command::new("cmd")
        .args(["/C", "npx", "tsx", "src/server.ts"])
        .current_dir(&api_dir)
        .spawn()
        .ok()
        .map(|child| child.id())
}

/// Kills the API server's whole process tree (cmd.exe -> npx -> node) —
/// killing just the cmd.exe PID leaves the actual node process running on
/// Windows, since process.kill() doesn't recurse into children.
#[cfg(target_os = "windows")]
pub fn stop_backend(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
}

/// Non-Windows builds don't auto-start the backend at all yet — the
/// Windows path above is hardcoded to a dev-machine repo path and shells
/// out to `cmd`/`taskkill`, neither of which exist elsewhere. Rather than
/// let those calls fail one by one after a real delay (the Windows version
/// sleeps 20s waiting for Docker Desktop before giving up), this returns
/// immediately: run `docker compose -f infra/docker-compose.yml up -d` and
/// `npm run dev --workspace=apps/api` yourself before opening the app. See
/// the README's Platform Support section.
#[cfg(not(target_os = "windows"))]
pub fn start_backend() -> Option<u32> {
    log::warn!(
        "[backend] auto-start isn't implemented on this platform yet — start Postgres and \
         apps/api manually (see the README's Setup section)."
    );
    None
}

#[cfg(not(target_os = "windows"))]
pub fn stop_backend(_pid: u32) {}
