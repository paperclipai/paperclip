// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNotConnected } from "./AppNotConnected";

const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listGalleryMock = vi.hoisted(() => vi.fn());
const listConnectionGrantsMock = vi.hoisted(() => vi.fn());
const listConnectionActivityMock = vi.hoisted(() => vi.fn());
const listActionRequestsMock = vi.hoisted(() => vi.fn());
const listUserDirectoryMock = vi.hoisted(() => vi.fn());
const updateApplicationMock = vi.hoisted(() => vi.fn());
const mockAgentsList = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const navigateComponentMock = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ applicationId: "app-1", tab: "permissions" as string | undefined }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listConnectionGrants: (connectionId: string) => listConnectionGrantsMock(connectionId),
    listConnectionActivity: (connectionId: string, limit: number) =>
      listConnectionActivityMock(connectionId, limit),
    listActionRequests: (companyId: string, status: string) =>
      listActionRequestsMock(companyId, status),
    updateApplication: (applicationId: string, input: unknown) =>
      updateApplicationMock(applicationId, input),
    approveActionRequest: vi.fn(),
    declineActionRequest: vi.fn(),
    createTrustRuleFromActionRequest: vi.fn(),
  },
}));

vi.mock("@/api/access", () => ({
  accessApi: {
    listUserDirectory: (companyId: string) => listUserDirectoryMock(companyId),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => mockAgentsList(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    navigateComponentMock({ to, replace });
    return <div data-navigate-to={to} />;
  },
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
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

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    companyId: "company-1",
    applicationKey: "github",
    name: "GitHub",
    description: "Repository app",
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-old",
    companyId: "company-1",
    applicationId: "app-1",
    name: "GitHub",
    connectionKind: "managed",
    transport: "mcp_remote",
    authKind: "api_key",
    credentialPolicy: "shared",
    status: "archived",
    transportConfig: { url: "https://github.example/mcp" },
    config: { url: "https://github.example/mcp" },
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "error",
    healthMessage: "Token expired.",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    lastUsedAt: new Date("2026-06-10T00:00:00Z"),
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-06-11T00:00:00Z"),
    ...overrides,
  };
}

describe("AppNotConnected", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.applicationId = "app-1";
    mockParams.tab = "permissions";
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    listGalleryMock.mockResolvedValue({
      apps: [{ key: "github", name: "GitHub", logoUrl: "https://example.test/github.png" }],
    });
    listConnectionActivityMock.mockResolvedValue({ events: [], issues: {}, actionRequests: {} });
    listConnectionGrantsMock.mockResolvedValue({
      connection: { id: "conn-old", uid: "conn-old" },
      grants: [],
      capabilities: {
        canConfigure: true,
        canCreateOrganizationGrant: true,
        canSetCompanyInstall: true,
        canConnectAsCurrentUser: true,
        canManageAgentInstalls: true,
        canViewOtherPersonalIdentities: false,
        editableAgentIds: [],
      },
      currentUserId: "user-1",
      members: [],
    });
    listActionRequestsMock.mockResolvedValue({ actionRequests: [] });
    listUserDirectoryMock.mockResolvedValue({ users: [] });
    mockAgentsList.mockResolvedValue([]);
    updateApplicationMock.mockResolvedValue(application({ status: "archived" }));
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AppNotConnected />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("redirects the application root route to Permissions", async () => {
    mockParams.tab = undefined;

    await renderPage();

    expect(navigateComponentMock).toHaveBeenCalledWith({ to: "/apps/app/app-1/permissions", replace: true });
    expect(listApplicationsMock).not.toHaveBeenCalled();
  });

  it("redirects to the connected app tab when a live connection exists", async () => {
    mockParams.tab = "permissions";
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ id: "conn-live", status: "active" })],
    });

    await renderPage();

    expect(navigateComponentMock).toHaveBeenCalledWith({ to: "/apps/conn-live/permissions", replace: true });
  });

  it("redirects a provider application to its live connection Permissions page", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "app-1",
          applicationKey: "app-gallery:notion:one",
          name: "Notion",
          metadata: { sourceTemplateKey: "notion" },
        }),
        application({
          id: "app-2",
          applicationKey: "app-gallery:notion:two",
          name: "Notion workspace",
          metadata: { sourceTemplateKey: "notion" },
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({
          id: "conn-one",
          applicationId: "app-1",
          name: "Notion",
          status: "active",
          createdByUserId: "user-1",
        }),
        connection({ id: "conn-two", applicationId: "app-2", name: "Notion team", status: "active" }),
      ],
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

    await renderPage();

    expect(navigateComponentMock).toHaveBeenCalledWith({
      to: "/apps/conn-one/permissions",
      replace: true,
    });
  });

  it("does not group unrelated generic link applications", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [
        application({
          id: "app-1",
          applicationKey: "app-gallery:link:first",
          name: "First server",
          metadata: { source: "link" },
        }),
        application({
          id: "app-2",
          applicationKey: "app-gallery:link:second",
          name: "Second server",
          metadata: { source: "link" },
        }),
      ],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "conn-old", applicationId: "app-1", status: "archived" }),
        connection({ id: "conn-live", applicationId: "app-2", status: "active" }),
      ],
    });

    await renderPage();

    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Reconnect");
  });

  it.each([
    ["review", "Nothing is waiting for your OK right now."],
    ["permissions", "Permissions paused"],
  ])("renders the %s tab with persistent app identity", async (tab, expectedText) => {
    mockParams.tab = tab;

    await renderPage();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).toContain(expectedText);
  });

  it.each([
    ["setup", "/apps/app/app-1/permissions"],
    ["test", "/apps/app/app-1/permissions"],
    ["advanced", "/apps/app/app-1/permissions"],
    ["activity", "/activity?action=tool_"],
  ])("redirects the retired %s tab", async (tab, to) => {
    mockParams.tab = tab;
    await renderPage();
    expect(navigateComponentMock).toHaveBeenCalledWith({ to, replace: true });
  });

  it.each(["permissions", "review"])("shows reconnect directly below the header on %s", async (tab) => {
    mockParams.tab = tab;

    await renderPage();

    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Add a working GitHub key to restore access.");
    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Reconnect",
    )).toBe(true);
  });

  it("carries the retained identity into the reconnect flow", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ credentialPolicy: "per_user", createdByUserId: "user-1" })],
    });

    await renderPage();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Reconnect")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/apps/connect?applicationId=app-1&name=GitHub&new=1&reconnect=conn-old&identity=user&source=github&link=https%3A%2F%2Fgithub.example%2Fmcp",
    );
  });

  it("keeps a removed Vercel-backed connection in the isolated Vercel setup", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ credentialSource: "vercel_connect" })],
    });

    await renderPage();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Reconnect")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/apps/vercel-connect?applicationId=app-1&name=GitHub&new=1&reconnect=conn-old&identity=organization&source=github&link=https%3A%2F%2Fgithub.example%2Fmcp",
    );
  });

  it("prefills a custom MCP reconnect from the stored transport URL", async () => {
    listApplicationsMock.mockResolvedValue({
      applications: [application({ applicationKey: "custom-mcp", name: "Bla", metadata: null })],
    });
    listConnectionsMock.mockResolvedValue({
      connections: [connection({
        name: "Bla",
        config: { url: "http://127.0.0.1:49287" },
        transportConfig: { url: "http://127.0.0.1:49287" },
      })],
    });
    listGalleryMock.mockResolvedValue({ apps: [] });

    await renderPage();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Reconnect")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/apps/connect?applicationId=app-1&name=Bla&new=1&reconnect=conn-old&identity=organization&byo=1&link=http%3A%2F%2F127.0.0.1%3A49287",
    );
  });

  it("does not offer a removed personal reconnect to someone other than its fixed owner", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [connection({ credentialPolicy: "per_user", createdByUserId: "user-2" })],
    });
    listConnectionGrantsMock.mockResolvedValue({
      connection: { id: "conn-old", uid: "conn-old" },
      grants: [{
        id: "grant-user-2",
        kind: "user",
        subjectUserId: "user-2",
        status: "revoked",
        credentialSecretRefs: [],
      }],
      capabilities: {
        canConfigure: true,
        canCreateOrganizationGrant: true,
        canSetCompanyInstall: true,
        canConnectAsCurrentUser: true,
        canManageAgentInstalls: true,
        canViewOtherPersonalIdentities: true,
        editableAgentIds: [],
      },
      currentUserId: "user-1",
      members: [],
    });

    await renderPage();

    expect(container.textContent).toContain("The person this connection belongs to must reconnect it.");
    expect(Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent?.trim() === "Reconnect",
    )).toBe(false);
  });
});
