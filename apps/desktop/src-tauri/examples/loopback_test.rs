use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use app_lib::loopback::run_loopback_capture;

/// Manual verification tool (not part of the app): captures ~12s of system
/// loopback audio and writes each WAV chunk received to
/// %TEMP%\loopback-chunk-N.wav, so a human/test script can inspect them for
/// real captured audio vs silence. Run with: cargo run --example loopback_test
fn main() {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    let handle = thread::spawn(move || {
        let mut count = 0;
        let result = run_loopback_capture(stop_flag_clone, 1.0, |wav_bytes| {
            let path = std::env::temp_dir().join(format!("loopback-chunk-{count}.wav"));
            let mut f = File::create(&path).expect("create chunk file");
            f.write_all(&wav_bytes).expect("write chunk file");
            println!("wrote {} bytes to {:?}", wav_bytes.len(), path);
            count += 1;
        });
        if let Err(e) = result {
            eprintln!("capture error: {e}");
        }
    });

    thread::sleep(Duration::from_secs(12));
    stop_flag.store(true, Ordering::Relaxed);
    handle.join().expect("capture thread panicked");
    println!("done");
}
