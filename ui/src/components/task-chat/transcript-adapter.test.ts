import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import {
  assembleThreadItems,
  attachSettledTurns,
  buildActivityPhases,
  buildTurnTimelineRows,
  buildMergedTurnSummary,
  buildTurnSummary,
  coalesceSettledTurns,
  deriveRunStatusLabel,
  embedPlanDocumentAtWriteBoundary,
  flattenSelfTalk,
  isNestableLiveChild,
  ISSUE_BRIEF_ITEM_ID,
  omitProgressRepeatedByResponseAcrossSegments,
  paperclipRunnerActivityItems,
  paperclipRunnerFinalResponse,
  paperclipRunnerHistoryItems,
  paperclipRunnerTimelineItems,
  prependIssueBrief,
  settledRunChildren,
  splitTranscriptAtAnchors,
  toolDisplayName,
  transcriptToTaskChatItems,
  type SettledTurnMergeMeta,
  type ThreadBackboneEntry,
} from "./transcript-adapter";
import type {
  TaskChatItem,
  TaskChatPlanDocumentItem,
  TaskChatTurnItem,
} from "./task-chat-model";
import { providerActivityPresentation } from "./task-chat-activity-presentation";

const TS = "2026-07-31T12:00:00.000Z";

describe("omitProgressRepeatedByResponseAcrossSegments", () => {
  const progress = (id: string, text: string): TaskChatItem => ({
    id,
    kind: "message",
    author: "agent",
    text,
    channel: "progress",
    interstitial: true,
  });

  it("removes only the final matching progress item across a steered run", () => {
    const first = progress("first", "Repeated answer");
    const second = progress("second", "Repeated answer");
    const segments = [[first], [second]];

    expect(
      omitProgressRepeatedByResponseAcrossSegments(segments, "Repeated answer"),
    ).toEqual([[first], []]);
  });

  it("preserves segment identity when there is no durable-response match", () => {
    const segments = [[progress("first", "Progress only")]];
    expect(
      omitProgressRepeatedByResponseAcrossSegments(segments, "Final answer"),
    ).toBe(segments);
  });
});

function toolCall(name: string, input?: unknown): TranscriptEntry {
  return {
    kind: "tool_call",
    ts: TS,
    name,
    toolUseId: `tool-${name}`,
    input,
  } as TranscriptEntry;
}

describe("splitTranscriptAtAnchors", () => {
  const assistant = (ts: string, text: string): TranscriptEntry =>
    ({ kind: "assistant", ts, channel: "progress", text }) as TranscriptEntry;

  it("assigns each boundary and its following entries to the next segment", () => {
    const entries = [
      assistant("2026-08-25T17:20:50.000Z", "before"),
      assistant("2026-08-25T17:21:44.541Z", "first boundary"),
      assistant("2026-08-25T17:22:10.000Z", "between"),
      assistant("2026-08-25T17:23:00.000Z", "second boundary"),
    ];
    const segments = splitTranscriptAtAnchors(
      entries,
      Date.parse("2026-08-25T17:20:45.369Z"),
      [
        Date.parse("2026-08-25T17:23:00.000Z"),
        Date.parse("2026-08-25T17:21:44.541Z"),
        Date.parse("2026-08-25T17:21:44.541Z"),
      ],
    );

    expect(segments.map((segment) => segment.entries.length)).toEqual([
      1, 2, 1,
    ]);
    expect(
      segments.map((segment) =>
        segment.entries.map((entry) =>
          entry.kind === "assistant" ? entry.text : entry.kind,
        ),
      ),
    ).toEqual([["before"], ["first boundary", "between"], ["second boundary"]]);
  });
});

describe("deriveRunStatusLabel", () => {
  it("labels a tail tool_call with the taxonomy verb and tool · target detail", () => {
    const status = deriveRunStatusLabel([
      toolCall("Grep", { pattern: "ui/src/components" }),
    ]);
    expect(status.label).toBe("Searching file contents");
    expect(status.detail).toBe("Grep · ui/src/components");
    expect(status.toolName).toBe("Grep");
  });

  it("uses family verbs per tool", () => {
    expect(
      deriveRunStatusLabel([toolCall("Bash", { command: "pnpm test" })]).label,
    ).toBe("Running a command");
    expect(
      deriveRunStatusLabel([toolCall("Edit", { file_path: "a.ts" })]).label,
    ).toBe("Editing a file");
    expect(
      deriveRunStatusLabel([toolCall("mcp__linear__search_issues")]).label,
    ).toBe("Searching issues");
  });

  it("omits the target from the detail when the input has none", () => {
    const status = deriveRunStatusLabel([toolCall("Read")]);
    expect(status.detail).toBe("Read");
  });

  it("keeps Thinking / Responding / Running fallbacks", () => {
    expect(
      deriveRunStatusLabel([
        { kind: "thinking", ts: TS, text: "hmm" } as TranscriptEntry,
      ]).label,
    ).toBe("Thinking");
    expect(
      deriveRunStatusLabel([
        { kind: "assistant", ts: TS, text: "done" } as TranscriptEntry,
      ]).label,
    ).toBe("Responding");
    expect(deriveRunStatusLabel([]).label).toBe("Running");
    // A settled tool (tool_result at the tail) means "between tools" → Running.
    expect(
      deriveRunStatusLabel([
        toolCall("Bash", { command: "ls" }),
        {
          kind: "tool_result",
          ts: TS,
          toolUseId: "tool-Bash",
          content: "ok",
        } as TranscriptEntry,
      ]).label,
    ).toBe("Running");
  });
});

describe("toolDisplayName", () => {
  it("collapses mcp names the same way the taxonomy does", () => {
    expect(toolDisplayName("mcp__linear-server__search_issues")).toBe(
      "Search issues",
    );
    expect(toolDisplayName("bash")).toBe("Bash");
    expect(toolDisplayName("")).toBe("Unnamed tool");
    expect(toolDisplayName("tool")).toBe("Unnamed tool");
  });

  it("maps acpx placeholder names to the explicit unnamed-tool label", () => {
    expect(toolDisplayName("tool call")).toBe("Unnamed tool");
    expect(toolDisplayName("tool call (completed)")).toBe("Unnamed tool");
    expect(toolDisplayName("acp_tool")).toBe("Unnamed tool");
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
        {
          kind: "tool_call",
          ts: TS,
          name: "Terminal",
          toolUseId: "tc-2",
        } as TranscriptEntry,
        {
          kind: "tool_call",
          ts: TS,
          name: "ls -la",
          toolUseId: "tc-2",
        } as TranscriptEntry,
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
    const items = transcriptToTaskChatItems(
      [update("tc-orphan", "pending")],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].target).toBeUndefined();
  });

  it("upgrades a generic-named call when a later entry carries the real name", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "tool_call",
          ts: TS,
          name: "tool call",
          toolUseId: "tc-1",
        } as TranscriptEntry,
        {
          kind: "tool_call",
          ts: TS,
          name: "Read",
          toolUseId: "tc-1",
        } as TranscriptEntry,
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    if (items[0].kind !== "tool") return;
    expect(items[0].name).toBe("Read");
  });

  it("marks an unfinished tool interrupted once the transcript is settled", () => {
    const items = transcriptToTaskChatItems(
      [toolCall("Terminal", { command: "sleep 120" })],
      opts,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool",
      name: "Terminal",
      status: "interrupted",
      detail: "Interrupted before the provider reported completion.",
    });
  });
});

