// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { queryKeys } from "../../lib/queryKeys";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatToolCard } from "./TaskChatToolCard";
import { summarizeToolInput, transcriptToTaskChatItems } from "./transcript-adapter";
import type { TaskChatActivityPhaseItem, TaskChatToolItem } from "./task-chat-model";

const issuesApi = vi.hoisted(() => ({ get: vi.fn(), getCore: vi.fn() }));
vi.mock("../../api/issues", () => ({ issuesApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_UUID = "e3ecf9bc-099a-4b10-8169-9ce490a91e3d";
const TS = "2026-11-06T15:41:52.000Z";

/** The Codex walk's collapsed row: a task lookup whose only argument is the task UUID. */
function taskLookupRow(): TaskChatToolItem {
  const entries: TranscriptEntry[] = [
    { kind: "tool_call", ts: TS, toolUseId: "call-1", name: "Read", input: { taskId: TASK_UUID } },
    { kind: "tool_result", ts: TS, toolUseId: "call-1", content: "{}", isError: false },
  ];
  const items = transcriptToTaskChatItems(entries, { runId: "run-1", agentName: "Head baker", running: false });
  const tool = items.find((item): item is TaskChatToolItem => item.kind === "tool");
  if (!tool) throw new Error("expected a tool row");
  return tool;
}

const phase = (items: TaskChatToolItem[]): TaskChatActivityPhaseItem => ({
  id: "phase", kind: "activity_phase", items, active: false, summary: "",
});

describe("tool rows never show raw task UUIDs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  beforeEach(() => {
    issuesApi.get.mockReset();
    issuesApi.getCore.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  function renderRow(tool: TaskChatToolItem) {
    act(() => root.render(
      <QueryClientProvider client={queryClient}>
        <TaskChatRunnerActivityGroup defaultExpanded item={phase([tool])} />
      </QueryClientProvider>,
    ));
    return container.querySelector(`[data-activity-row="${tool.id}"]`);
  }

  it("keeps a UUID argument out of the summarized target", () => {
    expect(summarizeToolInput({ taskId: TASK_UUID }) ?? "").not.toContain(TASK_UUID);
    expect(summarizeToolInput({ issueId: TASK_UUID, includeComments: true }) ?? "").not.toContain(TASK_UUID);
  });

  it("shows the task identifier in place of its UUID", () => {
    queryClient.setQueryData(queryKeys.issues.detail(TASK_UUID), {
      id: TASK_UUID, identifier: "PIX-3", title: "Create printable cake menu and logo",
    });
    const row = renderRow(taskLookupRow());
    expect(row?.textContent).not.toContain(TASK_UUID);
    expect(row?.textContent).toContain("PIX-3");
  });

  it("reads only the core task view for an uncached task, on both tool-row surfaces", async () => {
    issuesApi.getCore.mockResolvedValue({ id: TASK_UUID, identifier: "PIX-3", title: "Create printable cake menu and logo" });
    const tool = taskLookupRow();
    act(() => root.render(
      <QueryClientProvider client={queryClient}>
        <TaskChatToolCard item={tool} />
      </QueryClientProvider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const card = container.querySelector('[data-testid="task-chat-tool-card"]');
    expect(card?.textContent).toContain("PIX-3");
    expect(card?.textContent).not.toContain(TASK_UUID);
    expect(issuesApi.getCore).toHaveBeenCalledTimes(1);
    expect(issuesApi.get).not.toHaveBeenCalled();
  });

  it("falls back to a plain word while the task cannot be resolved", async () => {
    issuesApi.getCore.mockRejectedValue(new Error("not found"));
    const row = renderRow(taskLookupRow());
    await act(async () => { await Promise.resolve(); });
    expect(row?.textContent).not.toContain(TASK_UUID);
    expect(row?.textContent).toContain("task");
  });
});
