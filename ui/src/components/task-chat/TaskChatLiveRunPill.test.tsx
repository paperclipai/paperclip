// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../adapters";
import { TaskChatLiveRunPill, toolCountSummaryFromEntries } from "./TaskChatLiveRunPill";

function toolCall(overrides: Partial<Extract<TranscriptEntry, { kind: "tool_call" }>>): TranscriptEntry {
  return { kind: "tool_call", ts: "2026-08-08T00:00:00.000Z", name: "read_file", input: {}, ...overrides };
}

describe("toolCountSummaryFromEntries", () => {
  it("returns null when there are no tool calls", () => {
    expect(toolCountSummaryFromEntries([])).toBeNull();
    expect(
      toolCountSummaryFromEntries([{ kind: "assistant", ts: "t", text: "hi" } as TranscriptEntry]),
    ).toBeNull();
  });

  it("counts commands and other tools separately with pluralization", () => {
    const entries: TranscriptEntry[] = [
      toolCall({ name: "bash", input: { command: "ls" }, toolUseId: "c1" }),
      toolCall({ name: "command_execution", input: { command: "pwd" }, toolUseId: "c2" }),
      toolCall({ name: "read_file", input: { path: "a.ts" }, toolUseId: "t1" }),
    ];
    expect(toolCountSummaryFromEntries(entries)).toBe("ran 2 commands, called 1 tool");
  });

  it("dedupes re-emitted tool_calls that share a toolUseId", () => {
    const entries: TranscriptEntry[] = [
      toolCall({ name: "read_file", input: {}, toolUseId: "t1" }),
      toolCall({ name: "read_file", input: { path: "a.ts" }, toolUseId: "t1" }),
      toolCall({ name: "read_file", input: { path: "a.ts" }, toolUseId: "t1" }),
    ];
    expect(toolCountSummaryFromEntries(entries)).toBe("called 1 tool");
  });
});

describe("TaskChatLiveRunPill", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shimmers 'Working' with elapsed + tool summary while streaming", () => {
    const startedAtMs = Date.now() - 65_000; // ~1 minute ago
    act(() => {
      root.render(
        <TaskChatLiveRunPill
          status="running"
          startedAtMs={startedAtMs}
          toolSummary="called 3 tools"
        />,
      );
    });
    const pill = container.querySelector('[data-testid="task-chat-live-run-pill"]');
    expect(pill).not.toBeNull();
    const shimmer = container.querySelector(".shimmer-text");
    expect(shimmer?.textContent).toBe("Working");
    expect(pill?.textContent).toContain("for 1 minute");
    expect(pill?.textContent).toContain("called 3 tools");
  });

  it("settles to a static 'Worked' summary once the run is terminal", () => {
    const startedAtMs = 1_000;
    act(() => {
      root.render(
        <TaskChatLiveRunPill
          status="succeeded"
          startedAtMs={startedAtMs}
          finishedAtMs={startedAtMs + 42_000}
          toolSummary="ran 1 command"
        />,
      );
    });
    const pill = container.querySelector('[data-testid="task-chat-live-run-pill"]');
    expect(container.querySelector(".shimmer-text")).toBeNull();
    expect(pill?.textContent).toContain("Worked");
    expect(pill?.textContent).toContain("for 42 seconds");
    expect(pill?.textContent).toContain("ran 1 command");
  });
});
