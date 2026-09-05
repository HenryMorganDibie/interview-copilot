pub mod backend;
pub mod loopback_commands;

// System-audio (interviewer) capture is native Rust against WASAPI, which
// only exists on Windows. Non-Windows builds compile a stub with the same
// `run_loopback_capture` signature instead (see loopback_stub.rs) so the
// crate builds cross-platform; `loopback_commands.rs` calls it unchanged
// either way, and the frontend already treats a failure to start it as
// non-fatal (mic-only fallback). See the README's Platform Support section.
#[cfg(target_os = "windows")]
pub mod loopback;
#[cfg(not(target_os = "windows"))]
#[path = "loopback_stub.rs"]
pub mod loopback;

use backend::{start_backend, stop_backend, BackendHandle};
use loopback_commands::{start_loopback_capture, stop_loopback_capture, LoopbackState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LoopbackState::default())
    .manage(BackendHandle::default())
    .invoke_handler(tauri::generate_handler![
      start_loopback_capture,
      stop_loopback_capture
    ])
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Runs on a background thread so the window shows immediately —
      // sidecar startup can take a moment and must never block that.
      let app_handle = app.handle().clone();
      std::thread::spawn(move || {
        if let Some(child) = start_backend(&app_handle) {
          let state = app_handle.state::<BackendHandle>();
          *state.0.lock().unwrap() = Some(child);
        }
      });

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        let state = window.state::<BackendHandle>();
        let child = state.0.lock().unwrap().take();
        if let Some(child) = child {
          stop_backend(child);
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
