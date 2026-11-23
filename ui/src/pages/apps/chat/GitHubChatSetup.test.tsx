// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubChatSetup } from "./GitHubChatSetup";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { projectsApi } from "@/api/projects";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

const fixture = vi.hoisted(() => ({
  agents: [] as any[],
  endpoint: null as any,
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Bot Company", issuePrefix: "BOT" },
  }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: fixture.setBreadcrumbs }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
vi.mock("@/components/SetupWizard", () => ({
  SetupWizardNavigation: () => null,
  SetupWizardFooter: ({ children, onSaveExit }: any) => (
    <footer>
      <button type="button" onClick={onSaveExit}>Save &amp; exit</button>
      {children}
    </footer>
  ),
}));
vi.mock("@/components/AgentMultiSelect", () => ({
  AgentSelect: ({ agents, value, onChange }: any) => (
    <select aria-label="Agent" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Choose an agent</option>
      {agents.map((agent: any) => (
        <option key={agent.id} value={agent.id}>{agent.name}</option>
      ))}
    </select>
  ),
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(), get: vi.fn(), updatePermissions: vi.fn() },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: { list: vi.fn(), create: vi.fn(), get: vi.fn(), listResources: vi.fn(), setup: vi.fn(), generateSetupSecret: vi.fn() },
}));
vi.mock("@/api/projects", () => ({ projectsApi: { repositoryOptions: vi.fn() } }));
vi.mock("@/api/githubChat", () => ({
  githubChatApi: {
    configuration: vi.fn(), advance: vi.fn(), repositories: vi.fn(), registration: vi.fn(),
    restartRegistration: vi.fn(), saveDraft: vi.fn(), startIdentity: vi.fn(), confirmIdentity: vi.fn(),
    identity: vi.fn(), connectApp: vi.fn(), personalConnections: vi.fn(),
  },
}));
vi.mock("@/api/tools", () => ({ toolsApi: { startCloudConnectorEnrollment: vi.fn() } }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

describe("GitHub App wizard session replay masking", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    fixture.agents = [{
      id: "reviewer", name: "Reviewer", status: "idle", role: "engineer",
      permissions: { canCreateAgents: true, canCreateSkills: false }, access: { canAssignTasks: true }, createdAt: "2026-01-01",
    }];
    fixture.endpoint = {
      id: "draft-1", companyId: "company-1", provider: "github", assignedAgentId: "reviewer",
      assignedAgentName: "Reviewer", status: "draft",
      setup: { github: { stage: "setup", ownerType: "organization", ownerLogin: "saved-org", appName: "Saved App" } },
    };
    vi.mocked(agentsApi.list).mockResolvedValue(fixture.agents);
    vi.mocked(agentsApi.get).mockResolvedValue(fixture.agents[0]);
    vi.mocked(chatEndpointsApi.get).mockResolvedValue(fixture.endpoint);
    vi.mocked(chatEndpointsApi.list).mockResolvedValue([{ ...fixture.endpoint, id: "connected", status: "active" }]);
    vi.mocked(projectsApi.repositoryOptions).mockRejectedValue(new Error("Unavailable"));
    vi.mocked(chatEndpointsApi.listResources).mockResolvedValue([]);
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "create" });
    vi.mocked(githubChatApi.configuration).mockResolvedValue({
      revision: 1,
      configuration: { version: 1, toolsEnabled: true, responsibleUserId: "board", memberAccess: "selected", people: [], defaults: defaultGitHubReviewPolicy(), repositories: {} },
    });
    vi.mocked(githubChatApi.repositories).mockResolvedValue({ items: [], nextOffset: null, totalCount: 1, enabledCount: 1, availableCount: 1 });
    vi.mocked(githubChatApi.saveDraft).mockResolvedValue({ saved: true });
    vi.mocked(githubChatApi.personalConnections).mockResolvedValue([]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  it("masks the saved GitHub organization name in the owner selector from session replay", async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/BOT/apps/chat/connect?provider=github&resume=draft-1"]}>
            <TooltipProvider>
              <Routes>
                <Route path="/BOT/apps/chat/connect" element={<GitHubChatSetup />} />
              </Routes>
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => {
      expect((container.querySelector("#github-owner-type") as HTMLSelectElement | null)?.value).toBe("organization:saved-org");
    });
    expect(replayLeaks("saved-org", container.querySelector("#github-owner-type")!)).toEqual({ rendered: true, recorded: false });
  });
});
