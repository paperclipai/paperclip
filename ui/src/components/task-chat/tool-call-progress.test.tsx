// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallProgressSnapshot } from "@paperclipai/shared";
import { TaskChatToolCard } from "./TaskChatToolCard";
import {
  pickToolCallProgress,
  readToolCallProgressEvent,
  TaskChatToolProgress,
  toolCallNameMatches,
  ToolCallProgressProvider,
  ToolCallProgressRunProvider,
  ToolCallProgressStore,
} from "./tool-call-progress";
import type { TaskChatToolItem } from "./task-chat-model";

const savedProgress = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/mcpApps", () => ({ mcpAppsApi: { toolCallProgress: savedProgress.list } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (fields: Partial<ToolCallProgressSnapshot> = {}): ToolCallProgressSnapshot => ({
  invocationId: "call-1", runId: "run-1", toolName: "kv_demo__slow_with_progress",
  startedAt: "2026-11-13T10:00:00.000Z", updatedAt: "2026-11-13T10:00:05.000Z",
  progress: 2, total: 5, message: "Exporting rows", done: false, ...fields,
});
const tool = (fields: Partial<TaskChatToolItem> = {}): TaskChatToolItem => ({
  id: "toolu_1", kind: "tool", name: "slow_with_progress", rawName: "mcp__paperclip__kv_demo__slow_with_progress",
  status: "in_progress", ...fields,
});

describe("tool call progress matching", () => {
  it("matches the gateway tool name inside the agent's tool name, and nothing else", () => {
    expect(toolCallNameMatches("mcp__paperclip__kv_demo__slow_with_progress", "kv_demo__slow_with_progress")).toBe(true);
    expect(toolCallNameMatches("kv_demo__slow_with_progress", "kv_demo__slow_with_progress")).toBe(true);
    expect(toolCallNameMatches("mcp__paperclip__kv_demo__slow_with_progressive", "kv_demo__slow_with_progress")).toBe(false);
    expect(toolCallNameMatches("mcp__paperclip__other_slow_with_progress", "kv_demo__slow_with_progress")).toBe(false);
    expect(toolCallNameMatches(undefined, "x")).toBe(false);
    // Gateway names carry "." and ":", which agents may rewrite.
    expect(toolCallNameMatches("mcp__paperclip__mcp_kv-demo-1a2b3c4d_slow-with-progress", "mcp.kv-demo-1a2b3c4d:slow-with-progress")).toBe(true);
    expect(toolCallNameMatches("mcp__paperclip__mcp.kv-demo-1a2b3c4d:slow-with-progress", "mcp.kv-demo-1a2b3c4d:slow-with-progress")).toBe(true);
    expect(toolCallNameMatches("mcp__paperclip__mcp.kv-demo-99999999:slow-with-progress", "mcp.kv-demo-1a2b3c4d:slow-with-progress")).toBe(false);
  });

  it("picks the newest unfinished call of the row's tool in the row's run", () => {
    const entries = [
      snapshot({ invocationId: "old", startedAt: "2026-11-13T09:00:00.000Z" }),
      snapshot({ invocationId: "new", startedAt: "2026-11-13T10:00:00.000Z" }),
      snapshot({ invocationId: "finished", startedAt: "2026-11-13T11:00:00.000Z", done: true }),
      snapshot({ invocationId: "other-run", runId: "run-2", startedAt: "2026-11-13T12:00:00.000Z" }),
      snapshot({ invocationId: "other-tool", toolName: "kv_demo__get", startedAt: "2026-11-13T13:00:00.000Z" }),
    ];
    expect(pickToolCallProgress(entries, tool(), "run-1")?.invocationId).toBe("new");
    expect(pickToolCallProgress(entries, tool(), null)?.invocationId).toBe("other-run");
    expect(pickToolCallProgress(entries, tool({ rawName: "Bash", name: "Bash" }), "run-1")).toBeNull();
  });

  it("keeps the newest state of each call, a finished call stays finished, and memory is bounded", () => {
    const store = new ToolCallProgressStore();
    store.put(snapshot({ progress: 3, updatedAt: "2026-11-13T10:00:06.000Z" }));
    store.put(snapshot({ progress: 2, updatedAt: "2026-11-13T10:00:05.000Z" }));
    expect([...store.entries()].map((entry) => entry.progress)).toEqual([3]);
    store.put(snapshot({ progress: 3, done: true, updatedAt: "2026-11-13T10:00:06.000Z" }));
    store.put(snapshot({ progress: 4, updatedAt: "2026-11-13T10:00:09.000Z" }));
    expect([...store.entries()][0]!.done).toBe(true);
    for (let i = 0; i < 80; i++) store.put(snapshot({ invocationId: `call-${i + 2}` }));
    expect([...store.entries()]).toHaveLength(50);
  });

  it("reads live events defensively", () => {
    expect(readToolCallProgressEvent({ ...snapshot(), message: "x".repeat(500) })?.message).toHaveLength(200);
    expect(readToolCallProgressEvent({ ...snapshot(), runId: undefined })).toBeNull();
    expect(readToolCallProgressEvent({ ...snapshot(), progress: "2" })).toBeNull();
    expect(readToolCallProgressEvent({ ...snapshot(), total: -1 })?.total).toBeNull();
  });
});

