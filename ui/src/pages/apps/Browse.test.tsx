// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse, pendingFirstSignInOnlyApplicationIds } from "./Browse";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

const aggregatorCatalogMock = vi.hoisted(() => [] as AggregatorAppCatalogEntry[]);
const openNewIssueMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const setupComposioAppMock = vi.hoisted(() => vi.fn());
const listComposioAppsMock = vi.hoisted(() => vi.fn());
const syncComposioAppsMock = vi.hoisted(() => vi.fn());
const refreshComposioAppsMock = vi.hoisted(() => vi.fn());
const manageComposioAppAccountMock = vi.hoisted(() => vi.fn());

function genericResponse(value: { apps?: any[]; sync?: Record<string, unknown> }) {
  return {
    provider: "composio",
    discovery: { availability: "available", message: null },
    sync: { status: "ready", ...value.sync },
    apps: (value.apps ?? []).map((snapshot) => ({
      ...snapshot,
      provider: snapshot.provider ?? "composio",
      appSlug: snapshot.appSlug ?? aggregatorCatalogMock.find((app) => app.aliases.includes(snapshot.toolkit) || app.routes.some((route) => route.toolkit === snapshot.toolkit))?.slug ?? snapshot.toolkit,
      appName: snapshot.appName ?? snapshot.toolkit,
    })),
  };
}

vi.mock("@/api/agents", () => ({ agentsApi: { list: (companyId: string) => listAgentsMock(companyId) } }));
vi.mock("@paperclipai/shared/aggregator-app-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/shared/aggregator-app-catalog")>();
  return {
    ...actual,
    AGGREGATOR_APP_CATALOG: aggregatorCatalogMock,
    findComposioCatalogApp: (toolkit: string) =>
      aggregatorCatalogMock.find((app) => app.aliases.includes(toolkit) || app.routes.some((route) => route.provider === "composio" && route.toolkit === toolkit)),
  };
});
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: openNewIssueMock }) }));

const accountIdentity = vi.hoisted(() => ({ userId: "board-user" as string | null, settled: true, failed: false }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => accountIdentity }));

const poolListMock = vi.hoisted(() => vi.fn());
const poolRemoveMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: poolListMock, remove: poolRemoveMock } }));

const assistantConnectionsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/publicMcp", () => ({ publicMcpApi: { connections: assistantConnectionsMock } }));
const tailscaleConnectionsMock = vi.hoisted(() => vi.fn(async () => [] as Array<{ id: string; companyId: string; name: string; status: string }>));
vi.mock("@/api/tailscale", () => ({ tailscaleApi: { list: tailscaleConnectionsMock } }));

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listAiConnectionsMock = vi.hoisted(() => vi.fn());
const setAiDefaultMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: listAiConnectionsMock, setDefault: setAiDefaultMock } }));
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const boardAccessMock = vi.hoisted(() => vi.fn());
const archiveConnectionMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const experimentalMock = vi.hoisted(() => vi.fn());
const chatSetupMock = vi.hoisted(() => vi.fn());
const emailControlMock = vi.hoisted(() => vi.fn());
const chatListMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: experimentalMock } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: chatListMock, setup: chatSetupMock } }));
vi.mock("@/api/email", () => ({ emailApi: { control: emailControlMock } }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listAggregatorApps: async (...args: unknown[]) => genericResponse(await listComposioAppsMock(...args)),
    syncAggregatorApps: async (...args: unknown[]) => genericResponse(await syncComposioAppsMock(...args)),
    refreshAggregatorApps: async (...args: unknown[]) => genericResponse(await refreshComposioAppsMock(...args)),
    refreshCatalog: vi.fn().mockResolvedValue({}),
    configureArcadeDiscovery: vi.fn(),
    syncComposioApps: (...args: unknown[]) => syncComposioAppsMock(...args),
    listComposioApps: (...args: unknown[]) => listComposioAppsMock(...args),
    refreshComposioApps: (...args: unknown[]) => refreshComposioAppsMock(...args),
    manageComposioAppAccount: (...args: unknown[]) => manageComposioAppAccountMock(...args),
    setupComposioApp: (...args: unknown[]) => setupComposioAppMock(...args),
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    archiveConnection: (connectionId: string) => archiveConnectionMock(connectionId),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
    getCurrentBoardAccess: boardAccessMock,
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
  useOptionalToastActions: () => ({ pushToast: pushToastMock }),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-notion",
    name: "Notion",
    description: "Read and update workspace content.",
    status: "active",
    applicationKey: "app-gallery:notion:one",
    metadata: { sourceTemplateKey: "notion" },
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-notion",
    applicationId: "app-notion",
    transport: "mcp_remote",
    name: "devinfoley@gmail.com",
    status: "active",
    enabled: true,
    authKind: "oauth",
    healthStatus: "ok",
    healthMessage: null,
    lastError: null,
    createdByUserId: "user-1",
    config: { sourceTemplateKey: "notion" },
    transportConfig: {},
    ...overrides,
  };
}

