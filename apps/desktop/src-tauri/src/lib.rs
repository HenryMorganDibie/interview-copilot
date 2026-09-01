pub mod loopback;
pub mod loopback_commands;

use loopback_commands::{start_loopback_capture, stop_loopback_capture, LoopbackState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(LoopbackState::default())
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
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
