// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { JoinRequestQueue } from "./JoinRequestQueue";

const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const approveJoinRequestMock = vi.hoisted(() => vi.fn());
const rejectJoinRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listJoinRequests: (companyId: string, status: string, requestType?: string) =>
      listJoinRequestsMock(companyId, status, requestType),
    approveJoinRequest: (companyId: string, requestId: string) => approveJoinRequestMock(companyId, requestId),
    rejectJoinRequest: (companyId: string, requestId: string) => rejectJoinRequestMock(companyId, requestId),
  },
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

const pendingRequest = {
  id: "join-1",
  status: "pending_approval",
  requestType: "human",
  createdAt: "2026-04-10T00:00:00.000Z",
  requestIp: "127.0.0.1",
  requesterUser: { id: "user-2", email: "board@paperclip.local", name: "Board User", image: null },
  requestEmailSnapshot: "board@paperclip.local",
  requestingUserId: "user-2",
  invite: { allowedJoinTypes: "human", humanRole: "operator", inviteMessage: null },
};

const pendingQueueKey = queryKeys.access.joinRequests("company-1", "pending_approval:all");

describe("JoinRequestQueue", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listJoinRequestsMock.mockResolvedValue([pendingRequest]);
    approveJoinRequestMock.mockResolvedValue({});
    rejectJoinRequestMock.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPage(client: QueryClient) {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <JoinRequestQueue />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("keeps loaded join requests on screen when a refetch fails transiently", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);
    expect(container.textContent).toContain("Board User");

    listJoinRequestsMock.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: pendingQueueKey });
    });
    await flushReact();

    expect(listJoinRequestsMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Board User");
    expect(container.textContent).toContain("Join Request Queue");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
    expect(container.textContent).not.toContain("tenant_app_unavailable");

    await act(async () => root.unmount());
  });

  it("shows readable copy and a Retry button when join requests fail to load", async () => {
    listJoinRequestsMock.mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);

    expect(container.textContent).toContain("Couldn't load join requests");
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Board User");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the permission copy for a forbidden queue", async () => {
    listJoinRequestsMock.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = await renderPage(client);

    expect(container.textContent).toContain(
      "You do not have permission to review join requests for this organization.",
    );
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();

    await act(async () => root.unmount());
  });
});
