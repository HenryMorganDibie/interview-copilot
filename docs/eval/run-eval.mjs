import fs from "node:fs";

const API_BASE = "http://127.0.0.1:8722";
const evalSet = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const detectionSet = JSON.parse(fs.readFileSync(process.argv[3], "utf-8"));

function baseContext(question) {
  return { sessionId: "eval-run", currentQuestion: question, recentTranscript: [], previousQuestions: [], previousAnswers: [] };
}

async function analyzeQuestion(question) {
  const res = await fetch(`${API_BASE}/api/analyze-question`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(baseContext(question)),
  });
  if (!res.ok) return null;
  return res.json();
}

async function generateAnswer(question, analysis) {
  const start = Date.now();
  let firstTokenAt = null;

  const res = await fetch(`${API_BASE}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      analysis,
      interviewContext: baseContext(question),
      evidence: [],
      responseMode: "direct",
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let finalAnswer = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        if (line.startsWith("data:")) {
          const payload = JSON.parse(line.slice(5).trim());
          if (currentEvent === "delta" && payload.text) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
          } else if (currentEvent === "done") {
            finalAnswer = payload;
          }
        }
      }
    }
  }

  const totalMs = Date.now() - start;
  const firstTokenMs = firstTokenAt ? firstTokenAt - start : null;
  return { finalAnswer, totalMs, firstTokenMs };
}

async function main() {
  console.log("=== PART 1: Question Detection Accuracy ===\n");
  let detectionCorrect = 0;
  const detectionResults = [];
  for (const item of detectionSet) {
    const analysis = await analyzeQuestion(item.text);
    const predictedReal = analysis && analysis.type !== "unknown" && analysis.confidence >= 0.35;
    const correct = predictedReal === item.isRealQuestion;
    if (correct) detectionCorrect++;
    detectionResults.push({ text: item.text, expected: item.isRealQuestion, predicted: predictedReal, type: analysis?.type, confidence: analysis?.confidence, correct });
    console.log(`${correct ? "OK" : "MISS"} [expected=${item.isRealQuestion}, got type=${analysis?.type} conf=${analysis?.confidence}] "${item.text}"`);
  }
  const detectionAccuracy = detectionCorrect / detectionSet.length;
  console.log(`\nDetection accuracy: ${detectionCorrect}/${detectionSet.length} = ${(detectionAccuracy * 100).toFixed(1)}%\n`);

  console.log("=== PART 2: Answer Generation Eval ===\n");
  const results = [];
  for (const item of evalSet) {
    process.stdout.write(`Running ${item.id}: "${item.question.slice(0, 60)}..." `);
    const analysis = await analyzeQuestion(item.question);
    const { finalAnswer, totalMs, firstTokenMs } = await generateAnswer(item.question, analysis);

    const sourceNames = (finalAnswer?.sources ?? []).map((s) => s.sourceName.toLowerCase());
    const retrievalHit = item.expectedSourceContains
      ? sourceNames.some((s) => s.includes(item.expectedSourceContains.toLowerCase()))
      : null;
    const hasEvidence = sourceNames.length > 0;
    const possibleHallucination = item.category === "no_evidence" && (hasEvidence || (finalAnswer?.confidence ?? 0) > 0.5);

    results.push({
      id: item.id,
      category: item.category,
      question: item.question,
      analysisType: analysis?.type,
      requiresWebResearch: analysis?.requiresWebResearch,
      answer: finalAnswer?.answer,
      confidence: finalAnswer?.confidence,
      sources: sourceNames,
      retrievalHit,
      possibleHallucination,
      firstTokenMs,
      totalMs,
    });
    console.log(`done (${totalMs}ms total, ${firstTokenMs}ms to first token, confidence=${finalAnswer?.confidence})`);
  }

  fs.writeFileSync(process.argv[4], JSON.stringify({ detectionResults, detectionAccuracy, results }, null, 2));
  console.log(`\nFull results written to ${process.argv[4]}`);
}

main().catch((err) => {
  console.error("EVAL FAILED:", err);
  process.exit(1);
});
