// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDetail } from "./AppDetail";

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
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ connectionId: "conn-1", tab: "setup" as string | undefined }));
const navigateComponentMock = vi.hoisted(() => vi.fn());

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
    reconnectConnection: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "agent-1", name: "Coder", title: "Engineer", status: "active" },
    ]),
  },
}));

vi.mock("@/lib/router", () => ({
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
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

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
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
      authorizationUrl: "http://example.test/oauth",
      expiresAt: "2026-07-10T00:00:00.000Z",
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

  it("redirects a missing tab to setup", async () => {
    mockParams.tab = undefined;

    await renderAppDetail();

    expect(navigateComponentMock).toHaveBeenCalledWith({ to: "/apps/conn-1/setup", replace: true });
  });

  it.each([
    ["setup", "Agents can use this app"],
    ["review", "1 new action to review"],
    ["permissions", "Action permissions"],
    ["activity", "No activity yet."],
    ["advanced", "Technical details"],
  ])("renders the %s tab panel", async (tab, expectedText) => {
    mockParams.tab = tab;

    await renderAppDetail();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("2 actions available");
    expect(container.textContent).toContain(expectedText);
  });

  it("hides secret URL parameters in advanced technical details", async () => {
    mockParams.tab = "advanced";
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

  it("shows new quarantined actions on the review tab instead of an empty state", async () => {
    mockParams.tab = "review";

    await renderAppDetail();

    expect(container.textContent).toContain("1 new action to review");
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Review")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(container.textContent).toContain("Delete repo");
    expect(container.textContent).not.toContain("Nothing is waiting for your OK right now.");
  });

  it("keeps setup focused on description and lifecycle", async () => {
    mockParams.tab = "setup";

    await renderAppDetail();

    expect(container.textContent).toContain("Give agents a governed way to inspect repositories and pull requests.");
    expect(container.textContent).toContain("Agents can use this app");
    expect(container.textContent).not.toContain("Read repo");
    expect(container.textContent).not.toContain("Action permissions");
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
    expect(container.textContent).toContain("1 new action to review");
    const readSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Read repo permission"]');
    const writeSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Write issue permission"]');
    expect(readSelect?.value).toBe("allowed");
    expect(writeSelect?.value).toBe("ask");
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
});
