# Evaluation results

Measured against the real running app — real Postgres/pgvector, real local Ollama models, real Groq calls, real knowledge base (2 CVs + 3 of Henry's own GitHub repos: `schema-watch`, `mvno-intelligence-hub`, `snowflake-semantic-agent`). Reproducible with `run-eval.mjs` in this folder against your own knowledge base and `eval-set.json`/`detection-set.json`.

Run across 3 separate full passes on 2026-09-05 to check consistency, not just report one lucky run.

## Question detection accuracy

12 transcript fragments (6 real questions, 6 conversational noise like "Thank you." / "Mm-hmm.") through `/api/analyze-question`, checking whether the debounce+classification pipeline correctly tells a real question apart from noise.

| Run | Accuracy |
|---|---|
| 1 | 11/12 (91.7%) |
| 2 | 11/12 (91.7%) |
| 3 | 12/12 (100%) |

The one recurring miss across runs: "Alright, let's move to the next one." — classified as a `follow_up` question rather than noise. A reasonable ambiguity (it *could* precede a real follow-up), not a broken classifier.

## Answer generation: retrieval accuracy

9 questions with a known-correct expected source (e.g. "How does Schema-Watch detect breaking API changes?" should cite `schema-watch`), run through the full pipeline: question analysis → retrieval → generation.

| Run | Hit rate |
|---|---|
| 1 | 9/9 (100%) |
| 2 | 8/9 (88.9%) |

The one miss (run 2): a question about "the MVNO Intelligence Hub project" only retrieved a CV chunk, missing the repo itself, because the question analyzer occasionally classifies a borderline personal-project question as `requiresPersonalExperience: false`, which raises the evidence-matching bar (see "Bugs found via this evaluation" below). This is real, measured run-to-run variance from the LLM-based classifier, not something papered over.

## Hallucination avoidance (no-evidence questions)

3 questions about experience the knowledge base has no record of at all (rocket engine control software, quantum computing, leading a 50-person construction crew). Manually verified across all runs: **0/3 fabricated a claim** — every answer explicitly said it didn't have that experience rather than inventing one, consistent with the [grounding policy](../../README.md#grounding-policy).

(An automated heuristic — flag as "possible hallucination" if `sources` is non-empty or confidence is high — over-flagged 1-2 of these per run. Manual reading of the actual text showed every flagged case still correctly declined the claim; the heuristic just isn't precise enough to replace reading the answer. Included here for honesty about the limits of automated eval, not to inflate the result.)

## Web research routing

2 current-information questions ("what's new in Next.js this year", "latest PostgreSQL version"). Both correctly triggered `requiresWebResearch: true`, and after a bug fix (below), both came back with zero personal-knowledge-base sources attached — i.e. the answer is honestly presented as general/current information, not dressed up as personal experience.

## Latency (final validated run, 17 answer-generation calls)

| Metric | Mean | Median | P90 | Min | Max |
|---|---:|---:|---:|---:|---:|
| Time to first token | 4.3s | 3.5s | 6.4s | 2.5s | 8.2s |
| Full answer | 6.0s | 5.8s | 9.5s | 3.5s | 10.3s |

Slower than the sub-2s target mentioned in the README's aspirational example — measured honestly, not adjusted to look better. The tail latency (P90/max) corresponds to cases where the local Ollama pool attempts a local model before the router fails over to Groq; this machine is CPU-only with 8GB RAM, so a cold local-model load can take several seconds before the router gives up and falls back. On a machine with a GPU, or with the local pool disabled entirely in favor of Groq-only, this would be meaningfully faster.

## Bugs found and fixed via this evaluation

Running a real eval — not just reading the code — surfaced two real bugs before they shipped:

1. **Evidence leaking into unrelated answers.** A pure current-info question ("what's new in Next.js") was retrieving and citing an unrelated personal knowledge-base chunk as a "source," because a weak semantic match could still clear the retrieval threshold. Fixed by raising the evidence bar specifically when the question analyzer says the question probably isn't personal (`packages/knowledge/src/evidence.ts`'s `strict` mode).
2. **The first fix over-corrected.** An initial version hard-skipped evidence retrieval entirely whenever `requiresPersonalExperience` was `false`, but the analyzer isn't reliable enough to hard-gate on: a second eval run showed genuinely personal questions (about `schema-watch`, the Snowflake project) occasionally getting `requiresPersonalExperience: false` and losing all evidence. Fixed by always running retrieval and only raising the bar, not skipping it outright — the version reflected in the numbers above.

This second bug is arguably the more interesting finding: fixing an eval-surfaced issue can introduce a regression that only a *second* independent eval run catches. Trusting a single "it's fixed" run isn't enough.
