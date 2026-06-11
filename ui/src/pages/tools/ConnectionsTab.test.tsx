// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecret, ToolApplication, ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../context/ToastContext";
import { ConnectionsTab } from "./ConnectionsTab";

const mockToolsApi = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listApplications: vi.fn(),
  listCatalog: vi.fn(),
  listStdioTemplates: vi.fn(),
  checkConnectionHealth: vi.fn(),
  refreshCatalog: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../../api/tools", () => ({ toolsApi: mockToolsApi }));
vi.mock("../../api/secrets", () => ({ secretsApi: mockSecretsApi }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeConnection(overrides: Partial<ToolConnection>): ToolConnection {
  return {
    id: "conn-1",
    companyId: "company-1",
    applicationId: "app-1",
    name: "Production GitHub",
    connectionKind: "managed",
    transport: "remote_http",
    status: "active",
    transportConfig: { url: "https://mcp.github.example.com" },
    config: {},
    credentialSecretRefs: [],
    credentialRefs: [{ name: "Authorization", secretId: "secret-1", version: "latest", placement: "header", key: "Authorization" }],
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: new Date("2026-06-10T00:00:00Z"),
    lastCatalogRefreshAt: new Date("2026-06-10T00:00:00Z"),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-10T00:00:00Z"),
    ...overrides,
  };
}

function makeApp(overrides: Partial<ToolApplication>): ToolApplication {
  return {
    id: "app-1",
    companyId: "company-1",
    name: "GitHub",
    description: null,
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSecret(overrides: Partial<CompanySecret>): CompanySecret {
  return {
    id: "secret-1",
    companyId: "company-1",
    key: "github_token",
    name: "GitHub token",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("ConnectionsTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockToolsApi.listConnections.mockResolvedValue({ connections: [makeConnection({})] });
    mockToolsApi.listApplications.mockResolvedValue({ applications: [makeApp({})] });
    mockToolsApi.listCatalog.mockResolvedValue({
      catalog: [
        { id: "c1", toolName: "create_issue" },
        { id: "c2", toolName: "list_repos" },
      ],
    });
    mockToolsApi.listStdioTemplates.mockResolvedValue({ templates: [] });
    mockSecretsApi.list.mockResolvedValue([makeSecret({})]);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
    }
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    await act(() => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <ConnectionsTab companyId="company-1" />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  it("renders a dense table with the endpoint, application, transport and catalog count", async () => {
    await render();
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toEqual(["Connection", "Application", "Transport", "Health", "Catalog", "Actions"]);

    const text = container.textContent ?? "";
    expect(text).toContain("Production GitHub");
    expect(text).toContain("https://mcp.github.example.com");
    expect(text).toContain("GitHub"); // application column
    expect(text).toContain("remote http"); // transport pill label
    expect(text).toContain("2 tools"); // catalog count from listCatalog
    expect(text).toContain("1 credential ref");
  });

  it("opens the unified add wizard without offering free-text secrets", async () => {
    await render();
    const newBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("New connection"),
    );
    expect(newBtn).toBeTruthy();
    await act(() => {
      newBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const body = document.body.textContent ?? "";
    expect(body).toContain("Add application");
    expect(body).toContain("Use existing application");
    // The dialog must NOT offer a free-text token/secret input.
    const inputs = Array.from(document.querySelectorAll("input"));
    const hasSecretValueField = inputs.some((i) =>
      /token|secret value|password|api[- ]?key/i.test(`${i.getAttribute("placeholder") ?? ""} ${i.getAttribute("aria-label") ?? ""}`),
    );
    expect(hasSecretValueField).toBe(false);
  });
});