describe("transcriptToTaskChatItems protocol surfaces", () => {
  const opts = { runId: "run-protocol", running: false };

  it("retains and updates provider activity instead of dropping it", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "provider_activity",
          ts: TS,
          family: "plan",
          eventType: "plan.updated",
          status: "running",
          title: "Plan",
          summary: "Drafting",
          payload: {
            planId: "plan-1",
            revision: 1,
            steps: [
              { stepId: "one", body: "Inventory", status: "in_progress" },
            ],
          },
        },
        {
          kind: "provider_activity",
          ts: TS,
          family: "plan",
          eventType: "plan.updated",
          status: "completed",
          title: "Plan",
          summary: "Ready",
          payload: {
            planId: "plan-1",
            revision: 2,
            steps: [{ stepId: "one", body: "Inventory", status: "completed" }],
          },
        },
      ],
      opts,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "protocol",
      surface: "provider_activity",
      family: "plan",
      status: "completed",
      summary: "Ready",
    });
  });

  it("preserves named ACPX tool identity and progress when terminal updates omit them", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "provider_activity",
          ts: TS,
          family: "tool_execution",
          eventType: "tool.execution.started",
          status: "running",
          title: "Tool execution",
          summary: "Searching the task index",
          payload: {
            executionId: "exec-lifecycle",
            transport: "mcp",
            namespace: "paperclip",
            name: "search_tasks",
            operation: "search",
            progress: "Searching the task index",
            target: "doc/plan.md",
          },
        },
        {
          kind: "provider_activity",
          ts: TS,
          family: "tool_execution",
          eventType: "tool.execution.completed",
          status: "completed",
          title: "Tool execution",
          summary: "tool call",
          payload: {
            executionId: "exec-lifecycle",
            transport: "builtin",
            name: "tool call",
            status: "completed",
            output: "done",
          },
        },
      ] as TranscriptEntry[],
      opts,
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item).toMatchObject({
      kind: "protocol",
      surface: "provider_activity",
      family: "tool_execution",
      status: "completed",
      summary: "Searching the task index",
      output: "done",
    });
    if (item.kind !== "protocol" || item.surface !== "provider_activity")
      return;
    expect(item.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Name", value: "search_tasks" }),
        expect.objectContaining({ label: "Namespace", value: "paperclip" }),
        expect.objectContaining({ label: "Operation", value: "search" }),
        expect.objectContaining({ label: "Target", value: "doc/plan.md" }),
        expect.objectContaining({
          label: "Progress",
          value: "Searching the task index",
        }),
      ]),
    );
    expect(providerActivityPresentation(item)).toMatchObject({
      runningLabel: "Searching tasks",
      completedLabel: "Searched tasks",
      detail: "Searching the task index · Paperclip · search_tasks",
    });
  });

  it("marks a running provider activity interrupted in a settled transcript", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "provider_activity",
          ts: TS,
          family: "tool_execution",
          eventType: "tool.execution.started",
          status: "running",
          title: "Tool execution",
          summary: "sleep 120",
          payload: {},
        },
      ],
      opts,
    );
    expect(items[0]).toMatchObject({
      kind: "protocol",
      surface: "provider_activity",
      status: "interrupted",
      summary: "sleep 120 · Interrupted before completion.",
    });
  });

  it("coalesces workspace revisions and runtime request lifecycle states", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "workspace_change",
          ts: TS,
          changeSetId: "change-1",
          revision: 1,
          source: "harness_reported",
          complete: false,
          files: [],
          totals: { files: 0, additions: null, deletions: null },
          patchArtifactRef: null,
        },
        {
          kind: "workspace_change",
          ts: TS,
          changeSetId: "change-1",
          revision: 2,
          source: "runner_verified",
          complete: true,
          files: [
            {
              path: "ui/src/App.tsx",
              operation: "modify",
              previousPath: null,
              additions: 1,
              deletions: 0,
              binary: false,
              diff: "+ok",
            },
          ],
          totals: { files: 1, additions: 1, deletions: 0 },
          patchArtifactRef: null,
        },
        {
          kind: "runtime_request",
          ts: TS,
          requestId: "request-1",
          requestKind: "command_approval",
          turnId: "turn-1",
          requestType: "permission",
          status: "pending",
          prompt: "Allow?",
          choices: [],
          fields: [],
        },
        {
          kind: "runtime_request",
          ts: TS,
          requestId: "request-1",
          requestKind: "command_approval",
          turnId: "turn-1",
          requestType: "permission",
          status: "resolved",
          prompt: "Allow?",
          choices: [],
          fields: [],
        },
      ],
      opts,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "protocol",
      surface: "workspace_change",
      revision: 2,
      complete: true,
    });
    expect(items[1]).toMatchObject({
      kind: "protocol",
      surface: "runtime_request",
      runId: "run-protocol",
      turnId: "turn-1",
      requestKind: "command_approval",
      status: "resolved",
    });
  });

  it("bounds provider output and workspace previews to 8 KiB", () => {
    const oversized = "x".repeat(9 * 1024);
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "provider_activity",
          ts: TS,
          family: "tool_execution",
          eventType: "tool.execution.completed",
          status: "completed",
          title: "Tool execution",
          summary: "Done",
          payload: { executionId: "exec-1", output: oversized },
        },
        {
          kind: "workspace_file_reference",
          ts: TS,
          referenceId: "file-1",
          source: "runner_verified",
          path: "ui/src/App.tsx",
          displayName: "App.tsx",
          mediaType: "text/typescript",
          presentation: "code",
          line: null,
          preview: oversized,
          previewTruncated: false,
          contentDigest: null,
        },
      ],
      opts,
    );
    const provider = items.find(
      (item) =>
        item.kind === "protocol" && item.surface === "provider_activity",
    );
    const file = items.find(
      (item) => item.kind === "protocol" && item.surface === "workspace_file",
    );
    expect(
      provider && provider.surface === "provider_activity"
        ? provider.output?.length
        : 0,
    ).toBe(8 * 1024);
    expect(
      provider && provider.surface === "provider_activity"
        ? provider.outputTruncated
        : false,
    ).toBe(true);
    expect(
      file && file.surface === "workspace_file" ? file.preview?.length : 0,
    ).toBe(8 * 1024);
    expect(
      file && file.surface === "workspace_file" ? file.previewTruncated : false,
    ).toBe(true);
  });

  it("turns canonical research sources into safe links and exposes notice metadata", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "provider_activity",
          ts: TS,
          family: "research",
          eventType: "research.completed",
          status: "completed",
          title: "Research",
          summary: "PRP",
          payload: {
            researchId: "research-1",
            sources: [
              {
                title: "Protocol notes",
                url: "https://example.com/prp",
                snippet: "Canonical event details",
              },
              { title: "Unsafe", url: "file:///etc/passwd" },
            ],
          },
        },
        {
          kind: "provider_activity",
          ts: TS,
          family: "provider_notice",
          eventType: "provider.notice.recorded",
          status: "informational",
          title: "Provider notice",
          summary: "Update configuration",
          payload: {
            noticeId: "notice-1",
            severity: "warning",
            category: "config",
            scope: "environment",
            recoverable: true,
            userActionable: false,
          },
        },
      ],
      opts,
    );
    const research = items.find(
      (item) =>
        item.kind === "protocol" &&
        item.surface === "provider_activity" &&
        item.family === "research",
    );
    const notice = items.find(
      (item) =>
        item.kind === "protocol" &&
        item.surface === "provider_activity" &&
        item.family === "provider_notice",
    );
    expect(
      research?.kind === "protocol" && research.surface === "provider_activity"
        ? research.links
        : [],
    ).toEqual([
      {
        label: "Protocol notes",
        href: "https://example.com/prp",
        description: "Canonical event details",
      },
    ]);
    expect(
      notice?.kind === "protocol" && notice.surface === "provider_activity"
        ? notice.details
        : [],
    ).toEqual(
      expect.arrayContaining([
        { label: "Severity", value: "warning", mono: false },
        { label: "Category", value: "config", mono: false },
        { label: "Scope", value: "environment", mono: false },
        { label: "Recoverable", value: "Yes", mono: false },
        { label: "User Actionable", value: "No", mono: false },
      ]),
    );
  });

  it("retains every canonical provider family for live and settled rendering", () => {
    const families = [
      "plan",
      "tool_execution",
      "research",
      "delegation",
      "model_identity",
      "context",
      "artifact",
      "review",
      "hook",
      "memory",
      "safety",
      "terminal",
      "wait",
      "provider_notice",
    ] as const;
    const entries = families.map((family, index): TranscriptEntry => ({
      kind: "provider_activity",
      ts: new Date(Date.parse(TS) + index).toISOString(),
      family,
      eventType: `${family}.fixture`,
      status: index % 2 === 0 ? "running" : "completed",
      title: family,
      summary: `Visible ${family}`,
      payload: { [`${family}Id`]: `${family}-1` },
    }));
    const items = transcriptToTaskChatItems(entries, {
      ...opts,
      running: true,
    });
    expect(
      items.map((item) =>
        item.kind === "protocol" && item.surface === "provider_activity"
          ? item.family
          : null,
      ),
    ).toEqual(families);
  });
});

