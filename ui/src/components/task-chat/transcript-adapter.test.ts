import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import {
  assembleThreadItems,
  attachSettledTurns,
  buildMergedTurnSummary,
  buildTurnSummary,
  coalesceSettledTurns,
  deriveRunStatusLabel,
  flattenSelfTalk,
  isNestableLiveChild,
  ISSUE_BRIEF_ITEM_ID,
  prependIssueBrief,
  settledRunChildren,
  toolDisplayName,
  transcriptToTaskChatItems,
  type SettledTurnMergeMeta,
  type ThreadBackboneEntry,
} from "./transcript-adapter";
import type { TaskChatItem, TaskChatTurnItem } from "./task-chat-model";

const TS = "2026-07-31T12:00:00.000Z";

function toolCall(name: string, input?: unknown): TranscriptEntry {
  return { kind: "tool_call", ts: TS, name, toolUseId: `tool-${name}`, input } as TranscriptEntry;
}

describe("deriveRunStatusLabel", () => {
  it("labels a tail tool_call with the taxonomy verb and tool · target detail", () => {
    const status = deriveRunStatusLabel([toolCall("Grep", { pattern: "ui/src/components" })]);
    expect(status.label).toBe("Grepping");
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

describe("transcriptToTaskChatItems native usage", () => {
  it("does not merge progress and final runner messages", () => {
    const items = transcriptToTaskChatItems([
      {
        kind: "assistant",
        ts: TS,
        text: "Checking files.",
        channel: "progress",
      },
      {
        kind: "assistant",
        ts: TS,
        text: "The change is ready.",
        channel: "final",
      },
    ], { runId: "native-run", running: true });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "Checking files.",
        channel: "progress",
        interstitial: true,
      }),
      expect.objectContaining({
        kind: "message",
        text: "The change is ready.",
        channel: "final",
        interstitial: false,
      }),
    ]);
  });

  it("renders runner usage without inventing a context-window size", () => {
    const items = transcriptToTaskChatItems([{
      kind: "result",
      ts: TS,
      text: "",
      inputTokens: 40,
      outputTokens: 10,
      cachedTokens: 5,
      costUsd: 0.02,
      subtype: "paperclip_runner_usage",
      isError: false,
      errors: [],
    }], { runId: "native-run", running: true });

    expect(items).toEqual([{
      id: "native-run:usage:0",
      kind: "usage",
      usage: {
        used: 55,
        size: 0,
        inputTokens: 40,
        outputTokens: 10,
        costUsd: 0.02,
      },
    }]);
  });

  it("renders cumulative-only runner session usage", () => {
    const items = transcriptToTaskChatItems([{
      kind: "result",
      ts: TS,
      text: "",
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "paperclip_runner_session_usage",
      isError: false,
      errors: [],
    }], { runId: "native-run", running: true });

    expect(items).toEqual([expect.objectContaining({
      kind: "usage",
      label: "Provider session total",
      detail: expect.stringContaining("cumulative usage"),
      usage: expect.objectContaining({ used: 100, inputTokens: 80, outputTokens: 20 }),
    })]);
  });

  it("does not change direct-adapter result presentation", () => {
    const items = transcriptToTaskChatItems([{
      kind: "result",
      ts: TS,
      text: "done",
      inputTokens: 40,
      outputTokens: 10,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "success",
      isError: false,
      errors: [],
    }], { runId: "legacy-run", running: true });
    expect(items).toEqual([]);
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

  it("keeps session-cumulative runner usage out of run summaries", () => {
    const runUsage = {
      kind: "result",
      ts: TS,
      subtype: "paperclip_runner_usage",
      inputTokens: 40,
      outputTokens: 10,
    } as TranscriptEntry;
    const sessionUsage = {
      kind: "result",
      ts: TS,
      subtype: "paperclip_runner_session_usage",
      inputTokens: 800,
      outputTokens: 200,
    } as TranscriptEntry;

    expect(buildTurnSummary([runUsage, sessionUsage]).tokensLabel).toBe(
      "50 tokens",
    );
    expect(
      buildMergedTurnSummary([
        { entries: [runUsage] },
        { entries: [sessionUsage] },
      ]).tokensLabel,
    ).toBe("50 tokens");
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

describe("isNestableLiveChild", () => {
  const items: TaskChatItem[] = [
    { id: "t", kind: "tool", name: "Read", status: "completed" },
    { id: "th", kind: "thinking", lines: ["hm"] },
    { id: "u", kind: "usage", usage: { used: 1, size: 2 } },
    { id: "m", kind: "message", author: "agent", text: "finished self-talk", interstitial: true },
    { id: "mk", kind: "marker", variant: "session_start", label: "Session started" },
    { id: "s", kind: "status", status: "running", label: "Running" },
    { id: "i", kind: "interaction", interaction: {} as never },
  ];

  it("nests only tool and usage rows inside the live parent row (PAP-361)", () => {
    expect(items.filter(isNestableLiveChild).map((it) => it.kind)).toEqual([
      "tool",
      "usage",
    ]);
  });

  it("keeps messages, thinking, markers, statuses and interactions out", () => {
    // Interstitial updates — finished or streaming — never nest: they are
    // ephemeral, living on the live line only while streaming. Thinking never
    // nests either (its live signal is the pill's "Thinking…" state), and the
    // final reply keeps its bubble.
    for (const kind of ["message", "thinking", "marker", "status", "interaction"]) {
      const item = items.find((it) => it.kind === kind)!;
      expect(isNestableLiveChild(item)).toBe(false);
    }
    expect(
      isNestableLiveChild({
        id: "m2",
        kind: "message",
        author: "agent",
        text: "typing…",
        interstitial: true,
        streaming: true,
      }),
    ).toBe(false);
    expect(
      isNestableLiveChild({ id: "m3", kind: "message", author: "agent", text: "Final reply." }),
    ).toBe(false);
  });
});

describe("interstitial self-talk classification (PAP-355)", () => {
  const stream: TranscriptEntry[] = [
    { kind: "assistant", ts: TS, text: "Let me check the adapter." } as TranscriptEntry,
    toolCall("Read", { file_path: "a.ts" }),
    { kind: "assistant", ts: "2026-07-31T12:00:05.000Z", text: "Found it — fixing now." } as TranscriptEntry,
  ];

  it("tags agent messages streamed inside a live run turn as interstitial", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: true }).filter(
      (it) => it.kind === "message",
    );
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
    }
  });

  it("marks only the message still open at the tail as streaming", () => {
    const items = transcriptToTaskChatItems(stream, { runId: "run-1", running: true });
    const messages = items.filter((it) => it.kind === "message");
    if (messages[0].kind !== "message" || messages[1].kind !== "message") return;
    // The first message was closed by the tool call — finished self-talk.
    expect(messages[0].streaming).toBe(false);
    expect(messages[1].streaming).toBe(true);
  });

  it("marks no message streaming when the tail is a tool call", () => {
    const items = transcriptToTaskChatItems(
      [...stream, toolCall("Bash", { command: "pnpm test" })],
      { runId: "run-1", running: true },
    );
    for (const m of items) {
      if (m.kind === "message") expect(m.streaming).toBe(false);
    }
  });

  it("tags settled-history messages interstitial too, so live and history agree", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: false }).filter(
      (it) => it.kind === "message",
    );
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
      expect(m.streaming).toBe(false);
    }
  });

  it("stamps atMs from the first streamed chunk", () => {
    const messages = transcriptToTaskChatItems(stream, { runId: "run-1", running: false }).filter(
      (it) => it.kind === "message",
    );
    if (messages[0].kind !== "message" || messages[1].kind !== "message") return;
    expect(messages[0].atMs).toBe(Date.parse(TS));
    expect(messages[1].atMs).toBe(Date.parse("2026-07-31T12:00:05.000Z"));
  });
});

