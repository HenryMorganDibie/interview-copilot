import { HashRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { OverviewPage } from "@/pages/OverviewPage";
import { KnowledgeBasePage } from "@/pages/KnowledgeBasePage";
import { GitHubPage } from "@/pages/GitHubPage";
import { JobDescriptionsPage } from "@/pages/JobDescriptionsPage";
import { SessionSetupPage } from "@/pages/SessionSetupPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { LiveInterviewPage } from "@/pages/LiveInterviewPage";

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/live" element={<LiveInterviewPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
          <Route path="/github" element={<GitHubPage />} />
          <Route path="/job-descriptions" element={<JobDescriptionsPage />} />
          <Route path="/session-setup" element={<SessionSetupPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;
