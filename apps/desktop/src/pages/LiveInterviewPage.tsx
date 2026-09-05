import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronLeft } from "lucide-react";
import type { InterviewAnswer, SpeechToTextProvider, TranscriptEvent } from "@interview-copilot/shared";
import { LiveSessionOrchestrator } from "@interview-copilot/interview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MicCaptureProvider } from "@/lib/micCapture";
import { SystemAudioCaptureProvider } from "@/lib/systemAudioCapture";
import { analyzeQuestion, generateAnswerStream } from "@/lib/apiClient";
import { getResponseMode, getJobDescription } from "@/lib/settings";
import { cn } from "@/lib/utils";

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
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [currentQuestion, setCurrentQuestion] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [answer, setAnswer] = useState<InterviewAnswer | null>(null);
  const [generating, setGenerating] = useState(false);

  const providersRef = useRef<SpeechToTextProvider[]>([]);
  const orchestratorRef = useRef<LiveSessionOrchestrator | null>(null);
  /**
   * Tracks whether the turn currently generating is a continuation of the
   * previous one (the orchestrator classified it "follow_up"/"clarification"
   * — typically a compound question that got split across a pause longer
   * than the silence debounce, see liveSessionOrchestrator.ts) rather than a
   * fresh new question. Read in onAnswerComplete to decide whether to merge
   * key points/sources into the existing answer or start over — a ref, not
   * state, since it only needs to be current at the moment the *next*
   * callback fires, not drive a re-render itself.
   */
  const isContinuationRef = useRef(false);

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
        // A "follow_up"/"clarification" turn continues the previous
        // question rather than replacing it — most often a compound
        // question that got split across a pause longer than the silence
        // debounce. Appending keeps the full exchange visible instead of
        // the second half silently erasing the first the moment it starts
        // streaming in.
        const isContinuation =
          question.analysis.type === "follow_up" || question.analysis.type === "clarification";
        isContinuationRef.current = isContinuation;
        setCurrentQuestion((prev) => (isContinuation && prev ? `${prev} ${question.text}` : question.text));
        setAnswerText((prev) => (isContinuation && prev ? `${prev}\n\n` : ""));
        if (!isContinuation) setAnswer(null);
        setGenerating(true);
      },
      onAnswerDelta: (delta) => setAnswerText((prev) => prev + delta),
      onAnswerComplete: (finalAnswer) => {
        setAnswer((prev) =>
          isContinuationRef.current && prev
            ? {
                ...finalAnswer,
                keyPoints: [...prev.keyPoints, ...finalAnswer.keyPoints],
                sources: [...prev.sources, ...finalAnswer.sources],
              }
            : finalAnswer,
        );
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
        <Link
          to="/"
          className="flex items-center gap-1 text-sm font-semibold text-foreground hover:text-muted-foreground"
        >
          <ChevronLeft className="size-4" />
          Interview Copilot
        </Link>
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

      {/* The glance area: question + answer + key points, sized and spaced to
          be readable at a glance while actually in an interview. Everything
          else (evidence, raw transcript) lives behind Details below, not
          competing for attention here. */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-10">
          <section>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Question
            </p>
            <p className="mt-3 text-2xl font-semibold leading-snug">
              {currentQuestion ?? (
                <span className="text-muted-foreground">
                  Waiting for the interviewer to ask a question...
                </span>
              )}
            </p>
          </section>

          <section>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Your answer
            </p>
            {answerText || generating ? (
              <p className="mt-3 whitespace-pre-line text-xl leading-relaxed">
                {answerText}
                {generating ? <span className="animate-pulse">▍</span> : null}
              </p>
            ) : (
              <p className="mt-3 text-lg text-muted-foreground">
                Nothing to show yet. Start listening to begin.
              </p>
            )}

            {answer && answer.keyPoints.length > 0 ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {answer.keyPoints.map((point, i) => (
                  <Badge key={i} variant="secondary" className="font-normal">
                    {point}
                  </Badge>
                ))}
              </div>
            ) : null}
          </section>
        </div>

        <div className="mx-auto w-full max-w-3xl px-8 pb-10">
          <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
                <ChevronDown
                  className={cn("size-4 transition-transform", detailsOpen && "rotate-180")}
                />
                Details
                {answer?.sources.length ? (
                  <Badge variant="secondary" className="ml-1 font-normal">
                    {answer.sources.length} source{answer.sources.length === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 space-y-6">
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
                          (confidence:{" "}
                          {source.confidence >= 0.6 ? "High" : source.confidence >= 0.35 ? "Medium" : "Low"})
                        </span>
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">-</p>
                )}
              </section>

              <section>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Transcript
                </p>
                <ScrollArea className="mt-2 h-40 rounded-md border border-border p-3">
                  {transcript.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing captured yet. Both your microphone and system audio (the
                      interviewer's voice over a call) are transcribed once you start listening.
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
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  );
}