describe("buildActivityPhases provider summaries", () => {
  it("includes canonical provider work in the folded activity summary", () => {
    const provider = (
      id: string,
      family: "research" | "hook",
    ): TaskChatItem => ({
      id,
      kind: "protocol",
      surface: "provider_activity",
      family,
      eventType: `${family}.completed`,
      status: "completed",
      title: family,
      details: [],
      steps: [],
      links: [],
      children: [],
    });
    const phases = buildActivityPhases(
      [
        {
          id: "finish",
          kind: "tool",
          name: "Paperclip_finish",
          status: "completed",
        },
        provider("research-1", "research"),
        provider("research-2", "research"),
        provider("research-3", "research"),
        provider("hook-1", "hook"),
        {
          id: "workspace",
          kind: "protocol",
          surface: "workspace_change",
          changeSetId: "change-1",
          revision: 1,
          source: "runner_verified",
          complete: true,
          files: [],
          totals: { files: 2, additions: 1, deletions: 1 },
          patchArtifactRef: null,
        },
      ],
      false,
    );
    expect(phases[0]?.summary).toBe(
      "Used a tool, searched 3 times, ran a hook",
    );
  });

  it("counts canonical tool execution when no native tool row exists", () => {
    const phases = buildActivityPhases(
      [
        {
          id: "provider-tool",
          kind: "protocol",
          surface: "provider_activity",
          family: "tool_execution",
          eventType: "tool.execution.completed",
          status: "completed",
          title: "Tool execution",
          details: [],
          steps: [],
          links: [],
          children: [],
        },
      ],
      false,
    );
    expect(phases[0]?.summary).toBe("Used a tool");
  });

  it("summarizes the sanitized DOT-212 mix with at most three semantic groups", () => {
    const providerTool = (
      id: string,
      name: string,
      operation: string,
      namespace?: string,
    ): TaskChatItem => ({
      id,
      kind: "protocol",
      surface: "provider_activity",
      family: "tool_execution",
      eventType: "tool.execution.completed",
      status: "completed",
      title: "Tool execution",
      details: [
        { label: "Transport", value: namespace ? "mcp" : "builtin" },
        { label: "Operation", value: operation },
        { label: "Name", value: name, mono: true },
        ...(namespace
          ? [{ label: "Namespace", value: namespace, mono: true }]
          : []),
      ],
      steps: [],
      links: [],
      children: [],
    });
    const items: TaskChatItem[] = [
      ...Array.from({ length: 6 }, (_, index) =>
        providerTool(`search-${index}`, "ToolSearch", "search"),
      ),
      providerTool("context", "get_task_context", "read", "paperclip"),
      providerTool("documents", "list_documents", "list", "paperclip"),
      providerTool("history", "get_task_history", "read", "paperclip"),
      providerTool("tasks", "search_tasks", "search", "paperclip"),
      providerTool("progress", "report_progress", "edit", "paperclip"),
      providerTool("block", "paperclip_block", "edit", "paperclip"),
    ];
    expect(buildActivityPhases(items, false)[0]?.summary).toBe(
      "Searched available tools 6 times, read from Paperclip 3 times, used Paperclip 3 times",
    );
  });
});