describe("flattenSelfTalk", () => {
  it("strips markdown markers to one plain line", () => {
    expect(
      flattenSelfTalk("## Plan\n\nI'll **extend** the `ipRateLimit` helper:\n- read it\n- patch it"),
    ).toBe("Plan I'll extend the ipRateLimit helper: read it patch it");
  });

  it("keeps link text, drops the url, and is stream-safe on unclosed markers", () => {
    expect(flattenSelfTalk("see [the docs](https://x) for **bol")).toBe("see the docs for bol");
    expect(flattenSelfTalk("```ts\nconst a = 1;")).toBe("const a = 1;");
  });
});

describe("deriveRunStatusLabel streaming interstitial text (PAP-361)", () => {
  it("returns the trailing message's flattened text with the Responding label", () => {
    const status = deriveRunStatusLabel([
      { kind: "assistant", ts: TS, text: "I'll **extend** " } as TranscriptEntry,
      { kind: "assistant", ts: TS, text: "the `ipRateLimit` helper." } as TranscriptEntry,
    ]);
    expect(status.label).toBe("Responding");
    expect(status.selfTalk).toBe("I'll extend the ipRateLimit helper.");
    expect(status.detail).toBeUndefined();
  });

  it("only accumulates the trailing message, not one closed by a tool call", () => {
    const status = deriveRunStatusLabel([
      { kind: "assistant", ts: TS, text: "Earlier note." } as TranscriptEntry,
      toolCall("Read", { file_path: "a.ts" }),
      { kind: "assistant", ts: TS, text: "Fresh line." } as TranscriptEntry,
    ]);
    expect(status.selfTalk).toBe("Fresh line.");
  });

  it("carries no selfTalk for tool or thinking tails", () => {
    expect(deriveRunStatusLabel([toolCall("Read")]).selfTalk).toBeUndefined();
    expect(
      deriveRunStatusLabel([{ kind: "thinking", ts: TS, text: "hm" } as TranscriptEntry]).selfTalk,
    ).toBeUndefined();
    expect(deriveRunStatusLabel([]).selfTalk).toBeUndefined();
  });
});

