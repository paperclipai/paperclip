import { Routes, Route, Navigate } from "react-router";
import { useCompany } from "@/context/CompanyContext";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { AppShell } from "@/components/shell/AppShell";
import { Dashboard } from "@/pages/Dashboard";
import { Agents } from "@/pages/Agents";
import { AgentDetail } from "@/pages/AgentDetail";
import { Projects } from "@/pages/Projects";
import { Issues } from "@/pages/Issues";
import { IssueDetail } from "@/pages/IssueDetail";
import { Workflows } from "@/pages/Workflows";
import { WorkflowBuilder } from "@/pages/WorkflowBuilder";
import { Goals } from "@/pages/Goals";
import { Costs } from "@/pages/Costs";
import { PluginManager } from "@/pages/PluginManager";
import { LocalAI } from "@/pages/LocalAI";
import { Automation } from "@/pages/Automation";
import { Approvals } from "@/pages/Approvals";
import { OrgChart } from "@/pages/OrgChart";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { SettingsPage } from "@/pages/Settings";
import { Activity } from "@/pages/Activity";

export function App() {
  const { companies, loading } = useCompany();

  if (!loading && companies.length === 0) {
    return <OnboardingWizard />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/:agentId" element={<AgentDetail />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/issues" element={<Issues />} />
        <Route path="/issues/:issueId" element={<IssueDetail />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/:workflowId/builder" element={<WorkflowBuilder />} />
        <Route path="/goals" element={<Goals />} />
        <Route path="/costs" element={<Costs />} />
        <Route path="/plugins" element={<PluginManager />} />
        <Route path="/local-ai" element={<LocalAI />} />
        <Route path="/automation" element={<Automation />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/org-chart" element={<OrgChart />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/activity" element={<Activity />} />
      </Route>
    </Routes>
  );
}
