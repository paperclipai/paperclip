// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSettings } from "./InstanceSettings";
import { I18nProvider, I18N_LOCALE_STORAGE_KEY } from "@/i18n/runtime";

const listInstanceSchedulerAgentsMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const setBreadcrumbsMock = vi.fn();

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    listInstanceSchedulerAgents: () => listInstanceSchedulerAgentsMock(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    instance: { schedulerHeartbeats: ["instance", "scheduler-heartbeats"] },
    agents: {
      list: (companyId: string) => ["agents", "list", companyId],
      detail: (agentId: string) => ["agents", "detail", agentId],
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InstanceSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listInstanceSchedulerAgentsMock.mockResolvedValue([]);
    invalidateQueriesMock.mockResolvedValue(undefined);
    setBreadcrumbsMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <InstanceSettings />
          </I18nProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    return root;
  }

  async function waitFor(condition: () => boolean, attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    throw new Error("Timed out waiting for InstanceSettings to settle");
  }

  it("renders localized heartbeat copy, summary and empty state", async () => {
    localStorage.setItem(I18N_LOCALE_STORAGE_KEY, "zh-CN");
    const root = await renderPage();

    await waitFor(() => container.textContent?.includes("当前条件下没有匹配的调度器心跳。") === true);

    expect(container.textContent).toContain("调度器心跳");
    expect(container.textContent).toContain("活跃");
    expect(container.textContent).toContain("当前条件下没有匹配的调度器心跳。");
    expect(setBreadcrumbsMock).toHaveBeenLastCalledWith([
      { label: "实例设置" },
      { label: "心跳" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});
