import type { AnswerGenerationContext, ResponseMode } from "@interview-copilot/shared";

/** Marks the end of the spoken answer and the start of the trailing JSON metadata block. */
export const ANSWER_METADATA_DELIMITER = "---METADATA---";

const PART_1_INSTRUCTIONS: Record<ResponseMode, string> = {
  direct: `PART 1 — the spoken answer only. Plain text, no markdown, no labels, no JSON. 3-6 sentences, conversational — this is read aloud, so it must stand alone as natural speech.`,
  talking_points: `PART 1 — 3-5 short talking points, one per line, each starting with "• ". Fragments, not full sentences — just enough for the candidate to expand on out loud in their own words. No markdown other than the "• " prefix, no JSON.`,
  follow_up: `PART 1 — a short follow-up answer, 1-2 sentences maximum. This is for a rapid back-and-forth exchange (the interviewer just asked a quick probing question), so brevity matters more than completeness. Plain text, no markdown, no labels, no JSON.`,
};

/**
 * Enforces the six answer-generation rules from the product spec:
 * never fabricate experience, prefer real experience, be concise, sound
 * human, answer the actual question, preserve uncertainty. The exact shape
 * of the spoken part (full prose / bullet points / one-liner) depends on
 * responseMode — the user's configured preference for how answers are
 * delivered, not a per-question decision.
 */
export function buildAnswerSystemPrompt(responseMode: ResponseMode): string {
  return `You are an interview copilot generating an answer the candidate can say out loud.

Rules:
1. Never fabricate experience. Only use the evidence provided in the EVIDENCE section. If evidence is missing or "unknown", say so plainly rather than inventing a project or outcome.
2. Prefer the candidate's real experience when evidence supports it.
3. Be concise. No essays.
4. Sound human: no corporate buzzword overload, no "As an AI...", no overly polished generic interview language.
5. Answer the actual question asked. Do not dump everything you know about the topic.
6. Preserve uncertainty: if you don't know something, don't invent it.
7. If a piece of evidence reads like the candidate's own pre-written, first-person answer or story (not a CV bullet or repo description, but something phrased the way a person would actually say it out loud) and it directly answers the current question, stay close to its exact wording rather than freely rewriting it — the candidate likely rehearsed that phrasing, and hearing something different live is disorienting, not an improvement. Light trimming for length is fine; changing the substance or voice is not.
8. If the interviewer goes off-topic, asks something the candidate's evidence doesn't cover, or the question only loosely relates to CURRENT QUESTION's stated topic: never respond with just "I don't have experience with that" and stop there. Give the most useful honest answer available — reason from general knowledge/best practice, relate it to the closest adjacent thing the evidence *does* support, or ask a brief clarifying angle — so the candidate always has something substantive to say out loud. Only fall back to a plain "I haven't worked with that directly" when there is truly nothing adjacent to offer, and even then pair it with what the candidate would do to get up to speed.

Respond in exactly two parts, in this order, with nothing else:

${PART_1_INSTRUCTIONS[responseMode]}

PART 2 — on its own line, the exact marker ${ANSWER_METADATA_DELIMITER}, then ONLY a single JSON object (no markdown fences) with this shape:
{"keyPoints": string[], "followUp": string | null, "confidence": number between 0 and 1, "reasoningSummary": string | null}

Do not repeat the answer text inside the JSON. "confidence" reflects how well the EVIDENCE section supports the answer (low if evidence is thin or absent). "reasoningSummary" is a short one-sentence, user-facing note like "Based primarily on your Schema-Watch project." Omit internal reasoning/chain-of-thought entirely.`;
}

export function buildAnswerUserPrompt(context: AnswerGenerationContext): string {
  const { question, analysis, interviewContext, evidence, webResearch, responseMode } = context;

  // Both arrays must be sliced the same way before pairing by index — the
  // orchestrator's own window (RECENT_QA_LIMIT) can be wider than the 3 we
  // want here, and indexing an unsliced previousAnswers by a sliced
  // previousQuestions' index silently pairs each question with the wrong
  // answer (e.g. the oldest 3 answers instead of the 3 that actually go
  // with the last 3 questions) once more than 3 Q&A pairs have accumulated.
  const recentQuestions = interviewContext.previousQuestions.slice(-3);
  const recentAnswers = interviewContext.previousAnswers.slice(-3);
  const recentQA = recentQuestions
    .map((q, i) => {
      const answer = recentAnswers[i];
      return `Q: ${q.text}\nA: ${answer?.answer ?? "(no answer recorded)"}`;
    })
    .join("\n\n");

  const evidenceBlock = evidence.length
    ? evidence
        .map(
          (e) =>
            `- [${e.type}] ${e.claim}${e.sourceId ? ` (source: ${e.sourceId})` : ""}`,
        )
        .join("\n")
    : "No personal evidence retrieved for this question.";

  return [
    interviewContext.jobDescription
      ? `JOB DESCRIPTION CONTEXT:\n${interviewContext.jobDescription}\n`
      : "",
    recentQA ? `RECENT CONVERSATION:\n${recentQA}\n` : "",
    `CURRENT QUESTION (${analysis.type}, topic: ${analysis.topic}):\n${question}\n`,
    `EVIDENCE:\n${evidenceBlock}\n`,
    webResearch ? `WEB RESEARCH (external, not personal experience):\n${webResearch}\n` : "",
    `RESPONSE MODE: ${responseMode}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildQuestionAnalysisSystemPrompt(): string {
  return `Classify the interviewer's most recent question. Respond with ONLY a single JSON object matching exactly:
{"question": string, "type": "behavioral"|"technical"|"system_design"|"product"|"experience"|"career"|"culture"|"company"|"follow_up"|"clarification"|"general_knowledge"|"current_information"|"unknown", "requiresPersonalExperience": boolean, "requiresWebResearch": boolean, "topic": string, "confidence": number between 0 and 1}

"requiresWebResearch" is true only for questions about current/external information (e.g. "what's new in X", current versions, current company/industry facts) that the candidate's personal knowledge base cannot answer.
Treat a short follow-up ("why not X?", "what about Y?") as continuing the previous question's topic, using type "follow_up" or "clarification" as appropriate.`;
}
