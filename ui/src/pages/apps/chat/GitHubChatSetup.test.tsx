// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubChatSetup, gitHubAppManifestAction } from "./GitHubChatSetup";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentsApi } from "@/api/agents";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { projectsApi } from "@/api/projects";
import { toolsApi } from "@/api/tools";
import { copyTextToClipboard } from "@/lib/clipboard";

const fixture = vi.hoisted(() => ({
  agents: [] as any[],
  endpoint: null as any,
  setBreadcrumbs: vi.fn(),
}));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Bot Company",
      issuePrefix: "BOT",
    },
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
    <select
      aria-label="Agent"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose an agent</option>
      {agents.map((agent: any) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(), get: vi.fn(), updatePermissions: vi.fn() },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: {
    list: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    listResources: vi.fn(),
    setup: vi.fn(),
  },
}));
vi.mock("@/api/projects", () => ({ projectsApi: { repositoryOptions: vi.fn() } }));
vi.mock("@/api/githubChat", () => ({
  githubChatApi: {
    configuration: vi.fn(),
    advance: vi.fn(),
    repositories: vi.fn(),
    registration: vi.fn(),
    restartRegistration: vi.fn(),
    saveDraft: vi.fn(),
    startIdentity: vi.fn(),
    confirmIdentity: vi.fn(),
    identity: vi.fn(),
    connectApp: vi.fn(),
    personalConnections: vi.fn(),
  },
}));
vi.mock("@/api/tools", () => ({
  toolsApi: { startCloudConnectorEnrollment: vi.fn() },
}));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

