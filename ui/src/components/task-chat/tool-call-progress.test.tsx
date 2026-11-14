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
import { transcriptToTaskChatItems, wrappedAppToolName } from "./transcript-adapter";

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

  it("finds a native runner's row by the shortened, hashed name it gives the tool", () => {
    const gatewayName = "mcp.kv-demo-1a2b3c4d:slow-with-progress";
    const nativeName = "app_mcp_kv_demo_1a2b3c4d_slow_with_progress_889fb9a8d98e";
    const entry = snapshot({ toolName: gatewayName, nativeToolName: nativeName });
    expect(pickToolCallProgress([entry], tool({ rawName: nativeName, name: nativeName }), "run-1")).toBe(entry);
    expect(pickToolCallProgress([entry], tool({ rawName: `mcp__paperclip__${nativeName}` }), "run-1")).toBe(entry);
    // Another tool's hash never matches.
    expect(pickToolCallProgress([entry], tool({ rawName: "app_mcp_kv_demo_1a2b3c4d_slow_with_progress_000000000000" }), "run-1")).toBeNull();
    expect(readToolCallProgressEvent({ ...entry })?.nativeToolName).toBe(nativeName);
  });

  it("finds a wrapper call's row (OpenCode's paperclip_call_assigned_tool) by the tool it runs", () => {
    const gatewayName = "mcp.kv-demo-1a2b3c4d:slow-with-progress";
    const nativeName = "app_mcp_kv_demo_1a2b3c4d_slow_with_progress_889fb9a8d98e";
    const items = transcriptToTaskChatItems([{
      kind: "tool_call", ts: "2026-11-13T10:00:00.000Z", toolUseId: "call-1",
      name: "paperclip_call_assigned_tool", input: { name: nativeName, arguments: { steps: 10 } },
    }], { runId: "run-1", running: true });
    const row = items.find((item): item is TaskChatToolItem => item.kind === "tool")!;
    expect(row.appToolName).toBe(nativeName);
    const entry = snapshot({ toolName: gatewayName, nativeToolName: nativeName });
    expect(pickToolCallProgress([entry], row, "run-1")).toBe(entry);
    // Any other call, or a wrapper without a name, carries none.
    expect(wrappedAppToolName("Bash", { name: nativeName })).toBeUndefined();
    expect(wrappedAppToolName("mcp__paperclip__paperclip_call_assigned_tool", { name: nativeName })).toBe(nativeName);
    expect(wrappedAppToolName("paperclip_call_assigned_tool", { arguments: {} })).toBeUndefined();
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
    expect([...store.entries()]).toEqual([]);
    for (let i = 0; i < 80; i++) store.put(snapshot({ invocationId: `call-${i + 2}` }));
    expect([...store.entries()]).toHaveLength(50);
  });

  it("a fresh read ends calls that finished unseen, and never drops a call it does not list", () => {
    const store = new ToolCallProgressStore();
    store.put(snapshot({ invocationId: "finished-while-hidden", updatedAt: "2026-11-13T10:00:05.000Z" }));
    store.put(snapshot({ invocationId: "not-saved-yet", updatedAt: "2026-11-13T10:00:06.000Z" }));
    // The read reports the finished call as done and does not list the other one yet.
    for (const entry of [snapshot({ invocationId: "finished-while-hidden", done: true, updatedAt: "2026-11-13T10:00:09.000Z" })]) store.put(entry);
    expect(pickToolCallProgress(store.entries(), tool(), "run-1")?.invocationId).toBe("not-saved-yet");
    expect([...store.entries()].map((entry) => entry.invocationId)).toEqual(["not-saved-yet"]);
  });

  it("keeps running calls when a read reports many finished ones", () => {
    const store = new ToolCallProgressStore();
    for (let i = 0; i < 50; i++) store.put(snapshot({ invocationId: `running-${i}` }));
    for (let i = 0; i < 50; i++) store.put(snapshot({ invocationId: `history-${i}`, done: true }));
    expect([...store.entries()]).toHaveLength(50);
    expect([...store.entries()].every((entry) => entry.invocationId.startsWith("running-") && !entry.done)).toBe(true);
  });

  it("a call's live end before a delayed read listing it as running keeps it ended", () => {
    const store = new ToolCallProgressStore();
    // Opened near the end: the live end arrives first, then the read made just before it.
    store.put(snapshot({ invocationId: "ending", done: true, updatedAt: "2026-11-13T10:00:10.000Z" }));
    store.put(snapshot({ invocationId: "ending", progress: 9, total: 10, updatedAt: "2026-11-13T10:00:09.000Z" }));
    expect([...store.entries()]).toEqual([]);
    expect(pickToolCallProgress(store.entries(), tool(), "run-1")).toBeNull();
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

  it("reads fresh saved progress when someone leaves the task and comes back mid-call", async () => {
    savedProgress.list.mockResolvedValue([snapshot({ progress: 1, message: "Step 1" })]);
    render(<TaskChatToolCard item={tool()} />);
    await vi.waitFor(async () => {
      await settle();
      expect(container.querySelector('[data-testid="task-chat-tool-progress-message"]')?.textContent).toBe("Step 1");
    });
    act(() => root.render(<QueryClientProvider client={queryClient}><div /></QueryClientProvider>));
    savedProgress.list.mockResolvedValue([snapshot({ progress: 4, message: "Step 4", updatedAt: "2026-11-13T10:00:09.000Z" })]);
    render(<TaskChatToolCard item={tool()} />);
    await vi.waitFor(async () => {
      await settle();
      expect(container.querySelector('[data-testid="task-chat-tool-progress-message"]')?.textContent).toBe("Step 4");
    });
    expect(savedProgress.list).toHaveBeenCalledTimes(2);
  });

  it("never asks for progress for a finished row", async () => {
    render(<TaskChatToolCard item={tool({ status: "completed" })} />);
    await settle();
    expect(savedProgress.list).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="task-chat-tool-progress"]')).toBeNull();
  });
});