describe("settledRunChildren (PAP-361)", () => {
  const transcript: TranscriptEntry[] = [
    { kind: "assistant", ts: TS, text: "Checking the adapter first." } as TranscriptEntry,
    toolCall("Read", { file_path: "a.ts" }),
    { kind: "thinking", ts: TS, text: "wire it in" } as TranscriptEntry,
    toolCall("Edit", { file_path: "a.ts" }),
    { kind: "assistant", ts: TS, text: "Done — the limiter is wired in." } as TranscriptEntry,
  ];
  const parsed = transcriptToTaskChatItems(transcript, { runId: "run-1", running: false });

  it("groups tools under the historical assistant boundary and excludes the final reply", () => {
    const children = settledRunChildren(parsed);
    expect(children.map((c) => c.kind)).toEqual(["activity_phase"]);
    const phase = children[0];
    expect(phase.kind === "activity_phase" && phase.interstitial?.text).toBe("Checking the adapter first.");
    expect(phase.kind === "activity_phase" && phase.items.map((item) => item.kind)).toEqual(["tool", "tool"]);
  });

  it("excludes an explicit final reply when runner usage follows it", () => {
    const finalThenUsage = transcriptToTaskChatItems([
      {
        kind: "assistant",
        ts: TS,
        text: "Done — the limiter is wired in.",
        channel: "final",
      } as TranscriptEntry,
      {
        kind: "result",
        ts: TS,
        text: "",
        inputTokens: 40,
        outputTokens: 10,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "paperclip_runner_usage",
        isError: false,
        errors: [],
      } as TranscriptEntry,
    ], { runId: "native-run", running: false });

    const children = settledRunChildren(finalThenUsage);
    expect(children).toHaveLength(1);
    const phase = children[0];
    expect(phase.kind).toBe("activity_phase");
    if (phase.kind !== "activity_phase") return;
    expect(phase.interstitial).toBeUndefined();
    expect(phase.items.map((item) => item.kind)).toEqual(["usage"]);
  });

  it("matches the folded summary's tool count exactly (row-count parity)", () => {
    const children = settledRunChildren(parsed);
    const summary = buildTurnSummary(transcript);
    const phaseToolCount = children.reduce(
      (count, child) => count + (child.kind === "activity_phase" ? child.items.filter((item) => item.kind === "tool").length : 0),
      0,
    );
    expect(phaseToolCount).toBe(summary.toolCount);
  });

  it("creates a stable opening phase for calls before the first interstitial", () => {
    const opening = transcriptToTaskChatItems([
      toolCall("Read", { file_path: "a.ts" }),
      { kind: "assistant", ts: TS, text: "Now editing." } as TranscriptEntry,
      toolCall("Edit", { file_path: "a.ts" }),
      { kind: "assistant", ts: TS, text: "Done." } as TranscriptEntry,
    ], { runId: "run-opening", running: false });
    const phases = settledRunChildren(opening);
    expect(phases).toHaveLength(2);
    expect(phases[0].id).toContain(":phase:opening");
    expect(phases[1].kind === "activity_phase" && phases[1].summary).toBe("Edited 1 file");
  });
});