describe("Connectors landing page privacy & access gates", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    boardAccessMock.mockReset().mockResolvedValue({ source: "session", isInstanceAdmin: true });
    accountIdentity.userId = "board-user";
    accountIdentity.settled = true;
    assistantConnectionsMock.mockReset().mockResolvedValue([]);
    syncComposioAppsMock.mockReset().mockImplementation((...args) => listComposioAppsMock(...args));
    listComposioAppsMock.mockReset().mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockReset().mockResolvedValue({ apps: [] });
    manageComposioAppAccountMock.mockReset();
    listAgentsMock.mockResolvedValue([{ id: "default-agent", name: "Default agent", role: "ceo", reportsTo: null, status: "active", createdAt: new Date(0) }]);
    aggregatorCatalogMock.splice(0);
    experimentalMock.mockResolvedValue({ enableChatConnectors: true, enableGitHubReviewBots: true });
    chatListMock.mockResolvedValue([]);
    chatSetupMock.mockReset().mockResolvedValue({ status: "archived" });
    emailControlMock.mockReset().mockResolvedValue({ status: "archived" });
    listGalleryMock.mockResolvedValue({ apps: [] });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listAiConnectionsMock.mockReset().mockResolvedValue({ currentUserId: "board-user", canManageConnections: true, connections: [] });
    setAiDefaultMock.mockReset().mockResolvedValue({ ok: true });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    archiveConnectionMock.mockResolvedValue(connection({ status: "archived" }));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    vi.clearAllMocks();
  });

  async function renderBrowse(allCatalog = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TooltipProvider><Browse /></TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    if (allCatalog) {
      await clickButton("All", container);
    }
    return client;
  }

  async function clickButton(text: string, scope: ParentNode = document) {
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)!;
    expect(button).toBeTruthy();
    await act(() => button.click());
    await flushReact();
  }

  async function search(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  it("titles the Google AI connector after Antigravity and Gemini", async () => {
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("google")] });
    await renderBrowse(false);
    const google = container.querySelector('[data-app-slug="google"]');
    expect(google?.querySelector("h2")?.textContent).toBe("Google Antigravity and Gemini");
    expect(google?.textContent).toContain("Connect Google Antigravity accounts or Gemini API keys for your agents.");
    expect(container.querySelector('[aria-label="Connect Google Antigravity and Gemini"]')).not.toBeNull();
  });

  it("does not advertise Tailscale setup or request tailnets for non-instance-admin members", async () => {
    boardAccessMock.mockResolvedValue({ source: "session", isInstanceAdmin: false });
    await renderBrowse(false);
    await search("Tailscale");
    expect(container.querySelector('[aria-label="Connect Tailscale"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="tailscale"]')).toBeNull();
    expect(tailscaleConnectionsMock).not.toHaveBeenCalled();
  });

  it("masks upstream account labels in the Manage dialog from session replay", async () => {
    aggregatorCatalogMock.push({
      name: "Fathom",
      slug: "fathom",
      aliases: ["fathom"],
      routes: [{ provider: "composio", toolkit: "fathom", logoUrl: "https://logos.example.com/fathom.svg", docsUrl: "https://docs.composio.dev/fathom" }],
    });
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } })] });
    const snapshot = { connectionId: "conn-notion", toolkit: "fathom", status: "connected", checkedAt: new Date().toISOString(), accounts: [{ id: "ca-work", alias: "Meeting notes", status: "ACTIVE", isDefault: true }] };
    listComposioAppsMock.mockResolvedValue({ apps: [snapshot] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [snapshot] });

    await renderBrowse();
    await clickButton("Manage", container);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(replayLeaks("Meeting notes", dialog)).toEqual({ rendered: true, recorded: false });
    expect(replayLeaks("Composio account", dialog)).toEqual({ rendered: true, recorded: false });
  });

  it("masks Notebook account labels in the row and removal confirmation dialog from session replay", async () => {
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("paperclip-notebook")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "notebook-app", name: "Paperclip Notebook", applicationKey: "app-gallery:paperclip-notebook:one",
      metadata: { sourceTemplateKey: "paperclip-notebook" },
    })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({
      id: "saved-notebook", applicationId: "notebook-app", name: "Notebook account",
      config: { sourceTemplateKey: "paperclip-notebook" }, healthStatus: "error", requiresReauthorization: true,
    })] });

    await renderBrowse();
    const row = container.querySelector('[data-app-slug="paperclip-notebook"]')!;
    await act(() => { row.querySelector<HTMLButtonElement>('button[aria-label^="Manage "]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    expect(replayLeaks("Notebook account", row)).toEqual({ rendered: true, recorded: false });
    await act(() => { [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Remove connection")!.click(); });
    await flushReact();
    const removeDialog = document.querySelector('[role="alertdialog"]')!;
    expect(replayLeaks("Notebook account", removeDialog)).toEqual({ rendered: true, recorded: false });
  });

  it("finds apps with only unfinished sign-ins in one pass over a large list", () => {
    const connections = Array.from({ length: 5000 }, (_, index) => ({
      applicationId: `app-${index % 2500}`,
      status: index < 2500 ? "draft" as const : "active" as const,
      firstSignInPending: index < 2500 || undefined,
    }));
    connections.push({ applicationId: "app-only-pending", status: "draft", firstSignInPending: true });
    let reads = 0;
    const counted = new Proxy(connections, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect([...pendingFirstSignInOnlyApplicationIds(counted)]).toEqual(["app-only-pending"]);
    expect(reads).toBeLessThanOrEqual(connections.length);
  });
});
