import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeSource, KnowledgeSourceType } from "@interview-copilot/shared";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteKnowledgeSource, listKnowledgeSources, uploadKnowledgeDocument } from "@/lib/apiClient";

const SOURCE_TYPES: { value: KnowledgeSourceType; label: string }[] = [
  { value: "cv", label: "CV / Resume" },
  { value: "project", label: "Project doc" },
  { value: "document", label: "Other document" },
  { value: "job_description", label: "Job description" },
];

export function KnowledgeBasePage() {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [sourceType, setSourceType] = useState<KnowledgeSourceType>("cv");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listKnowledgeSources().then(setSources);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;

      setUploading(true);
      setError(null);
      try {
        await uploadKnowledgeDocument(file, sourceType);
        refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to upload document");
      } finally {
        setUploading(false);
      }
    },
    [sourceType, refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteKnowledgeSource(id);
      refresh();
    },
    [refresh],
  );

  return (
    <div>
      <PageHeader
        title="Knowledge Base"
        description="CV, resumes, project docs, and technical notes that ground your answers."
      />
      <div className="max-w-2xl space-y-4 p-8">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex items-center gap-2">
              <Select value={sourceType} onValueChange={(v) => setSourceType(v as KnowledgeSourceType)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading..." : "Upload document"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.md,.txt"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <p className="text-xs text-muted-foreground">PDF, Markdown, or plain text.</p>
          </CardContent>
        </Card>

        {sources.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            No documents ingested yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex items-center justify-between rounded-md border border-border px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{source.sourceName}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {source.sourceType}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(source.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(source.id)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
