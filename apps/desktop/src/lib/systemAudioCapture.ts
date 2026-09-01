import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SpeechToTextProvider, TranscriptEvent } from "@interview-copilot/shared";
import { transcribeChunk } from "./apiClient";

type AudioChunkPayload = {
  /** Base64-encoded WAV bytes emitted by the Rust WASAPI loopback capture. */
  data_base64: string;
};

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Captures system/loopback audio (the interviewer's voice over a video
 * call, or anything else playing through the speakers) via a native
 * Rust/WASAPI capture running in the Tauri backend — this can't be done
 * from the webview alone, unlike microphone capture. All transcripts from
 * this provider are labeled "interviewer".
 */
export class SystemAudioCaptureProvider implements SpeechToTextProvider {
  private unlisten: UnlistenFn | null = null;
  private callback: ((event: TranscriptEvent) => void) | null = null;

  onTranscript(callback: (event: TranscriptEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (this.unlisten) return;

    this.unlisten = await listen<AudioChunkPayload>("loopback-audio-chunk", (event) => {
      this.handleChunk(event.payload).catch(() => {});
    });

    try {
      await invoke("start_loopback_capture");
    } catch (err) {
      this.unlisten?.();
      this.unlisten = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    await invoke("stop_loopback_capture").catch(() => {});
    this.unlisten?.();
    this.unlisten = null;
  }

  private async handleChunk(payload: AudioChunkPayload): Promise<void> {
    const blob = base64ToBlob(payload.data_base64, "audio/wav");
    const text = await transcribeChunk(blob);
    if (!text.trim()) return;

    this.callback?.({
      id: crypto.randomUUID(),
      speaker: "interviewer",
      text: text.trim(),
      timestamp: Date.now(),
      isFinal: true,
    });
  }
}