describe("buildTurnTimelineRows (DOT-217)", () => {
  const commentary = (id: string, text: string): TaskChatItem => ({
    id,
    kind: "message",
    author: "agent",
    text,
    interstitial: true,
    channel: "progress",
  });
  const tool = (id: string): TaskChatItem => ({
    id,
    kind: "tool",
    name: "Read",
    rawName: "read_file",
    target: `${id}.ts`,
    status: "completed",
  });
  const request = (
    id: string,
    status: "pending" | "resolved" | "cancelled" | "expired",
  ): TaskChatItem => ({
    id: `${id}:${status}`,
    kind: "protocol",
    surface: "runtime_request",
    runId: "run-dot-217",
    requestId: id,
    requestKind: "user_input",
    turnId: "turn-dot-217",
    requestType: "input",
    status,
    prompt: `Question ${id}`,
    choices: [],
    fields: [],
  });

  const workspace: TaskChatItem = {
    id: "workspace-change",
    kind: "protocol",
    surface: "workspace_change",
    changeSetId: "turn-dot-217:workspace",
    revision: 2,
    source: "runner_verified",
    complete: true,
    files: [
      {
        path: "src/App.tsx",
        operation: "modify",
        previousPath: null,
        additions: 2,
        deletions: 1,
        binary: false,
        diff: "+new\n-old\n",
      },
    ],
    totals: { files: 1, additions: 2, deletions: 1 },
    patchArtifactRef: null,
  };

  it("keeps commentary, grouped tools, and latest question receipts in first-seen order", () => {
    const input = [
      commentary("commentary-1", "Inspecting the workspace."),
      tool("tool-1"),
      tool("tool-2"),
      commentary("commentary-2", "I need two product choices."),
      request("questions-1", "pending"),
      commentary("commentary-3", "I’ll continue with the selected scope."),
      tool("tool-3"),
      request("questions-2", "pending"),
      commentary("commentary-4", "The final constraint is clear."),
      tool("tool-4"),
      request("questions-1", "resolved"),
      request("questions-2", "cancelled"),
    ];

    const rows = buildTurnTimelineRows(input, false);
    expect(
      rows.map((row) => {
        if (row.kind === "activity_phase") {
          return `${row.interstitial?.id ?? "opening"}:${row.items.map((item) => item.id).join(",")}`;
        }
        if (row.kind === "protocol" && row.surface === "runtime_request") {
          return `${row.requestId}:${row.status}`;
        }
        return row.kind;
      }),
    ).toEqual([
      "commentary-1:tool-1,tool-2",
      "commentary-2:",
      "questions-1:resolved",
      "commentary-3:tool-3",
      "questions-2:cancelled",
      "commentary-4:tool-4",
    ]);
  });

  it("keeps a pending request composer-only while preserving its group boundary", () => {
    const rows = buildTurnTimelineRows(
      [tool("before"), request("pending", "pending"), tool("after")],
      true,
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "activity_phase")).toBe(true);
    expect(
      rows.map((row) =>
        row.kind === "activity_phase" ? row.items[0]?.id : null,
      ),
    ).toEqual(["before", "after"]);
    expect(rows[0]).toMatchObject({ kind: "activity_phase", active: false });
    expect(rows[1]).toMatchObject({ kind: "activity_phase", active: true });
  });

  it("retains progress-only phases and uses the same row order for settled assembly", () => {
    const input = [
      tool("opening"),
      commentary("commentary-only", "Still checking the edge case."),
      request("expired", "expired"),
    ];
    expect(settledRunChildren(input)).toEqual(
      buildTurnTimelineRows(input, false),
    );
    expect(buildTurnTimelineRows(input, false).map((row) => row.kind)).toEqual([
      "activity_phase",
      "activity_phase",
      "protocol",
    ]);
  });

  it("keeps runtime requests in the Paperclip Runner timeline input", () => {
    const pending = request("pending", "pending");
    expect(
      paperclipRunnerTimelineItems([
        commentary("commentary", "Checking."),
        pending,
        { id: "usage", kind: "usage", usage: { used: 1, size: 10 } },
      ]).map((item) => item.id),
    ).toEqual(["commentary", pending.id, "usage"]);
  });

  it("keeps aggregate workspace changes at the turn boundary outside activity", () => {
    const rows = buildTurnTimelineRows(
      paperclipRunnerTimelineItems([tool("before"), workspace, tool("after")]),
      false,
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "activity_phase",
      "protocol",
      "activity_phase",
    ]);
    expect(rows[1]).toMatchObject({
      surface: "workspace_change",
      changeSetId: "turn-dot-217:workspace",
    });
  });

  it("suppresses file-change fragments only when an aggregate event exists", () => {
    const fileChange: TaskChatItem = {
      id: "provider-file-change",
      kind: "tool",
      name: "File change",
      rawName: "fileChange",
      status: "completed",
      diff: { path: "src/App.tsx", added: 2, removed: 1 },
    };
    expect(paperclipRunnerActivityItems([fileChange])).toEqual([fileChange]);
    expect(paperclipRunnerActivityItems([fileChange, workspace])).toEqual([
      workspace,
    ]);
  });

  it("keeps a yielded run-result and provider wait prose out of the durable final slot", () => {
    expect(
      paperclipRunnerFinalResponse([
        {
          id: "provider-wait",
          kind: "message",
          author: "agent",
          text: "Waiting for Review browser RTS plan.",
          channel: "final",
          streaming: false,
        },
        {
          id: "result",
          kind: "protocol",
          surface: "run_result",
          disposition: "yielded",
          summary: "Waiting for Review browser RTS plan.",
          objectiveSatisfied: false,
          verification: [],
          remainingWork: [],
          blocker: null,
          artifacts: [],
        },
      ]),
    ).toBeUndefined();
  });

  it("keeps a saved plan at its write_document boundary", () => {
    const plan: TaskChatPlanDocumentItem = {
      id: "plan-doc:revision-1",
      kind: "plan_document",
      document: {} as TaskChatPlanDocumentItem["document"],
    };
    const embedded = embedPlanDocumentAtWriteBoundary(
      [
        commentary("commentary-1", "Inspecting."),
        tool("read-before-plan"),
        commentary("commentary-2", "Publishing the plan."),
        {
          id: "write-plan",
          kind: "tool",
          name: "Write document",
          rawName: "write_document",
          status: "completed",
        },
        {
          id: "write-plan-provider",
          kind: "protocol",
          surface: "provider_activity",
          family: "tool_execution",
          eventType: "tool.execution.completed",
          status: "completed",
          title: "write_document",
          details: [{ label: "Name", value: "write_document" }],
          steps: [],
          links: [],
          children: [],
        },
        commentary("commentary-3", "The plan is published."),
      ],
      plan,
    );

    const rows = buildTurnTimelineRows(
      paperclipRunnerTimelineItems(embedded),
      false,
    );
    expect(
      rows.map((row) =>
        row.kind === "activity_phase"
          ? `${row.interstitial?.id}:${row.items.map((item) => item.id).join(",")}`
          : row.id,
      ),
    ).toEqual([
      "commentary-1:read-before-plan",
      "commentary-2:write-plan,write-plan-provider",
      plan.id,
      "commentary-3:",
    ]);
    expect(
      embedded.find((item) => item.kind === "plan_document"),
    ).toMatchObject({ placement: "write_boundary" });
  });

  it("retains a saved plan as an explicit fallback when its write boundary is unavailable", () => {
    const plan: TaskChatPlanDocumentItem = {
      id: "plan-doc:revision-fallback",
      kind: "plan_document",
      document: {} as TaskChatPlanDocumentItem["document"],
    };

    expect(
      embedPlanDocumentAtWriteBoundary(
        [commentary("commentary", "Transcript is still hydrating.")],
        plan,
      ),
    ).toEqual([
      commentary("commentary", "Transcript is still hydrating."),
      { ...plan, placement: "fallback" },
    ]);
  });
});

describe("transcriptToTaskChatItems native usage", () => {
  it("does not merge progress and final runner messages", () => {
    const items = transcriptToTaskChatItems(
      [
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
      ],
      { runId: "native-run", running: true },
    );

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

  it("keeps separate completed commentary items as separate chronological paragraphs", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "I am checking the existing behavior.",
          channel: "progress",
          itemId: "message-1",
        },
        {
          kind: "assistant",
          ts: "2026-07-31T12:00:01.000Z",
          text: "The implementation is ready.",
          channel: "progress",
          itemId: "message-2",
        },
      ],
      { runId: "native-run", running: false },
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "message",
        text: "I am checking the existing behavior.",
      }),
      expect.objectContaining({
        kind: "message",
        text: "The implementation is ready.",
      }),
    ]);
  });

  it("coalesces only streaming chunks that share an item identity", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "Still ",
          channel: "progress",
          delta: true,
          itemId: "message-1",
        },
        {
          kind: "assistant",
          ts: TS,
          text: "working",
          channel: "progress",
          delta: true,
          itemId: "message-1",
        },
        {
          kind: "assistant",
          ts: TS,
          text: "Next message",
          channel: "progress",
          delta: true,
          itemId: "message-2",
        },
      ],
      { runId: "native-run", running: true },
    );

    expect(items).toEqual([
      expect.objectContaining({ kind: "message", text: "Still working" }),
      expect.objectContaining({ kind: "message", text: "Next message" }),
    ]);
  });

  it("keeps distinct completed reasoning items separate even on the same channel", () => {
    const items = transcriptToTaskChatItems(
      [
        {
          kind: "thinking",
          ts: TS,
          text: "Inspecting transport.",
          lifecycle: "completed",
          channel: "summary",
          itemId: "reason-1",
        },
        {
          kind: "thinking",
          ts: "2026-07-31T12:00:01.000Z",
          text: "Checking persistence.",
          lifecycle: "completed",
          channel: "summary",
          itemId: "reason-2",
        },
      ],
      { runId: "native-run", running: false },
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "thinking",
        lines: ["Inspecting transport."],
      }),
      expect.objectContaining({
        kind: "thinking",
        lines: ["Checking persistence."],
      }),
    ]);
  });

  it("renders runner usage without inventing a context-window size", () => {
    const items = transcriptToTaskChatItems(
      [
        {
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
        },
      ],
      { runId: "native-run", running: true },
    );

    expect(items).toEqual([
      {
        id: "native-run:usage:0",
        kind: "usage",
        usage: {
          used: 55,
          size: 0,
          inputTokens: 40,
          outputTokens: 10,
          costUsd: 0.02,
        },
      },
    ]);
  });

  it("renders cumulative-only runner session usage", () => {
    const items = transcriptToTaskChatItems(
      [
        {
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
        },
      ],
      { runId: "native-run", running: true },
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "usage",
        label: "Provider session total",
        detail: expect.stringContaining("cumulative usage"),
        usage: expect.objectContaining({
          used: 100,
          inputTokens: 80,
          outputTokens: 20,
        }),
      }),
    ]);
  });

  it("does not change direct-adapter result presentation", () => {
    const items = transcriptToTaskChatItems(
      [
        {
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
        },
      ],
      { runId: "legacy-run", running: true },
    );
    expect(items).toEqual([]);
  });
});

