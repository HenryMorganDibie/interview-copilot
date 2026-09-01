import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/PageHeader";

const setupSteps = [
  { title: "Upload your CV", done: false },
  { title: "Connect GitHub", done: false },
  { title: "Add a job description", done: false },
  { title: "Configure your LLM providers", done: false },
];

export function OverviewPage() {
  return (
    <div>
      <PageHeader
        title="Overview"
        description="Set up your knowledge base before starting a live session."
      />
      <div className="grid grid-cols-1 gap-4 p-8 sm:grid-cols-2 lg:grid-cols-4">
        {setupSteps.map((step) => (
          <Card key={step.title}>
            <CardHeader>
              <CardTitle className="text-sm font-medium">{step.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {step.done ? "Complete" : "Not started"}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