describe("buildMergedTurnSummary (PAP-362)", () => {
  const runA: TranscriptEntry[] = [
    { kind: "tool_call", ts: "2026-07-31T12:00:00.000Z", name: "Read", toolUseId: "a-1" } as TranscriptEntry,
    { kind: "tool_call", ts: "2026-07-31T12:00:05.000Z", name: "Edit", toolUseId: "a-2" } as TranscriptEntry,
    { kind: "diff", ts: "2026-07-31T12:00:06.000Z", changeType: "add", text: "+x" } as TranscriptEntry,
    { kind: "result", ts: "2026-07-31T12:00:10.000Z", inputTokens: 500, outputTokens: 300 } as TranscriptEntry,
  ];
  const runB: TranscriptEntry[] = [
    { kind: "tool_call", ts: "2026-07-31T12:30:00.000Z", name: "Bash", toolUseId: "b-1" } as TranscriptEntry,
    { kind: "result", ts: "2026-07-31T12:30:05.000Z", inputTokens: 300, outputTokens: 100 } as TranscriptEntry,
  ];

  it("sums tool count, diffs, tokens, and duration across runs", () => {
    const summary = buildMergedTurnSummary([
      { entries: runA, durationMs: 30_000 },
      { entries: runB, durationMs: 15_000 },
    ]);
    expect(summary.toolCount).toBe(3);
    expect(summary.added).toBe(1);
    expect(summary.tokensLabel).toBe("1.2k tokens");
    expect(summary.durationLabel).toBe("45s");
    expect(summary.failed).toBeUndefined();
  });

  it("sums per-run ts spans — never the idle gap between runs", () => {
    // runA spans 10s, runB spans 5s, the gap between them is ~30min.
    const summary = buildMergedTurnSummary([{ entries: runA }, { entries: runB }]);
    expect(summary.durationLabel).toBe("15s");
  });

  it("marks the merged turn failed when any run failed", () => {
    const summary = buildMergedTurnSummary([
      { entries: runA, durationMs: 1000 },
      { entries: runB, durationMs: 1000, failed: true },
    ]);
    expect(summary.failed).toBe(true);
  });
});

