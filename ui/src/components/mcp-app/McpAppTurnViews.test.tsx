// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppViewSummary } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";

const detail = vi.fn(() => new Promise(() => undefined));
vi.mock("@/api/mcpApps", () => ({ mcpAppsApi: { list: vi.fn(), detail: (...args: unknown[]) => detail(...(args as [])), callTool: vi.fn() } }));

const { McpAppIssueProvider } = await import("./McpAppIssueContext");
const { McpAppTurnViews } = await import("./McpAppTurnViews");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function views(count: number): McpAppViewSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`, issueId: "issue-1", runId: "run-1", connectionId: "conn-1",
    applicationName: "Circleback", toolName: "mcp.circleback:displaymeetings", upstreamToolName: "DisplayMeetings",
    resourceUri: "ui://circleback/meetings", toolInput: {}, createdAt: "2026-11-12T00:00:00.000Z",
  }));
}

let observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
class FakeIntersectionObserver {
  targets: Element[] = [];
  constructor(public callback: IntersectionObserverCallback) { observers.push(this); }
  observe(target: Element) { this.targets.push(target); }
  disconnect() { this.targets = []; }
  unobserve() {}
  takeRecords() { return []; }
}

async function render(count: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.mcpApps.views("issue-1"), views(count));
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <McpAppIssueProvider issueId="issue-1"><McpAppTurnViews runId="run-1" /></McpAppIssueProvider>
    </QueryClientProvider>,
  ));
  return { container, root };
}

afterEach(() => {
  observers = [];
  detail.mockClear();
  vi.unstubAllGlobals();
});

describe("McpAppTurnViews", () => {
  it("loads a view's document only when it nears the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("navigation", { addEventListener: () => undefined });
    const { container, root } = await render(2);
    expect(container.querySelectorAll("[data-testid=mcp-app-view-placeholder]")).toHaveLength(2);
    expect(detail).not.toHaveBeenCalled();
    const first = observers[0]!;
    await act(async () => first.callback([{ isIntersecting: true, target: first.targets[0]! } as IntersectionObserverEntry], first as unknown as IntersectionObserver));
    expect(detail).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("[data-testid=mcp-app-view-placeholder]")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it("shows five views per run and the rest on request", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const { container, root } = await render(7);
    expect(container.querySelectorAll("[data-testid=mcp-app-turn-view]")).toHaveLength(5);
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show 2 more")!;
    expect(more).toBeTruthy();
    await act(async () => more.click());
    expect(container.querySelectorAll("[data-testid=mcp-app-turn-view]")).toHaveLength(7);
    expect(detail).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
