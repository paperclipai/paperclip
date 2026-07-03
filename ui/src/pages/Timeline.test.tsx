// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "./Timeline";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockWorkTimelineApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/api/workTimeline", () => ({
  workTimelineApi: mockWorkTimelineApi,
}));

vi.mock("@/components/RequestCollapsedSidebar", () => ({
  RequestCollapsedSidebar: () => <div data-testid="request-collapsed-sidebar" />,
}));

const emptyTimeline: WorkTimelineResult = {
  actors: [],
  spans: [],
  events: [],
  edges: [],
  pagination: {
    limit: 100,
    offset: 0,
    totalIssues: 0,
    hasMore: false,
  },
  window: {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-07T23:59:59.999Z",
    capped: false,
  },
};

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Timeline", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockWorkTimelineApi.get.mockResolvedValue(emptyTimeline);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("requests the collapsed app sidebar by default", async () => {
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Timeline />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="request-collapsed-sidebar"]')).not.toBeNull();
  });
});
