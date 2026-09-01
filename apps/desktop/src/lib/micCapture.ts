import type { SpeechToTextProvider, TranscriptEvent } from "@interview-copilot/shared";
import { transcribeChunk } from "./apiClient";

/**
 * How long each recorded segment is before it's sent off for transcription.
 * MediaRecorder chunks aren't independently decodable except the first, so
 * segments are recorded as discrete start/stop cycles rather than one
 * continuous stream — this is the simplest robust approach for an MVP and
 * trades a small gap between segments for reliability. A future revision
 * can move to VAD-based (silence-triggered) segmentation instead of a
 * fixed interval.
 */
const SEGMENT_MS = 4_000;
/** Segments smaller than this are almost certainly silence; skip the transcription call. */
const MIN_BLOB_BYTES = 2_000;

/**
 * Captures microphone audio only (candidate's own voice) — this app does
 * not yet support system/loopback audio capture for the interviewer's
 * voice, which would require a native Tauri/Rust plugin (WASAPI loopback
 * on Windows). All transcripts from this provider are labeled "user".
 */
export class MicCaptureProvider implements SpeechToTextProvider {
  private stream: MediaStream | null = null;
  private stopped = true;
  private callback: ((event: TranscriptEvent) => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  onTranscript(callback: (event: TranscriptEvent) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped && this.stream) {
      const blob = await this.recordSegment(this.stream);
      if (this.stopped) break;
      if (blob.size >= MIN_BLOB_BYTES) {
        // Fire-and-forget: never let one failed transcription stall capture of the next segment.
        this.transcribeAndEmit(blob).catch(() => {});
      }
    }
  }

  private recordSegment(stream: MediaStream): Promise<Blob> {
    return new Promise((resolve) => {
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => resolve(new Blob(chunks, { type: "audio/webm" }));
      recorder.start();
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, SEGMENT_MS);
    });
  }

  private async transcribeAndEmit(blob: Blob): Promise<void> {
    const text = await transcribeChunk(blob);
    if (!text.trim()) return;

    this.callback?.({
      id: crypto.randomUUID(),
      speaker: "user",
      text: text.trim(),
      timestamp: Date.now(),
      isFinal: true,
    });
  }
}
