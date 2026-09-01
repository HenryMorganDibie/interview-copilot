import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SettingsPage() {
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
              <Input id="ollama-url" placeholder="http://127.0.0.1:11434" disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="groq-key">Groq API key</Label>
              <Input id="groq-key" type="password" placeholder="Configured on the backend" disabled />
            </div>
            <p className="text-xs text-muted-foreground">
              Provider configuration is wired up in Phase 5. API keys are never stored in or sent to the frontend.
            </p>
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