describe("buildTurnSummary tool counting", () => {
  function statusEntry(
    toolUseId: string | undefined,
    status: string,
  ): TranscriptEntry {
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
      {
        kind: "tool_call",
        ts: TS,
        name: "Terminal",
        toolUseId: "tc-3",
      } as TranscriptEntry,
      {
        kind: "tool_call",
        ts: TS,
        name: "pnpm test",
        toolUseId: "tc-3",
      } as TranscriptEntry,
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
    {
      id: "m",
      kind: "message",
      author: "agent",
      text: "finished self-talk",
      interstitial: true,
    },
    {
      id: "mk",
      kind: "marker",
      variant: "session_start",
      label: "Session started",
    },
    { id: "s", kind: "status", status: "running", label: "Running" },
    { id: "i", kind: "interaction", interaction: {} as never },
  ];

  it("nests tools, provider reasoning, and usage inside the live parent row", () => {
    expect(items.filter(isNestableLiveChild).map((it) => it.kind)).toEqual([
      "tool",
      "thinking",
      "usage",
    ]);
  });

  it("keeps messages, markers, statuses and interactions out", () => {
    // Interstitial updates — finished or streaming — never nest: they are
    // ephemeral, living on the live line only while streaming, and the final
    // reply keeps its bubble.
    for (const kind of ["message", "marker", "status", "interaction"]) {
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
      isNestableLiveChild({
        id: "m3",
        kind: "message",
        author: "agent",
        text: "Final reply.",
      }),
    ).toBe(false);
  });
});

describe("interstitial self-talk classification (PAP-355)", () => {
  const stream: TranscriptEntry[] = [
    {
      kind: "assistant",
      ts: TS,
      text: "Let me check the adapter.",
    } as TranscriptEntry,
    toolCall("Read", { file_path: "a.ts" }),
    {
      kind: "assistant",
      ts: "2026-07-31T12:00:05.000Z",
      text: "Found it — fixing now.",
    } as TranscriptEntry,
  ];

  it("tags agent messages streamed inside a live run turn as interstitial", () => {
    const messages = transcriptToTaskChatItems(stream, {
      runId: "run-1",
      running: true,
    }).filter((it) => it.kind === "message");
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
    }
  });

  it("marks only the message still open at the tail as streaming", () => {
    const items = transcriptToTaskChatItems(stream, {
      runId: "run-1",
      running: true,
    });
    const messages = items.filter((it) => it.kind === "message");
    if (messages[0].kind !== "message" || messages[1].kind !== "message")
      return;
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
    const messages = transcriptToTaskChatItems(stream, {
      runId: "run-1",
      running: false,
    }).filter((it) => it.kind === "message");
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      if (m.kind !== "message") continue;
      expect(m.interstitial).toBe(true);
      expect(m.streaming).toBe(false);
    }
  });

  it("stamps atMs from the first streamed chunk", () => {
    const messages = transcriptToTaskChatItems(stream, {
      runId: "run-1",
      running: false,
    }).filter((it) => it.kind === "message");
    if (messages[0].kind !== "message" || messages[1].kind !== "message")
      return;
    expect(messages[0].atMs).toBe(Date.parse(TS));
    expect(messages[1].atMs).toBe(Date.parse("2026-07-31T12:00:05.000Z"));
  });
});

describe("flattenSelfTalk", () => {
  it("strips markdown markers to one plain line", () => {
    expect(
      flattenSelfTalk(
        "## Plan\n\nI'll **extend** the `ipRateLimit` helper:\n- read it\n- patch it",
      ),
    ).toBe("Plan I'll extend the ipRateLimit helper: read it patch it");
  });

  it("keeps link text, drops the url, and is stream-safe on unclosed markers", () => {
    expect(flattenSelfTalk("see [the docs](https://x) for **bol")).toBe(
      "see the docs for bol",
    );
    expect(flattenSelfTalk("```ts\nconst a = 1;")).toBe("const a = 1;");
  });
});

