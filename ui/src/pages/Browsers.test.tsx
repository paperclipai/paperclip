// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Browsers } from "./Browsers";

const mockLiveRunsForCompany = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const openedStreams: string[] = [];

class MockEventSource {
  onerror: (() => void) | null = null;
  constructor(public url: string) { openedStreams.push(url); }
  addEventListener() {}
  close() {}
}

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: mockLiveRunsForCompany },
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("../lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Browsers", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    openedStreams.length = 0;
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens one isolated live stream per active run", async () => {
    mockLiveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-1", agentName: "Atlas", status: "running", adapterType: "codex", invocationSource: "issue", triggerDetail: null, startedAt: "2026-07-11T00:00:00Z", finishedAt: null, createdAt: "2026-07-11T00:00:00Z", issueId: "issue-1", issueIdentifier: "ELIA-10", issueTitle: "Research vendor" },
      { id: "run-2", agentId: "agent-2", agentName: "Nova", status: "running", adapterType: "codex", invocationSource: "issue", triggerDetail: null, startedAt: "2026-07-11T00:00:01Z", finishedAt: null, createdAt: "2026-07-11T00:00:01Z", issueId: "issue-2", issueIdentifier: "ELIA-11", issueTitle: "Validate checkout" },
    ]);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(<QueryClientProvider client={client}><Browsers /></QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("2 active · 2 recent");
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("ELIA-11");
    expect(openedStreams).toEqual(expect.arrayContaining([
      "/api/heartbeat-runs/run-1/browser-stream",
      "/api/heartbeat-runs/run-2/browser-stream",
    ]));
    expect(new Set(openedStreams).size).toBe(2);

    await act(async () => root.unmount());
  });
});
