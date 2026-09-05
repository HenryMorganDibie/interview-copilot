import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getSettings, saveSettings } from "@/lib/apiClient";

export function SettingsPage() {
  const [groqConfigured, setGroqConfigured] = useState<boolean | null>(null);
  const [groqInput, setGroqInput] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setGroqConfigured(s.groqApiKeyConfigured);
      setOllamaUrl(s.ollamaBaseUrl);
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      // Only ever send fields that actually changed -- leaving the Groq
      // input blank must never touch an already-configured key, and
      // re-sending an unchanged Ollama URL is harmless but pointless.
      const update: { groqApiKey?: string; ollamaBaseUrl?: string } = {};
      if (groqInput.trim()) update.groqApiKey = groqInput.trim();
      if (ollamaUrl.trim()) update.ollamaBaseUrl = ollamaUrl.trim();

      if (Object.keys(update).length === 0) {
        setError("Nothing to save.");
        return;
      }

      const result = await saveSettings(update);
      setGroqConfigured(result.groqApiKeyConfigured);
      setOllamaUrl(result.ollamaBaseUrl);
      setGroqInput("");
      setMessage("Saved. Restart the app for this to take effect.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Settings" description="LLM providers, privacy, and transcript retention." />
      <div className="max-w-xl space-y-4 p-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">LLM providers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ollama-url">Ollama server URL</Label>
              <Input
                id="ollama-url"
                placeholder="http://127.0.0.1:11434"
                value={ollamaUrl}
                onChange={(e) => setOllamaUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="groq-key">Groq API key</Label>
                {groqConfigured === null ? null : (
                  <Badge variant={groqConfigured ? "default" : "secondary"} className="text-xs">
                    {groqConfigured ? "Configured" : "Not set"}
                  </Badge>
                )}
              </div>
              <Input
                id="groq-key"
                type="password"
                placeholder={groqConfigured ? "Leave blank to keep the current key" : "gsk_..."}
                value={groqInput}
                onChange={(e) => setGroqInput(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Free tier at{" "}
                <a href="https://console.groq.com" target="_blank" rel="noreferrer" className="underline">
                  console.groq.com
                </a>
                . Needed for live question analysis and answer generation unless you run Ollama locally instead.
              </p>
            </div>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Privacy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Transcript retention controls and data deletion arrive alongside the audio pipeline (Phase 2) and knowledge base (Phase 3).
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