describe("coalesceSettledTurns (PAP-362)", () => {
  const runA: TranscriptEntry[] = [
    { kind: "tool_call", ts: TS, name: "Read", toolUseId: "a-1" } as TranscriptEntry,
    { kind: "tool_call", ts: TS, name: "Edit", toolUseId: "a-2" } as TranscriptEntry,
  ];
  const runB: TranscriptEntry[] = [
    { kind: "tool_call", ts: TS, name: "Bash", toolUseId: "b-1" } as TranscriptEntry,
  ];

  function agentBubble(id: string): TaskChatItem {
    return { id, kind: "message", author: "agent", authorName: "CEO", text: "Done." };
  }
  function turn(id: string, entries: TranscriptEntry[], durationMs: number): TaskChatItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: entries.map((e, i) => ({
        id: `${id}:tool:${i}`,
        kind: "tool" as const,
        name: (e as { name: string }).name,
        status: "completed" as const,
      })),
      summary: buildTurnSummary(entries, { durationMs }),
    };
  }
  const metaById = new Map<string, SettledTurnMergeMeta>([
    ["run-a:turn", { agentKey: "agent-1", agentName: "CEO", parts: [{ entries: runA, durationMs: 30_000 }] }],
    ["run-b:turn", { agentKey: "agent-1", agentName: "CEO", parts: [{ entries: runB, durationMs: 15_000 }] }],
  ]);

  it("merges two back-to-back runs into ONE Worked row summing tools and duration", () => {
    // Two terminal runs, same agent, consecutive comments, no user message
    // between → the merged turn sits below the LAST bubble.
    const items: TaskChatItem[] = [
      agentBubble("msg-a"),
      turn("run-a:turn", runA, 30_000),
      agentBubble("msg-b"),
      turn("run-b:turn", runB, 15_000),
    ];
    const out = coalesceSettledTurns(items, metaById);
    expect(out.map((i) => i.kind)).toEqual(["message", "message", "turn"]);
    const merged = out[2] as Extract<TaskChatItem, { kind: "turn" }>;
    expect(merged.id).toBe("run-a:turn"); // stable: keeps the first run's id
    expect(merged.summary.toolCount).toBe(3);
    expect(merged.summary.durationLabel).toBe("45s");
    expect(merged.items.map((c) => c.id)).toEqual([
      "run-a:turn:tool:0",
      "run-a:turn:tool:1",
      "run-b:turn:tool:0",
    ]);
  });

  it("keeps two rows when a user message sits between the runs", () => {
    const items: TaskChatItem[] = [
      agentBubble("msg-a"),
      turn("run-a:turn", runA, 30_000),
      { id: "msg-u", kind: "message", author: "human", text: "also do X" },
      agentBubble("msg-b"),
      turn("run-b:turn", runB, 15_000),
    ];
    const out = coalesceSettledTurns(items, metaById);
    expect(out.filter((i) => i.kind === "turn")).toHaveLength(2);
    expect(out.map((i) => i.id)).toEqual(["msg-a", "run-a:turn", "msg-u", "msg-b", "run-b:turn"]);
  });

  it("does not merge across an interaction or into another agent's turn", () => {
    const withInteraction: TaskChatItem[] = [
      turn("run-a:turn", runA, 30_000),
      { id: "int-1", kind: "interaction", interaction: {} } as TaskChatItem,
      turn("run-b:turn", runB, 15_000),
    ];
    expect(coalesceSettledTurns(withInteraction, metaById).filter((i) => i.kind === "turn")).toHaveLength(2);

    const otherAgent = new Map(metaById);
    otherAgent.set("run-b:turn", { agentKey: "agent-2", agentName: "QA", parts: [{ entries: runB }] });
    const sameShape: TaskChatItem[] = [turn("run-a:turn", runA, 30_000), turn("run-b:turn", runB, 15_000)];
    expect(coalesceSettledTurns(sameShape, otherAgent).filter((i) => i.kind === "turn")).toHaveLength(2);
  });

  it("never merges the live (unsettled) turn and preserves animateFold", () => {
    const live: TaskChatItem = { id: "run-b:turn", kind: "turn", settled: false, items: [], summary: buildTurnSummary([]) };
    const out = coalesceSettledTurns([turn("run-a:turn", runA, 30_000), live], metaById);
    expect(out).toHaveLength(2);

    const seenLive = { ...turn("run-b:turn", runB, 15_000), animateFold: true } as TaskChatItem;
    const merged = coalesceSettledTurns([turn("run-a:turn", runA, 30_000), seenLive], metaById);
    expect(merged).toHaveLength(1);
    expect((merged[0] as Extract<TaskChatItem, { kind: "turn" }>).animateFold).toBe(true);
  });
});

