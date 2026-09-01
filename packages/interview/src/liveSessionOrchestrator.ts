import type {
  AnswerGenerationContext,
  InterviewAnswer,
  InterviewContext,
  Question,
  QuestionAnalysis,
  ResponseMode,
  TranscriptEvent,
} from "@interview-copilot/shared";

export type LiveSessionOrchestratorOptions = {
  sessionId: string;
  jobDescription?: string;
  /** The user's configured preference for how answers are delivered. Default "direct". */
  responseMode?: ResponseMode;
  /** How long to wait after the interviewer stops talking before treating it as a finished turn. Default 2000ms. */
  silenceMs?: number;
  /** Below this confidence (or type "unknown"), a "question" is treated as noise/hallucination and skipped. Default 0.35. */
  minConfidence?: number;
  analyzeQuestion: (context: InterviewContext) => Promise<QuestionAnalysis | null>;
  generateAnswer: (
    context: AnswerGenerationContext,
    onDelta: (text: string) => void,
  ) => Promise<InterviewAnswer>;
  onTranscript?: (event: TranscriptEvent) => void;
  onQuestionDetected?: (question: Question) => void;
  onAnswerDelta?: (delta: string) => void;
  onAnswerComplete?: (answer: InterviewAnswer) => void;
  onSkipped?: (reason: string, analysis: QuestionAnalysis) => void;
  onError?: (message: string) => void;
};

const RECENT_TRANSCRIPT_LIMIT = 20;
const RECENT_QA_LIMIT = 5;

/**
 * Owns the live-interview loop: buffers interviewer speech, waits for a
 * pause (debounce, not per-fragment) before deciding a turn is finished,
 * classifies it, and only calls the LLM for turns that actually look like
 * questions — never on every transcript fragment. Framework-agnostic (no
 * DOM/React deps) so the UI layer only wires callbacks to state.
 */
export class LiveSessionOrchestrator {
  private readonly silenceMs: number;
  private readonly minConfidence: number;

  private interviewerBuffer: TranscriptEvent[] = [];
  private recentTranscript: TranscriptEvent[] = [];
  private previousQuestions: Question[] = [];
  private previousAnswers: InterviewAnswer[] = [];

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a second turn finalizing while the previous one is still generating. */
  private processing = false;
  private pendingWhileProcessing = false;

  private readonly opts: LiveSessionOrchestratorOptions;

  constructor(opts: LiveSessionOrchestratorOptions) {
    this.opts = opts;
    this.silenceMs = opts.silenceMs ?? 2000;
    this.minConfidence = opts.minConfidence ?? 0.35;
  }

  /** Feed every transcript event here (both speakers) as it arrives. */
  handleTranscript(event: TranscriptEvent): void {
    this.opts.onTranscript?.(event);

    this.recentTranscript.push(event);
    if (this.recentTranscript.length > RECENT_TRANSCRIPT_LIMIT) {
      this.recentTranscript.shift();
    }

    if (event.speaker !== "interviewer") return;

    this.interviewerBuffer.push(event);
    this.resetSilenceTimer();
  }

  /** Cancels any pending debounce timer. Call when stopping the session. */
  dispose(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.finalizeTurn().catch((err) => {
        this.opts.onError?.(err instanceof Error ? err.message : "Unexpected error");
      });
    }, this.silenceMs);
  }

  private async finalizeTurn(): Promise<void> {
    if (this.interviewerBuffer.length === 0) return;

    if (this.processing) {
      // A previous turn is still generating; try again once it's done
      // rather than firing overlapping LLM calls.
      this.pendingWhileProcessing = true;
      return;
    }

    const text = this.interviewerBuffer.map((e) => e.text).join(" ").trim();
    this.interviewerBuffer = [];
    if (!text) return;

    this.processing = true;
    try {
      const interviewContext: InterviewContext = {
        sessionId: this.opts.sessionId,
        currentQuestion: text,
        recentTranscript: [...this.recentTranscript],
        previousQuestions: this.previousQuestions.slice(-RECENT_QA_LIMIT),
        previousAnswers: this.previousAnswers.slice(-RECENT_QA_LIMIT),
        jobDescription: this.opts.jobDescription,
      };

      const analysis = await this.opts.analyzeQuestion(interviewContext);
      if (!analysis) {
        this.opts.onError?.("Question analysis unavailable.");
        return;
      }
      if (analysis.type === "unknown" || analysis.confidence < this.minConfidence) {
        this.opts.onSkipped?.("Not confidently a question", analysis);
        return;
      }

      const question: Question = {
        id: crypto.randomUUID(),
        text,
        analysis,
        timestamp: Date.now(),
      };
      this.previousQuestions.push(question);
      this.opts.onQuestionDetected?.(question);

      const answer = await this.opts.generateAnswer(
        {
          question: text,
          analysis,
          interviewContext,
          evidence: [], // server fills this from the real knowledge base
          responseMode: this.opts.responseMode ?? "direct",
        },
        (delta) => this.opts.onAnswerDelta?.(delta),
      );

      this.previousAnswers.push(answer);
      this.opts.onAnswerComplete?.(answer);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err.message : "Unable to generate answer.");
    } finally {
      this.processing = false;
      if (this.pendingWhileProcessing) {
        this.pendingWhileProcessing = false;
        this.finalizeTurn().catch((err) => {
          this.opts.onError?.(err instanceof Error ? err.message : "Unexpected error");
        });
      }
    }
  }
}
