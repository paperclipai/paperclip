// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDetail } from "./AppDetail";

const getConnectionMock = vi.hoisted(() => vi.fn());
const listGalleryMock = vi.hoisted(() => vi.fn());
const listCatalogMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listPoliciesMock = vi.hoisted(() => vi.fn());
const listConnectionActivityMock = vi.hoisted(() => vi.fn());
const listActionRequestsMock = vi.hoisted(() => vi.fn());
const updateConnectionMock = vi.hoisted(() => vi.fn());
const finishAppMock = vi.hoisted(() => vi.fn());
const refreshCatalogMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ connectionId: "conn-1", tab: "setup" as string | undefined }));
const navigateComponentMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    getConnection: (connectionId: string) => getConnectionMock(connectionId),
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
    archiveConnection: vi.fn(),
    refreshCatalog: (connectionId: string) => refreshCatalogMock(connectionId),
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
    transport: "remote_http",
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

describe("AppDetail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.connectionId = "conn-1";
    mockParams.tab = "setup";
    getConnectionMock.mockResolvedValue(connection());
    listGalleryMock.mockResolvedValue({
      apps: [
        {
          key: "github",
          name: "GitHub",
          logoUrl: "https://example.com/github.png",
          tagline: "GitHub tagline",
          description: "Give agents a governed way to inspect repositories and pull requests.",
          authKind: "api_key",
          transportTemplate: { transport: "remote_http", url: "https://github.example/mcp" },
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
    refreshCatalogMock.mockResolvedValue({ discoveredCount: 0, quarantinedCount: 0, catalog: [] });
  });

  afterEach(() => {
    act(() => root?.unmount());
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
    ["review", "Nothing is waiting for your OK right now."],
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

  it("keeps setup focused on description and lifecycle", async () => {
    mockParams.tab = "setup";

    await renderAppDetail();

    expect(container.textContent).toContain("Give agents a governed way to inspect repositories and pull requests.");
    expect(container.textContent).toContain("Agents can use this app");
    expect(container.textContent).not.toContain("Read repo");
    expect(container.textContent).not.toContain("Action permissions");
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