describe("attachSettledTurns (round 9)", () => {
  const runA: TranscriptEntry[] = [
    { kind: "tool_call", ts: TS, name: "Read", toolUseId: "a-1" } as TranscriptEntry,
  ];

  function agentBubble(id: string, authorName = "CEO"): TaskChatItem {
    return { id, kind: "message", author: "agent", authorName, text: "Done." };
  }
  function settledTurn(id: string): TaskChatItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [{ id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" }],
      summary: buildTurnSummary(runA, { durationMs: 30_000 }),
    };
  }
  const metaById = new Map<string, SettledTurnMergeMeta>([
    ["run-a:turn", { agentKey: "agent-1", agentName: "CEO", parts: [{ entries: runA, durationMs: 30_000 }] }],
  ]);

  it("folds a settled turn into the agent reply bubble directly above it", () => {
    const out = attachSettledTurns([agentBubble("msg-a"), settledTurn("run-a:turn")], metaById);
    expect(out).toHaveLength(1);
    const bubble = out[0] as Extract<TaskChatItem, { kind: "message" }>;
    expect(bubble.id).toBe("msg-a");
    expect(bubble.attachedTurn?.id).toBe("run-a:turn");
    expect(bubble.attachedTurn?.summary.durationLabel).toBe("30s");
  });

  it("keeps the standalone row when the preceding item is not that agent's bubble", () => {
    // Human message directly above.
    const afterHuman = attachSettledTurns(
      [{ id: "msg-u", kind: "message", author: "human", text: "hi" }, settledTurn("run-a:turn")],
      metaById,
    );
    expect(afterHuman.map((i) => i.kind)).toEqual(["message", "turn"]);
    // Another agent's bubble above.
    const otherAgent = attachSettledTurns([agentBubble("msg-q", "QA"), settledTurn("run-a:turn")], metaById);
    expect(otherAgent.map((i) => i.kind)).toEqual(["message", "turn"]);
    // No meta (unknown identity) → conservative standalone fallback.
    const noMeta = attachSettledTurns([agentBubble("msg-a"), settledTurn("run-x:turn")], metaById);
    expect(noMeta.map((i) => i.kind)).toEqual(["message", "turn"]);
    // Nothing above at all.
    const first = attachSettledTurns([settledTurn("run-a:turn")], metaById);
    expect(first.map((i) => i.kind)).toEqual(["turn"]);
  });

  it("never attaches the live (unsettled) turn and attaches at most one turn per bubble", () => {
    const live: TaskChatItem = {
      id: "run-live:turn",
      kind: "turn",
      settled: false,
      items: [],
      summary: buildTurnSummary([]),
    };
    const out = attachSettledTurns([agentBubble("msg-a"), live], metaById);
    expect(out.map((i) => i.kind)).toEqual(["message", "turn"]);

    // A second settled turn behind an already-attached bubble stays standalone
    // (coalesceSettledTurns runs first, so same-agent turns arrive pre-merged).
    const twice = attachSettledTurns(
      [agentBubble("msg-a"), settledTurn("run-a:turn"), settledTurn("run-a:turn")],
      metaById,
    );
    expect(twice.map((i) => i.kind)).toEqual(["message", "turn"]);
    expect((twice[0] as Extract<TaskChatItem, { kind: "message" }>).attachedTurn?.id).toBe("run-a:turn");
  });
});