describe("deriveRunStatusLabel streaming interstitial text (PAP-361)", () => {
  it("returns the trailing message's flattened text with the Responding label", () => {
    const status = deriveRunStatusLabel([
      {
        kind: "assistant",
        ts: TS,
        text: "I'll **extend** ",
      } as TranscriptEntry,
      {
        kind: "assistant",
        ts: TS,
        text: "the `ipRateLimit` helper.",
      } as TranscriptEntry,
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
      deriveRunStatusLabel([
        { kind: "thinking", ts: TS, text: "hm" } as TranscriptEntry,
      ]).selfTalk,
    ).toBeUndefined();
    expect(deriveRunStatusLabel([]).selfTalk).toBeUndefined();
  });
});

describe("settledRunChildren (PAP-361)", () => {
  const transcript: TranscriptEntry[] = [
    {
      kind: "assistant",
      ts: TS,
      text: "Checking the adapter first.",
    } as TranscriptEntry,
    toolCall("Read", { file_path: "a.ts" }),
    { kind: "thinking", ts: TS, text: "wire it in" } as TranscriptEntry,
    toolCall("Edit", { file_path: "a.ts" }),
    {
      kind: "assistant",
      ts: TS,
      text: "Done — the limiter is wired in.",
    } as TranscriptEntry,
  ];
  const parsed = transcriptToTaskChatItems(transcript, {
    runId: "run-1",
    running: false,
  });

  it("groups tools under the historical assistant boundary and excludes the final reply", () => {
    const children = settledRunChildren(parsed);
    expect(children.map((c) => c.kind)).toEqual(["activity_phase"]);
    const phase = children[0];
    expect(phase.kind === "activity_phase" && phase.interstitial?.text).toBe(
      "Checking the adapter first.",
    );
    expect(
      phase.kind === "activity_phase" && phase.items.map((item) => item.kind),
    ).toEqual(["tool", "thinking", "tool"]);
  });

  it("excludes an explicit final reply when runner usage follows it", () => {
    const finalThenUsage = transcriptToTaskChatItems(
      [
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
      ],
      { runId: "native-run", running: false },
    );

    const children = settledRunChildren(finalThenUsage);
    expect(children).toHaveLength(1);
    const phase = children[0];
    expect(phase.kind).toBe("activity_phase");
    if (phase.kind !== "activity_phase") return;
    expect(phase.interstitial).toBeUndefined();
    expect(phase.items.map((item) => item.kind)).toEqual(["usage"]);
  });

  it("keeps a channel-less final reply out of activity when bookkeeping follows it", () => {
    const finalThenBookkeeping = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "Done — the direct adapter finished.",
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
      ],
      { runId: "legacy-run", running: false },
    );

    const children = settledRunChildren(finalThenBookkeeping);
    expect(children).toHaveLength(1);
    const phase = children[0];
    expect(phase.kind).toBe("activity_phase");
    if (phase.kind !== "activity_phase") return;
    expect(phase.interstitial).toBeUndefined();
    expect(phase.items.map((item) => item.kind)).toEqual(["usage"]);
  });

  it("keeps a channel-less final reply out of activity when a workspace summary follows it", () => {
    const finalReply = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "Done — the workspace is updated.",
        } as TranscriptEntry,
      ],
      { runId: "legacy-run", running: false },
    );
    const children = settledRunChildren([
      ...finalReply,
      {
        id: "workspace-summary",
        kind: "protocol",
        surface: "workspace_change",
        changeSetId: "changes-1",
        revision: 1,
        source: "harness_reported",
        complete: true,
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        patchArtifactRef: null,
      },
    ]);

    expect(children).toHaveLength(1);
    expect(children[0]?.kind).toBe("protocol");
    expect(
      children.some(
        (child) =>
          child.kind === "activity_phase" &&
          child.interstitial?.text === "Done — the workspace is updated.",
      ),
    ).toBe(false);
  });

  it("does not hide channel-less commentary when real activity follows it", () => {
    const commentaryThenToolAndUsage = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "Checking the direct adapter first.",
        } as TranscriptEntry,
        toolCall("Read", { file_path: "a.ts" }),
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
      ],
      { runId: "legacy-run", running: false },
    );

    const children = settledRunChildren(commentaryThenToolAndUsage);
    expect(children).toHaveLength(1);
    const phase = children[0];
    expect(phase.kind).toBe("activity_phase");
    if (phase.kind !== "activity_phase") return;
    expect(phase.interstitial?.text).toBe("Checking the direct adapter first.");
    expect(phase.items.map((item) => item.kind)).toEqual(["tool", "usage"]);
  });

  it("matches the folded summary's tool count exactly (row-count parity)", () => {
    const children = settledRunChildren(parsed);
    const summary = buildTurnSummary(transcript);
    const phaseToolCount = children.reduce(
      (count, child) =>
        count +
        (child.kind === "activity_phase"
          ? child.items.filter((item) => item.kind === "tool").length
          : 0),
      0,
    );
    expect(phaseToolCount).toBe(summary.toolCount);
  });

  it("creates a stable opening phase for calls before the first interstitial", () => {
    const opening = transcriptToTaskChatItems(
      [
        toolCall("Read", { file_path: "a.ts" }),
        { kind: "assistant", ts: TS, text: "Now editing." } as TranscriptEntry,
        toolCall("Edit", { file_path: "a.ts" }),
        { kind: "assistant", ts: TS, text: "Done." } as TranscriptEntry,
      ],
      { runId: "run-opening", running: false },
    );
    const phases = settledRunChildren(opening);
    expect(phases).toHaveLength(2);
    expect(phases[0].id).toContain(":phase:opening");
    expect(phases[1].kind === "activity_phase" && phases[1].summary).toBe(
      "Edited a file",
    );
  });
});

describe("paperclip runner semantic channels", () => {
  it("concatenates fragmented reasoning deltas into logical lines", () => {
    const parsed = transcriptToTaskChatItems(
      [
        {
          kind: "thinking",
          ts: TS,
          text: "Inspect",
          delta: true,
          channel: "summary",
        },
        {
          kind: "thinking",
          ts: TS,
          text: "ing the ",
          delta: true,
          channel: "summary",
        },
        {
          kind: "thinking",
          ts: TS,
          text: "runner",
          delta: true,
          channel: "summary",
        },
        {
          kind: "thinking",
          ts: TS,
          text: "\nThen ",
          delta: true,
          channel: "summary",
        },
        {
          kind: "thinking",
          ts: TS,
          text: "verify streaming",
          delta: true,
          channel: "summary",
        },
      ],
      { runId: "run-fragmented-reasoning", running: true },
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      kind: "thinking",
      lines: ["Inspecting the runner", "Then verify streaming"],
      transcriptIndex: 4,
    });
  });

  it("ends reasoning when a newer transcript surface becomes current", () => {
    const parsed = transcriptToTaskChatItems(
      [
        {
          kind: "thinking",
          ts: TS,
          text: "Inspecting the runner",
          channel: "summary",
          delta: true,
        },
        {
          kind: "assistant",
          ts: TS,
          text: "I found the relevant component.",
          channel: "progress",
        },
        {
          kind: "thinking",
          ts: TS,
          text: "Checking the render state",
          channel: "summary",
          delta: true,
        },
        toolCall("Read", { file_path: "TaskChatThinking.tsx" }),
        {
          kind: "thinking",
          ts: TS,
          text: "Verifying the fix",
          channel: "summary",
          delta: true,
        },
      ],
      { runId: "run-reasoning-activity", running: true },
    );
    const thinking = parsed.filter(
      (item): item is Extract<TaskChatItem, { kind: "thinking" }> =>
        item.kind === "thinking",
    );
    expect(thinking.map((item) => item.streaming)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("turns empty reasoning lifecycle frames into a visible thinking item", () => {
    const parsed = transcriptToTaskChatItems(
      [
        {
          kind: "thinking",
          ts: "2026-08-21T12:00:00.000Z",
          text: "",
          lifecycle: "started",
          channel: "summary",
        },
        {
          kind: "thinking",
          ts: "2026-08-21T12:00:02.000Z",
          text: "",
          lifecycle: "completed",
          channel: "summary",
        },
      ],
      { runId: "run-empty-reasoning", running: true },
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        kind: "thinking",
        lines: [],
        streaming: false,
        lifecycleOnly: true,
        summaryLabel: "Thought for 2s",
      }),
    ]);
  });

  it("keeps progress/final messages and reasoning summary/detail in distinct items", () => {
    const parsed = transcriptToTaskChatItems(
      [
        {
          kind: "assistant",
          ts: TS,
          text: "Checking.",
          channel: "progress",
          delta: true,
        },
        {
          kind: "thinking",
          ts: TS,
          text: "Summary",
          channel: "summary",
          delta: true,
        },
        {
          kind: "thinking",
          ts: TS,
          text: "Detail",
          channel: "detail",
          delta: true,
        },
        {
          kind: "assistant",
          ts: TS,
          text: "Done.",
          channel: "final",
          delta: true,
        },
      ],
      { runId: "run-channels", running: true },
    );
    expect(parsed.map((item) => item.kind)).toEqual([
      "message",
      "thinking",
      "thinking",
      "message",
    ]);
    expect(parsed[0]).toMatchObject({
      interstitial: true,
      channel: "progress",
    });
    expect(parsed[1]).toMatchObject({ channel: "summary", streaming: false });
    expect(parsed[2]).toMatchObject({ channel: "detail", streaming: false });
    expect(parsed[3]).toMatchObject({ interstitial: false, channel: "final" });
    const history = settledRunChildren(parsed);
    expect(JSON.stringify(history)).not.toContain("Done.");
  });

  it("filters lifecycle and usage noise from only the runner history surface", () => {
    const items: TaskChatItem[] = [
      {
        id: "session",
        kind: "marker",
        variant: "session_start",
        label: "Session started",
        detail: "session-id",
      },
      {
        id: "start",
        kind: "marker",
        variant: "turn_boundary",
        label: "Turn started",
      },
      {
        id: "usage",
        kind: "usage",
        usage: {
          used: 1_024,
          size: 128_000,
          inputTokens: 1_000,
          outputTokens: 24,
        },
      },
      {
        id: "tool",
        kind: "tool",
        name: "Paperclip_finish",
        status: "completed",
        target: "done",
      },
      {
        id: "interrupt",
        kind: "marker",
        variant: "interrupted",
        label: "Interrupted",
      },
      {
        id: "runner",
        kind: "marker",
        variant: "turn_boundary",
        label: "Runner update",
      },
      {
        id: "complete",
        kind: "marker",
        variant: "turn_boundary",
        label: "Turn completed",
      },
    ];

    expect(paperclipRunnerHistoryItems(items).map((item) => item.id)).toEqual([
      "tool",
      "interrupt",
      "runner",
    ]);
    expect(items).toHaveLength(7);
  });

  it("projects one semantic activity row per useful logical item", () => {
    const items: TaskChatItem[] = [
      {
        id: "progress",
        kind: "message",
        author: "agent",
        text: "Looking this up.",
        interstitial: true,
        channel: "progress",
      },
      {
        id: "final",
        kind: "message",
        author: "agent",
        text: "Finished.",
        channel: "final",
      },
      {
        id: "empty-thinking",
        kind: "thinking",
        lines: [],
        lifecycleOnly: true,
      },
      {
        id: "thinking",
        kind: "thinking",
        lines: ["Provider-authored summary"],
      },
      {
        id: "tool",
        kind: "tool",
        name: "Search",
        rawName: "web_search",
        status: "completed",
      },
      {
        id: "finish",
        kind: "tool",
        name: "Paperclip_finish",
        rawName: "paperclip_finish",
        status: "completed",
      },
      {
        id: "session",
        kind: "marker",
        variant: "session_start",
        label: "Session started",
      },
      {
        id: "interrupt",
        kind: "marker",
        variant: "interrupted",
        label: "Interrupted",
      },
      { id: "usage", kind: "usage", usage: { used: 20, size: 100 } },
      {
        id: "research",
        kind: "protocol",
        surface: "provider_activity",
        family: "research",
        eventType: "research.completed",
        status: "completed",
        title: "Research",
        details: [],
        steps: [],
        links: [],
        children: [],
      },
      {
        id: "result",
        kind: "protocol",
        surface: "run_result",
        disposition: "done",
        summary: "Finished.",
        objectiveSatisfied: true,
        verification: [],
        remainingWork: [],
        blocker: null,
        artifacts: [],
      },
      {
        id: "terminal",
        kind: "protocol",
        surface: "run_terminal",
        turnState: "completed",
        runState: "succeeded",
        disposition: "done",
      },
    ];

    expect(paperclipRunnerActivityItems(items).map((item) => item.id)).toEqual([
      "progress",
      "thinking",
      "tool",
      "interrupt",
      "usage",
      "research",
    ]);
  });
});

