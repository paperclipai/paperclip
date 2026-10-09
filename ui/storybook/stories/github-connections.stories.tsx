import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { Link, Route, Routes, useLocation } from "@/lib/router";
import { SetupWizardSidebarProvider } from "@/context/SetupWizardSidebarContext";
import { SetupWizardSidebar } from "@/components/SetupWizard";
import { queryKeys } from "@/lib/queryKeys";
import { Browse } from "@/pages/apps/Browse";
import { AppsConnect } from "@/pages/apps/AppsConnect";
import { ChatEndpointSetup } from "@/pages/apps/chat/ChatEndpointSetup";
import { storybookAgents } from "../fixtures/paperclipData";

const companyId = "company-storybook";
// Hosted Storybooks live below a branch path; reuse their bundled GitHub marks.
const githubBranding = {
  logoUrl: "./brands/apps/github.svg",
  darkLogoUrl: "./brands/apps/github-dark.svg",
};

function GitHubConnections({ saved = false, chatEnabled = true }) {
  const location = useLocation();
  const [client] = useState(() => {
    const result = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } },
    });
    const github = getAppStoreDefinition("github")!;
    result.setQueryData(queryKeys.apps.gallery(companyId), {
      apps: [
        { ...github, branding: githubBranding, ownershipAvailability: { platform_shared: true, customer: true } },
        { ...getAppStoreDefinition("github-code-review-bot"), branding: githubBranding },
      ],
      capabilities: { canSetCompanyInstall: true, canCreatePersonalConnection: true, canCreateOrganizationConnection: true },
    });
    result.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: chatEnabled });
    result.setQueryData(queryKeys.tools.applications(companyId), { applications: saved ? [
      { id: "github-tools", companyId, name: "GitHub", status: "active", metadata: { sourceTemplateKey: "github" } },
      // Existing bots retain their provider/source identity after the catalog split.
      { id: "github-bot", companyId, name: "Review bot", status: "active", type: "chat", metadata: { sourceTemplateKey: "github", purpose: "channel" } },
    ] : [] });
    result.setQueryData(queryKeys.tools.connections(companyId), { connections: saved ? [{
      id: "github-account", applicationId: "github-tools", companyId, name: "octocat",
      status: "active", enabled: true, healthStatus: "healthy", transport: "mcp_remote",
      authKind: "oauth", config: { sourceTemplateKey: "github" }, transportConfig: {},
    }] : [] });
    result.setQueryData(queryKeys.chatEndpoints.list(companyId), saved ? [
      { id: "github-review", companyId, provider: "github", status: "active", assignedAgentId: "reviewer", assignedAgentName: "Reviewer", botLabel: "Paperclip Review", allowUnlinkedPeople: false },
      { id: "github-draft", companyId, provider: "github", status: "draft", assignedAgentId: "backup", assignedAgentName: "Backup reviewer", allowUnlinkedPeople: false },
    ] : []);
    result.setQueryData(queryKeys.access.companyUserDirectory(companyId), { users: [] });
    result.setQueryData(["github-setup-agents", companyId], storybookAgents);
    return result;
  });
  return (
    <QueryClientProvider client={client}>
      <SetupWizardSidebarProvider>
        <div className="flex min-h-screen">
          {location.pathname.endsWith("/apps/chat/connect") && (
            <div className="hidden w-64 shrink-0 md:block">
              <SetupWizardSidebar />
            </div>
          )}
          <main className="mx-auto min-w-0 w-full max-w-4xl space-y-6 p-6">
            <Link to="/apps" className="text-sm text-muted-foreground hover:text-foreground">
              Connectors
            </Link>
            <Routes>
              <Route path="/:companyPrefix/apps/connect" element={<AppsConnect />} />
              <Route path="/:companyPrefix/apps/chat/connect" element={<ChatEndpointSetup />} />
              <Route path="*" element={<Browse />} />
            </Routes>
          </main>
        </div>
      </SetupWizardSidebarProvider>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Connections/GitHub and Code Review Bot",
  component: GitHubConnections,
  play: async ({ canvasElement }) => {
    await userEvent.type(await within(canvasElement).findByRole("searchbox", { name: "Search connectors" }), "GitHub");
  },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Production catalog cards and setup pages with local API query fixtures. GitHub opens account/tool access; GitHub Code Review Bot opens Choose agent. These stories cover discovery and entry into setup, without live GitHub consent or app installation." } },
  },
} satisfies Meta<typeof GitHubConnections>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Catalog: Story = {};
export const SavedConnections: Story = { args: { saved: true } };
export const ChatDisabled: Story = {
  args: { chatEnabled: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: /^Connect GitHub$/ })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "GitHub Code Review Bot" })).not.toBeInTheDocument();
  },
};
export const ToolSetup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /^Connect GitHub$/ }));
    await expect(await canvas.findByRole("heading", { name: "Connect GitHub as" })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Choose how to connect" })).not.toBeInTheDocument();
  },
};
export const BotSetup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /^Connect GitHub Code Review Bot$/ }));
    await expect(await canvas.findByRole("heading", { name: /^Choose agent$/ })).toBeVisible();
    await expect(canvas.queryByRole("heading", { name: "Choose how to connect" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /^Continue$/ })).toBeDisabled();
  },
};
export const Mobile: Story = {
  args: { saved: true },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const Light: Story = { globals: { theme: "light" } };
