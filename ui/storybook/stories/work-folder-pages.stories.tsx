import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { AgentDetail } from "@/pages/AgentDetail";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { InstanceExperimentalSettings } from "@/pages/InstanceExperimentalSettings";
import { ProfileSettings } from "@/pages/ProfileSettings";
import { useCompany } from "@/context/CompanyContext";
import {
  WorkFolderStoryProvider,
  workFolderAgent,
  workFolderProject,
  workFolderTask,
} from "../fixtures/WorkFolderStoryProvider";
import { WORK_FOLDER_COMPANY } from "../fixtures/workFolders";
import type { WorkFolderScope } from "@paperclipai/shared";

type PageScope = WorkFolderScope | "settings";
const paths = {
  settings: "/PAP/company/settings/instance/experimental",
  task: `/PAP/issues/${workFolderTask.identifier}`,
  agent: `/PAP/agents/${workFolderAgent.urlKey}`,
  project: `/PAP/projects/${workFolderProject.urlKey}`,
  user: "/PAP/company/settings/instance/profile",
};
function Page({ scope }: { scope: PageScope }) {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const onRoute = location.pathname.startsWith(paths[scope]);
  useEffect(() => {
    if (selectedCompanyId !== WORK_FOLDER_COMPANY)
      setSelectedCompanyId(WORK_FOLDER_COMPANY);
  }, [selectedCompanyId, setSelectedCompanyId]);
  useEffect(() => {
    if (!onRoute) navigate(paths[scope], { replace: true });
  }, [scope, onRoute, navigate]);
  if (selectedCompanyId !== WORK_FOLDER_COMPANY || !onRoute) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="company/settings/instance/experimental" element={<InstanceExperimentalSettings />} />
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="agents/:agentId/:tab?" element={<AgentDetail />} />
          <Route path="projects/:projectId/:tab?" element={<ProjectDetail />} />
          <Route
            path="company/settings/instance/profile"
            element={<ProfileSettings />}
          />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
const meta = {
  title: "Work folders/Pages",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Task properties expose cached-file inspection only when enabled in development settings. The inspector previews and downloads saved copies, not the live sandbox filesystem. Other page mutations are not simulated.",
      },
    },
  },
  args: { scope: "task", enableCachedTaskFiles: false },
  argTypes: { scope: { control: false } },
  render: ({ scope, enableCachedTaskFiles }: { scope: PageScope; enableCachedTaskFiles: boolean }) => (
    <WorkFolderStoryProvider key={`${scope}:${enableCachedTaskFiles}`} enableCachedTaskFiles={enableCachedTaskFiles}>
      <Page scope={scope} />
    </WorkFolderStoryProvider>
  ),
} satisfies Meta<{ scope: PageScope; enableCachedTaskFiles: boolean }>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TaskPage: Story = { args: { scope: "task" } };
export const AgentPage: Story = { args: { scope: "agent" } };
export const ProjectPage: Story = { args: { scope: "project" } };
export const ProfileSettingsPage: Story = { args: { scope: "user" } };
export const MobileTaskPage: Story = {
  args: { scope: "task" },
  globals: { viewport: { value: "mobile" } },
};

export const TaskPageCachedFiles: Story = { args: { scope: "task", enableCachedTaskFiles: true } };
export const DevelopmentSettings: Story = { args: { scope: "settings" } };
