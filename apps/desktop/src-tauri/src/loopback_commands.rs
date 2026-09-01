use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::loopback::run_loopback_capture;

const CHUNK_SECONDS: f32 = 4.0;
const EVENT_NAME: &str = "loopback-audio-chunk";

#[derive(Default)]
pub struct LoopbackState {
    inner: Mutex<Option<LoopbackHandle>>,
}

struct LoopbackHandle {
    stop_flag: Arc<AtomicBool>,
    join_handle: JoinHandle<()>,
}

#[derive(Clone, Serialize)]
struct AudioChunkPayload {
    /// Base64-encoded WAV bytes.
    data_base64: String,
}

#[tauri::command]
pub fn start_loopback_capture(app: AppHandle, state: State<LoopbackState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already running; idempotent
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();

    let join_handle = std::thread::spawn(move || {
        let result = run_loopback_capture(thread_stop_flag, CHUNK_SECONDS, |wav_bytes| {
            let data_base64 = base64::engine::general_purpose::STANDARD.encode(&wav_bytes);
            if let Err(e) = app.emit(EVENT_NAME, AudioChunkPayload { data_base64 }) {
                log::warn!("[loopback] failed to emit audio chunk event: {e}");
            }
        });
        if let Err(e) = result {
            log::error!("[loopback] capture stopped with error: {e}");
        }
    });

    *guard = Some(LoopbackHandle {
        stop_flag,
        join_handle,
    });
    Ok(())
}

#[tauri::command]
pub fn stop_loopback_capture(state: State<LoopbackState>) -> Result<(), String> {
    let handle = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.take()
    };

    if let Some(handle) = handle {
        handle.stop_flag.store(true, Ordering::Relaxed);
        // Capture polls at 50ms intervals internally, so this join returns quickly.
        let _ = handle.join_handle.join();
    }
    Ok(())
}
