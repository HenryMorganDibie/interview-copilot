import { useState } from "react";
import type { ResponseMode } from "@interview-copilot/shared";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getResponseMode, setResponseMode } from "@/lib/settings";

const RESPONSE_MODES: { value: ResponseMode; label: string; description: string }[] = [
  { value: "direct", label: "Direct", description: "A complete 3-6 sentence spoken answer, ready to say as-is." },
  {
    value: "talking_points",
    label: "Talking Points",
    description: "3-5 short bullet fragments to speak from in your own words, not a script to read verbatim.",
  },
  {
    value: "follow_up",
    label: "Follow-up",
    description: "A terse 1-2 sentence answer, for a quick clarifying question mid-conversation.",
  },
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
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
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
            </div>
            <p className="text-xs text-muted-foreground">
              {RESPONSE_MODES.find((m) => m.value === mode)?.description}
            </p>
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