describe("buildMergedTurnSummary (PAP-362)", () => {
  const runA: TranscriptEntry[] = [
    {
      kind: "tool_call",
      ts: "2026-07-31T12:00:00.000Z",
      name: "Read",
      toolUseId: "a-1",
    } as TranscriptEntry,
    {
      kind: "tool_call",
      ts: "2026-07-31T12:00:05.000Z",
      name: "Edit",
      toolUseId: "a-2",
    } as TranscriptEntry,
    {
      kind: "diff",
      ts: "2026-07-31T12:00:06.000Z",
      changeType: "add",
      text: "+x",
    } as TranscriptEntry,
    {
      kind: "result",
      ts: "2026-07-31T12:00:10.000Z",
      inputTokens: 500,
      outputTokens: 300,
    } as TranscriptEntry,
  ];
  const runB: TranscriptEntry[] = [
    {
      kind: "tool_call",
      ts: "2026-07-31T12:30:00.000Z",
      name: "Bash",
      toolUseId: "b-1",
    } as TranscriptEntry,
    {
      kind: "result",
      ts: "2026-07-31T12:30:05.000Z",
      inputTokens: 300,
      outputTokens: 100,
    } as TranscriptEntry,
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
    const summary = buildMergedTurnSummary([
      { entries: runA },
      { entries: runB },
    ]);
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
    {
      kind: "tool_call",
      ts: TS,
      name: "Read",
      toolUseId: "a-1",
    } as TranscriptEntry,
    {
      kind: "tool_call",
      ts: TS,
      name: "Edit",
      toolUseId: "a-2",
    } as TranscriptEntry,
  ];
  const runB: TranscriptEntry[] = [
    {
      kind: "tool_call",
      ts: TS,
      name: "Bash",
      toolUseId: "b-1",
    } as TranscriptEntry,
  ];

  function agentBubble(id: string): TaskChatItem {
    return {
      id,
      kind: "message",
      author: "agent",
      authorName: "CEO",
      text: "Done.",
    };
  }
  function turn(
    id: string,
    entries: TranscriptEntry[],
    durationMs: number,
  ): TaskChatItem {
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
    [
      "run-a:turn",
      {
        agentKey: "agent-1",
        agentName: "CEO",
        parts: [{ entries: runA, durationMs: 30_000 }],
      },
    ],
    [
      "run-b:turn",
      {
        agentKey: "agent-1",
        agentName: "CEO",
        parts: [{ entries: runB, durationMs: 15_000 }],
      },
    ],
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
    expect(out.map((i) => i.id)).toEqual([
      "msg-a",
      "run-a:turn",
      "msg-u",
      "msg-b",
      "run-b:turn",
    ]);
  });

  it("does not merge across an interaction or into another agent's turn", () => {
    const withInteraction: TaskChatItem[] = [
      turn("run-a:turn", runA, 30_000),
      { id: "int-1", kind: "interaction", interaction: {} } as TaskChatItem,
      turn("run-b:turn", runB, 15_000),
    ];
    expect(
      coalesceSettledTurns(withInteraction, metaById).filter(
        (i) => i.kind === "turn",
      ),
    ).toHaveLength(2);

    const otherAgent = new Map(metaById);
    otherAgent.set("run-b:turn", {
      agentKey: "agent-2",
      agentName: "QA",
      parts: [{ entries: runB }],
    });
    const sameShape: TaskChatItem[] = [
      turn("run-a:turn", runA, 30_000),
      turn("run-b:turn", runB, 15_000),
    ];
    expect(
      coalesceSettledTurns(sameShape, otherAgent).filter(
        (i) => i.kind === "turn",
      ),
    ).toHaveLength(2);
  });

  it("never merges the live (unsettled) turn and preserves animateFold", () => {
    const live: TaskChatItem = {
      id: "run-b:turn",
      kind: "turn",
      settled: false,
      items: [],
      summary: buildTurnSummary([]),
    };
    const out = coalesceSettledTurns(
      [turn("run-a:turn", runA, 30_000), live],
      metaById,
    );
    expect(out).toHaveLength(2);

    const seenLive = {
      ...turn("run-b:turn", runB, 15_000),
      animateFold: true,
    } as TaskChatItem;
    const merged = coalesceSettledTurns(
      [turn("run-a:turn", runA, 30_000), seenLive],
      metaById,
    );
    expect(merged).toHaveLength(1);
    expect(
      (merged[0] as Extract<TaskChatItem, { kind: "turn" }>).animateFold,
    ).toBe(true);
  });
});

