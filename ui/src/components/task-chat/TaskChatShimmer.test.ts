import { expect, it } from "vitest";
import { taskChatShimmerOwner, visibleTranscriptPlaceholder } from "./TaskChatShimmer";
import { THREAD_PREVIEW_CASES } from "../design-sandbox/task-thread-fixtures";
import { transcriptToTaskChatItems } from "./transcript-adapter";
import type { TaskChatItem } from "./task-chat-model";

const itemsFor = (id: string) => transcriptToTaskChatItems(THREAD_PREVIEW_CASES.find(item => item.id === id)!.build().entries, { runId: "shimmer-test", running: true });
it("hands off motion from startup to reasoning to the latest tool, then stops for final text", () => {
  expect(taskChatShimmerOwner([])).toBe("working");
  for (const [fixture, kind] of [["thinking", "thinking"], ["working", "tool"], ["tool-call", "tool"]]) {
    const items = itemsFor(fixture);
    const owner = items.find(item => item.id === taskChatShimmerOwner(items));
    expect(owner?.kind).toBe(kind);
  }
  expect(taskChatShimmerOwner(itemsFor("streaming-final"))).toBeNull();
  expect(taskChatShimmerOwner(itemsFor("permission-pending"))).toBeNull();
  expect(taskChatShimmerOwner(itemsFor("tool-completed"))).toBe("working");
});
it("never reanimates an earlier outstanding tool after the provider moves on", () => {
  const tools: TaskChatItem[] = [
    { id: "old", kind: "tool", name: "exec_command", status: "in_progress" },
    { id: "new", kind: "tool", name: "read_file", status: "in_progress" },
  ];
  expect(taskChatShimmerOwner(tools)).toBe("new");
  expect(taskChatShimmerOwner([...tools, { id: "reply", kind: "message", author: "agent", text: "Done", channel: "final", streaming: true }])).toBeNull();
});
it("omits preparation plumbing but preserves meaningful waiting, recovery and errors", () => {
  for (const message of ["Preparing the turn…", "Preparing the transcript...", "Waiting for transcript...", "Loading transcript", "run phase: prepare_turn (930ms)"]) {
    expect(visibleTranscriptPlaceholder(message)).toBeUndefined();
  }
  for (const message of ["Waiting to start…", "Waiting for permission…", "Live runner activity is temporarily unavailable. Retrying…", "Workspace setup failed before the agent started."]) {
    expect(visibleTranscriptPlaceholder(message)).toBe(message);
  }
});
