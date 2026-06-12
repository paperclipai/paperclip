// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppNotConnected } from "./AppNotConnected";

const listApplicationsMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listGalleryMock = vi.hoisted(() => vi.fn());
const listConnectionActivityMock = vi.hoisted(() => vi.fn());
const listActionRequestsMock = vi.hoisted(() => vi.fn());
const updateApplicationMock = vi.hoisted(() => vi.fn());
const mockAgentsList = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const navigateComponentMock = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({ applicationId: "app-1", tab: "setup" as string | undefined }));

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listGallery: (companyId: string) => listGalleryMock(companyId),
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
    transport: "remote_http",
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
    mockParams.tab = "setup";
    listApplicationsMock.mockResolvedValue({ applications: [application()] });
    listConnectionsMock.mockResolvedValue({ connections: [connection()] });
    listGalleryMock.mockResolvedValue({
      apps: [{ key: "github", name: "GitHub", logoUrl: "https://example.test/github.png" }],
    });
    listConnectionActivityMock.mockResolvedValue({ events: [], issues: {}, actionRequests: {} });
    listActionRequestsMock.mockResolvedValue({ actionRequests: [] });
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

  it("redirects the application root route to setup", async () => {
    mockParams.tab = undefined;

    await renderPage();

    expect(navigateComponentMock).toHaveBeenCalledWith({ to: "/apps/app/app-1/setup", replace: true });
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

  it.each([
    ["setup", "Reconnect this app"],
    ["review", "Nothing is waiting for your OK right now."],
    ["permissions", "Permissions paused"],
    ["activity", "No activity yet."],
    ["advanced", "Danger zone"],
  ])("renders the %s tab with persistent app identity", async (tab, expectedText) => {
    mockParams.tab = tab;

    await renderPage();

    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Not connected");
    expect(container.textContent).toContain(expectedText);
  });

  it("keeps previous setup context on reconnect tabs", async () => {
    mockParams.tab = "setup";

    await renderPage();

    expect(container.textContent).toContain("Previous setup");
    expect(container.textContent).toContain("Last error: Token expired.");
    expect(container.textContent).toContain("https://github.example/mcp");
  });
});
