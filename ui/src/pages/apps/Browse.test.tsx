// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browse } from "./Browse";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";

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
const chatListMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: experimentalMock } }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { list: chatListMock, setup: chatSetupMock } }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
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
    experimentalMock.mockResolvedValue({ enableChatConnectors: true });
    chatListMock.mockResolvedValue([]);
    chatSetupMock.mockReset().mockResolvedValue({ status: "archived" });
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
    vi.clearAllMocks();
  });

  async function renderBrowse() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Browse />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return client;
  }

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
    listGalleryMock.mockResolvedValue({ apps: ["github", "github-code-review-bot", "discord", "telegram", "microsoft-teams"].map(getAppStoreDefinition) });
    listApplicationsMock.mockResolvedValue({ applications: [application({
      id: "chat-app", type: "chat", name: "Private bot", applicationKey: "chat:github:endpoint-1", metadata: { purpose: "channel" },
    })] });
    await renderBrowse();
    expect(chatListMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-app-slug="github"]')).not.toBeNull();
    for (const slug of ["github-code-review-bot", "discord", "telegram", "microsoft-teams", "slack"]) {
      expect(container.querySelector(`[data-app-slug="${slug}"]`)).toBeNull();
    }
    expect(container.textContent).not.toContain("Private bot");
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

  it("separates tools and saved bots and hides only bots when chat connectors are disabled", async () => {
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
    await act(() => { client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: false }); });
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
      "justify-start",
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
      "discord",
      "github-code-review-bot",
      "imessage-photon",
      "jira",
      "microsoft-teams",
      "notion",
      "slack",
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
    expect(rows[0]?.dataset.appSlug).toBe("notion");
    const notion = rows[0]!;
    expect(notion.textContent).toContain("devinfoley@gmail.com");
    expect(notion.textContent).toContain("ops@example.com");
    expect(notion.textContent).toContain("Connected by");
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

  it.each(["active", "draft"])("confirms chat removal for %s connections and refreshes the list", async (status) => {
    chatListMock.mockResolvedValue([{ id: "chat-1", provider: "slack", status, assignedAgentName: "CEO" }]);
    const client = await renderBrowse();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(() => void container.querySelector('button[aria-label="Manage CEO Slack connection"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    await flushReact();
    const remove = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.trim() === "Remove connection");
    await act(() => remove!.click());
    await flushReact();
    expect(chatSetupMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Existing Paperclip tasks and conversation history remain available.");
    chatListMock.mockResolvedValue([]);
    await act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Remove connection")!.click());
    await flushReact();
    expect(chatSetupMock).toHaveBeenCalledWith("chat-1", { action: "remove" });
    expect(archiveConnectionMock).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chatEndpoints.list("company-1") });
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
