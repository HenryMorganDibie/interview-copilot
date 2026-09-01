import type { TranscriptEvent } from "./llm.js";

export type AudioSourceKind = "microphone" | "system" | "unknown";

export interface SpeechToTextProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  onTranscript(callback: (event: TranscriptEvent) => void): void;
}