describe("attachSettledTurns (round 9)", () => {
  const runA: TranscriptEntry[] = [
    {
      kind: "tool_call",
      ts: TS,
      name: "Read",
      toolUseId: "a-1",
    } as TranscriptEntry,
  ];

  function agentBubble(id: string, authorName = "CEO"): TaskChatItem {
    return { id, kind: "message", author: "agent", authorName, text: "Done." };
  }
  function settledTurn(id: string): TaskChatItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [
        { id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" },
      ],
      summary: buildTurnSummary(runA, { durationMs: 30_000 }),
    };
  }
  const metaById = new Map<string, SettledTurnMergeMeta>([
    [
      "run-a:turn",
      {
        agentKey: "agent-1",
        agentName: "CEO",
        parts: [{ entries: runA, durationMs: 30_000 }],
      },
    ],
  ]);

  it("folds a settled turn into the agent reply bubble directly above it", () => {
    const out = attachSettledTurns(
      [agentBubble("msg-a"), settledTurn("run-a:turn")],
      metaById,
    );
    expect(out).toHaveLength(1);
    const bubble = out[0] as Extract<TaskChatItem, { kind: "message" }>;
    expect(bubble.id).toBe("msg-a");
    expect(bubble.attachedTurn?.id).toBe("run-a:turn");
    expect(bubble.attachedTurn?.summary.durationLabel).toBe("30s");
  });

  it("keeps the standalone row when the preceding item is not that agent's bubble", () => {
    // Human message directly above.
    const afterHuman = attachSettledTurns(
      [
        { id: "msg-u", kind: "message", author: "human", text: "hi" },
        settledTurn("run-a:turn"),
      ],
      metaById,
    );
    expect(afterHuman.map((i) => i.kind)).toEqual(["message", "turn"]);
    // Another agent's bubble above.
    const otherAgent = attachSettledTurns(
      [agentBubble("msg-q", "QA"), settledTurn("run-a:turn")],
      metaById,
    );
    expect(otherAgent.map((i) => i.kind)).toEqual(["message", "turn"]);
    // No meta (unknown identity) → conservative standalone fallback.
    const noMeta = attachSettledTurns(
      [agentBubble("msg-a"), settledTurn("run-x:turn")],
      metaById,
    );
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
      [
        agentBubble("msg-a"),
        settledTurn("run-a:turn"),
        settledTurn("run-a:turn"),
      ],
      metaById,
    );
    expect(twice.map((i) => i.kind)).toEqual(["message", "turn"]);
    expect(
      (twice[0] as Extract<TaskChatItem, { kind: "message" }>).attachedTurn?.id,
    ).toBe("run-a:turn");
  });
});

describe("assembleThreadItems (PAP-367)", () => {
  function entry(
    id: string,
    ms: number,
    item?: Partial<TaskChatItem>,
  ): ThreadBackboneEntry {
    return {
      ms,
      id,
      item: {
        id,
        kind: "message",
        author: "human",
        text: `msg ${id}`,
        ...item,
      } as TaskChatItem,
    };
  }
  function settledTurn(id: string): TaskChatTurnItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [
        { id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" },
      ],
      summary: buildTurnSummary([toolCall("Read")], { durationMs: 34_000 }),
    };
  }
  const noAnchors = new Map<string, TaskChatTurnItem[]>();

  it("inserts a comment-less settled turn chronologically at its run's start time", () => {
    const backbone = [
      entry("u1", 1_000),
      entry("a1", 2_000, { author: "agent", authorName: "CEO" }),
      entry("u2", 3_000),
    ];
    const out = assembleThreadItems(backbone, noAnchors, [
      { turn: settledTurn("run-x:turn"), startMs: 2_500 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["u1", "a1", "run-x:turn", "u2"]);
  });

  it("does not append a comment-less turn after the newest user message (the P11 bug)", () => {
    // The screenshot bug: an OLD stopped run (start 1_500) re-pinning its
    // "Worked · 34s" row under every NEW user bubble (3_000).
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    const out = assembleThreadItems(backbone, noAnchors, [
      { turn: settledTurn("run-x:turn"), startMs: 1_500 },
    ]);
    expect(out.map((i) => i.id)).toEqual(["u1", "run-x:turn", "u2"]);
    expect(out[out.length - 1].id).toBe("u2");
  });

  it("keeps anchored turns directly after their run's reply comment", () => {
    const backbone = [
      entry("u1", 1_000),
      entry("a1", 2_000, { author: "agent", authorName: "CEO" }),
      entry("u2", 3_000),
    ];
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
    const tie = assembleThreadItems(backbone, noAnchors, [
      { turn: settledTurn("run-y:turn"), startMs: 1_000 },
    ]);
    expect(tie.map((i) => i.id)).toEqual(["u1", "run-y:turn", "u2"]);
  });

  it("chronological insertion after a user message stays a standalone row through coalesce+attach", () => {
    // Interplay guard: the inserted turn sits below a HUMAN bubble, so the
    // later passes must neither merge it into anything nor attach it.
    const backbone = [entry("u1", 1_000), entry("u2", 3_000)];
    const metaById = new Map<string, SettledTurnMergeMeta>([
      [
        "run-x:turn",
        {
          agentKey: "agent-1",
          agentName: "CEO",
          parts: [{ entries: [toolCall("Read")], durationMs: 34_000 }],
        },
      ],
    ]);
    const assembled = assembleThreadItems(backbone, noAnchors, [
      { turn: settledTurn("run-x:turn"), startMs: 1_500 },
    ]);
    const out = attachSettledTurns(
      coalesceSettledTurns(assembled, metaById),
      metaById,
    );
    expect(out.map((i) => i.id)).toEqual(["u1", "run-x:turn", "u2"]);
    expect(
      out.every(
        (i) =>
          i.kind !== "message" ||
          (i as Extract<TaskChatItem, { kind: "message" }>).attachedTurn ==
            null,
      ),
    ).toBe(true);
  });
});

describe("prependIssueBrief (PAP-375)", () => {
  function entry(id: string, ms: number): ThreadBackboneEntry {
    return {
      ms,
      id,
      item: {
        id,
        kind: "message",
        author: "human",
        text: `msg ${id}`,
      } as TaskChatItem,
    };
  }
  function settledTurn(id: string): TaskChatTurnItem {
    return {
      id,
      kind: "turn",
      settled: true,
      items: [
        { id: `${id}:tool:0`, kind: "tool", name: "Read", status: "completed" },
      ],
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
    expect(out.map((i) => i.id)).toEqual([
      ISSUE_BRIEF_ITEM_ID,
      "run-x:turn",
      "u1",
      "u2",
    ]);
    expect(out[0].kind).toBe("brief");
  });

  it("is the first item of an otherwise empty thread, and a no-op without a brief", () => {
    expect(prependIssueBrief([], true).map((i) => i.kind)).toEqual(["brief"]);
    const items = [entry("u1", 1_000).item];
    expect(prependIssueBrief(items, false)).toBe(items);
  });
});
