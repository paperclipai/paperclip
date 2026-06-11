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
const mockNavigate = vi.hoisted(() => vi.fn());

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
    finishApp: vi.fn(),
    archiveConnection: vi.fn(),
    refreshCatalog: vi.fn(),
    reconnectConnection: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ connectionId: "conn-1" }),
  useNavigate: () => mockNavigate,
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
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
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

describe("AppDetail", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getConnectionMock.mockResolvedValue(connection());
    listGalleryMock.mockResolvedValue({ apps: [] });
    listCatalogMock.mockResolvedValue({ catalog: [] });
    listProfilesMock.mockResolvedValue({ profiles: [] });
    listPoliciesMock.mockResolvedValue({ policies: [] });
    listConnectionActivityMock.mockResolvedValue({ events: [] });
    listActionRequestsMock.mockResolvedValue({ actionRequests: [] });
    updateConnectionMock.mockResolvedValue(connection({ enabled: false }));
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
});
