// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsAttention } from "./AppsAttention";

const listAppsAttentionMock = vi.hoisted(() => vi.fn());
const listGalleryMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listAppsAttention: (companyId: string) => listAppsAttentionMock(companyId),
    listGallery: (companyId: string) => listGalleryMock(companyId),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
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

vi.mock("./ReviewQueueCard", () => ({
  ReviewQueueCard: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function connection() {
  return {
    id: "conn-gmail",
    companyId: "company-1",
    applicationId: "app-gmail",
    name: "Gmail",
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
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

describe("AppsAttention", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listGalleryMock.mockResolvedValue({ apps: [] });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AppsAttention />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  it("deep-links profile new-tools attention to the profile review flow", async () => {
    listAppsAttentionMock.mockResolvedValue({
      apps: [
        {
          connection: connection(),
          healthNeedsAttention: false,
          quarantinedCatalogEntryCount: 0,
          pendingActionRequestCount: 0,
          newToolsPendingReviewCount: 3,
          newToolsPendingProfiles: [{ profileId: "profile-gmail", profileName: "Gmail", pendingCount: 3 }],
          reasons: ["profile_new_tools"],
        },
      ],
      totals: {
        connections: 1,
        health: 0,
        quarantinedCatalogEntries: 0,
        pendingActionRequests: 0,
        newToolsPendingReview: 3,
        newToolsPendingProfiles: 1,
      },
    });

    await render();

    expect(container.textContent).toContain("3 new tools need profile review.");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Review");
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(navigateMock).toHaveBeenCalledWith("/apps/advanced/profiles/profile-gmail?review=new-tools");
  });
});
