// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppViewSummary } from "@paperclipai/shared";

const list = vi.fn<(issueId: string) => Promise<McpAppViewSummary[]>>();
vi.mock("@/api/mcpApps", () => ({ mcpAppsApi: { list: (issueId: string) => list(issueId) } }));

const { McpAppIssueProvider, useMcpAppViewsForRun } = await import("./McpAppIssueContext");

function view(id: string, runId: string): McpAppViewSummary {
  return {
    id, issueId: "issue-1", runId, connectionId: "conn-1", applicationName: "Circleback",
    toolName: "mcp.circleback:displaymeetings", upstreamToolName: "DisplayMeetings",
    resourceUri: "ui://circleback/meetings", toolInput: {}, createdAt: "2026-11-12T00:00:00.000Z",
  };
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <McpAppIssueProvider issueId="issue-1">{children}</McpAppIssueProvider>
    </QueryClientProvider>
  );
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function renderHook<P, R>(hook: (props: P) => R, options: { wrapper: (props: { children: ReactNode }) => ReactNode; initialProps?: P }) {
  const result = { current: undefined as unknown as R };
  const container = document.createElement("div");
  const root = createRoot(container);
  const Wrapper = options.wrapper;
  function Probe({ props }: { props: P }) {
    result.current = hook(props);
    return null;
  }
  const render = (props: P) => act(() => root.render(<Wrapper><Probe props={props} /></Wrapper>));
  await render(options.initialProps as P);
  return { result, rerender: (props: P) => render(props), unmount: () => act(() => root.unmount()) };
}

async function waitFor(check: () => void, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }
}

afterEach(() => list.mockReset());

describe("useMcpAppViewsForRun", () => {
  it("refreshes the task's list once when a live run completes another MCP tool call", async () => {
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([view("v1", "run-1")]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = await renderHook(
      ({ refreshKey }: { refreshKey: string }) => useMcpAppViewsForRun("run-1", { refreshKey }),
      { wrapper: wrapper(client), initialProps: { refreshKey: "0:running" } },
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(result.current.views).toEqual([]);
    await rerender({ refreshKey: "1:running" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.views.map((v) => v.id)).toEqual(["v1"]));
    await rerender({ refreshKey: "1:running" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refreshes once for a settled reply newer than the loaded list", async () => {
    list.mockResolvedValueOnce([]).mockResolvedValue([view("v1", "run-1")]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = await renderHook(
      () => useMcpAppViewsForRun("run-1", { notBeforeMs: Date.now() + 60_000 }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.views.map((v) => v.id)).toEqual(["v1"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for a reply older than the loaded list", async () => {
    list.mockResolvedValue([view("v1", "run-1")]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = await renderHook(
      () => useMcpAppViewsForRun("run-1", { notBeforeMs: Date.now() - 60_000 }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.views).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(list).toHaveBeenCalledTimes(1);
  });
});
