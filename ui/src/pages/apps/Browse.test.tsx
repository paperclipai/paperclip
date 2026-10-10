// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";
import { aiConnectionRouterAppDefinition, getAppStoreDefinition } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";

const aggregatorCatalogMock = vi.hoisted(() => [] as AggregatorAppCatalogEntry[]);
const openNewIssueMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const setupComposioAppMock = vi.hoisted(() => vi.fn());
const listComposioAppsMock = vi.hoisted(() => vi.fn());
const syncComposioAppsMock = vi.hoisted(() => vi.fn());
const refreshComposioAppsMock = vi.hoisted(() => vi.fn());
const manageComposioAppAccountMock = vi.hoisted(() => vi.fn());
function genericResponse(value: { apps?: any[]; sync?: Record<string, unknown> }) {
  return { provider: "composio", discovery: { availability: "available", message: null },
    sync: { status: "ready", ...value.sync }, apps: (value.apps ?? []).map(snapshot => ({ ...snapshot, provider: snapshot.provider ?? "composio",
      appSlug: snapshot.appSlug ?? aggregatorCatalogMock.find(app => app.aliases.includes(snapshot.toolkit) || app.routes.some(route => route.toolkit === snapshot.toolkit))?.slug ?? snapshot.toolkit,
      appName: snapshot.appName ?? snapshot.toolkit })) };
}
vi.mock("@/api/agents", () => ({ agentsApi: { list: (companyId: string) => listAgentsMock(companyId) } }));
vi.mock("@paperclipai/shared/aggregator-app-catalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/shared/aggregator-app-catalog")>(),
  AGGREGATOR_APP_CATALOG: aggregatorCatalogMock,
  findComposioCatalogApp: (toolkit: string) => aggregatorCatalogMock.find(app => app.aliases.includes(toolkit) || app.routes.some(route => route.provider === "composio" && route.toolkit === toolkit)),
}));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: openNewIssueMock }) }));

const accountIdentity = vi.hoisted(() => ({ userId: "board-user" as string | null, settled: true, failed: false }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => accountIdentity }));

const poolListMock = vi.hoisted(() => vi.fn());
const poolRemoveMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connection-pools", () => ({ aiConnectionPoolsApi: { list: poolListMock, remove: poolRemoveMock } }));

const assistantConnectionsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/publicMcp", () => ({ publicMcpApi: { connections: assistantConnectionsMock } }));

const listGalleryMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
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
    archiveConnection: (
      connectionId: string,
    ) => archiveConnectionMock(connectionId),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
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
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function galleryEntry(overrides: Record<string, unknown>) {
  return {
    key: "github",
    name: "GitHub",
    logoUrl: "https://example.com/github.png",
    tagline: "Let agents open pull requests and issues.",
    authKind: "oauth",
    transportTemplate: {
      transport: "mcp_remote",
      url: "https://api.github.com/mcp",
    },
    credentialFields: [],
    recommendedDefaults: {},
    urlPatterns: [],
    ...overrides,
  };
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

describe("Connectors landing page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    accountIdentity.userId = "board-user"; accountIdentity.settled = true;
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
    listGalleryMock.mockResolvedValue({
      apps: [
        galleryEntry({
          key: "notion",
          name: "Notion",
          tagline: "Read and update workspace content.",
        }),
        galleryEntry({
          key: "jira",
          name: "Jira",
          tagline: "Track projects and issues.",
        }),
        galleryEntry({
          key: "gmail",
          name: "Gmail",
          tagline: "Search and draft email.",
          availability: {
            available: false,
            reason: "Gmail is not available on this Paperclip instance yet.",
          },
        }),
      ],
    });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
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
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
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

  it("shows provider catalog rows and splits legacy gateway accounts by API format", async () => {
    const slugs = ["notion", "openrouter", "bedrock", "google", "responses-api", "messages-api", "chat-completions-api", "local"];
    listGalleryMock.mockResolvedValue({ apps: slugs.map(slug => getAppStoreDefinition(slug)) });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Model gateway", applicationKey: "app-gallery:gateway", metadata: { sourceTemplateKey: "gateway" } })] });
    listConnectionsMock.mockResolvedValue({ connections: ["responses", "messages"].map(protocol => connection({
      id: protocol, name: `${protocol} account`, applicationId: "gateway-app", connectionPurpose: "ai",
      config: { sourceTemplateKey: "gateway", ai: { provider: protocol === "messages" ? "anthropic" : "openai", method: "api_key", routing: { kind: "gateway", protocol, auth: "bearer", baseUrl: "https://models.example.com/v1", models: [] } } },
    })) });
    await renderBrowse();
    expect(container.textContent).not.toContain("Connect a model provider");
    expect(container.textContent).not.toContain("Model gateway");
    for (const slug of slugs) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    const responses = container.querySelector('[data-app-slug="responses-api"]')!;
    const messages = container.querySelector('[data-app-slug="messages-api"]')!;
    expect(responses.textContent).toContain("responses account");
    expect(responses.textContent).not.toContain("messages account");
    expect(messages.textContent).toContain("messages account");
    const bedrock = container.querySelector('[data-app-slug="bedrock"]')!;
    const connect = Array.from(bedrock.querySelectorAll('button')).find(button => button.textContent?.includes("Connect"))!;
    await act(() => connect.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=bedrock");
  });

  it("offers assistant setup from Connections without choosing an agent", async () => {
    await renderBrowse();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Set up Assistant Connection (MCP)"]');
    expect(button).not.toBeNull();
    await act(() => button!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/assistant-connection");
    expect(chatSetupMock).not.toHaveBeenCalled();
  });

  it("keeps assistant setup in the Paperclip catalog when filtering connection sources", async () => {
    await renderBrowse(false);
    const assistantButton = () => container.querySelector('[aria-label="Set up Assistant Connection (MCP)"]');
    expect(assistantButton()).not.toBeNull();
    await clickButton("Composio", container);
    expect(assistantButton()).toBeNull();
    await clickButton("Arcade", container);
    expect(assistantButton()).toBeNull();
    await clickButton("All", container);
    await search("assistant");
    expect(assistantButton()).not.toBeNull();
    expect(container.textContent).not.toContain("No connectors match");
  });

  const assistantGrant = { id: "grant", companyId: "company-1", companyName: "Paperclip", clientName: "Claude", scopes: ["paperclip:read"], createdAt: "2026-10-06T00:00:00Z", revokedAt: null };

  it("shows active assistant grants in Installed and removes them after revocation", async () => {
    assistantConnectionsMock.mockResolvedValue([assistantGrant]);
    const client = await renderBrowse(false);
    await clickButton("Installed", container);
    const manage = container.querySelector<HTMLButtonElement>('[aria-label="Manage Assistant Connection (MCP)"]');
    expect(manage).not.toBeNull();
    expect(container.querySelector('[data-app-slug="assistant-connection"]')?.textContent).toContain("Claude");
    await act(() => manage!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/assistant-connection");
    assistantConnectionsMock.mockResolvedValue([{ ...assistantGrant, revokedAt: "2026-10-06T01:00:00Z" }]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["mcp-connections"] }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="assistant-connection"]')).toBeNull();
  });

  it.each([
    ["empty", []],
    ["revoked", [{ ...assistantGrant, revokedAt: "2026-10-06T01:00:00Z" }]],
    ["another organization", [{ ...assistantGrant, companyId: "other-company" }]],
  ])("does not show %s assistant grants as installed", async (_label, grants) => {
    assistantConnectionsMock.mockResolvedValue(grants);
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.querySelector('[data-app-slug="assistant-connection"]')).toBeNull();
  });

  it("keeps pending assistant status visible in Installed until it can determine access", async () => {
    let resolve!: (rows: typeof assistantGrant[]) => void;
    assistantConnectionsMock.mockReturnValue(new Promise<typeof assistantGrant[]>(done => { resolve = done; }));
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.textContent).toContain("Checking your connection status");
    expect(container.textContent).not.toContain("No connectors match");
    await act(() => resolve([assistantGrant]));
    await flushReact();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
  });

  it("shows a retryable assistant status failure in Installed instead of an empty result", async () => {
    assistantConnectionsMock.mockRejectedValue(new Error("offline"));
    await renderBrowse(false);
    await clickButton("Installed", container);
    expect(container.textContent).toContain("Couldn’t load your connection status");
    expect(container.textContent).not.toContain("No connectors match");
    assistantConnectionsMock.mockResolvedValue([assistantGrant]);
    await clickButton("Try again", container);
    await flushReact();
    expect(container.querySelector('[aria-label="Manage Assistant Connection (MCP)"]')).not.toBeNull();
  });

  function indexedApp(name: string, providers: ("composio" | "arcade" | "executor")[] = ["composio"]): AggregatorAppCatalogEntry {
    const slug = name.toLowerCase().replaceAll(" ", "-");
    return { name, slug, aliases: [slug], routes: providers.map((provider) => ({
      provider, toolkit: slug, logoUrl: `https://logos.example.com/${slug}.svg`, docsUrl: `https://docs.${provider}.dev/${slug}`,
    })) };
  }

  async function search(value: string) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();
  }

  function composioFixture() {
    aggregatorCatalogMock.push(indexedApp("Circleback"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } })] });
    const snapshot = { connectionId: "conn-notion", toolkit: "circleback", status: "connected", checkedAt: new Date().toISOString(), accounts: [{ id: "ca-work", alias: "Meeting notes", status: "ACTIVE", isDefault: true }] };
    listComposioAppsMock.mockResolvedValue({ apps: [snapshot] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [snapshot] });
    return snapshot;
  }

  async function clickButton(text: string, scope: ParentNode = document) {
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === text)!;
    expect(button).toBeTruthy();
    await act(() => button.click());
    await flushReact();
  }

  async function accountMenu(action: string, name = "Meeting notes") {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="Manage ${name}"]`)!;
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === action)!;
    await act(() => item.click());
    await flushReact();
  }

  async function connectionMenu(name = "Meeting notes") {
    const trigger = container.querySelector<HTMLButtonElement>(`[data-app-slug="circleback"] button[aria-label="Manage ${name} connection"]`)!;
    expect(trigger).toBeTruthy();
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  }

  async function openComposioAccountMenu(name = "Composio account") {
    const trigger = container.querySelector<HTMLButtonElement>(`[data-app-slug="composio"] button[aria-label="Manage ${name} connection"]`)!;
    expect(trigger).toBeTruthy();
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    return document.querySelector<HTMLElement>('[role="menu"]')!;
  }

  it("defaults to Paperclip with five chips, expands search to All, and retains explicit source scope", async () => {
    aggregatorCatalogMock.push(indexedApp("Remote App", ["composio"]));
    await renderBrowse(false);
    expect(container.querySelector('[aria-label="App filters"]')?.textContent).toBe("PaperclipComposioArcadeInstalledAll");
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeNull();
    await search("Remote App");
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("All");
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeTruthy();
    await search("");
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("Paperclip");
    await clickButton("Arcade", container);
    await search("Remote App");
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("Arcade");
    expect(container.textContent).toContain("No connectors match");
    await clickButton("Clear search", container);
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("Arcade");
  });

  it.each(["composio", "arcade"] as const)("scopes %s to its catalog and accounts without native catalog overlaps", async (provider) => {
    const otherProvider = provider === "composio" ? "arcade" : "composio";
    const providerName = provider === "composio" ? "Composio" : "Arcade";
    aggregatorCatalogMock.push(indexedApp("Notion", [provider]), indexedApp("Remote App", [provider]), indexedApp("Other App", [otherProvider]));
    listGalleryMock.mockResolvedValue({ apps: ["notion", provider, otherProvider].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application(), application({ id: "gateway-app", name: providerName, metadata: { sourceTemplateKey: provider } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Native Notion" }), connection({ id: "gateway", applicationId: "gateway-app", name: `${providerName} account`, config: { sourceTemplateKey: provider } })] });
    listComposioAppsMock.mockResolvedValue({ apps: [{ provider, appSlug: "notion", appName: "Notion", connectionId: "gateway", toolkit: "notion", status: "not_connected", accounts: [] }] });
    await renderBrowse(false);
    expect(container.querySelector('[data-app-slug="notion"]')).toBeTruthy();

    await clickButton(providerName, container);
    expect(container.querySelector(`[data-app-slug="${provider}"]`)).toBeTruthy();
    expect(container.querySelector('[data-app-slug="remote-app"]')).toBeTruthy();
    expect(container.querySelector('[data-app-slug="notion"]')).toBeNull();
    expect(container.querySelector(`[data-app-slug="${otherProvider}"]`)).toBeNull();
    expect(container.querySelector('[data-app-slug="other-app"]')).toBeNull();

    await search("Notion");
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe(providerName);
    expect(container.textContent).toContain("No connectors match");
    await clickButton("All", container);
    expect(container.querySelector('[data-app-slug="notion"]')?.textContent).toContain("Native Notion");
  });

  it("does not reuse another viewing user's managed-account cache", async () => {
    composioFixture();
    const client = await renderBrowse(false);
    expect(container.textContent).toContain("Meeting notes");
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    accountIdentity.userId = "another-user";
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><Browse /></TooltipProvider></QueryClientProvider>));
    await flushReact();
    expect(container.textContent).not.toContain("Meeting notes");
    expect(client.getQueryData(queryKeys.tools.aggregatorApps("conn-notion", "board-user"))).toBeTruthy();
    expect(client.getQueryData<{ apps: unknown[] }>(queryKeys.tools.aggregatorApps("conn-notion", "another-user"))?.apps).toEqual([]);
  });

  it("groups native and matching-label accounts across providers and gateways without dropping any lines", async () => {
    aggregatorCatalogMock.push(indexedApp("Notion", ["composio", "arcade"]));
    listGalleryMock.mockResolvedValue({ apps: ["notion", "composio", "arcade", "executor"].map(getAppStoreDefinition) });
    const gateways = ["composio", "arcade", "executor", "arcade"];
    listApplicationsMock.mockResolvedValue({ applications: [application(), ...gateways.map((provider, index) => application({ id: `app-${index}`, name: provider, metadata: { sourceTemplateKey: provider } }))] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Native" }), ...gateways.map((provider, index) => connection({ id: `gateway-${index}`, applicationId: `app-${index}`, name: `Gateway ${index}`, config: { sourceTemplateKey: provider } }))] });
    listComposioAppsMock.mockImplementation((id: string) => ({ apps: [{ provider: gateways[Number(id.split("-")[1])], appSlug: "notion", appName: "Notion", connectionId: id, toolkit: "notion", checkedAt: new Date().toISOString(), status: "connected", accounts: [{ id: "same-id", alias: "Work", status: "ACTIVE", isDefault: false }] }] }));
    await renderBrowse(false);
    expect(container.querySelectorAll('[data-app-slug="notion"]')).toHaveLength(1);
    const row = container.querySelector('[data-app-slug="notion"]')!;
    expect(row.querySelectorAll('button[aria-label="Manage Work connection"]')).toHaveLength(4);
    expect(row.textContent).toContain("Native");
    for (const provider of ["Composio", "Arcade", "Executor"]) expect(row.textContent).toContain(`Managed by ${provider}`);
    await clickButton("Arcade", container);
    expect(container.querySelectorAll('[data-app-slug="notion"] button[aria-label="Manage Work connection"]')).toHaveLength(4);
    expect(container.querySelector('[data-app-slug="notion"] button[aria-label="Connect Notion"]')).toBeNull();
  });

  it("offers only provider management in imported account menus", async () => {
    composioFixture();
    await renderBrowse();
    const items = await connectionMenu();
    expect(items.map(item => item.textContent?.trim())).toEqual(["Open in Composio"]);
    expect(items[0].getAttribute("href")).toBe("https://dashboard.composio.dev/~/org/connect/apps");
    expect(items[0].getAttribute("target")).toBe("_blank");
    expect(navigateMock).not.toHaveBeenCalled();
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
    expect(archiveConnectionMock).not.toHaveBeenCalled();
  });

  it("does not expose local deletion or renaming for imported accounts", async () => {
    composioFixture();
    await renderBrowse();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Manage Meeting notes connection"]')!;
    await act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Open in Composio");
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Remove connection");
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Rename");
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
  });

  it("shows verified upstream accounts as installed on every page, searches their labels, and opens Manage", async () => {
    composioFixture();
    listUserDirectoryMock.mockResolvedValue({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null } }] });
    aggregatorCatalogMock.push(...Array.from({ length: 60 }, (_, index) => indexedApp(`Indexed App ${index}`)));
    await renderBrowse();
    const circleback = container.querySelector('[data-app-slug="circleback"]')!;
    expect(circleback.getAttribute("data-connected")).toBe("true");
    expect(circleback.textContent).toContain("Accounts managed in Composio.");
    expect(circleback.textContent).toContain("Managed by Composio ·“Composio account”");
    expect(circleback.textContent).not.toContain("Connected by");
    expect(circleback.textContent).not.toContain("Dotta");
    expect(circleback.querySelector('[title="Connected"]')).toBeTruthy();
    expect(circleback.querySelector('button[aria-label="Manage Meeting notes"]')).toBeTruthy();
    expect(circleback.querySelector('button[aria-label="Connect Circleback"]')).toBeNull();
    await clickButton("Next", container);
    expect(container.querySelector('[data-app-slug="circleback"] button[aria-label="Manage Circleback"]')).toBeTruthy();
    await search("Meeting notes");
    expect(container.querySelectorAll('[data-app-slug="circleback"]')).toHaveLength(1);
    await clickButton("Manage", container);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Meeting notes");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('“Composio account”');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Accounts and sign-in are managed in Composio.");
    expect(document.querySelectorAll('[role="dialog"] a[href="/apps/conn-notion/permissions"]')).toHaveLength(1);
    expect(openNewIssueMock).not.toHaveBeenCalled();
  });

  it("uses the waiting status for an aggregator account until sign-in is verified", async () => {
    const snapshot = composioFixture();
    const pending = { ...snapshot, status: "not_connected", accounts: [{ ...snapshot.accounts[0], status: "INITIATED" }] };
    listComposioAppsMock.mockResolvedValue({ apps: [pending] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [pending] });
    await renderBrowse();
    const circleback = container.querySelector('[data-app-slug="circleback"]')!;
    expect(circleback.textContent).toContain("Waiting for sign-in");
    expect(circleback.textContent).toContain("Finish connecting this account.");
    expect(circleback.querySelector('[title="Connected"]')).toBeNull();
    await act(() => circleback.querySelector<HTMLButtonElement>('button[aria-label="Manage Meeting notes"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Manage Circleback");
  });

  it("discovers app authorization on refresh and reflects a disconnection when returning from Composio", async () => {
    composioFixture();
    const response = await listComposioAppsMock();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    syncComposioAppsMock.mockResolvedValue(response);
    await renderBrowse();
    await vi.waitFor(() => expect(container.querySelector('[data-app-slug="circleback"]')?.getAttribute("data-connected")).toBe("true"));
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    syncComposioAppsMock.mockResolvedValue({ apps: [] });
    await act(() => focusManager.setFocused(false));
    await act(() => focusManager.setFocused(true));
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="Connect Circleback"]')).toBeTruthy());
    focusManager.setFocused(undefined);
    expect(setupComposioAppMock).not.toHaveBeenCalled();
  });

  it("opens provider-owned management and refreshes observed accounts without mutation", async () => {
    const snapshot = composioFixture();
    await renderBrowse();
    await clickButton("Manage", container);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Accounts and sign-in are managed in Composio.");
    expect(dialog.querySelector('a[href="https://dashboard.composio.dev/~/org/connect/apps"]')?.getAttribute("target")).toBe("_blank");
    expect(dialog.textContent).not.toContain("Rename");
    expect(dialog.textContent).not.toContain("Disconnect");
    const disconnected = { ...snapshot, status: "not_connected", accounts: [] };
    refreshComposioAppsMock.mockResolvedValue({ apps: [disconnected] });
    await clickButton("Refresh", dialog);
    expect(refreshComposioAppsMock).toHaveBeenCalledWith("conn-notion", ["circleback"]);
    expect(dialog.textContent).toContain("No connected Circleback accounts.");
    expect(manageComposioAppAccountMock).not.toHaveBeenCalled();
    expect(setupComposioAppMock).not.toHaveBeenCalled();
  });

  it("preserves failed observations with an unverified status and offers retry", async () => {
    const snapshot = composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [{ ...snapshot, errorAt: new Date().toISOString() }], sync: { status: "error", error: "Unavailable" } });
    await renderBrowse();
    expect(container.querySelector('button[aria-label="Manage Circleback"]')).toBeTruthy();
    expect(container.querySelector('[data-app-slug="circleback"] [title="Connected"]')).toBeNull();
    expect(container.textContent).toContain("Last known account · Refresh to verify");
    expect(container.textContent).toContain("Unavailable");
    const menu = await openComposioAccountMenu();
    await act(() => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")!.click());
    await flushReact();
    expect(syncComposioAppsMock).toHaveBeenCalledWith("conn-notion", true);
  });

  it("refreshes only the selected Composio account while another account is syncing", async () => {
    composioFixture();
    const work = connection({ id: "conn-work", applicationId: "gateway-app", name: "Work Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } });
    const personal = connection({ id: "conn-personal", applicationId: "gateway-app", name: "Personal Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } });
    listConnectionsMock.mockResolvedValue({ connections: [work, personal] });
    listComposioAppsMock.mockImplementation((id: string) => Promise.resolve({ apps: [], sync: { status: id === "conn-work" ? "syncing" : "ready" } }));
    await renderBrowse();
    expect(container.textContent).not.toContain("Refresh Composio");
    let menu = await openComposioAccountMenu("Work Composio");
    expect(Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")?.getAttribute("aria-disabled")).toBe("true");
    await act(() => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flushReact();
    menu = await openComposioAccountMenu("Personal Composio");
    const refresh = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Refresh Composio")!;
    expect(refresh.getAttribute("aria-disabled")).not.toBe("true");
    syncComposioAppsMock.mockClear();
    await act(() => refresh.click());
    await flushReact();
    expect(syncComposioAppsMock.mock.calls.filter(([, force]) => force === true)).toEqual([["conn-personal", true]]);
  });

  it("discovers native-overlap accounts without adding an aggregator connect offer", async () => {
    const snapshot = composioFixture();
    aggregatorCatalogMock.push(indexedApp("Notion"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio"), getAppStoreDefinition("notion")] });
    listComposioAppsMock.mockResolvedValue({ apps: [{ ...snapshot, toolkit: "notion", accounts: [{ ...snapshot.accounts[0], alias: "Imported workspace" }] }] });
    await renderBrowse();
    const row = container.querySelector('[data-app-slug="notion"]')!;
    expect(row.textContent).toContain("Imported workspace");
    expect(row.textContent).toContain("Managed by Composio ·“Composio account”");
    expect(row.querySelector('button[aria-label*="third-party"]')).toBeNull();
    expect(row.querySelector('button[aria-label="Connect Notion"]')).toBeTruthy();
    expect(syncComposioAppsMock).toHaveBeenCalledWith("conn-notion");
    expect(refreshComposioAppsMock).not.toHaveBeenCalled();
  });

  it("suppresses aggregator routes for native apps, including hidden native connectors", async () => {
    aggregatorCatalogMock.push(indexedApp("Notion", ["composio", "arcade"]), indexedApp("Google Sheets"), indexedApp("GitHub API"), indexedApp("Context7"), indexedApp("HubSpot", ["composio", "arcade"]));
    await renderBrowse();
    expect(container.querySelectorAll('[data-app-slug="notion"]')).toHaveLength(1);
    expect(container.querySelector('[data-app-slug="notion"] button[aria-label*="third-party"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="google-sheets"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="github-api"]')).toBeNull();
    expect(container.querySelector('[data-app-slug="context7"]')).toBeNull();
    expect(container.querySelectorAll('[data-app-slug="hubspot"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-app-slug="hubspot"] button[aria-label*="third-party"]')).toHaveLength(2);
  });

  it("paginates the catalog while keeping installed connectors above every page and resets on search", async () => {
    aggregatorCatalogMock.push(...Array.from({ length: 60 }, (_, index) => indexedApp(`Indexed App ${String(index).padStart(2, "0")}`)));
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    await renderBrowse();
    expect(container.querySelectorAll('[data-connected="false"][data-app-slug]:not([data-app-slug="custom-mcp"]):not([data-app-slug="assistant-connection"])')).toHaveLength(50);
    expect(container.querySelector('[aria-label="Connector list"] > [data-app-slug]:not([data-app-slug="assistant-connection"])')?.getAttribute("data-app-slug")).toBe("notion");
    const next = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Next")!;
    await act(() => next.click());
    expect(container.textContent).toContain("Page 2 of");
    expect(container.querySelector('[aria-label="Connector list"] > [data-app-slug]:not([data-app-slug="assistant-connection"])')?.getAttribute("data-app-slug")).toBe("notion");
    await search("Indexed App 59");
    expect(container.textContent).toContain("Page 1 of 1");
    expect(container.querySelector('[data-app-slug="indexed-app-59"]')).not.toBeNull();
    await search("no-such-app");
    expect(container.textContent).toContain("No connectors match");
    expect(container.querySelector('[aria-label="Connector catalog pages"]')).toBeNull();
  });

  it("offers each provider once and carries the exact selected toolkit to setup", async () => {
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect HubSpot"]')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Which service would you like to use?");
    await act(() => Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.includes("Arcade"))!.click());
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=arcade&targetToolkit=hubspot");
  });

  it.each(["composio", "arcade"] as const)("skips provider selection and opens setup for a sole %s provider", async (provider) => {
    const app = indexedApp("Circleback", [provider]);
    app.routes[0].toolkit = "circle_back";
    aggregatorCatalogMock.push(app);
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    expect(navigateMock).toHaveBeenCalledWith(`/apps/connect?source=${provider}&targetToolkit=circle_back`);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the saved gateway flow directly for a sole provider and allows cancellation", async () => {
    aggregatorCatalogMock.push(indexedApp("Circleback"));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Connect Circleback through Composio");
    expect(dialog.textContent).not.toContain("Which service would you like to use?");
    expect(dialog.textContent).not.toContain("Back");
    expect(dialog.textContent).not.toContain("Connection settings");
    expect(dialog.textContent).not.toContain("An agent can check Circleback in Composio");
    expect(dialog.querySelector('[data-slot="badge"]')).toBeNull();
    expect(dialog.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(dialog.querySelector('#composio-app-agent')).toBeNull();
    expect(dialog.textContent).not.toContain("Which agent");
    expect(dialog.textContent).not.toContain("Using");
    expect(dialog.textContent).not.toContain("Use another account");
    expect(dialog.querySelector('a[href="https://dashboard.composio.dev/~/org/connect/apps"]')).toBeNull();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    await act(() => Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("configures an app directly through a saved gateway without creating an agent task", async () => {
    setupComposioAppMock.mockResolvedValueOnce({ status: "authorization_required", authorizationUrl: "https://connect.composio.dev/link/test" })
      .mockRejectedValueOnce(new Error("Finish connecting this app in Composio, then check again")).mockResolvedValueOnce({ status: "connected" });
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    expect(container.querySelector('[data-app-slug="hubspot"]')?.getAttribute("data-connected")).toBe("false");
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect HubSpot"]')!.click());
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent?.includes("Composio"))!.click());
    expect(document.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(navigateMock).not.toHaveBeenCalled();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "Continue")!.click());
    await vi.waitFor(() => expect(setupComposioAppMock).toHaveBeenCalledWith("conn-notion", "hubspot", { action: "start" }));
    await vi.waitFor(() => expect(document.querySelector('a[href="https://connect.composio.dev/link/test"]')).not.toBeNull());
    expect(openNewIssueMock).not.toHaveBeenCalled();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "I’ve connected it")!.click());
    await vi.waitFor(() => expect(setupComposioAppMock).toHaveBeenCalledWith("conn-notion", "hubspot", { action: "complete" }));
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain("Finish connecting"));
    expect(document.querySelector('a[href="https://connect.composio.dev/link/test"]')).not.toBeNull();
    await act(() => Array.from(document.querySelector('[role="dialog"]')!.querySelectorAll("button")).find((button) => button.textContent === "I’ve connected it")!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(pushToastMock).toHaveBeenCalledWith({ title: "HubSpot is connected through Composio.", tone: "success" });
    expect(openNewIssueMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uses the selected saved Composio account and clears the previous account's sign-in link", async () => {
    composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [] });
    listConnectionsMock.mockResolvedValue({ connections: [
      connection({ applicationId: "gateway-app", name: "Work Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } }),
      connection({ id: "conn-personal", applicationId: "gateway-app", name: "Personal Composio", transport: "mcp_remote", config: { sourceTemplateKey: "composio" } }),
      connection({ id: "conn-paused", applicationId: "gateway-app", name: "Paused Composio", enabled: false, config: { sourceTemplateKey: "composio" } }),
    ] });
    listAgentsMock.mockRejectedValue(new Error("Agents are unavailable"));
    setupComposioAppMock.mockReset().mockResolvedValueOnce({ status: "authorization_required", authorizationUrl: "https://connect.composio.dev/link/personal" }).mockResolvedValueOnce({ status: "connected" });
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const select = document.querySelector<HTMLSelectElement>('#composio-app-account')!;
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(["Work Composio", "Personal Composio", "Connect a new account…"]);
    await act(() => { select.value = "conn-personal"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    await clickButton("Continue", document.querySelector('[role="dialog"]')!);
    expect(setupComposioAppMock).toHaveBeenCalledWith("conn-personal", "circleback", { action: "start" });
    expect(document.querySelector('a[href="https://connect.composio.dev/link/personal"]')).toBeTruthy();
    await act(() => { select.value = "conn-notion"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    expect(document.querySelector('a[href="https://connect.composio.dev/link/personal"]')).toBeNull();
    await clickButton("Continue", document.querySelector('[role="dialog"]')!);
    expect(setupComposioAppMock).toHaveBeenLastCalledWith("conn-notion", "circleback", { action: "start" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(listAgentsMock).not.toHaveBeenCalled();
    expect(openNewIssueMock).not.toHaveBeenCalled();
    listAgentsMock.mockResolvedValue([]);
  });

  it("offers a new Composio account in the dropdown and carries the requested app into setup", async () => {
    composioFixture();
    listComposioAppsMock.mockResolvedValue({ apps: [] });
    refreshComposioAppsMock.mockResolvedValue({ apps: [] });
    setupComposioAppMock.mockReset();
    await renderBrowse();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Connect Circleback"]')!.click());
    const select = document.querySelector<HTMLSelectElement>('#composio-app-account')!;
    await act(() => { select.value = "__new__"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flushReact();
    expect(navigateMock).not.toHaveBeenCalled();
    await clickButton("Connect new account", document.querySelector('[role="dialog"]')!);
    expect(navigateMock).toHaveBeenCalledWith("/apps/connect?source=composio&targetToolkit=circleback&new=1");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(setupComposioAppMock).not.toHaveBeenCalled();
    expect(listAgentsMock).not.toHaveBeenCalled();
  });

  it("returns from Composio gateway setup directly to its app flow even with multiple providers", async () => {
    aggregatorCatalogMock.push(indexedApp("HubSpot", ["composio", "arcade"]));
    window.history.replaceState({}, "", "/apps?source=composio&targetToolkit=hubspot");
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("composio")] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "gateway-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "gateway-app", name: "Composio account", config: { sourceTemplateKey: "composio" } })] });
    await renderBrowse();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("through Composio"));
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Which service would you like to use?");
    expect(document.querySelector<HTMLSelectElement>('#composio-app-account')?.value).toBe("conn-notion");
    expect(document.querySelector('#composio-app-agent')).toBeNull();
    expect(openNewIssueMock).not.toHaveBeenCalled();
  });

  it("shows retirement guidance before paused state for an obsolete Composio account", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application({ id: "old-app", name: "Composio", metadata: { sourceTemplateKey: "composio" } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ applicationId: "old-app", enabled: false, healthStatus: "error", transport: "rest_api", config: { sourceTemplateKey: "composio", connectionMethodKey: "api-key" } })] });
    await renderBrowse();
    expect(container.textContent).toContain("Retired");
    expect(container.textContent).toContain("Add a new Composio MCP connection");
    expect(container.textContent).not.toContain("Paused");
  });

  const googleSlugs = [
    "gmail", "google-drive", "google-docs", "google-sheets", "google-slides",
    "google-calendar", "google-chat", "google-people", "google-workspace-search",
  ];

  it("temporarily hides all Google Workspace catalog rows without changing their definitions", async () => {
    const definitions = googleSlugs.map((slug) => getAppStoreDefinition(slug)!);
    listGalleryMock.mockResolvedValue({ apps: [...definitions, getAppStoreDefinition("notion")] });
    const client = await renderBrowse();

    for (const definition of definitions) {
      expect(definition.methods.length).toBeGreaterThan(0);
      expect(getAppStoreDefinition(definition.slug)).toBe(definition);
      expect(container.querySelector(`[data-app-slug="${definition.slug}"]`)).toBeNull();
    }
    expect(container.querySelector('[data-app-slug="notion"]')).not.toBeNull();
    expect(client.getQueryData(queryKeys.apps.gallery("company-1"))).toEqual({
      apps: [...definitions, getAppStoreDefinition("notion")],
    });
    expect(archiveConnectionMock).not.toHaveBeenCalled();
  });

  it.each(["active", "draft", "disabled"])(
    "hides saved Google %s accounts without disabling or removing them",
    async (status) => {
      const applications = googleSlugs.map((slug) => application({
        id: `app-${slug}`, name: `Saved ${slug}`, applicationKey: `app-gallery:${slug}:one`,
        metadata: { sourceTemplateKey: slug },
      }));
      const connections = googleSlugs.map((slug) => connection({
        id: `conn-${slug}`, applicationId: `app-${slug}`, name: `Account for ${slug}`,
        status, enabled: status !== "disabled", config: { sourceTemplateKey: slug },
      }));
      listGalleryMock.mockResolvedValue({ apps: googleSlugs.map(getAppStoreDefinition) });
      listApplicationsMock.mockResolvedValue({ applications });
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      for (const slug of googleSlugs) {
        expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
        expect(container.textContent).not.toContain(`Account for ${slug}`);
      }
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(client.getQueryData(queryKeys.tools.applications("company-1"))).toEqual({ applications });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["config", "transportConfig"])(
    "hides a Google account identified by %s even when its gallery entry is absent",
    async (sourceField) => {
      listGalleryMock.mockResolvedValue({ apps: [] });
      listApplicationsMock.mockResolvedValue({ applications: [application({
        id: "legacy-google", name: "My documents", applicationKey: null, metadata: null,
      }), application()] });
      listConnectionsMock.mockResolvedValue({ connections: [connection({
        id: "legacy-google-account", applicationId: "legacy-google", name: "Saved Google account",
        config: {}, transportConfig: {}, [sourceField]: { sourceTemplateKey: "google-docs" },
      }), connection()] });
      await renderBrowse();

      expect(container.textContent).not.toContain("Saved Google account");
      expect(container.textContent).toContain("Notion");
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["catalog", "custom"])(
    "preserves non-Google accounts in a mixed-provider %s row",
    async (rowKind) => {
      const notion = getAppStoreDefinition("notion")!;
      listGalleryMock.mockResolvedValue({ apps: rowKind === "catalog" ? [notion] : [] });
      listApplicationsMock.mockResolvedValue({ applications: [application(rowKind === "custom"
        ? { name: "My tools", applicationKey: null, metadata: null }
        : {})] });
      const connections = [connection({
        id: "google-account", name: "Hidden Google account",
        config: { sourceTemplateKey: "google-docs" },
      }), connection({
        id: "notion-account", name: "Visible Notion account",
        config: { sourceTemplateKey: "notion" },
      })];
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      expect(container.textContent).toContain("Visible Notion account");
      expect(container.textContent).not.toContain("Hidden Google account");
      expect(container.textContent).toContain(rowKind === "catalog" ? "Notion" : "My tools");
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it.each(["metadata", "applicationKey"])(
    "keeps a non-Google custom connector identified by %s when only its Google accounts are hidden",
    async (sourceField) => {
      listGalleryMock.mockResolvedValue({ apps: [] });
      const savedApplication = application({
        name: "My custom connector",
        metadata: sourceField === "metadata" ? { sourceTemplateKey: "custom-provider" } : null,
        applicationKey: sourceField === "applicationKey" ? "custom-provider" : null,
      });
      listApplicationsMock.mockResolvedValue({ applications: [savedApplication] });
      const connections = [connection({
        name: "Hidden Google account", config: { sourceTemplateKey: "google-docs" },
      })];
      listConnectionsMock.mockResolvedValue({ connections });
      const client = await renderBrowse();

      expect(container.querySelector('[data-app-slug="custom-provider"]')).not.toBeNull();
      expect(container.textContent).toContain("My custom connector");
      expect(container.textContent).not.toContain("Hidden Google account");
      expect(client.getQueryData(queryKeys.tools.applications("company-1"))).toEqual({ applications: [savedApplication] });
      expect(client.getQueryData(queryKeys.tools.connections("company-1"))).toEqual({ connections });
      expect(archiveConnectionMock).not.toHaveBeenCalled();
    },
  );

  it("hides cached memory connectors until enabled and preserves saved MCP connections", async () => {
    const providers = ["mem0", "zep", "supermemory", "cognee", "honcho"];
    listGalleryMock.mockResolvedValue({ apps: [...providers, "notion"].map(getAppStoreDefinition) });
    const client = await renderBrowse();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    expect(container.querySelector('[data-app-slug="notion"]')).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableMemoryConnectors: true }); });
    await flushReact();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    await act(() => {
      client.setQueryData(queryKeys.tools.connections("company-1"), { connections: [connection({ id: "saved", applicationId: "saved-app", config: { sourceTemplateKey: "mem0", connectionMethodKey: "mcp" }, transport: "mcp_remote" })] });
      client.setQueryData(queryKeys.tools.applications("company-1"), { applications: [application({ id: "saved-app", name: "Mem0", metadata: { sourceTemplateKey: "mem0" } })] });
      client.setQueryData(queryKeys.instance.experimentalSettings, { enableMemoryConnectors: false });
    });
    await flushReact();
    expect(container.textContent).toContain("Mem0");
    for (const slug of ["zep", "supermemory", "cognee", "honcho"]) expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
  });

  it("shows all MCP aggregators by default and ignores cached legacy opt-outs", async () => {
    const providers = ["zapier", "arcade", "composio", "executor"];
    listGalleryMock.mockResolvedValue({ apps: [...providers, "notion"].map(getAppStoreDefinition) });
    const client = await renderBrowse();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableMcpAggregators: false }); });
    await flushReact();
    for (const slug of providers) expect(container.querySelector(`[data-app-slug="${slug}"]`)).not.toBeNull();
  });

  it("defaults to tools-only GitHub and hides chat-only catalog and existing chat accounts", async () => {
    experimentalMock.mockResolvedValue({});
    listGalleryMock.mockResolvedValue({ apps: ["agentmail", "github", "github-code-review-bot", "discord", "telegram", "microsoft-teams"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "chat-app", type: "chat", name: "Private bot", applicationKey: "chat:github:endpoint-1", metadata: { purpose: "channel" },
    })] });
    await renderBrowse();
    expect(chatListMock).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    for (const slug of ["github-code-review-bot", "discord", "telegram", "microsoft-teams", "slack"]) {
      expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    }
    expect(container.textContent).not.toContain("Private bot");
    expect(container.querySelector('[data-app-slug="agentmail"]')).not.toBeNull();
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Connect AgentMail"]')!.click());
    expect(navigateMock.mock.lastCall?.[0]).toContain("/apps/chat/connect?provider=agentmail");
    expect(container.textContent).not.toContain("Chat with agents");
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Add key GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
  });

  it("names what the card will actually ask for", async () => {
    // PAP-659 C4. The verb is derived from the connector's resolved default
    // method, so it changes with what this instance can do rather than being a
    // fixed string: Notion signs in, GitHub-without-the-cloud-connector wants a
    // token, and GitHub with it signs in too.
    const github = getAppStoreDefinition("github")!;
    listGalleryMock.mockResolvedValue({
      apps: [
        getAppStoreDefinition("notion"),
        { ...github, ownershipAvailability: { ...github.ownershipAvailability, platform_shared: true } },
      ],
    });
    await renderBrowse();
    expect(container.querySelector('button[aria-label="Connect Notion"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Connect GitHub"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add key GitHub"]')).toBeNull();
  });

  it("separates tools and saved bots and gates bots independently of chat connectors", async () => {
    listGalleryMock.mockResolvedValue({ apps: ["github", "github-code-review-bot"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [
      application({ id: "github-tools", name: "GitHub", metadata: { sourceTemplateKey: "github" } }),
      application({ id: "chat-app", type: "chat", name: "Legacy bot", metadata: { sourceTemplateKey: "github", purpose: "channel" } }),
    ] });
    listConnectionsMock.mockResolvedValue({ connections: [
      connection({ id: "github-account", applicationId: "github-tools", name: "My GitHub" }),
      connection({ id: "chat-tools", applicationId: "chat-app", connectionPurpose: "channel" }),
    ] });
    chatListMock.mockResolvedValue([
      { id: "endpoint-1", provider: "github", status: "active", assignedAgentName: "Review agent", botLabel: "Review bot", assignedAgentId: "agent-1" },
      { id: "endpoint-2", provider: "github", status: "draft", assignedAgentName: "Draft agent", assignedAgentId: "agent-2" },
    ]);
    const client = await renderBrowse();
    const tools = container.querySelector('[data-app-slug="github"]')!;
    const bots = container.querySelector('[data-app-slug="github-code-review-bot"]')!;
    expect(tools.textContent).toContain("My GitHub");
    expect(tools.textContent).not.toContain("Review agent");
    expect(bots.textContent).toContain("Review agent · Code review bot");
    expect(bots.textContent).toContain("Draft agent");
    expect(bots.textContent).not.toContain("My GitHub");
    expect(container.textContent).not.toContain("Legacy bot");
    await act(() => void tools.querySelector<HTMLButtonElement>('button[aria-label="Add account GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github&applicationId=github-tools&name=GitHub&new=1");
    await act(() => void bots.querySelector<HTMLButtonElement>('button[aria-label="Add connection GitHub Code Review Bot"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat");
    const finish = [...bots.querySelectorAll("button")].find((button) => button.textContent === "Finish setup")!;
    await act(() => finish.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat&resume=endpoint-2");
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: false, enableGitHubReviewBots: true }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).not.toBeNull();
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: true, enableGitHubReviewBots: false }); });
    await flushReact();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).toBeNull();
    expect(container.textContent).not.toContain("Review agent");
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
  });

  it("keeps the GitHub tool card when the chat catalog needs its local fallback", async () => {
    listGalleryMock.mockResolvedValue({ apps: [getAppStoreDefinition("github")] });
    await renderBrowse();
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    expect(container.querySelector('[data-app-slug="github-code-review-bot"]')).not.toBeNull();
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Add key GitHub"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/connect?source=github");
    await act(() => void container.querySelector<HTMLButtonElement>('button[aria-label="Connect GitHub Code Review Bot"]')!.click());
    expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/connect?provider=github&purpose=chat");
  });

  it("renders one connector list with the requested header and no gallery sections", async () => {
    await renderBrowse();

    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Connectors" }]);
    expect(setBreadcrumbsMock).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ href: "/dashboard" })]),
    );
    expect(container.querySelector("header")?.textContent).not.toContain(
      "Connectors",
    );
    expect(
      container.querySelector('header input[aria-label="Search connectors"]'),
    ).toBeTruthy();
    expect(container.querySelector("header")?.classList).toContain(
      "items-start",
    );
    expect(container.querySelector("header")?.classList).not.toContain(
      "justify-end",
    );
    expect(container.querySelector('[aria-label="Popular apps"]')).toBeNull();
    expect(container.querySelector('[aria-label="Connected apps"]')).toBeNull();
    expect(container.querySelector('[aria-label="All apps"]')).toBeNull();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[aria-label="Connector list"] > [data-app-slug]',
        ),
      ).map((row) => row.dataset.appSlug),
    ).toEqual([
      "assistant-connection",
      "agentmail",
      "discord",
      "github-code-review-bot",
      "imessage-photon",
      "jira",
      "microsoft-teams",
      "notion",
      "slack",
      "speko",
      "telegram",
      "custom-mcp",
    ]);
    expect(
      container.querySelector('button[aria-label="Connect Jira"]'),
    ).toBeTruthy();
    expect(container.querySelector('[data-app-slug="gmail"]')).toBeNull();
    expect(container.textContent).toContain("Connect your own tool");

    const customConnect = container.querySelector<HTMLButtonElement>(
      '[data-app-slug="custom-mcp"] button',
    );
    await act(async () => {
      customConnect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connect your own MCP server");
    expect(container.textContent).toContain("Paste a config");
    expect(container.textContent).not.toContain("Run your own");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) =>
          button.textContent?.includes("Connect your own MCP server"),
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/byo");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Paste a config"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/advanced/paste-config");
  });

  it("sorts connected providers first and shows account, owner, status actions, and edit menus inline", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection(),
        connection({
          id: "conn-expired",
          name: "ops@example.com",
          healthStatus: "error",
          healthMessage: "The saved sign-in expired.",
        }),
      ],
    });
    listUserDirectoryMock.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: {
            id: "user-1",
            name: "Dotta",
            email: "dotta@example.com",
            image: null,
          },
        },
      ],
    });

    await renderBrowse();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[aria-label="Connector list"] > [data-app-slug]',
      ),
    );
    const providers = rows.filter(row => row.dataset.appSlug !== "assistant-connection");
    expect(providers[0]?.dataset.appSlug).toBe("notion");
    const notion = providers[0]!;
    expect(notion.textContent).toContain("devinfoley@gmail.com");
    expect(notion.textContent).toContain("ops@example.com");
    expect(notion.textContent).not.toContain("Connected by");
    expect(notion.textContent).toContain("Dotta");
    expect(notion.textContent).toContain("The saved sign-in expired.");
    expect(
      notion.querySelector('button[aria-label="Add account Notion"]'),
    ).toBeTruthy();
    expect(
      notion.querySelector(
        'button[aria-label="Manage devinfoley@gmail.com connection"]',
      ),
    ).toBeTruthy();
    expect(
      notion.querySelector(
        'button[aria-label="Manage ops@example.com connection"]',
      ),
    ).toBeTruthy();

    await act(async () => {
      notion
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open devinfoley@gmail.com permissions"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/conn-notion/permissions");

    await act(async () => {
      notion
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Add account Notion"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=notion&applicationId=app-notion&name=Notion&new=1",
    );

    const reconnect = Array.from(notion.querySelectorAll("button")).find(
      (button) => button.textContent === "Reconnect",
    );
    await act(async () => {
      reconnect?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/apps/conn-expired/permissions");
  });

  it("removes a connection from the overflow menu only after destructive confirmation", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });

    await renderBrowse();

    const menuTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Manage devinfoley@gmail.com connection"]',
    );
    expect(menuTrigger).toBeTruthy();

    await act(async () => {
      menuTrigger?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await flushReact();

    const removeItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.trim() === "Remove connection");
    expect(removeItem).toBeTruthy();
    expect(removeItem?.getAttribute("data-variant")).toBe("destructive");

    await act(async () => {
      removeItem?.dispatchEvent(new Event("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Remove devinfoley@gmail.com connection?",
    );

    const confirmButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "Remove connection");
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveConnectionMock).toHaveBeenCalledWith("conn-notion");
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connection removed",
        tone: "success",
      }),
    );
  });

  it("retains the confirmed pool revision when a concurrent edit rejects removal", async () => {
    const app = aiConnectionRouterAppDefinition("example.pool", { name: "AI connection pool", description: "Use saved connections" });
    listGalleryMock.mockResolvedValue({ apps: [app] });
    listApplicationsMock.mockResolvedValue({ applications: [application({ name: app.name, metadata: { sourceTemplateKey: app.slug } })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({ name: "Research", config: { aiRouter: { pluginKey: "example.pool" } } })] });
    poolListMock.mockResolvedValue([{ id: "conn-notion", name: "Research", revision: 7 }]);
    poolRemoveMock.mockRejectedValue(new Error("Pool changed; reload before deleting"));
    await renderBrowse();
    await act(() => { container.querySelector<HTMLButtonElement>('button[aria-label="Manage Research connection"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    await flushReact();
    await act(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(item => item.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(document.body.textContent).toContain("The connections in this pool are kept.");
    poolListMock.mockResolvedValue([{ id: "conn-notion", name: "Edited elsewhere", revision: 8 }]);
    await act(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(poolRemoveMock).toHaveBeenCalledWith("company-1", "conn-notion", 7);
    expect(poolListMock).toHaveBeenCalledTimes(1);
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ body: "Pool changed; reload before deleting" }));
  });

  it("starts each AgentMail Add connection with a distinct setup identity", async () => {
    chatListMock.mockResolvedValue([{ id: "chat-draft", provider: "agentmail", status: "draft", assignedAgentName: "Ralph" }]);
    await renderBrowse();
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add connection AgentMail"]')!;
    await act(() => add.click());
    const first = new URL(navigateMock.mock.lastCall![0], "http://localhost");
    expect(first.pathname).toBe("/apps/chat/connect");
    expect(first.searchParams.get("provider")).toBe("agentmail");
    expect(first.searchParams.get("setupId")).toMatch(/^[0-9a-f-]{36}$/);
    await act(() => add.click());
    expect(navigateMock.mock.lastCall![0]).not.toBe(first.pathname + first.search);
  });

  it.each(["slack", "discord", "telegram", "github", "microsoft-teams", "agentmail", "imessage-photon"])(
    "puts Manage and removal in the %s chat menu while keeping draft setup visible",
    async (provider) => {
      chatListMock.mockResolvedValue([
        { id: "chat-active", provider, status: "active", assignedAgentName: "Active agent" },
        { id: "chat-draft", provider, status: "draft", assignedAgentName: "Draft agent" },
        { id: "chat-archived", provider, status: "archived", assignedAgentName: "Removed agent" },
      ]);
      await renderBrowse();
      expect(container.textContent).not.toContain("Removed agent");
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Manage")).toBe(false);
      const finish = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Finish setup");
      await act(() => finish!.click());
      expect(navigateMock).toHaveBeenLastCalledWith(`/apps/chat/connect?provider=${provider}&purpose=chat&resume=chat-draft`);
      expect(container.querySelector('button[aria-label^="Manage Draft agent"]')).toBeTruthy();
      await act(() => void container.querySelector('button[aria-label^="Manage Active agent"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      await flushReact();
      const manage = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Manage");
      await act(() => manage!.click());
      expect(navigateMock).toHaveBeenLastCalledWith("/apps/chat/chat-active/settings");
    },
  );

  it.each(["slack", "agentmail", "discord", "telegram", "microsoft-teams", "github"])("shows agent and connector-owner identities without routine status labels for %s", async provider => {
    listAgentsMock.mockResolvedValue([{ id: "maya", name: "Maya", appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "cherry-pop" } }]);
    listUserDirectoryMock.mockResolvedValue({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null } }] });
    chatListMock.mockResolvedValue([{ id: "chat-avatar", provider, status: "verifying", assignedAgentId: "maya", assignedAgentName: "Maya", sponsorUserId: "user-1", setup: { webhookVerifiedAt: "2026-10-07T12:00:00Z" } }]);
    await renderBrowse();
    const avatar = container.querySelector('[aria-label="Maya avatar"]');
    expect(avatar).not.toBeNull();
    const row = avatar!.parentElement!.parentElement!;
    expect(row.textContent).toContain("Dotta");
    expect(row.textContent).not.toContain("Connected by");
    expect(row.textContent).not.toContain("verifying");
    expect(row.querySelector('[data-slot="avatar"]')).not.toBeNull();
  });

  it.each([
    ["slack", "Slack", "active"], ["slack", "Slack", "draft"],
    ["agentmail", "AgentMail", "active"], ["agentmail", "AgentMail", "draft"],
  ])("confirms %s removal for %s %s connections and refreshes the list", async (provider, providerName, status) => {
    chatListMock.mockResolvedValue([{ id: "chat-1", provider, status, assignedAgentName: "CEO" }]);
    const client = await renderBrowse();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(() => void container.querySelector(`button[aria-label="Manage CEO ${providerName} connection"]`)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await flushReact();
    const remove = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Remove connection");
    await act(() => remove!.click());
    await flushReact();
    expect(chatSetupMock).not.toHaveBeenCalled();
    expect(emailControlMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Existing Paperclip tasks and conversation history remain available.");
    chatListMock.mockResolvedValue([]);
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    if (provider === "agentmail") {
      expect(emailControlMock).toHaveBeenCalledWith("chat-1", "remove");
      expect(chatSetupMock).not.toHaveBeenCalled();
    } else {
      expect(chatSetupMock).toHaveBeenCalledWith("chat-1", { action: "remove" });
      expect(emailControlMock).not.toHaveBeenCalled();
    }
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatEndpoints.list("company-1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["email-inboxes", "company-1"] });
    expect(container.textContent).not.toContain("CEO");
  });

  it("keeps chat removal open for retry when the server rejects removal", async () => {
    chatListMock.mockResolvedValue([{ id: "chat-1", provider: "slack", status: "draft", assignedAgentName: "CEO" }]);
    chatSetupMock.mockRejectedValueOnce(new Error("Connection is busy. Try again."));
    await renderBrowse();
    await act(() => void container.querySelector('button[aria-label="Manage CEO Slack connection"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await flushReact();
    await act(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ tone: "error", body: "Connection is busy. Try again." }));
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!.click());
    await flushReact();
    expect(chatSetupMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("keeps an interrupted account visible and resumes setup from its account row", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-draft",
          name: "Notion",
          status: "draft",
          healthStatus: "unchecked",
        }),
      ],
    });

    await renderBrowse();

    expect(container.textContent).toContain("Setup incomplete");
    const finish = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Finish setup",
    );
    await act(async () => {
      finish?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=notion&resume=conn-draft",
    );
  });

  it("resumes a hidden provider only from its existing draft account row", async () => {
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "app-clickup",
      name: "ClickUp",
      applicationKey: "app-gallery:clickup:one",
      metadata: { sourceTemplateKey: "clickup" },
    })] });
    listConnectionsMock.mockResolvedValue({ connections: [connection({
      id: "conn-clickup-draft",
      applicationId: "app-clickup",
      name: "ClickUp",
      status: "draft",
      config: { sourceTemplateKey: "clickup" },
    })] });

    await renderBrowse();

    const row = container.querySelector('[data-app-slug="clickup"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Setup incomplete");
    const finish = Array.from(row!.querySelectorAll("button")).find(
      (button) => button.textContent === "Finish setup",
    );
    await act(async () => {
      finish?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/apps/connect?source=clickup&resume=conn-clickup-draft",
    );
    expect(getAppStoreDefinition("clickup")).toBeNull();
  });

  it("filters the single list without restoring section chrome", async () => {
    await renderBrowse();

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search connectors"]',
    );
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(input, "jira");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[aria-label="Connector list"] > [data-app-slug]',
      ),
    );
    expect(rows.map((row) => row.dataset.appSlug)).toEqual(["jira"]);
    expect(container.textContent).not.toContain("Popular");
    expect(container.textContent).not.toContain("All apps");
  });

  it("shows existing accounts and an actionable warning when the gallery request fails", async () => {
    listGalleryMock.mockRejectedValue(new Error("Gallery unavailable"));
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "custom-app",
          name: "Internal search",
          applicationKey: "custom:search",
          metadata: { source: "link" },
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "custom-connection",
          applicationId: "custom-app",
          name: "search.internal.example",
          config: {},
        }),
      ],
    });

    await renderBrowse();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t load every connector",
    );
    expect(container.textContent).toContain("Internal search");
    expect(container.textContent).toContain("search.internal.example");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Try again",
      ),
    ).toBe(true);
  });
});
