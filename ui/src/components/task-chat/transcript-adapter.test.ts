import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import {
  buildTurnSummary,
  deriveRunStatusLabel,
  toolDisplayName,
  transcriptToTaskChatItems,
} from "./transcript-adapter";

const TS = "2026-07-31T12:00:00.000Z";

function toolCall(name: string, input?: unknown): TranscriptEntry {
  return { kind: "tool_call", ts: TS, name, toolUseId: `tool-${name}`, input } as TranscriptEntry;
}

describe("deriveRunStatusLabel", () => {
  it("labels a tail tool_call with the taxonomy verb and tool · target detail", () => {
    const status = deriveRunStatusLabel([toolCall("Grep", { pattern: "ui/src/components" })]);
    expect(status.label).toBe("Searching");
    expect(status.detail).toBe("Grep · ui/src/components");
    expect(status.toolName).toBe("Grep");
  });

  it("uses family verbs per tool", () => {
    expect(deriveRunStatusLabel([toolCall("Bash", { command: "pnpm test" })]).label).toBe(
      "Running a command",
    );
    expect(deriveRunStatusLabel([toolCall("Edit", { file_path: "a.ts" })]).label).toBe(
      "Editing files",
    );
    expect(deriveRunStatusLabel([toolCall("mcp__linear__search_issues")]).label).toBe(
      "Using Search_issues",
    );
  });

  it("omits the target from the detail when the input has none", () => {
    const status = deriveRunStatusLabel([toolCall("Read")]);
    expect(status.detail).toBe("Read");
  });

  it("keeps Thinking / Responding / Running fallbacks", () => {
    expect(
      deriveRunStatusLabel([{ kind: "thinking", ts: TS, text: "hmm" } as TranscriptEntry]).label,
    ).toBe("Thinking");
    expect(
      deriveRunStatusLabel([{ kind: "assistant", ts: TS, text: "done" } as TranscriptEntry]).label,
    ).toBe("Responding");
    expect(deriveRunStatusLabel([]).label).toBe("Running");
    // A settled tool (tool_result at the tail) means "between tools" → Running.
    expect(
      deriveRunStatusLabel([
        toolCall("Bash", { command: "ls" }),
        { kind: "tool_result", ts: TS, toolUseId: "tool-Bash", content: "ok" } as TranscriptEntry,
      ]).label,
    ).toBe("Running");
  });
});

describe("toolDisplayName", () => {
  it("collapses mcp names the same way the taxonomy does", () => {
    expect(toolDisplayName("mcp__linear-server__search_issues")).toBe("Search_issues");
    expect(toolDisplayName("bash")).toBe("Bash");
    expect(toolDisplayName("")).toBe("Tool");
    expect(toolDisplayName("tool")).toBe("Tool");
  });

  it("maps acpx placeholder names to the generic Tool label", () => {
    expect(toolDisplayName("tool call")).toBe("Tool");
    expect(toolDisplayName("tool call (completed)")).toBe("Tool");
    expect(toolDisplayName("acp_tool")).toBe("Tool");
  });
});

describe("transcriptToTaskChatItems tool_call updates", () => {
  const opts = { runId: "run-1", running: false };

  function update(toolUseId: string, status: string): TranscriptEntry {
    // Mirrors what a persisted acpx tool_call_update line parses to: the
    // literal placeholder name plus a synthesized { text, status } input.
    return {
      kind: "tool_call",
      ts: TS,
      name: "tool call",
      toolUseId,
      input: { text: `tool call (${status})`, status },
    } as TranscriptEntry;
  }

  it("keeps the initial real name and target when a generic update arrives", () => {
    const items = transcriptToTaskChatItems(
      [
        toolCall("Terminal", { command: "pnpm test" }),
        update("tool-Terminal", "completed"),
        {
          kind: "tool_result",
          ts: TS,
          toolUseId: "tool-Terminal",
          toolName: "tool call",
          content: "ok",
        } as TranscriptEntry,
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    const tool = items[0];
    expect(tool.kind).toBe("tool");
    if (tool.kind !== "tool") return;
    expect(tool.name).toBe("Terminal");
    expect(tool.rawName).toBe("Terminal");
    expect(tool.target).toBe("pnpm test");
    expect(tool.status).toBe("completed");
  });

  it("keeps identity on retitle and uses the invocation as the target", () => {
    // Real stored sequence: "Terminal" (pending) → retitle to the command →
    // generic "tool call" completion updates.
    const items = transcriptToTaskChatItems(
      [
        { kind: "tool_call", ts: TS, name: "Terminal", toolUseId: "tc-2" } as TranscriptEntry,
        { kind: "tool_call", ts: TS, name: "ls -la", toolUseId: "tc-2" } as TranscriptEntry,
        update("tc-2", "completed"),
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].name).toBe("Terminal");
    expect(items[0].rawName).toBe("Terminal");
    expect(items[0].target).toBe("ls -la");
  });

  it("never renders the synthesized { text, status } input as a target", () => {
    const items = transcriptToTaskChatItems([update("tc-orphan", "pending")], opts);
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].target).toBeUndefined();
  });

  it("upgrades a generic-named call when a later entry carries the real name", () => {
    const items = transcriptToTaskChatItems(
      [
        { kind: "tool_call", ts: TS, name: "tool call", toolUseId: "tc-1" } as TranscriptEntry,
        { kind: "tool_call", ts: TS, name: "Read", toolUseId: "tc-1" } as TranscriptEntry,
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].name).toBe("Read");
  });
});

describe("buildTurnSummary tool counting", () => {
  function statusEntry(toolUseId: string | undefined, status: string): TranscriptEntry {
    return {
      kind: "tool_call",
      ts: TS,
      name: "Bash",
      toolUseId,
      input: { text: `tool call (${status})`, status },
    } as TranscriptEntry;
  }

  it("counts unique tool calls, not per-status transcript entries", () => {
    // 4 real calls × 4 status changes each = 16 entries; the summary must
    // match the 4 rows the expanded list renders.
    const entries = ["tc-1", "tc-2", "tc-3", "tc-4"].flatMap((id) =>
      ["pending", "in_progress", "in_progress", "completed"].map((status) =>
        statusEntry(id, status),
      ),
    );
    expect(entries).toHaveLength(16);
    expect(buildTurnSummary(entries).toolCount).toBe(4);
  });

  it("counts id-less legacy entries once each", () => {
    const entries = [
      statusEntry(undefined, "completed"),
      statusEntry(undefined, "completed"),
      toolCall("Read"),
    ];
    expect(buildTurnSummary(entries).toolCount).toBe(3);
  });
});

describe("deriveRunStatusLabel with generic tail updates", () => {
  it("recovers the real tool name from the call's initial entry", () => {
    const status = deriveRunStatusLabel([
      toolCall("Terminal", { command: "ls -la" }),
      {
        kind: "tool_call",
        ts: TS,
        name: "tool call",
        toolUseId: "tool-Terminal",
      } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Running a command");
    expect(status.toolName).toBe("Terminal");
  });

  it("treats a tail retitle as the invocation, not the identity", () => {
    const status = deriveRunStatusLabel([
      { kind: "tool_call", ts: TS, name: "Terminal", toolUseId: "tc-3" } as TranscriptEntry,
      { kind: "tool_call", ts: TS, name: "pnpm test", toolUseId: "tc-3" } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Running a command");
    expect(status.toolName).toBe("Terminal");
    expect(status.detail).toBe("Terminal · pnpm test");
  });
});
