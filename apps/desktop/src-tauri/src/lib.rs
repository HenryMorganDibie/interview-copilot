pub mod backend;
pub mod loopback;
pub mod loopback_commands;

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
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Runs on a background thread so the window shows immediately —
      // Docker/API startup can take a few seconds and must never block that.
      let app_handle = app.handle().clone();
      std::thread::spawn(move || {
        if let Some(pid) = start_backend() {
          let state = app_handle.state::<BackendHandle>();
          *state.0.lock().unwrap() = Some(pid);
        }
      });

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { .. } = event {
        let state = window.state::<BackendHandle>();
        let pid = state.0.lock().unwrap().take();
        if let Some(pid) = pid {
          stop_backend(pid);
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
