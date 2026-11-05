import { describe, expect, it } from "vitest";

import {
  CODEX_THREAD_ITEM_CLASSIFICATION,
  PROVIDER_EVENT_FAMILIES,
  canonicalProviderEventsFromAcpxRuntimeEvent,
  canonicalProviderEventsFromCodex,
  canonicalProviderEventsFromOpenCodePart,
  boundedAcpMeta,
  createAcpxToolEventNormalizer,
  createGrokMessageNormalizer,
  providerFamilyCapabilities,
} from "./provider-events.js";
import { validatePrpEvent } from "./protocol/replay-contract.js";

function envelope(
  event: ReturnType<typeof canonicalProviderEventsFromCodex>[number],
) {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `source:${event.itemId}`,
    sourceSeq: 1,
    sourceInstanceId: "runner-1",
    sourceKind: "runner",
    runId: "run-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    itemId: event.itemId,
    eventType: event.eventType,
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-21T12:00:00.000Z",
    payload: event.payload,
  };
}

describe("provider-neutral events", () => {
  it("keeps unrelated information as bounded run-log evidence without a provider notice", () => {
    const [event] = canonicalProviderEventsFromCodex("warning", {
      classification: "unrelated_information",
      message: "ignored unrelated provider information",
      providerMethod: "account/updated",
      expectedThreadId: "root",
      receivedThreadId: "x".repeat(300),
      expectedTurnId: "turn-1",
      receivedTurnId: null,
      accessToken: "not-for-the-log",
      planType: "private-account-data",
    });
    expect(event).toEqual({
      eventType: "harness.diagnostic",
      itemId: "provider-item",
      payload: {
        code: "codex_unrelated_information",
        classification: "unrelated_information",
        providerMethod: "account/updated",
        expectedThreadId: "root",
        receivedThreadId: "x".repeat(244) + "…[truncated]",
        expectedTurnId: "turn-1",
        receivedTurnId: null,
      },
    });
    expect(validatePrpEvent(envelope(event)).ok).toBe(true);
    const [unicodeEvent] = canonicalProviderEventsFromCodex("warning", {
      classification: "unrelated_information",
      expectedThreadId: "token=not-for-the-log",
      receivedThreadId: "😀".repeat(300),
    });
    expect(unicodeEvent.payload).toMatchObject({
      expectedThreadId: "token=[REDACTED]",
      receivedThreadId: "😀".repeat(244) + "…[truncated]",
      receivedTurnId: null,
    });
    expect(canonicalProviderEventsFromCodex("error", {
      classification: "unrelated_information",
      message: "Provider connection failed",
    })[0].eventType).toBe("provider.notice.recorded");
  });

  it("maps Codex TurnError text, retries and error info into the notice", () => {
    const [retry] = canonicalProviderEventsFromCodex("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: {
        message: "Reconnecting... 2/5",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        additionalDetails: "stream closed before response.completed",
      },
    });
    expect(retry.payload).toMatchObject({
      severity: "warning",
      category: "provider_retry",
      recoverable: true,
      summary: "stream closed before response.completed",
      details: [
        { name: "Attempt", value: "2" },
        { name: "Max attempts", value: "5" },
        { name: "Reason", value: "responseStreamDisconnected" },
        { name: "HTTP status", value: "502" },
      ],
    });
    expect(validatePrpEvent(envelope(retry)).ok).toBe(true);

    const [fatal] = canonicalProviderEventsFromCodex("error", {
      turnId: "turn-1",
      willRetry: false,
      error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null },
    });
    expect(fatal.payload).toMatchObject({
      severity: "error",
      category: "error",
      recoverable: false,
      summary: "You've hit your usage limit.",
      details: [{ name: "Reason", value: "usageLimitExceeded" }],
    });
    expect(fatal.payload.noticeId).not.toBe(retry.payload.noticeId);
    expect(validatePrpEvent(envelope(fatal)).ok).toBe(true);
  });

  it("preserves Codex notice summaries with legacy and empty-message fallbacks", () => {
    for (const method of ["configWarning", "deprecationNotice", "warning"]) {
      for (const [params, expected] of [
        [{ summary: "Repository is not trusted", message: "old message" }, "Repository is not trusted"],
        [{ summary: " ", message: "Legacy warning" }, "Legacy warning"],
        [{ details: "Additional warning details" }, "Additional warning details"],
        [{}, "Provider notice"],
      ] as const) {
        const [event] = canonicalProviderEventsFromCodex(method, params);
        expect(event.eventType).toBe("provider.notice.recorded");
        expect(event.payload.summary).toBe(expected);
        expect(event.payload.userActionable).toBe(false);
        expect(validatePrpEvent(envelope(event)).ok).toBe(true);
      }
    }
  });

  it("maps a failed Codex MCP server start to a user-facing notice", () => {
    const [event] = canonicalProviderEventsFromCodex("mcpServer/startupStatus/updated", {
      threadId: null,
      name: "paperclip",
      status: "failed",
      error: "MCP client for `paperclip` failed to start: program not found: paperclip-mcp",
      failureReason: null,
    });
    expect(event).toMatchObject({
      eventType: "provider.notice.recorded",
      itemId: "mcp-startup:paperclip",
      payload: {
        severity: "warning",
        category: "mcp_server_startup_failed",
        scope: "session",
        userActionable: true,
        summary: "paperclip MCP server failed to start: program not found: paperclip-mcp",
        details: [
          { name: "server", value: "paperclip" },
          { name: "reason", value: "program not found: paperclip-mcp" },
        ],
      },
    });
    expect(validatePrpEvent(envelope(event)).ok).toBe(true);

    const [reauth] = canonicalProviderEventsFromCodex("mcpServer/startupStatus/updated", {
      name: "linear", status: "failed", error: null, failureReason: "reauthenticationRequired",
    });
    expect(reauth.payload.summary).toBe("linear MCP server failed to start: needs re-authentication");
    // Codex 0.160's own wording, observed on a live run.
    const [live] = canonicalProviderEventsFromCodex("mcpServer/startupStatus/updated", {
      name: "github", status: "failed",
      error: "MCP client for `github` failed to start: MCP startup failed: No such file or directory (os error 2)",
    });
    expect(live.payload.summary).toBe("github MCP server failed to start: No such file or directory (os error 2)");
    expect(validatePrpEvent(envelope(reauth)).ok).toBe(true);

    for (const status of ["starting", "ready", "cancelled"]) {
      expect(canonicalProviderEventsFromCodex("mcpServer/startupStatus/updated", { name: "paperclip", status })).toEqual([]);
    }
  });

  it("classifies the complete qualified 18-variant Codex ThreadItem inventory", () => {
    expect(Object.keys(CODEX_THREAD_ITEM_CLASSIFICATION)).toEqual([
      "userMessage",
      "hookPrompt",
      "agentMessage",
      "plan",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "imageView",
      "sleep",
      "imageGeneration",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
    ]);
    expect(Object.values(CODEX_THREAD_ITEM_CLASSIFICATION)).not.toContain(
      "unclassified",
    );
    expect(CODEX_THREAD_ITEM_CLASSIFICATION.plan).toBe("existing_transcript");
  });

  it("negotiates every declared family and preserves explicit unsupported states", () => {
    const capabilities = providerFamilyCapabilities({
      plan: "available",
      artifact: "policy_disabled",
    });
    expect(capabilities).toHaveLength(PROVIDER_EVENT_FAMILIES.length);
    expect(
      capabilities.find((entry) => entry.family === "plan")?.detailLevel,
    ).toBe("structured");
    expect(
      capabilities.find((entry) => entry.family === "artifact")?.availability,
    ).toBe("policy_disabled");
    expect(
      capabilities.find((entry) => entry.family === "memory")?.availability,
    ).toBe("unsupported");
  });

  it("maps representative Codex variants across every canonical family to valid PRP", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "turn/plan/updated",
        { turnId: "turn-1", plan: [{ step: "Ship it", status: "inProgress" }] },
      ],
      [
        "item/completed",
        {
          item: {
            id: "exec-1",
            type: "commandExecution",
            status: "completed",
            output: "ok",
          },
        },
      ],
      [
        "item/completed",
        {
          item: {
            id: "web-1",
            type: "webSearch",
            action: { type: "search", query: "PRP" },
            results: [
              {
                ref_id: "source-1",
                title: "Protocol notes",
                url: "https://example.com/prp",
                snippet: "Canonical event details",
              },
            ],
          },
        },
      ],
      [
        "item/completed",
        {
          item: {
            id: "child-1",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
          },
        },
      ],
      [
        "model/rerouted",
        {
          turnId: "turn-1",
          fromModel: "gpt-5",
          toModel: "gpt-5.1",
          reason: "capacity",
        },
      ],
      ["thread/compacted", { itemId: "compact-1" }],
      [
        "item/completed",
        { item: { id: "image-1", type: "imageView", path: "artifacts/a.png" } },
      ],
      [
        "item/completed",
        { item: { id: "review-1", type: "enteredReviewMode" } },
      ],
      [
        "hook/completed",
        {
          run: {
            id: "hook-1",
            eventName: "post-tool",
            scope: "workspace",
            status: "completed",
          },
        },
      ],
      [
        "item/completed",
        {
          item: {
            id: "message-1",
            type: "agentMessage",
            memoryCitation: { entries: [{ label: "Decision" }] },
          },
        },
      ],
      [
        "item/autoApprovalReview/completed",
        { reviewId: "safety-1", targetItemId: "exec-1" },
      ],
      [
        "item/commandExecution/terminalInteraction",
        { itemId: "exec-1", stdin: "secret input" },
      ],
      [
        "item/completed",
        { item: { id: "wait-1", type: "sleep", durationMs: 1000 } },
      ],
      ["warning", { message: "Update the provider configuration" }],
    ];
    const mapped = cases.flatMap(([method, params]) =>
      canonicalProviderEventsFromCodex(method, params),
    );
    expect(mapped).toHaveLength(cases.length);
    for (const event of mapped)
      expect(validatePrpEvent(envelope(event))).toEqual({
        ok: true,
        event: expect.any(Object),
        issues: [],
      });
    expect(
      JSON.stringify(
        mapped.find((entry) => entry.eventType === "terminal.input.sent"),
      ),
    ).not.toContain("secret input");
    expect(
      mapped.find((entry) => entry.eventType === "research.completed")?.payload
        .sources,
    ).toEqual([
      {
        sourceId: "source-1",
        title: "Protocol notes",
        url: "https://example.com/prp",
        snippet: "Canonical event details",
      },
    ]);
  });

  it("bounds and filters Codex research sources before they enter PRP", () => {
    const event = canonicalProviderEventsFromCodex("item/completed", {
      item: {
        id: "web-1",
        type: "webSearch",
        results: [
          {
            ref_id: "good",
            title: "Good",
            url: "https://example.com/good",
            snippet: "x".repeat(5000),
          },
          { ref_id: "unsafe", title: "Unsafe", url: "file:///etc/passwd" },
        ],
      },
    })[0]!;
    expect(event.payload.sources).toEqual([
      expect.objectContaining({
        sourceId: "good",
        url: "https://example.com/good",
        snippet: "x".repeat(4000),
      }),
    ]);
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("bounds Codex plan explanations before they enter PRP", () => {
    const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
      turnId: "turn-1",
      explanation: "x".repeat(5000),
      plan: [{ step: "Ship it", status: "inProgress" }],
    })[0]!;
    expect(event.payload.explanation).toBe("x".repeat(4000));
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("normalizes malformed or non-positive Codex plan revisions", () => {
    for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
        turnId: "turn-revision",
        revision,
        plan: [{ step: "Ship it", status: "inProgress" }],
      })[0]!;
      expect(event.payload.revision).toBe(1);
      expect(validatePrpEvent(envelope(event))).toEqual({
        ok: true,
        event: expect.any(Object),
        issues: [],
      });
    }
    expect(
      canonicalProviderEventsFromCodex("turn/plan/updated", {
        turnId: "turn-revision",
        revision: 7,
        plan: [],
      })[0]?.payload.revision,
    ).toBe(7);
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
    expect(
      canonicalProviderEventsFromCodex("item/completed", {
        item: {
          id: "proposed-plan-1",
          type: "plan",
          text: "# Proposed implementation\n\nShip it.",
        },
      }),
    ).toEqual([]);
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
    const event = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "plan",
        tag: "plan",
        entries: [
          { content: "Inspect", status: "completed", priority: "high" },
          { content: "Implement", status: "in_progress", priority: "medium" },
          { content: "Verify", status: "pending", priority: "low" },
        ],
      } as never,
      "fallback",
      "turn-acp",
    )[0]!;

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
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("does not infer an ACPX checklist from legacy status text", () => {
    const events = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "status",
        tag: "plan",
        text: "Implement (in progress)",
      } as never,
      "fallback",
      "turn-acp",
    );
    expect(events.some((event) => event.eventType === "plan.updated")).toBe(
      false,
    );
  });

  it("bounds and sanitizes structured ACPX plan snapshots", () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      content: index === 3 ? "   " : `Step ${index} ${"x".repeat(5_000)}`,
      status: index === 0 ? "completed" : "pending",
    }));
    const event = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "plan",
        tag: "plan",
        entries,
      } as never,
      "fallback",
      "turn-bounded",
    )[0]!;
    const steps = event.payload.steps as Array<{ body: string }>;
    expect(steps).toHaveLength(255);
    expect(steps.every((step) => step.body.length <= 4_000)).toBe(true);
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("classifies only structured OpenCode parts and never assistant prose", () => {
    expect(
      canonicalProviderEventsFromOpenCodePart({
        id: "tool-1",
        type: "tool",
        tool: "read",
        state: { status: "completed", output: "done" },
      })[0]?.eventType,
    ).toBe("tool.execution.completed");
    expect(
      canonicalProviderEventsFromOpenCodePart({
        id: "text-1",
        type: "text",
        text: "I ran a command and delegated work",
      }),
    ).toEqual([]);
  });

  it.each([0, 37, -1])("preserves OpenCode bash metadata exit %i without changing tool completion", (exit) => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "bash-part", type: "tool", tool: "bash", callID: "bash-call",
      state: { status: "completed", input: { command: "node verify.mjs" },
        output: "Work validation finished", metadata: { exit, truncated: false }, time: { start: 1, end: 2 } },
    })[0]!;
    expect(event).toMatchObject({ eventType: "tool.execution.completed", itemId: "bash-part",
      payload: { executionId: "bash-part", name: "bash", status: "completed", exitCode: exit } });
    expect(validatePrpEvent(envelope(event)).ok).toBe(true);
  });

  it.each([undefined, null, "37", 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("does not infer a bash exit from invalid metadata %s", (exit) => {
    const event = canonicalProviderEventsFromOpenCodePart({ id: "bash-invalid", type: "tool", tool: "bash",
      state: { status: "completed", output: "exitCode=37", metadata: { exit } } })[0]!;
    expect(event.payload.exitCode).toBeNull();
  });

  it.each([
    { type: "tool", tool: "read", state: { status: "completed" } },
    { type: "tool", tool: "mcp_bash", state: { status: "completed" } },
    { type: "tool", tool: "unknown", callID: "functions.bash:0", state: { status: "completed" } },
    { type: "bash", state: { status: "completed" } },
    { type: "tool", tool: "bash", state: { status: "running" } },
    { type: "tool", tool: "bash", state: { status: "error", error: "Tool execution aborted" } },
  ])("rejects metadata exits outside a completed builtin bash part %#", (part) => {
    const event = canonicalProviderEventsFromOpenCodePart({ id: "not-bash-complete", ...part,
      state: { ...part.state, metadata: { exit: 37 } } })[0]!;
    expect(event.payload.exitCode).toBeNull();
  });

  it.each([0, 37, "37", 1.5])("rejects conflicting legacy and metadata exits %s", (exit) => {
    const event = canonicalProviderEventsFromOpenCodePart({ id: "bash-conflict", type: "tool", tool: "bash",
      state: { status: "completed", exit, metadata: { exit: 1 } } })[0]!;
    expect(event.payload.exitCode).toBeNull();
  });

  it.each([
    { tool: "bash", exit: 37, metadata: undefined },
    { tool: "bash", exit: 37, metadata: { exit: 37 } },
    { tool: "bash", exit: 37, metadata: { exit: "37" } },
    { tool: "read", exit: 37, metadata: { exit: 1 } },
  ])("preserves an existing legacy numeric exit %#", ({ tool, exit, metadata }) => {
    const event = canonicalProviderEventsFromOpenCodePart({ id: "legacy-exit", type: "tool", tool,
      state: { status: "completed", exit, metadata } })[0]!;
    expect(event.payload.exitCode).toBe(exit);
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
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("forwards ACP _meta as a bounded JSON-safe copy on every runtime event", () => {
    const normalize = createAcpxToolEventNormalizer();
    const tool = normalize({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "tool-meta",
      title: "Terminal",
      status: "pending",
      _meta: {
        claudeCode: { toolName: "Bash", parentToolUseId: "toolu_parent" },
        terminal_exit: { exit_code: 2, signal: null },
        ["__proto__"]: { polluted: true },
      },
    } as never);
    expect(tool._meta).toEqual({
      claudeCode: { toolName: "Bash", parentToolUseId: "toolu_parent" },
      terminal_exit: { exit_code: 2, signal: null },
    });
    const status = normalize({
      type: "status",
      tag: "usage_update",
      text: "usage updated",
      _meta: { "_claude/rateLimit": { status: "allowed", utilization: 0.78 } },
    } as never);
    expect(status._meta).toEqual({
      "_claude/rateLimit": { status: "allowed", utilization: 0.78 },
    });
    expect(
      normalize({ type: "status", text: "x", _meta: "not an object" } as never),
    ).not.toHaveProperty("_meta");
  });

  it("bounds ACP _meta depth, breadth, string size and total size", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 10; index += 1) deep = { next: deep };
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`k${index}`, index]),
    );
    const bounded = boundedAcpMeta({
      deep,
      wide,
      long: "x".repeat(10_000),
      big: Array.from({ length: 64 }, () => "y".repeat(3_000)),
      notFinite: Number.POSITIVE_INFINITY,
      fn: () => undefined,
    })!;
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(16_000);
    expect(Object.keys(bounded.wide as object)).toHaveLength(64);
    expect((bounded.long as string).length).toBe(4_000);
    expect(bounded).not.toHaveProperty("notFinite");
    expect(bounded).not.toHaveProperty("fn");
    expect(JSON.stringify(bounded.deep)).not.toContain("leaf");
    expect(boundedAcpMeta([1, 2])).toBeUndefined();
    expect(boundedAcpMeta({})).toBeUndefined();
  });

  it("charges every retained container, separator and escaped byte against the ACP _meta budget", () => {
    let tree: unknown = [];
    for (let level = 0; level < 3; level += 1) tree = Array.from({ length: 64 }, () => tree);
    const nested = boundedAcpMeta({ a: tree })!;
    expect(Buffer.byteLength(JSON.stringify(nested))).toBeLessThanOrEqual(16_000);
    const escaped = boundedAcpMeta({ nulls: "\u0000".repeat(4_000), ok: "kept?" })!;
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThanOrEqual(16_000);
    expect(escaped).not.toHaveProperty("nulls");
    expect(escaped.ok).toBe("kept?");
  });

  it("inspects a bounded number of keys on a very wide ACP _meta object", () => {
    let reads = 0;
    const wide = new Proxy(
      Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`__proto__x${index}`.replace("__proto__x", "k"), index])),
      { get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); } },
    );
    const bounded = boundedAcpMeta({ wide })!;
    expect(Object.keys(bounded.wide as object)).toHaveLength(64);
    expect(reads).toBeLessThanOrEqual(64);
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
      canonicalProviderEventsFromAcpxRuntimeEvent(event, `fallback-${index}`),
    );
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
      expect(validatePrpEvent(envelope(event))).toEqual({
        ok: true,
        event: expect.any(Object),
        issues: [],
      });
    }
  });

  it("bounds ACPX lifecycle identities and metadata before retaining them", () => {
    const normalize = createAcpxToolEventNormalizer();
    const providerId = `provider-tool-${"x".repeat(1_000)}`;
    const started = normalize({
      type: "tool_call",
      toolCallId: providerId,
      title: "t".repeat(8_000),
      kind: "read",
      status: "pending",
      text: "p".repeat(8_000),
      locations: [{ path: "a".repeat(8_000), line: 7 }],
    } as never);
    const progressed = normalize({
      type: "tool_call",
      toolCallId: providerId,
      title: "tool call",
      status: "in_progress",
    } as never);

    expect(started.toolCallId).toMatch(/^acpx-tool-[a-f0-9]{64}$/);
    expect(progressed.toolCallId).toBe(started.toolCallId);
    expect(Buffer.byteLength(String(progressed.title))).toBeLessThanOrEqual(
      4_000,
    );
    expect(Buffer.byteLength(String(progressed.text))).toBeLessThanOrEqual(
      4_000,
    );
    expect(
      Buffer.byteLength(
        String(
          (progressed.locations?.[0] as { path?: unknown } | undefined)?.path,
        ),
      ),
    ).toBeLessThanOrEqual(4_000);
  });

  it("evicts terminal and excess ACPX tool lifecycle metadata", () => {
    const normalize = createAcpxToolEventNormalizer();
    normalize({
      type: "tool_call",
      toolCallId: "terminal-tool",
      title: "Completed title",
      status: "pending",
    } as never);
    normalize({
      type: "tool_call",
      toolCallId: "terminal-tool",
      title: "tool call",
      status: "completed",
    } as never);
    expect(
      normalize({
        type: "tool_call",
        toolCallId: "terminal-tool",
        title: "tool call",
        status: "pending",
      } as never).title,
    ).toBeUndefined();

    for (let index = 0; index <= 512; index += 1) {
      normalize({
        type: "tool_call",
        toolCallId: `bounded-tool-${index}`,
        title: `Title ${index}`,
        status: "pending",
      } as never);
    }
    expect(
      normalize({
        type: "tool_call",
        toolCallId: "bounded-tool-0",
        title: "tool call",
        status: "in_progress",
      } as never).title,
    ).toBeUndefined();
  });

  it("treats provider status metacharacters as literal progress text", () => {
    const normalize = createAcpxToolEventNormalizer();
    expect(() =>
      normalize({
        type: "tool_call",
        tag: "tool_call",
        toolCallId: "tool-hostile-status",
        title: "Read",
        kind: "read",
        status: "[",
        text: "Read ([)",
      } as never),
    ).not.toThrow();
    expect(
      normalize({
        type: "tool_call",
        tag: "tool_call_update",
        toolCallId: "tool-hostile-status",
        title: "Read",
        status: "(",
        text: "Meaningful progress",
      } as never),
    ).toMatchObject({ text: "Meaningful progress" });
  });

  it("normalizes dotted MCP names, ToolSearch, and truly unnamed calls", () => {
    const dotted = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call",
        toolCallId: "mcp-1",
        title: "mcp.paperclip.get_task_context",
        kind: "other",
        status: "pending",
        text: "Starting",
      } as never,
      "fallback",
    )[0]!;
    const toolSearch = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call",
        toolCallId: "search-1",
        title: "ToolSearch",
        kind: "other",
        status: "pending",
        text: "Starting",
      } as never,
      "fallback",
    )[0]!;
    const unnamed = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call",
        toolCallId: "unknown-1",
        title: "tool call",
        kind: "other",
        status: "pending",
        text: "tool call (pending)",
      } as never,
      "fallback",
    )[0]!;

    expect(dotted.payload).toMatchObject({
      transport: "mcp",
      namespace: "paperclip",
      name: "get_task_context",
      operation: "read",
    });
    expect(toolSearch.payload).toMatchObject({
      transport: "builtin",
      namespace: null,
      name: "ToolSearch",
      operation: "search",
    });
    expect(unnamed.payload).toMatchObject({ name: null, operation: "unknown" });
  });

  it("records only ACP tool-input presence without exporting input values", () => {
    const update = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call_update",
        toolCallId: "acpx-input-1",
        title: "paperclip.search_tasks",
        kind: "other",
        status: "pending",
        rawInput: { query: "private value" },
      },
      "fallback",
    )[0]!;
    const statusOnly = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call_update",
        toolCallId: "acpx-input-1",
        title: "paperclip.search_tasks",
        kind: "other",
        status: "pending",
      },
      "fallback",
    )[0]!;
    expect(update.payload).toMatchObject({ inputUpdated: true });
    expect(update.payload).not.toHaveProperty("rawInput");
    expect(JSON.stringify(update.payload)).not.toContain("private value");
    expect(statusOnly.payload).not.toHaveProperty("inputUpdated");
    expect(
      canonicalProviderEventsFromAcpxRuntimeEvent(
        { ...statusOnly.payload, type: "tool_call", inputUpdated: false } as never,
        "fallback",
      )[0]!.payload,
    ).toMatchObject({ inputUpdated: false });
  });

  it("presents OpenCode's server-qualified semantic tool with its canonical name", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "finish-1",
      type: "tool",
      tool: "paperclip_paperclip_finish",
      state: { status: "running", input: {} },
    })[0]!;
    expect(event.payload).toMatchObject({
      name: "paperclip_finish",
      transport: "builtin",
    });
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
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
    expect(validatePrpEvent(envelope(event))).toEqual({
      ok: true,
      event: expect.any(Object),
      issues: [],
    });
  });

  it("does not infer a tool label from an opaque provider call id", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_unknown",
      type: "tool",
      tool: "unknown",
      callID: "call_f3d79e",
      state: { status: "error", error: "Unavailable" },
    })[0]!;
    expect(event.payload).toMatchObject({
      name: "unknown",
      output: "Unavailable",
    });
  });

  it("rejects a canonical event whose payload belongs to another family", () => {
    const plan = canonicalProviderEventsFromCodex("item/completed", {
      item: { id: "plan-1", type: "plan", text: "Ship it" },
    })[0]!;
    expect(
      validatePrpEvent(
        envelope({
          ...plan,
          eventType: "tool.execution.completed",
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});


describe("Grok output message boundaries", () => {
  it("keeps streamed chunks together and separates commentary from the post-tool answer", () => {
    const normalize = createGrokMessageNormalizer();
    expect(normalize({ type: "text_delta", text: "I will " }).messageId).toBe("grok-output-0");
    expect(normalize({ type: "text_delta", text: "check." }).messageId).toBe("grok-output-0");
    normalize({ type: "tool_call", toolCallId: "tool", status: "pending" });
    normalize({ type: "tool_call", toolCallId: "tool", status: "completed" });
    const thought = { type: "text_delta", stream: "thought", text: "private" };
    expect(normalize(thought)).toBe(thought);
    expect(normalize({ type: "text_delta", text: "Final" }).messageId).toBe("grok-output-1");
    expect(normalize({ type: "text_delta", text: " answer" }).messageId).toBe("grok-output-1");
  });
  it("preserves native IDs and does not invent boundaries for status updates", () => {
    const normalize = createGrokMessageNormalizer();
    expect(normalize({ type: "text_delta", messageId: "native-id", text: "hi" }).messageId).toBe("native-id");
    normalize({ type: "status", text: "working" });
    expect(normalize({ type: "text_delta", messageId: "native-id", text: " there" }).messageId).toBe("native-id");
    const reasoning = { type: "text_delta", tag: "agent_thought_chunk", text: "private" };
    expect(normalize(reasoning)).toBe(reasoning);
  });
});

describe("edit file changes", () => {
  it("turns a Codex fileChange item into a schema-valid edit row with its patch", () => {
    const [started] = canonicalProviderEventsFromCodex(
      "item/started",
      {
        item: {
          id: "call-1",
          type: "fileChange",
          status: "inProgress",
          changes: [
            { path: "/work/repo/src/a.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
            { path: "src/new.js", kind: { type: "add" }, diff: "x\ny\n" },
          ],
        },
      },
      { workingDirectory: "/work/repo" },
    );
    expect(started).toMatchObject({
      eventType: "tool.execution.started",
      payload: {
        operation: "edit",
        name: "apply_patch",
        target: "src/a.js",
        fileChanges: [
          { path: "src/a.js", operation: "modify", additions: 1, deletions: 1 },
          { path: "src/new.js", operation: "create", additions: 2, deletions: 0, diff: "@@ -0,0 +1,2 @@\n+x\n+y\n" },
        ],
      },
    });
    expect(validatePrpEvent(envelope(started!)).ok).toBe(true);
  });

  it("maps Claude ACP diff content to fileChanges and names the edited file", () => {
    const [event] = canonicalProviderEventsFromAcpxRuntimeEvent(
      {
        type: "tool_call",
        tag: "tool_call_update",
        toolCallId: "tool-1",
        title: "Edit price.js",
        kind: "edit",
        status: "completed",
        locations: [{ path: "/work/repo/price.js", line: 3 }],
        content: [{ type: "diff", path: "/work/repo/price.js", oldText: "a\nb", newText: "a\nc" }],
      },
      "fallback",
      "turn-1",
      { workingDirectory: ["/work/repo"] },
    );
    expect(event?.payload).toMatchObject({
      target: "price.js",
      fileChanges: [{ path: "price.js", operation: "modify", additions: 1, deletions: 1, diff: "@@ -3,2 +3,2 @@\n a\n-b\n+c\n" }],
    });
    expect(validatePrpEvent(envelope(event!)).ok).toBe(true);
  });
});
