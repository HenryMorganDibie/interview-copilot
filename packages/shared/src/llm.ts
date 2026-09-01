export type QuestionType =
  | "behavioral"
  | "technical"
  | "system_design"
  | "product"
  | "experience"
  | "career"
  | "culture"
  | "company"
  | "follow_up"
  | "clarification"
  | "general_knowledge"
  | "current_information"
  | "unknown";

export type QuestionAnalysis = {
  question: string;
  type: QuestionType;
  requiresPersonalExperience: boolean;
  requiresWebResearch: boolean;
  topic: string;
  confidence: number;
};

export type TranscriptEvent = {
  id: string;
  speaker: "user" | "interviewer" | "unknown";
  text: string;
  timestamp: number;
  isFinal: boolean;
};

export type Question = {
  id: string;
  text: string;
  analysis: QuestionAnalysis;
  timestamp: number;
};

export type AnswerSource = {
  sourceId: string;
  sourceName: string;
  sourceType: "cv" | "github" | "project" | "document" | "job_description" | "web";
  confidence: number;
};

export type InterviewAnswer = {
  answer: string;
  keyPoints: string[];
  followUp?: string;
  confidence: number;
  sources: AnswerSource[];
  reasoningSummary?: string;
};

export type CandidateProfile = {
  name: string;
  headline?: string;
  summary?: string;
};

export type InterviewContext = {
  sessionId: string;
  currentQuestion?: string;
  recentTranscript: TranscriptEvent[];
  previousQuestions: Question[];
  previousAnswers: InterviewAnswer[];
  jobDescription?: string;
  candidateProfile?: CandidateProfile;
};

export type EvidenceItem = {
  claim: string;
  type: "direct" | "inferred" | "unknown";
  sourceId?: string;
  sourceUrl?: string;
  confidence: number;
};

export type ResponseMode = "direct" | "talking_points" | "follow_up";

export type AnswerGenerationContext = {
  question: string;
  analysis: QuestionAnalysis;
  interviewContext: InterviewContext;
  evidence: EvidenceItem[];
  webResearch?: string;
  responseMode: ResponseMode;
};

/**
 * A single token/chunk of a streaming answer. Callers render `delta` as it
 * arrives; `done` marks the end of the stream, at which point the caller's
 * generateAnswer promise also resolves with the full structured answer.
 */
export type AnswerStreamChunk = {
  delta: string;
  done: boolean;
};

export interface LLMProvider {
  /** Stable id used for health tracking and logging, e.g. "ollama:qwen3:4b". */
  readonly id: string;

  analyzeQuestion(context: InterviewContext): Promise<QuestionAnalysis>;

  generateAnswer(
    context: AnswerGenerationContext,
    onChunk?: (chunk: AnswerStreamChunk) => void,
  ): Promise<InterviewAnswer>;

  /**
   * Generic one-shot JSON extraction for background analysis tasks that
   * aren't the live-answer critical path (job description parsing, GitHub
   * project-profile extraction, etc) — no streaming, no domain-specific
   * rules baked in like generateAnswer has. Returns the parsed JSON value,
   * or null if the model's output couldn't be parsed as JSON at all.
   */
  extractStructured(systemPrompt: string, userPrompt: string): Promise<unknown | null>;
}
