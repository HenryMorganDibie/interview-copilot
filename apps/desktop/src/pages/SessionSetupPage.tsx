import { useState } from "react";
import type { ResponseMode } from "@interview-copilot/shared";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getResponseMode, setResponseMode } from "@/lib/settings";

const RESPONSE_MODES: { value: ResponseMode; label: string }[] = [
  { value: "direct", label: "Direct" },
  { value: "talking_points", label: "Talking Points" },
  { value: "follow_up", label: "Follow-up" },
];

export function SessionSetupPage() {
  const [mode, setMode] = useState<ResponseMode>(getResponseMode());

  const handleSelect = (value: ResponseMode) => {
    setMode(value);
    setResponseMode(value);
  };

  return (
    <div>
      <PageHeader
        title="Session Setup"
        description="Choose response mode and review your interview preparation before going live."
      />
      <div className="grid max-w-3xl grid-cols-1 gap-4 p-8 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Response mode</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            {RESPONSE_MODES.map((m) => (
              <Button
                key={m.value}
                variant={mode === m.value ? "default" : "outline"}
                size="sm"
                onClick={() => handleSelect(m.value)}
              >
                {m.label}
              </Button>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Interview preparation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Paste a job description on the Job Descriptions page to see likely questions and
              requirement matching against your knowledge base.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