describe("tool row progress states", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    savedProgress.list.mockReset();
    savedProgress.list.mockResolvedValue([]);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (node: React.ReactNode) => act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <ToolCallProgressProvider issueId="issue-1"><ToolCallProgressRunProvider runId="run-1">{node}</ToolCallProgressRunProvider></ToolCallProgressProvider>
    </QueryClientProvider>,
  ));
  const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

  it("running with a total: a filling bar, the message, percent and elapsed time", () => {
    act(() => root.render(<TaskChatToolProgress progress={snapshot()} nowMs={Date.parse("2026-11-13T10:01:05.000Z")} />));
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(container.querySelector<HTMLElement>('[data-testid="task-chat-tool-progress-fill"]')!.style.width).toBe("40%");
    expect(container.textContent).toContain("Exporting rows");
    expect(container.textContent).toContain("40%");
    expect(container.querySelector('[data-testid="task-chat-tool-progress-elapsed"]')!.textContent).toBe("1m 5s");
  });

  it("running without a total: an indeterminate sweep and no percent", () => {
    act(() => root.render(<TaskChatToolProgress progress={snapshot({ total: null, message: null })} nowMs={Date.parse("2026-11-13T10:00:12.000Z")} />));
    expect(container.querySelector('[data-testid="task-chat-tool-progress-indeterminate"]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')!.hasAttribute("aria-valuenow")).toBe(false);
    expect(container.textContent).not.toContain("%");
    expect(container.querySelector('[data-testid="task-chat-tool-progress-message"]')).toBeNull();
    expect(container.textContent).toContain("12s");
  });

  it("renders provider text as plain text, never markup", () => {
    act(() => root.render(<TaskChatToolProgress progress={snapshot({ message: '<img src=x onerror="alert(1)"> done' })} nowMs={Date.parse("2026-11-13T10:00:01.000Z")} />));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)"> done');
  });

  it("drops the progress when the call completes", () => {
    render(<TaskChatToolCard item={tool()} progress={snapshot()} />);
    expect(container.querySelector('[data-testid="task-chat-tool-progress"]')).not.toBeNull();
    render(<TaskChatToolCard item={tool({ status: "completed" })} progress={snapshot()} />);
    expect(container.querySelector('[data-testid="task-chat-tool-progress"]')).toBeNull();
  });

  it("restores the saved progress of a running call after a reload", async () => {
    savedProgress.list.mockResolvedValue([snapshot({ progress: 3, message: "Writing file" })]);
    render(<TaskChatToolCard item={tool()} />);
    await vi.waitFor(async () => {
      await settle();
      expect(container.querySelector('[data-testid="task-chat-tool-progress-message"]')?.textContent).toBe("Writing file");
    });
    expect(savedProgress.list).toHaveBeenCalledWith("issue-1");
  });

  it("never asks for progress for a finished row", async () => {
    render(<TaskChatToolCard item={tool({ status: "completed" })} />);
    await settle();
    expect(savedProgress.list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-chat-tool-progress"]')).toBeNull();
  });
});
