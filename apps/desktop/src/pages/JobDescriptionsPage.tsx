import { useCallback, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { analyzeJobDescription, type JobMatchReport } from "@/lib/apiClient";

export function JobDescriptionsPage() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<JobMatchReport | null>(null);

  const handleAnalyze = useCallback(async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const result = await analyzeJobDescription(text);
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze job description");
    } finally {
      setLoading(false);
    }
  }, [text]);

  return (
    <div>
      <PageHeader
        title="Job Descriptions"
        description="Paste a job description to match it against your knowledge base."
      />
      <div className="max-w-2xl space-y-4 p-8">
        <Textarea
          placeholder="Paste the job description here..."
          className="min-h-48"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
        />
        <Button onClick={handleAnalyze} disabled={loading || !text.trim()}>
          {loading ? "Analyzing..." : "Analyze"}
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {report ? (
          <div className="space-y-6 pt-4">
            <section>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {report.profile.title}
                {report.profile.company ? ` @ ${report.profile.company}` : ""}
              </p>
              {report.profile.technologies.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {report.profile.technologies.map((t) => (
                    <Badge key={t} variant="secondary">
                      {t}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </section>

            <Separator />

            <section>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Requirement match
              </p>
              <ul className="mt-2 space-y-2">
                {report.requirementMatches.map((m) => (
                  <li key={m.requirement} className="text-sm">
                    <span className={m.matched ? "text-foreground" : "text-muted-foreground"}>
                      {m.matched ? "✓" : "✗"} {m.requirement}
                    </span>
                    {m.matched && m.matchingSources.length > 0 ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({m.matchingSources.join(", ")})
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {report.strongestStories.length > 0 ? (
              <>
                <Separator />
                <section>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Strongest stories
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {report.strongestStories.map((s) => (
                      <Badge key={s.sourceName} variant="secondary">
                        {s.sourceName} ({s.matchCount})
                      </Badge>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {report.weakAreas.length > 0 ? (
              <>
                <Separator />
                <section>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Weak areas
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    No matching evidence in your knowledge base yet — worth an honest, prepared answer.
                  </p>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-muted-foreground">
                    {report.weakAreas.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}

            {report.starStories.length > 0 ? (
              <>
                <Separator />
                <section>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Suggested STAR stories
                  </p>
                  <div className="mt-2 space-y-4">
                    {report.starStories.map((s, i) => (
                      <div key={i} className="rounded-md border border-border p-3">
                        <p className="text-sm font-medium">{s.project}</p>
                        <dl className="mt-2 space-y-1.5 text-sm">
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Situation</dt>
                            <dd>{s.situation}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Task</dt>
                            <dd>{s.task}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Action</dt>
                            <dd>{s.action}</dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium text-muted-foreground">Result</dt>
                            <dd>{s.result}</dd>
                          </div>
                        </dl>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {report.likelyQuestions.length > 0 ? (
              <>
                <Separator />
                <section>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Likely questions
                  </p>
                  <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                    {report.likelyQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
