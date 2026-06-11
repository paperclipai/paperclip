// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Apps } from "./Apps";

const listGalleryMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listAppsAttentionMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGallery: (companyId: string) => listGalleryMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listAppsAttention: (companyId: string) => listAppsAttentionMock(companyId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function connection(overrides: Record<string, unknown>) {
  return {
    id: "conn-x",
    companyId: "company-1",
    applicationId: "app-x",
    name: "GitHub",
    connectionKind: "managed",
    transport: "remote_http",
    status: "active",
    transportConfig: {},
    config: {},
    credentialSecretRefs: [],
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

function profile(connectionId: string, includedEntryIds: string[]) {
  return {
    id: `profile-${connectionId}`,
    companyId: "company-1",
    profileKey: `app:${connectionId}`,
    name: connectionId,
    description: null,
    status: "active",
    defaultAction: "deny",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    entries: includedEntryIds.map((catalogEntryId, index) => ({
      id: `entry-${connectionId}-${index}`,
      companyId: "company-1",
      profileId: `profile-${connectionId}`,
      selectorType: "catalog_entry",
      effect: "include",
      applicationId: null,
      connectionId,
      catalogEntryId,
      toolName: null,
      riskLevel: null,
      conditions: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })),
    bindings: [],
  };
}

describe("Apps table (M1b)", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    listGalleryMock.mockResolvedValue({ apps: [] });
    listAppsAttentionMock.mockResolvedValue({ apps: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderApps() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Apps />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("drops the redundant Connected hint, keeps attention/paused hints, and adds the new columns", async () => {
    listConnectionsMock.mockResolvedValue({
      connections: [
        connection({ id: "c-connected", name: "GitHub", healthStatus: "healthy" }),
        connection({
          id: "c-attention",
          name: "Slack",
          healthStatus: "error",
          lastUsedAt: new Date("2026-06-09T00:00:00Z"),
        }),
        connection({ id: "c-paused", name: "Notion", enabled: false }),
      ],
    });
    listProfilesMock.mockResolvedValue({
      profiles: [
        profile("c-connected", ["a", "b", "c"]),
        profile("c-attention", ["a"]),
      ],
    });

    await renderApps();

    const text = container.textContent ?? "";
    // 1. Connected rows lose the repeated hint.
    expect(text).not.toContain("Connected and ready");
    // 2. Attention + Paused rows keep their explanatory hint.
    expect(text).toContain("The key stopped working");
    expect(text).toContain("Paused — agents can");
    // 3. New header columns are present.
    const headers = Array.from(container.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(headers).toEqual(["App", "Status", "Actions", "Last used", ""]);
    // 4. Actions column reflects enabled catalog entries; missing profile => 0 on.
    expect(text).toContain("3 on");
    expect(text).toContain("1 on");
    expect(text).toContain("0 on");
    // 5. Last used renders a relative timestamp when present, dash when absent.
    expect(text).toContain("—");
  });
});