function Location() {
  const location = useLocation();
  return (
    <output>
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("GitHub App wizard", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.agents = [
      {
        id: "reviewer",
        name: "Reviewer",
        status: "idle",
        role: "engineer",
        permissions: { canCreateAgents: true, canCreateSkills: false },
        access: { canAssignTasks: true },
        createdAt: "2026-01-01",
      },
      {
        id: "helper",
        name: "Setup helper",
        status: "idle",
        role: "ceo",
        permissions: {},
        createdAt: "2026-01-01",
      },
      {
        id: "low",
        name: "Low-trust helper",
        status: "idle",
        role: "engineer",
        permissions: { trustPreset: "low_trust_review" },
        createdAt: "2026-01-01",
      },
    ];
    fixture.endpoint = {
      id: "draft-1",
      companyId: "company-1",
      provider: "github",
      assignedAgentId: "reviewer",
      assignedAgentName: "Reviewer",
      status: "draft",
      setup: { github: { stage: "setup" } },
    };
    vi.mocked(agentsApi.list).mockImplementation(async () => fixture.agents);
    vi.mocked(agentsApi.get).mockImplementation(async (id) =>
      fixture.agents.find((agent) => agent.id === id),
    );
    vi.mocked(agentsApi.updatePermissions).mockImplementation(
      async (id, permissions) => {
        fixture.agents = fixture.agents.map((agent) =>
          agent.id === id ? { ...agent, permissions } : agent,
        );
        return fixture.agents.find((agent) => agent.id === id);
      },
    );
    vi.mocked(chatEndpointsApi.get).mockImplementation(
      async () => fixture.endpoint,
    );
    vi.mocked(chatEndpointsApi.create).mockResolvedValue(fixture.endpoint);
    vi.mocked(chatEndpointsApi.list).mockResolvedValue([]);
    vi.mocked(projectsApi.repositoryOptions).mockResolvedValue({
      repositories: [], connectionCount: 0, failedConnectionCount: 0,
    });
    vi.mocked(chatEndpointsApi.listResources).mockResolvedValue([]);
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "create",
    });
    vi.mocked(githubChatApi.configuration).mockResolvedValue({
      revision: 1,
      configuration: { version: 1, toolsEnabled: true, responsibleUserId: "board", memberAccess: "selected", people: [],
        defaults: defaultGitHubReviewPolicy(), repositories: {} },
    });
    vi.mocked(githubChatApi.repositories).mockResolvedValue({
      items: [], nextOffset: null, totalCount: 1, enabledCount: 1, availableCount: 1,
    });
    vi.mocked(githubChatApi.saveDraft).mockResolvedValue({ saved: true });
    vi.mocked(githubChatApi.personalConnections).mockResolvedValue([]);
    vi.mocked(copyTextToClipboard).mockResolvedValue();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  it("shows pending signed delivery as waiting, not failed setup", async () => {
    fixture.endpoint.botExternalId = "1234";
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "verify",
      message: "Waiting for GitHub to verify webhook delivery…",
      verification: {
        ready: false,
        checks: [
          {
            key: "webhook",
            label: "Signed webhook delivery",
            ok: false,
            detail:
              "Keep this page open. Setup will continue automatically when GitHub’s signed ping arrives.",
          },
        ],
      },
    });
    await render("resume=draft-1");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Waiting for GitHub",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("continue automatically");
    expect(githubChatApi.registration).not.toHaveBeenCalled();
  });
  it("replaces a stale ping wait as soon as signed delivery arrives", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "verify",
      message: "Waiting for GitHub to verify webhook delivery…",
      verification: {
        ready: false,
        checks: [{ key: "webhook", label: "Signed delivery", ok: false,
          detail: "Keep this page open until the signed ping arrives." }],
      },
    });
    await render("resume=draft-1");
    expect(container.textContent).toContain("Waiting for GitHub");
    // Endpoint polling observes the receipt while full access verification is
    // still in flight. The previous progress response must not mislead users.
    await act(async () => {
      client.setQueryData(["github-setup", "draft-1"], {
        ...fixture.endpoint,
        setup: { ...fixture.endpoint.setup, webhookVerifiedAt: "2026-10-08T10:31:10Z" },
      });
    });
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "GitHub delivery verified. Checking App and repository access",
    );
    expect(container.textContent).not.toContain("Waiting for GitHub");
    expect(container.textContent).not.toContain("until the signed ping arrives");
    expect(container.textContent).not.toContain("GitHub connected");
    expect(githubChatApi.registration).not.toHaveBeenCalled();
  });
  it("reconnects the same App using vaulted credentials without requiring another paste", async () => {
    fixture.endpoint.status = "attention";
    fixture.endpoint.botExternalId = "1234";
    vi.mocked(chatEndpointsApi.setup).mockResolvedValue(fixture.endpoint);
    await render("resume=draft-1&reconnect=1");
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reconnect App",
    )!;
    expect(button.disabled).toBe(false);
    expect(container.querySelector("#github-webhook-secret")).toBeNull();
    await act(async () => {
      button.click();
    });
    expect(chatEndpointsApi.setup).toHaveBeenCalledWith("draft-1", {
      action: "reconnect",
    });
    expect(githubChatApi.connectApp).not.toHaveBeenCalled();
  });
  async function render(query = "agentId=reviewer") {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter
            initialEntries={[`/BOT/apps/chat/connect?provider=github&${query}`]}
          >
            <TooltipProvider>
              <Routes>
                <Route path="/BOT/apps/chat/connect" element={<GitHubChatSetup />} />
                <Route path="/apps/chat/:endpointId/:tab" element={<ChatEndpointDetail />} />
                <Route path="/apps" element={<div>Connectors</div>} />
              </Routes>
              <Location />
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await settle();
    // Completion mounts Settings and its own queries after the wizard redirect.
    await settle();
    await settle();
  }
  async function click(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (button) =>
        button.textContent === label ||
        button.getAttribute("aria-label") === label,
    );
    expect(button, label).toBeTruthy();
    await act(async () => button!.click());
    await settle();
  }
  it("binds Cloud enrollment return to the same draft without a duplicated company prefix", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "enrollment" });
    vi.mocked(toolsApi.startCloudConnectorEnrollment).mockResolvedValue({ configured: false, status: "pending", brokerBaseUrl: "https://gateway.example", instanceId: "instance-1", environment: "staging", origins: [] });
    const prior = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", "/BOT/apps/chat/connect?provider=github&purpose=chat&resume=draft-1");
    try {
      await render("purpose=chat&resume=draft-1");
      await click("Connect Paperclip Cloud");
      expect(toolsApi.startCloudConnectorEnrollment).toHaveBeenCalledWith("company-1", undefined, "/apps/chat/connect?provider=github&purpose=chat&resume=draft-1");
    } finally {
      window.history.replaceState(null, "", prior);
    }
  });
  it("starts with agent selection and saves the low-trust repair before removing its warning", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Choose agent");
    expect(container.textContent).not.toContain("permanent");
    expect(container.textContent).not.toContain("Copy setup prompt");
    await click("Change Reviewer to a low trust agent");
    expect(agentsApi.updatePermissions).toHaveBeenCalledWith(
      "reviewer",
      expect.objectContaining({
        trustPreset: "low_trust_review",
        canCreateAgents: false,
        canCreateSkills: false,
        canAssignTasks: true,
      }),
      "company-1",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("Continue");
    expect(chatEndpointsApi.create).toHaveBeenCalledWith("company-1", {
      provider: "github",
      assignedAgentId: "reviewer",
    });
    expect(container.querySelector("h1")?.textContent).toBe("Connect GitHub");
    expect(container.querySelector("output:not([for])")?.textContent).toContain(
      "resume=draft-1",
    );
  });
  it("does not offer a new connection while a saved draft cannot be loaded", async () => {
    vi.mocked(chatEndpointsApi.get).mockRejectedValue(new Error("Not found"));
    await render("resume=missing-draft&agentId=reviewer");
    expect(container.textContent).toContain("Could not load this connection");
    expect(container.textContent).not.toContain("Choose agent");
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
  });
  it("keeps the warning and shows the failure when changing trust fails", async () => {
    vi.mocked(agentsApi.updatePermissions).mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await render();
    await click("Change Reviewer to a low trust agent");
    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain(
      "Reviewer is not configured for low-trust review",
    );
  });
  it("resumes the assigned draft with only account and App name choices", async () => {
    await render("resume=draft-1");
    expect(container.querySelector("h1")?.textContent).toBe("Connect GitHub");
    expect(container.textContent).toContain("My account");
    expect(container.textContent).toContain("Another organization");
    expect(container.textContent).not.toContain("GitHub will ask you");
    expect(container.textContent).not.toContain("Creates your own GitHub App");
    expect(container.textContent).not.toContain("Assign setup task");
    expect(container.textContent).not.toContain("Copy setup prompt");
    expect(container.textContent).not.toContain("Choose setup method");
    expect(
      container.querySelector("input#github-app-name")?.getAttribute("value"),
    ).toBe("Reviewer");
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
  });
  it("offers known organizations from repositories and connected bots, without personal owners or duplicates", async () => {
    vi.mocked(projectsApi.repositoryOptions).mockResolvedValue({
      repositories: [
        { id: "1", fullName: "acme/api", ownerType: "organization", url: "https://github.com/acme/api", connections: ["GitHub"] },
        { id: "2", fullName: "ACME/web", ownerType: "organization", url: "https://github.com/ACME/web", connections: ["GitHub"] },
        { id: "3", fullName: "octocat/site", ownerType: "personal", url: "https://github.com/octocat/site", connections: ["GitHub"] },
        { id: "4", fullName: "unknown/legacy", url: "https://github.com/unknown/legacy", connections: ["GitHub"] },
      ], connectionCount: 1, failedConnectionCount: 0,
    });
    vi.mocked(chatEndpointsApi.list).mockResolvedValue([
      { ...fixture.endpoint, id: "connected", status: "active", setup: { github: { ownerType: "organization", ownerLogin: "paperclipai" } } },
      { ...fixture.endpoint, id: "unconnected", setup: { github: { ownerType: "organization", ownerLogin: "unfinished" } } },
    ]);
    await render("resume=draft-1");
    const select = container.querySelector("#github-owner-type") as HTMLSelectElement;
    expect([...select.options].map(option => option.textContent)).toEqual([
      "My account", "ACME", "paperclipai", "Another organization",
    ]);
    await act(async () => {
      select.value = "organization:paperclipai";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("#github-owner-login")).toBeNull();
    await click("Continue to GitHub");
    expect(githubChatApi.registration).toHaveBeenCalledWith("draft-1", {
      name: "Reviewer", ownerType: "organization", ownerLogin: "paperclipai",
    });
  });
  it("keeps Another organization editable even when the typed name is already known", async () => {
    vi.mocked(chatEndpointsApi.list).mockResolvedValue([
      { ...fixture.endpoint, status: "active", setup: { github: { ownerType: "organization", ownerLogin: "acme" } } },
    ]);
    await render("resume=draft-1");
    const select = container.querySelector("#github-owner-type") as HTMLSelectElement;
    await act(async () => {
      select.value = "organization:acme";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      select.value = "organization";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = container.querySelector("#github-owner-login") as HTMLInputElement;
    expect(input.value).toBe("");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("#github-owner-login")).toBe(input);
    await click("Save & exit");
    expect(githubChatApi.saveDraft).toHaveBeenCalledWith("draft-1", {
      name: "Reviewer", ownerType: "organization", ownerLogin: "acme",
    });
  });
  it("preserves the saved organization when known accounts arrive and allows manual setup after lookup failure", async () => {
    fixture.endpoint.setup.github = { ownerType: "organization", ownerLogin: "saved-org", appName: "Saved App" };
    vi.mocked(projectsApi.repositoryOptions).mockRejectedValue(new Error("Unavailable"));
    vi.mocked(chatEndpointsApi.list).mockResolvedValue([
      { ...fixture.endpoint, id: "connected", status: "active" },
    ]);
    await render("resume=draft-1");
    expect((container.querySelector("#github-owner-type") as HTMLSelectElement).value).toBe("organization:saved-org");
    expect(container.textContent).toContain("Could not load some connected GitHub accounts");
    await click("Save & exit");
    expect(githubChatApi.saveDraft).toHaveBeenCalledWith("draft-1", {
      name: "Saved App", ownerType: "organization", ownerLogin: "saved-org",
    });
  });
  it("requires no-App-created confirmation before restarting an expired handoff", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "recovery", restartableRegistrationId: "expired-1", message: "Handoff expired" });
    vi.mocked(githubChatApi.restartRegistration).mockResolvedValue({ endpointId: "draft-1", state: "create" });
    await render("resume=draft-1");
    const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Continue to GitHub")!;
    expect(button.disabled).toBe(true);
    expect(githubChatApi.restartRegistration).not.toHaveBeenCalled();
    await act(async () => (container.querySelector("#github-app-not-created") as HTMLElement).click());
    expect(button.disabled).toBe(false);
    await click("Continue to GitHub");
    expect(githubChatApi.restartRegistration).toHaveBeenCalledWith("draft-1", "expired-1");
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
    expect(githubChatApi.registration).not.toHaveBeenCalled();
  });
  it("does not offer registration restart for an uncertain exchange", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "recovery", message: "Recover existing App" });
    await render("resume=draft-1");
    expect(container.querySelector("#github-app-not-created")).toBeNull();
    expect(container.textContent).not.toContain("Continue to GitHub");
    expect(container.textContent).toContain("Use existing App credentials");
  });
  it("saves ownership and the suggested name when exiting", async () => {
    await render("resume=draft-1");
    const owner = container.querySelector(
      "#github-owner-type",
    ) as HTMLSelectElement;
    await act(async () => {
      owner.value = "organization";
      owner.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = container.querySelector(
      "#github-owner-login",
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save & exit");
    expect(githubChatApi.saveDraft).toHaveBeenCalledWith("draft-1", {
      name: "Reviewer",
      ownerType: "organization",
      ownerLogin: "acme",
    });
    expect(container.querySelector("output:not([for])")?.textContent).toBe("/apps");
  });
  it("replaces stale cached form defaults when the saved draft refreshes", async () => {
    await render("resume=draft-1");
    expect(
      (container.querySelector("#github-app-name") as HTMLInputElement).value,
    ).toBe("Reviewer");
    fixture.endpoint = {
      ...fixture.endpoint,
      setup: {
        github: {
          ownerType: "organization",
          ownerLogin: "acme",
          appName: "Saved App",
        },
      },
    };
    await act(async () =>
      client.invalidateQueries({ queryKey: ["github-setup", "draft-1"] }),
    );
    await settle();
    expect(
      (container.querySelector("#github-owner-type") as HTMLSelectElement)
        .value,
    ).toBe("organization");
    expect(
      (container.querySelector("#github-owner-login") as HTMLInputElement)
        .value,
    ).toBe("acme");
    expect(
      (container.querySelector("#github-app-name") as HTMLInputElement).value,
    ).toBe("Saved App");
  });
  it("submits the manifest directly, preserving the bound registration on retry", async () => {
    const registration = {
      registrationUrl:
        "https://github.com/organizations/acme/settings/apps/new?state=bound",
      manifest: { name: "Reviewer", public: false },
      expiresAt: "2026-10-06T20:00:00Z",
    };
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "create",
      registration,
    });
    await render("resume=draft-1");
    const form = container.querySelector("form")!;
    expect(form.method).toBe("post");
    expect(form.action).toBe(registration.registrationUrl);
    expect((form.querySelector('[name="manifest"]') as HTMLInputElement).value)
      .toBe(JSON.stringify(registration.manifest));
    expect(form.querySelector('button[type="submit"]')?.textContent).toBe("Continue to GitHub");
    expect((form.querySelector('button[type="button"]') as HTMLButtonElement).textContent).toBe("Save & exit");
    expect(githubChatApi.registration).not.toHaveBeenCalled();
    expect((container.querySelector("#github-owner-type") as HTMLSelectElement).disabled).toBe(true);
    expect(() => gitHubAppManifestAction({ ...registration, registrationUrl: "https://evil.example/apps/new" }))
      .toThrow("invalid registration");
  });
  it("submits the mounted native form after preparing a fresh registration", async () => {
    const registration = {
      registrationUrl: "https://github.com/settings/apps/new?state=bound",
      manifest: { name: "Reviewer", public: false }, expiresAt: "2026-10-07T20:00:00Z",
    };
    vi.mocked(githubChatApi.registration).mockResolvedValue({ endpointId: "draft-1", state: "create", registration });
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(function (this: HTMLFormElement) {
      expect(this.isConnected).toBe(true);
      expect((this.querySelector('[name="manifest"]') as HTMLInputElement).value).toBe(JSON.stringify(registration.manifest));
      this.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    try {
      await render("resume=draft-1");
      await click("Continue to GitHub");
      await settle();
      expect(requestSubmit).toHaveBeenCalledTimes(1);
      expect(githubChatApi.registration).toHaveBeenCalledTimes(1);
    } finally { requestSubmit.mockRestore(); }
  });
  it("shows passive installation progress without a duplicate repository picker or refresh gate", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "install",
      installationUrl: "https://github.com/apps/reviewer/installations/new",
    });
    await render("resume=draft-1");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).not.toContain("I’ve installed it");
    expect(container.textContent).not.toContain("Refresh repositories");
    expect(container.textContent).not.toContain("Prepare registration");
    expect(
      container.querySelector(
        'a[href="https://github.com/apps/reviewer/installations/new"]',
      ),
    ).toBeTruthy();
  });
  it("requires an explicit identity confirmation only for an unlinked account", async () => {
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "identity",
      identity: { githubUserId: "42", login: "octocat", avatarUrl: null },
    });
    vi.mocked(githubChatApi.confirmIdentity).mockResolvedValue({
      endpointId: "draft-1",
      state: "connected",
    });
    await render("resume=draft-1");
    await click("Confirm my account");
    expect(githubChatApi.confirmIdentity).toHaveBeenCalledWith("draft-1", "42");
    expect(githubChatApi.startIdentity).not.toHaveBeenCalled();
  });
  it("lets a member add a personal connection without manager setup APIs", async () => {
    vi.mocked(githubChatApi.advance).mockRejectedValue(
      new Error("Manager permission required"),
    );
    await render("resume=draft-1&stage=identity");
    expect(
      container.querySelector('a[href="/apps/connect?source=github"]'),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Manager permission required");
    expect(githubChatApi.advance).not.toHaveBeenCalled();
    expect(githubChatApi.startIdentity).not.toHaveBeenCalled();
    await click("Save & exit");
    expect(githubChatApi.saveDraft).not.toHaveBeenCalled();
  });
  it("links a member's verified personal account without advancing bot setup", async () => {
    vi.mocked(githubChatApi.personalConnections).mockResolvedValue([
      {
        connectionId: "personal-1",
        name: "My GitHub",
        login: "octocat",
        status: "active",
        enabled: true,
      },
    ]);
    vi.mocked(githubChatApi.identity).mockResolvedValue({
      connectionId: "personal-1",
      githubUserId: "42",
      login: "octocat",
      avatarUrl: null,
    });
    await render("resume=draft-1&stage=identity");
    const account = container.querySelector(
      "#github-personal-account",
    ) as HTMLSelectElement;
    await act(async () => {
      account.value = "personal-1";
      account.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Check my account");
    expect(githubChatApi.identity).toHaveBeenLastCalledWith(
      "draft-1",
      "personal-1",
      undefined,
    );
    await click("Confirm my account");
    expect(githubChatApi.identity).toHaveBeenLastCalledWith(
      "draft-1",
      "personal-1",
      "42",
    );
    expect(container.textContent).toContain(
      "You can now mention this bot on GitHub",
    );
    expect(githubChatApi.advance).not.toHaveBeenCalled();
    expect(githubChatApi.startIdentity).not.toHaveBeenCalled();
    expect(githubChatApi.confirmIdentity).not.toHaveBeenCalled();
  });
  it("completes automatically while reporting runtime readiness separately", async () => {
    fixture.endpoint = {
      ...fixture.endpoint,
      status: "active",
      setup: { step: "complete" },
      botLabel: "Actual GitHub Name",
      botUsername: "actual-agent[bot]",
      resources: [{ enabled: true, label: "acme/repo" }],
    };
    vi.mocked(githubChatApi.advance).mockResolvedValue({
      endpointId: "draft-1",
      state: "connected",
      runtimeChecks: [
        {
          key: "runtime",
          label: "Runtime",
          ok: false,
          detail: "Configure a runtime before the first review.",
        },
      ],
    });
    await render("resume=draft-1");
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("GitHub connected");
    expect(document.body.textContent).toContain("Actual GitHub Name");
    expect(document.body.textContent).toContain("GitHub App name and logo");
    expect(document.body.textContent).toContain("1 repository enabled");
    expect(container.querySelector("output:not([for])")?.textContent).toBe("/apps/chat/draft-1/settings");
    expect(document.querySelector('[role="dialog"] details')?.hasAttribute("open")).toBe(false);
    expect(document.body.textContent).toContain("Before your first review");
    expect(document.body.textContent).toContain("Configure a runtime");
    expect(document.body.textContent).not.toContain("Finish");
    await click("Copy mention");
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      "@actual-agent review this pull request",
    );
  });
  it.each(["Done", "Close", "Escape"])("dismisses with %s onto the same mounted Settings page", async (action) => {
    fixture.endpoint = { ...fixture.endpoint, status: "active", setup: { step: "complete" } };
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "connected" });
    await render("resume=draft-1");
    const settings = container.querySelector("textarea");
    expect(settings).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    if (action === "Escape") {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await settle();
    } else await click(action);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("output:not([for])")?.textContent).toBe("/apps/chat/draft-1/settings");
    expect(container.querySelector("textarea")).toBe(settings);
    expect(container.querySelector("h1")?.textContent).toBe("Reviewer");
    expect(document.activeElement).toBe(container.querySelector("h1"));
    expect(githubChatApi.saveDraft).not.toHaveBeenCalled();
    expect(chatEndpointsApi.create).not.toHaveBeenCalled();
  });
  it("reports copy failure without undoing the completed connection", async () => {
    fixture.endpoint = { ...fixture.endpoint, status: "active", setup: { step: "complete" }, botUsername: "actual-agent[bot]" };
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "connected" });
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await render("resume=draft-1");
    await click("Copy mention");
    expect(document.body.textContent).toContain("Copy failed");
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("GitHub connected");
    expect(githubChatApi.registration).not.toHaveBeenCalled();
  });
  it("shows a useful next step when a connected bot has no enabled repositories", async () => {
    fixture.endpoint = { ...fixture.endpoint, status: "active", setup: { step: "complete" } };
    vi.mocked(githubChatApi.advance).mockResolvedValue({ endpointId: "draft-1", state: "connected" });
    vi.mocked(githubChatApi.repositories).mockResolvedValue({
      items: [], nextOffset: null, totalCount: 2, enabledCount: 0, availableCount: 2,
    });
    await render("resume=draft-1");
    expect(document.body.textContent).toContain("No repositories enabled");
    expect(document.body.textContent).toContain("Enable a repository in Access to try your bot");
    expect(document.querySelector('[role="dialog"] a[href="/apps/chat/draft-1/access"]')).not.toBeNull();
  });

  it("does not flash App creation controls while checking a resumed connection", async () => {
    fixture.endpoint = { ...fixture.endpoint, status: "active", setup: { step: "complete" }, botUsername: "actual-agent[bot]" };
    vi.mocked(githubChatApi.advance).mockReturnValue(new Promise(() => {}));
    await render("resume=draft-1");
    expect(container.textContent).toContain("Checking your GitHub connection");
    expect(container.querySelector("#github-app-name")).toBeNull();
    expect(container.textContent).not.toContain("I already have an App");
    expect(container.textContent).not.toContain("GitHub connected");
  });

});