describe("assembleThreadItems (PAP-367)", () => {
  function entry(id: string, ms: number, item?: Partial<TaskChatItem>): ThreadBackboneEntry {
    return {
      ms,
      id,
      item: { id, kind: "message", author: "human", text: `msg ${id}`, ...item } as TaskChatItem,
    };
  }
  function settledTurn(id: string): TaskChatTurnItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [{ id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" }],
      summary: buildTurnSummary([toolCall("Read")], { durationMs: 34_000 }),
    };
  }
  const noAnchors = new Map<string, TaskChatTurnItem[]>();

  it("inserts a comment-less settled turn chronologically at its run's start time", () => {
    const backbone = [entry("u1", 1_000), entry("a1", 2_000, { author: "agent", authorName: "CEO" }), entry("u2", 3_000)];
    const out = assembleThreadItems(backbone, noAnchors, [{ turn: settledTurn("run-x:turn"), startMs: 2_500 }]);
    expect(out.map((i) => i.id)).toEqual(["u1", "a1", "run-x:turn", "u2"]);
  });

  it("does not append a comment-less turn after the newest user message (the P11 bug)", () => {
    // The screenshot bug: an OLD stopped run (start 1_500) re-pinning its
    // "Worked · 34s" row under every NEW user bubble (3_000).
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    const out = assembleThreadItems(backbone, noAnchors, [{ turn: settledTurn("run-x:turn"), startMs: 1_500 }]);
    expect(out.map((i) => i.id)).toEqual(["u1", "run-x:turn", "u2"]);
    expect(out[out.length - 1].id).toBe("u2");
  });

  it("keeps anchored turns directly after their run's reply comment", () => {
    const backbone = [entry("u1", 1_000), entry("a1", 2_000, { author: "agent", authorName: "CEO" }), entry("u2", 3_000)];
    const anchors = new Map([["a1", [settledTurn("run-a:turn")]]]);
    const out = assembleThreadItems(backbone, anchors, []);
    expect(out.map((i) => i.id)).toEqual(["u1", "a1", "run-a:turn", "u2"]);
  });

  it("keeps the tail slot for a turn with unknown start, and puts ties after the entry", () => {
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    // Unknown start (no linked meta yet — just-settled run): Infinity → tail.
    const tail = assembleThreadItems(backbone, noAnchors, [
      { turn: settledTurn("run-x:turn"), startMs: Number.POSITIVE_INFINITY },
    ]);
    expect(tail.map((i) => i.id)).toEqual(["u1", "u2", "run-x:turn"]);
    // Tie with the trigger comment: comment renders first.
    const tie = assembleThreadItems(backbone, noAnchors, [{ turn: settledTurn("run-y:turn"), startMs: 1_000 }]);
    expect(tie.map((i) => i.id)).toEqual(["u1", "run-y:turn", "u2"]);
  });

  it("chronological insertion after a user message stays a standalone row through coalesce+attach", () => {
    // Interplay guard: the inserted turn sits below a HUMAN bubble, so the
    // later passes must neither merge it into anything nor attach it.
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    const metaById = new Map<string, SettledTurnMergeMeta>([
      ["run-x:turn", { agentKey: "agent-1", agentName: "CEO", parts: [{ entries: [toolCall("Read")], durationMs: 34_000 }] }],
    ]);
    const assembled = assembleThreadItems(backbone, noAnchors, [{ turn: settledTurn("run-x:turn"), startMs: 1_500 }]);
    const out = attachSettledTurns(coalesceSettledTurns(assembled, metaById), metaById);
    expect(out.map((i) => i.id)).toEqual(["u1", "run-x:turn", "u2"]);
    expect(out.every((i) => i.kind !== "message" || (i as Extract<TaskChatItem, { kind: "message" }>).attachedTurn == null)).toBe(true);
  });
});

describe("prependIssueBrief (PAP-375)", () => {
  function entry(id: string, ms: number): ThreadBackboneEntry {
    return {
      ms,
      id,
      item: { id, kind: "message", author: "human", text: `msg ${id}` } as TaskChatItem,
    };
  }
  function settledTurn(id: string): TaskChatTurnItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [{ id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" }],
      summary: buildTurnSummary([toolCall("Read")], { durationMs: 34_000 }),
    };
  }

  it("keeps the description bubble above an unanchored turn that predates every backbone entry (F15)", () => {
    // A stopped run whose startMs (0) is EARLIER than the oldest comment: it
    // sorts to the very top of the assembled thread — the brief must still
    // render above it, because the prepend runs after assembly.
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    const assembled = assembleThreadItems(backbone, new Map(), [
      { turn: settledTurn("run-x:turn"), startMs: 0 },
    ]);
    const out = prependIssueBrief(assembled, true);
    expect(out.map((i) => i.id)).toEqual([ISSUE_BRIEF_ITEM_ID, "run-x:turn", "u1", "u2"]);
    expect(out[0].kind).toBe("brief");
  });

  it("is the first item of an otherwise empty thread, and a no-op without a brief", () => {
    expect(prependIssueBrief([], true).map((i) => i.kind)).toEqual(["brief"]);
    const items = [entry("u1", 1_000).item];
    expect(prependIssueBrief(items, false)).toBe(items);
  });
});
