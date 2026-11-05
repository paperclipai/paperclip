// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskChatRunnerActivityGroup, foldReadRuns, formatToolDuration } from "./TaskChatRunnerActivityGroup";
import type { TaskChatActivityPhaseItem, TaskChatToolItem } from "./task-chat-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tool = (id: string, fields: Partial<TaskChatToolItem>): TaskChatToolItem => ({
  id, kind: "tool", name: "Bash", rawName: "Bash", status: "completed", ...fields,
});
const read = (id: string, path: string) => tool(id, { name: "Read", rawName: "Read", operation: "read", target: path, exitCode: 0 });
const phase = (items: TaskChatToolItem[]): TaskChatActivityPhaseItem => ({ id: "phase", kind: "activity_phase", items, active: false, summary: "" });

describe("tool row grammar", () => {
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

  it("formats durations compactly", () => {
    expect([120, 1_840, 14_200, 123_000].map(formatToolDuration)).toEqual(["120ms", "1.8s", "14s", "2m 03s"]);
  });

  it("folds three or more consecutive reads and leaves shorter runs alone", () => {
    const rows = foldReadRuns([read("a", "a.ts"), read("b", "b.ts"), read("c", "c.ts"), tool("x", { target: "ls" }), read("d", "d.ts")]);
    expect(rows.map((row) => row.kind)).toEqual(["reads", "single", "single"]);
  });

  it("shows the command with its exit code and duration, hides exit 0 on reads, and explains a refusal", () => {
    act(() => root.render(
      <TaskChatRunnerActivityGroup
        defaultExpanded
        item={phase([
          read("r1", "src/a.ts"), read("r2", "src/b.ts"), read("r3", "src/c.ts"), read("r4", "src/d.ts"),
          tool("t1", { operation: "execute", target: "node --test", status: "failed", exitCode: 1, durationMs: 1_840 }),
          tool("t2", { operation: "execute", target: "rm -rf build", status: "failed", blockedReason: "Denied by rule" }),
        ])}
      />,
    ));
    const readRun = container.querySelector("[data-activity-read-run]");
    expect(readRun?.textContent).toContain("Read 4 files");
    expect(readRun?.textContent).toContain("a.ts, b.ts, c.ts +1");
    expect(readRun?.querySelector("[data-tool-exit-code]")).toBeNull();
    const command = container.querySelector('[data-activity-row="t1"]');
    expect(command?.textContent).toContain("$ node --test");
    expect(command?.querySelector("[data-tool-exit-code]")?.textContent).toBe("exit 1");
    expect(command?.querySelector("[data-tool-duration]")?.textContent).toBe("1.8s");
    const blocked = container.querySelector('[data-activity-row="t2"]');
    expect(blocked?.textContent).toContain("Blocked");
    expect(blocked?.querySelector("[data-tool-blocked-reason]")?.textContent).toBe("Denied by rule");
  });
});
