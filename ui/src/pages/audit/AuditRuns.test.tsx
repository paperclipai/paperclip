// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditRuns } from "./AuditRuns";

const listAgentsMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
let currentSearch = "";

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    list: (companyId: string, agentId?: string, limit?: number, options?: unknown) =>
      listRunsMock(companyId, agentId, limit, options),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useSearchParams: () => [new URLSearchParams(currentSearch), setSearchParamsMock],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-12345678",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "manual",
    status: "succeeded",
    startedAt: new Date("2026-08-31T18:00:00.000Z"),
    finishedAt: new Date("2026-08-31T18:01:05.000Z"),
    resultJson: { summary: "Reviewed the release checklist" },
    error: null,
    createdAt: new Date("2026-08-31T18:00:00.000Z"),
    ...overrides,
  } as HeartbeatRun;
}

async function flushReact() {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("AuditRuns", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    currentSearch = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    listAgentsMock.mockResolvedValue([{ id: "agent-1", name: "Fable" }]);
    listRunsMock.mockResolvedValue([run()]);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuditRuns companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders a filterable flat run list with existing run-detail links", async () => {
    await render();

    expect(listRunsMock).toHaveBeenCalledWith("company-1", undefined, 200, { summary: true });
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Reviewed the release checklist");
    expect(container.textContent).toContain("1m 5s");
    const list = container.querySelector('ul[aria-label="Recent runs"]');
    expect(list).toBeTruthy();
    expect(list?.closest('[data-slot="card"]')).toBeFalsy();
    expect(container.querySelector('a[href="/agents/agent-1/runs/run-12345678"]')).toBeTruthy();
  });

  it("uses the agent deep-link filter for both the query key and request", async () => {
    currentSearch = "agentId=agent-1&runStatus=succeeded";
    await render();

    expect(listRunsMock).toHaveBeenCalledWith("company-1", "agent-1", 200, { summary: true });
    expect(container.textContent).toContain("Clear filters");
  });
});
