import { useCallback, useEffect, useRef, useState } from "react";
import type { InterviewAnswer, SpeechToTextProvider, TranscriptEvent } from "@interview-copilot/shared";
import { LiveSessionOrchestrator } from "@interview-copilot/interview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MicCaptureProvider } from "@/lib/micCapture";
import { SystemAudioCaptureProvider } from "@/lib/systemAudioCapture";
import { analyzeQuestion, generateAnswerStream } from "@/lib/apiClient";
import { getResponseMode, getJobDescription } from "@/lib/settings";

type SessionState = "idle" | "listening" | "mic-error";

const SPEAKER_LABEL: Record<TranscriptEvent["speaker"], string> = {
  user: "You",
  interviewer: "Interviewer",
  unknown: "Unknown",
};

export function LiveInterviewPage() {
  const [state, setState] = useState<SessionState>("idle");
  const [transcript, setTranscript] = useState<TranscriptEvent[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [answer, setAnswer] = useState<InterviewAnswer | null>(null);
  const [generating, setGenerating] = useState(false);

  const providersRef = useRef<SpeechToTextProvider[]>([]);
  const orchestratorRef = useRef<LiveSessionOrchestrator | null>(null);

  useEffect(() => {
    return () => {
      orchestratorRef.current?.dispose();
      for (const provider of providersRef.current) {
        provider.stop().catch(() => {});
      }
    };
  }, []);

  const handleStart = useCallback(async () => {
    setErrorMessage(null);
    setCurrentQuestion(null);
    setAnswerText("");
    setAnswer(null);

    const jobDescription = getJobDescription() || undefined;

    const orchestrator = new LiveSessionOrchestrator({
      sessionId: crypto.randomUUID(),
      responseMode: getResponseMode(),
      jobDescription,
      analyzeQuestion,
      generateAnswer: generateAnswerStream,
      onTranscript: (event) => setTranscript((prev) => [...prev, event]),
      onQuestionDetected: (question) => {
        setCurrentQuestion(question.text);
        setAnswerText("");
        setAnswer(null);
        setGenerating(true);
      },
      onAnswerDelta: (delta) => setAnswerText((prev) => prev + delta),
      onAnswerComplete: (finalAnswer) => {
        setAnswer(finalAnswer);
        setGenerating(false);
      },
      onError: (message) => {
        setGenerating(false);
        setErrorMessage(message);
      },
    });
    orchestratorRef.current = orchestrator;

    const onEvent = (event: TranscriptEvent) => orchestrator.handleTranscript(event);

    const mic = new MicCaptureProvider();
    mic.onTranscript(onEvent);
    const system = new SystemAudioCaptureProvider(jobDescription);
    system.onTranscript(onEvent);

    const started: SpeechToTextProvider[] = [];
    const startErrors: string[] = [];

    try {
      await mic.start();
      started.push(mic);
    } catch {
      startErrors.push("microphone");
    }

    try {
      await system.start();
      started.push(system);
    } catch {
      // Non-fatal: the app still works with mic-only capture.
      startErrors.push("system audio");
    }

    providersRef.current = started;

    if (started.length === 0) {
      orchestratorRef.current = null;
      setState("mic-error");
      setErrorMessage(
        "Couldn't access the microphone or system audio. Check permissions and try again.",
      );
      return;
    }

    setState("listening");
    if (startErrors.length > 0) {
      setErrorMessage(
        `Listening, but couldn't start: ${startErrors.join(", ")}. The rest is still working.`,
      );
    }
  }, []);

  const handleStop = useCallback(async () => {
    orchestratorRef.current?.dispose();
    orchestratorRef.current = null;
    await Promise.all(providersRef.current.map((p) => p.stop()));
    providersRef.current = [];
    setState("idle");
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-8 py-4">
        <p className="text-sm font-semibold">Interview Copilot</p>
        <div className="flex items-center gap-3">
          <Badge variant={state === "listening" ? "default" : "secondary"} className="gap-1.5">
            <span
              className={
                state === "listening"
                  ? "size-2 rounded-full bg-current animate-pulse"
                  : "size-2 rounded-full bg-muted-foreground"
              }
            />
            {state === "listening" ? "Listening" : state === "mic-error" ? "Mic error" : "Idle"}
          </Badge>
          {state === "listening" ? (
            <Button size="sm" variant="outline" onClick={handleStop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={handleStart}>
              Start listening
            </Button>
          )}
        </div>
      </div>

      {errorMessage ? (
        <div className="border-b border-border bg-destructive/10 px-8 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Question
          </p>
          <p className="mt-2 text-lg">
            {currentQuestion ?? "Waiting for the interviewer to ask a question..."}
          </p>
        </section>

        <Separator />

        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Say this
          </p>
          {answerText || generating ? (
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">
              {answerText}
              {generating ? <span className="animate-pulse">▍</span> : null}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing to show yet. Start listening to begin.
            </p>
          )}
        </section>

        <Separator />

        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Key points
          </p>
          {answer && answer.keyPoints.length > 0 ? (
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
              {answer.keyPoints.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">-</p>
          )}
        </section>

        <Separator />

        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence
          </p>
          {answer && answer.sources.length > 0 ? (
            <div className="mt-2 space-y-1">
              {answer.sources.map((source, i) => (
                <p key={i} className="text-sm">
                  {source.sourceName}{" "}
                  <span className="text-xs text-muted-foreground">
                    (confidence: {source.confidence >= 0.6 ? "High" : source.confidence >= 0.35 ? "Medium" : "Low"})
                  </span>
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">-</p>
          )}
        </section>

        <Separator />

        <section>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Transcript
          </p>
          <ScrollArea className="mt-2 h-40 rounded-md border border-border p-3">
            {transcript.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing captured yet. Both your microphone and system audio (the interviewer's
                voice over a call) are transcribed once you start listening.
              </p>
            ) : (
              <ul className="space-y-2">
                {transcript.map((event) => (
                  <li key={event.id} className="text-sm">
                    <span className="text-xs text-muted-foreground">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{" "}
                    <span className="font-medium">{SPEAKER_LABEL[event.speaker]}:</span>{" "}
                    {event.text}
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </section>
      </div>
    </div>
  );
}
