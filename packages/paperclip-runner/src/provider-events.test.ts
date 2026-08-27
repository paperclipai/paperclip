import { describe, expect, it } from "vitest";

import {
  CODEX_THREAD_ITEM_CLASSIFICATION,
  PROVIDER_EVENT_FAMILIES,
  canonicalProviderEventsFromAcpxRuntimeEvent,
  canonicalProviderEventsFromCodex,
  canonicalProviderEventsFromOpenCodePart,
  createAcpxToolEventNormalizer,
  providerFamilyCapabilities,
} from "./provider-events.js";
import { validatePrpEvent } from "./protocol/replay-contract.js";

function envelope(event: ReturnType<typeof canonicalProviderEventsFromCodex>[number]) {
  return {
    schema: "paperclip.prp.event.v1", sourceEventId: `source:${event.itemId}`, sourceSeq: 1,
    sourceInstanceId: "runner-1", sourceKind: "runner", runId: "run-1",
    normalizedSessionId: "session-1", turnId: "turn-1", itemId: event.itemId,
    eventType: event.eventType, schemaVersion: 1, priority: 1,
    emittedAt: "2026-08-21T12:00:00.000Z", payload: event.payload,
  };
}

describe("provider-neutral events", () => {
  it("classifies the complete qualified 18-variant Codex ThreadItem inventory", () => {
    expect(Object.keys(CODEX_THREAD_ITEM_CLASSIFICATION)).toEqual([
      "userMessage", "hookPrompt", "agentMessage", "plan", "reasoning",
      "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
      "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView",
      "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode",
      "contextCompaction",
    ]);
    expect(Object.values(CODEX_THREAD_ITEM_CLASSIFICATION)).not.toContain("unclassified");
    expect(CODEX_THREAD_ITEM_CLASSIFICATION.plan).toBe("existing_transcript");
  });

  it("negotiates every declared family and preserves explicit unsupported states", () => {
    const capabilities = providerFamilyCapabilities({ plan: "available", artifact: "policy_disabled" });
    expect(capabilities).toHaveLength(PROVIDER_EVENT_FAMILIES.length);
    expect(capabilities.find((entry) => entry.family === "plan")?.detailLevel).toBe("structured");
    expect(capabilities.find((entry) => entry.family === "artifact")?.availability).toBe("policy_disabled");
    expect(capabilities.find((entry) => entry.family === "memory")?.availability).toBe("unsupported");
  });

  it("maps representative Codex variants across every canonical family to valid PRP", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["turn/plan/updated", { turnId: "turn-1", plan: [{ step: "Ship it", status: "inProgress" }] }],
      ["item/completed", { item: { id: "exec-1", type: "commandExecution", status: "completed", output: "ok" } }],
      ["item/completed", { item: { id: "web-1", type: "webSearch", action: { type: "search", query: "PRP" }, results: [{ ref_id: "source-1", title: "Protocol notes", url: "https://example.com/prp", snippet: "Canonical event details" }] } }],
      ["item/completed", { item: { id: "child-1", type: "collabAgentToolCall", tool: "spawnAgent" } }],
      ["model/rerouted", { turnId: "turn-1", fromModel: "gpt-5", toModel: "gpt-5.1", reason: "capacity" }],
      ["thread/compacted", { itemId: "compact-1" }],
      ["item/completed", { item: { id: "image-1", type: "imageView", path: "artifacts/a.png" } }],
      ["item/completed", { item: { id: "review-1", type: "enteredReviewMode" } }],
      ["hook/completed", { run: { id: "hook-1", eventName: "post-tool", scope: "workspace", status: "completed" } }],
      ["item/completed", { item: { id: "message-1", type: "agentMessage", memoryCitation: { entries: [{ label: "Decision" }] } } }],
      ["item/autoApprovalReview/completed", { reviewId: "safety-1", targetItemId: "exec-1" }],
      ["item/commandExecution/terminalInteraction", { itemId: "exec-1", stdin: "secret input" }],
      ["item/completed", { item: { id: "wait-1", type: "sleep", durationMs: 1000 } }],
      ["warning", { message: "Update the provider configuration" }],
    ];
    const mapped = cases.flatMap(([method, params]) => canonicalProviderEventsFromCodex(method, params));
    expect(mapped).toHaveLength(cases.length);
    for (const event of mapped) expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
    expect(JSON.stringify(mapped.find((entry) => entry.eventType === "terminal.input.sent"))).not.toContain("secret input");
    expect(mapped.find((entry) => entry.eventType === "research.completed")?.payload.sources).toEqual([{
      sourceId: "source-1",
      title: "Protocol notes",
      url: "https://example.com/prp",
      snippet: "Canonical event details",
    }]);
  });

  it("bounds and filters Codex research sources before they enter PRP", () => {
    const event = canonicalProviderEventsFromCodex("item/completed", {
      item: {
        id: "web-1",
        type: "webSearch",
        results: [
          { ref_id: "good", title: "Good", url: "https://example.com/good", snippet: "x".repeat(5000) },
          { ref_id: "unsafe", title: "Unsafe", url: "file:///etc/passwd" },
        ],
      },
    })[0]!;
    expect(event.payload.sources).toEqual([expect.objectContaining({ sourceId: "good", url: "https://example.com/good", snippet: "x".repeat(4000) })]);
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("marks a turn plan complete when every native step is complete", () => {
    const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "completed" },
      ],
    })[0]!;
    expect(event).toMatchObject({
      itemId: "turn-1",
      eventType: "plan.updated",
      payload: {
        planId: "turn-1",
        complete: true,
        syncStatus: "not_applicable",
        documentRevision: null,
      },
    });
  });

  it("treats Codex proposed-plan text as transcript content, not a checklist", () => {
    expect(canonicalProviderEventsFromCodex("item/completed", {
      item: { id: "proposed-plan-1", type: "plan", text: "# Proposed implementation\n\nShip it." },
    })).toEqual([]);
  });

  it("uses an empty native plan as a stable clearing snapshot", () => {
    const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
      turnId: "turn-1",
      plan: [],
    })[0]!;
    expect(event).toMatchObject({
      itemId: "turn-1",
      payload: { planId: "turn-1", steps: [], complete: false },
    });
  });

  it("normalizes provider plan statuses without accepting malformed steps", () => {
    const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
      turnId: "turn-statuses",
      plan: [
        { step: "Active", status: "inProgress" },
        { step: "Blocked", status: "failed" },
        { step: "Later", status: "unexpected" },
        { step: "   ", status: "completed" },
      ],
    })[0]!;
    expect(event.payload.steps).toEqual([
      { stepId: "step-1", body: "Active", status: "in_progress" },
      { stepId: "step-2", body: "Blocked", status: "blocked" },
      { stepId: "step-3", body: "Later", status: "pending" },
    ]);
    expect(event.payload.complete).toBe(false);
  });

  it("preserves every structured ACPX plan entry in a stable turn snapshot", () => {
    const event = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "plan",
      tag: "plan",
      entries: [
        { content: "Inspect", status: "completed", priority: "high" },
        { content: "Implement", status: "in_progress", priority: "medium" },
        { content: "Verify", status: "pending", priority: "low" },
      ],
    } as never, "fallback", "turn-acp")[0]!;

    expect(event).toMatchObject({
      itemId: "turn-acp",
      eventType: "plan.updated",
      payload: {
        planId: "turn-acp",
        complete: false,
        syncStatus: "not_applicable",
        steps: [
          { body: "Inspect", status: "completed" },
          { body: "Implement", status: "in_progress" },
          { body: "Verify", status: "pending" },
        ],
      },
    });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("does not infer an ACPX checklist from legacy status text", () => {
    const events = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "status",
      tag: "plan",
      text: "Implement (in progress)",
    } as never, "fallback", "turn-acp");
    expect(events.some((event) => event.eventType === "plan.updated")).toBe(false);
  });

  it("bounds and sanitizes structured ACPX plan snapshots", () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      content: index === 3 ? "   " : `Step ${index} ${"x".repeat(5_000)}`,
      status: index === 0 ? "completed" : "pending",
    }));
    const event = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "plan",
      tag: "plan",
      entries,
    } as never, "fallback", "turn-bounded")[0]!;
    const steps = event.payload.steps as Array<{ body: string }>;
    expect(steps).toHaveLength(255);
    expect(steps.every((step) => step.body.length <= 4_000)).toBe(true);
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("classifies only structured OpenCode parts and never assistant prose", () => {
    expect(canonicalProviderEventsFromOpenCodePart({ id: "tool-1", type: "tool", tool: "read", state: { status: "completed", output: "done" } })[0]?.eventType).toBe("tool.execution.completed");
    expect(canonicalProviderEventsFromOpenCodePart({ id: "text-1", type: "text", text: "I ran a command and delegated work" })).toEqual([]);
  });

  it("maps OpenCode pending dynamic tools to a valid builtin execution start", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_02c35c313001X42cqyvQrpXOFv",
      type: "tool",
      tool: "paperclip_report_progress",
      callID: "call_6cd0302e681d44c2aba3c164",
      state: { status: "pending", input: {}, raw: "" },
    })[0]!;
    expect(event).toMatchObject({
      eventType: "tool.execution.started",
      payload: {
        schema: "paperclip.tool.execution.v1",
        transport: "builtin",
        status: "running",
        name: "paperclip_report_progress",
      },
    });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("preserves ACPX identity across title-less progress and completion updates", () => {
    const normalize = createAcpxToolEventNormalizer();
    const started = normalize({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "tool-1",
      title: "mcp__paperclip__search_tasks",
      kind: "other",
      status: "pending",
      text: "mcp__paperclip__search_tasks (pending)",
      locations: [{ path: "doc/plan.md", line: 4 }],
    } as never);
    const progressed = normalize({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "tool-1",
      title: "tool call",
      status: "in_progress",
      text: "Searching the task index",
    } as never);
    const completed = normalize({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "tool-1",
      title: "tool call",
      status: "completed",
      text: "tool call (completed)",
      rawOutput: { ok: true },
    } as never);

    expect(progressed).toMatchObject({
      title: "mcp__paperclip__search_tasks",
      kind: "other",
      text: "Searching the task index",
      locations: [{ path: "doc/plan.md", line: 4 }],
    });
    expect(completed).toMatchObject({
      title: "mcp__paperclip__search_tasks",
      kind: "other",
      locations: [{ path: "doc/plan.md", line: 4 }],
    });

    const mapped = [started, progressed, completed].flatMap((event, index) =>
      canonicalProviderEventsFromAcpxRuntimeEvent(event, `fallback-${index}`));
    expect(mapped.at(-1)).toMatchObject({
      eventType: "tool.execution.completed",
      payload: {
        transport: "mcp",
        namespace: "paperclip",
        name: "search_tasks",
        operation: "search",
        target: "doc/plan.md",
        status: "completed",
      },
    });
    for (const event of mapped) {
      expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
    }
  });

  it("normalizes dotted MCP names, ToolSearch, and truly unnamed calls", () => {
    const dotted = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "tool_call", tag: "tool_call", toolCallId: "mcp-1", title: "mcp.paperclip.get_task_context",
      kind: "other", status: "pending", text: "Starting",
    } as never, "fallback")[0]!;
    const toolSearch = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "tool_call", tag: "tool_call", toolCallId: "search-1", title: "ToolSearch",
      kind: "other", status: "pending", text: "Starting",
    } as never, "fallback")[0]!;
    const unnamed = canonicalProviderEventsFromAcpxRuntimeEvent({
      type: "tool_call", tag: "tool_call", toolCallId: "unknown-1", title: "tool call",
      kind: "other", status: "pending", text: "tool call (pending)",
    } as never, "fallback")[0]!;

    expect(dotted.payload).toMatchObject({ transport: "mcp", namespace: "paperclip", name: "get_task_context", operation: "read" });
    expect(toolSearch.payload).toMatchObject({ transport: "builtin", namespace: null, name: "ToolSearch", operation: "search" });
    expect(unnamed.payload).toMatchObject({ name: null, operation: "unknown" });
  });

  it("presents OpenCode's server-qualified semantic tool with its canonical name", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "finish-1",
      type: "tool",
      tool: "paperclip_paperclip_finish",
      state: { status: "running", input: {} },
    })[0]!;
    expect(event.payload).toMatchObject({ name: "paperclip_finish", transport: "builtin" });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("recovers an interrupted OpenCode function label and error from its structured call id", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_interrupted",
      type: "tool",
      tool: "unknown",
      callID: "functions.todowrite:0",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
      },
    })[0]!;
    expect(event).toMatchObject({
      eventType: "tool.execution.completed",
      payload: {
        name: "todowrite",
        status: "failed",
        output: "Tool execution aborted",
        outputBytes: 22,
      },
    });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("does not infer a tool label from an opaque provider call id", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_unknown",
      type: "tool",
      tool: "unknown",
      callID: "call_f3d79e",
      state: { status: "error", error: "Unavailable" },
    })[0]!;
    expect(event.payload).toMatchObject({ name: "unknown", output: "Unavailable" });
  });

  it("rejects a canonical event whose payload belongs to another family", () => {
    const plan = canonicalProviderEventsFromCodex("item/completed", {
      item: { id: "plan-1", type: "plan", text: "Ship it" },
    })[0]!;
    expect(validatePrpEvent(envelope({
      ...plan,
      eventType: "tool.execution.completed",
    }))).toMatchObject({ ok: false });
  });
});
