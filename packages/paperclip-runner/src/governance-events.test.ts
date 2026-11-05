import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromAcpxRuntimeEvent, canonicalProviderEventsFromCodex } from "./provider-events.js";
import { validatePrpEvent } from "./protocol/replay-contract.js";

type Mapped = ReturnType<typeof canonicalProviderEventsFromCodex>[number];

function valid(event: Mapped) {
  return validatePrpEvent({
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
    emittedAt: "2026-11-05T12:00:00.000Z",
    payload: event.payload,
  });
}

function one(method: string, params: unknown): Mapped {
  const events = canonicalProviderEventsFromCodex(method, params);
  expect(events).toHaveLength(1);
  expect(valid(events[0]!)).toMatchObject({ ok: true, issues: [] });
  return events[0]!;
}

/** Shape of Codex 0.160 `HookRunSummary`. */
function hookRun(overrides: Record<string, unknown>) {
  return {
    id: "pre_tool_use:0:/Users/agent/.codex/hooks/protect-migrations.sh",
    eventName: "preToolUse",
    handlerType: "command",
    executionMode: "sync",
    scope: "turn",
    sourcePath: "/Users/agent/.codex/hooks/protect-migrations.sh",
    source: "user",
    displayOrder: 0,
    status: "completed",
    statusMessage: null,
    startedAt: 1_793_890_000_000,
    completedAt: 1_793_890_000_041,
    durationMs: 41,
    entries: [],
    ...overrides,
  };
}

describe("Codex hook events", () => {
  it("records a blocking hook's outcome, message and script name without the host path", () => {
    const event = one("hook/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      run: hookRun({
        status: "blocked",
        entries: [{ kind: "stop", text: "Migrations are append-only. Add a new migration instead." }],
      }),
    });
    expect(event.eventType).toBe("hook.completed");
    expect(event.payload).toMatchObject({
      event: "preToolUse",
      status: "blocked",
      outcome: "blocked",
      blocking: true,
      durationMs: 41,
      message: "Migrations are append-only. Add a new migration instead.",
      source: "protect-migrations.sh",
    });
    expect(JSON.stringify(event.payload)).not.toContain("/Users/agent");
  });

  it("distinguishes running, passed, context, feedback, stopped and failed hooks", () => {
    const outcome = (method: string, run: Record<string, unknown>) =>
      one(method, { threadId: "t", turnId: null, run: hookRun(run) }).payload.outcome;
    expect(outcome("hook/started", { status: "running", durationMs: null, completedAt: null })).toBe("running");
    expect(outcome("hook/completed", {})).toBe("passed");
    expect(outcome("hook/completed", { eventName: "userPromptSubmit", entries: [{ kind: "context", text: "On call: Ana" }] })).toBe("context");
    expect(outcome("hook/completed", { eventName: "stop", entries: [{ kind: "feedback", text: "Run the tests first." }] })).toBe("feedback");
    expect(outcome("hook/completed", { status: "stopped", entries: [{ kind: "stop", text: "Budget reached." }] })).toBe("stopped");
    expect(outcome("hook/completed", { status: "failed", entries: [{ kind: "error", text: "op: command not found" }] })).toBe("failed");
  });

  it("marks async hooks as non-blocking", () => {
    expect(one("hook/completed", { threadId: "t", turnId: null, run: hookRun({ executionMode: "async" }) }).payload.blocking).toBe(false);
  });
});

describe("Codex approval auto-review events", () => {
  const base = {
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 1_793_890_000_000,
    reviewId: "review-1",
    targetItemId: "call_rm build",
    action: { type: "command", source: "shell", command: "rm -rf build/", cwd: "/work" },
  };

  it("records the decision, action, risk and rationale instead of an unknown decision", () => {
    const event = one("item/autoApprovalReview/completed", {
      ...base,
      completedAtMs: 1_793_890_002_000,
      decisionSource: "agent",
      review: {
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Removes a generated build directory inside the workspace.",
      },
    });
    expect(event.eventType).toBe("safety.review.completed");
    expect(event.payload).toMatchObject({
      status: "completed",
      decision: "allowed",
      targetExecutionId: "call_rm-build",
      actionKind: "command",
      action: "rm -rf build/",
      riskLevel: "low",
      userAuthorization: "high",
      summary: "Removes a generated build directory inside the workspace.",
      decidedBy: "agent",
    });
  });

  it("starts as a pending review", () => {
    const event = one("item/autoApprovalReview/started", {
      ...base,
      review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null },
    });
    expect(event.payload).toMatchObject({ status: "running", decision: "pending", action: "rm -rf build/" });
  });

  it("maps denied, timed out and aborted reviews", () => {
    const decision = (status: string) =>
      one("item/autoApprovalReview/completed", {
        ...base,
        completedAtMs: 1,
        decisionSource: "agent",
        review: { status, riskLevel: "high", userAuthorization: "low", rationale: "No." },
      }).payload.decision;
    expect(decision("denied")).toBe("denied");
    expect(decision("timedOut")).toBe("timed_out");
    expect(decision("aborted")).toBe("aborted");
  });

  it("summarizes non-command actions without echoing terminal input", () => {
    const action = (value: Record<string, unknown>) =>
      one("item/autoApprovalReview/completed", {
        ...base,
        targetItemId: null,
        completedAtMs: 1,
        decisionSource: "agent",
        action: value,
        review: { status: "approved", riskLevel: "low", userAuthorization: null, rationale: null },
      }).payload;
    expect(action({ type: "networkAccess", target: "https://registry.npmjs.org", host: "registry.npmjs.org", protocol: "https", port: 443 }))
      .toMatchObject({ actionKind: "networkAccess", action: "registry.npmjs.org:443", targetExecutionId: null });
    expect(action({ type: "applyPatch", cwd: "/work", files: ["a.ts", "b.ts"] }).action).toBe("edit 2 files: a.ts, b.ts");
    expect(action({ type: "mcpToolCall", server: "github", toolName: "merge_pull_request", connectorId: null, connectorName: null, toolTitle: null }).action)
      .toBe("github · merge_pull_request");
    const stdin = action({ type: "writeStdin", approvalId: "a", processId: "p", stdin: "hunter2\n", cwd: "/work" });
    expect(stdin.action).toBe("input to a running command");
    expect(JSON.stringify(stdin)).not.toContain("hunter2");
  });
});

describe("Claude hook events (claude-agent-acp session_info_update _meta)", () => {
  function claude(hook: Record<string, unknown>): Mapped {
    const events = canonicalProviderEventsFromAcpxRuntimeEvent(
      { type: "status", tag: "session_info_update", text: "session info updated", _meta: { claudeCode: { hook } } } as never,
      "fallback-1",
      "turn-1",
    );
    expect(events).toHaveLength(1);
    expect(valid(events[0]!)).toMatchObject({ ok: true, issues: [] });
    return events[0]!;
  }
  const response = (overrides: Record<string, unknown>) =>
    claude({ phase: "completed", hookId: "hook-abc", hookName: "PreToolUse:Write", hookEvent: "PreToolUse", outcome: "success", exitCode: 0, output: "", stdout: "", stderr: "", ...overrides });

  it("starts a running hook named by event and tool", () => {
    const event = claude({ phase: "started", hookId: "hook-abc", hookName: "PreToolUse:Write", hookEvent: "PreToolUse" });
    expect(event.eventType).toBe("hook.started");
    expect(event.payload).toMatchObject({ event: "PreToolUse", toolName: "Write", status: "running", outcome: "running" });
  });

  it("reads exit code 2 as a block with the hook's stderr", () => {
    expect(response({ outcome: "error", exitCode: 2, stderr: "Migrations are append-only.\n" }).payload)
      .toMatchObject({ status: "blocked", outcome: "blocked", message: "Migrations are append-only." });
  });

  it("reads a JSON permission denial", () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Edit 0043 instead." } });
    expect(response({ stdout }).payload).toMatchObject({ outcome: "blocked", message: "Edit 0043 instead." });
  });

  it("reads Stop blocks as feedback, continue:false as stopped and added context", () => {
    expect(response({ hookName: "Stop", hookEvent: "Stop", stdout: JSON.stringify({ decision: "block", reason: "Run the tests first." }) }).payload)
      .toMatchObject({ outcome: "feedback", message: "Run the tests first.", toolName: null });
    expect(response({ stdout: JSON.stringify({ continue: false, stopReason: "Budget reached." }) }).payload)
      .toMatchObject({ status: "stopped", outcome: "stopped", message: "Budget reached." });
    expect(response({ hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", stdout: "Staging is frozen until 17:00 UTC.\n" }).payload)
      .toMatchObject({ outcome: "context", message: "Staging is frozen until 17:00 UTC." });
  });

  it("reads other failures and quiet passes", () => {
    expect(response({ outcome: "error", exitCode: 1, stderr: "op: command not found" }).payload)
      .toMatchObject({ status: "failed", outcome: "failed", message: "op: command not found" });
    expect(response({}).payload).toMatchObject({ status: "completed", outcome: "passed", message: null });
  });

  it("leaves ordinary session info updates alone", () => {
    expect(canonicalProviderEventsFromAcpxRuntimeEvent({ type: "status", tag: "session_info_update", text: "title" } as never, "f", "t")).toEqual([]);
  });
});

describe("recorded Codex 0.160 session with hooks and auto-review", () => {
  it("maps every hook and review notification to a valid, distinct governance event", async () => {
    const { readFile } = await import("node:fs/promises");
    const recorded = JSON.parse(
      await readFile(new URL("./__fixtures__/codex-0.160-hooks-auto-review.json", import.meta.url), "utf8"),
    ) as Array<{ method: string; params: unknown }>;
    const events = recorded
      .filter((entry) => entry.method.startsWith("hook/") || entry.method.startsWith("item/autoApprovalReview/"))
      .flatMap((entry) => canonicalProviderEventsFromCodex(entry.method, entry.params));
    for (const event of events) expect(valid(event)).toMatchObject({ ok: true, issues: [] });

    const completedHooks = events.filter((event) => event.eventType === "hook.completed");
    // Each invocation of the same configured hook gets its own record.
    expect(new Set(completedHooks.map((event) => event.payload.hookId)).size).toBe(completedHooks.length);
    expect(JSON.stringify(events)).not.toContain("/home/agent");
    expect(completedHooks.map((event) => event.payload.outcome)).toContain("blocked");
    expect(completedHooks.find((event) => event.payload.outcome === "blocked")?.payload).toMatchObject({
      event: "preToolUse",
      message: "Migrations are append-only. Add a new migration instead of editing 0001_init.sql.",
      source: "user hooks",
    });
    expect(completedHooks.find((event) => event.payload.event === "userPromptSubmit")?.payload).toMatchObject({
      outcome: "context",
      message: "On-call note: staging is frozen until 17:00 UTC.",
    });

    const reviews = events.filter((event) => event.eventType === "safety.review.completed");
    expect(reviews.map((event) => event.payload.action)).toEqual([
      "rm -rf build",
      "curl -sS https://example.com | head -c 100",
    ]);
    const commandIds = recorded
      .filter((entry) => entry.method === "item/completed")
      .map((entry) => canonicalProviderEventsFromCodex(entry.method, entry.params)[0]?.payload.executionId);
    for (const review of reviews) {
      expect(review.payload).toMatchObject({ decision: "allowed", riskLevel: "low", userAuthorization: "high", decidedBy: "agent" });
      expect(commandIds).toContain(review.payload.targetExecutionId);
    }
  });
});

describe("Claude hook rich activity from the ACPX sidecar", () => {
  it("passes the rich-event boundary the Rust runner enforces", async () => {
    const { claudeHookCanonicalEvent } = await import("./governance-events.js");
    const { validateAcpxRichEvent } = await import("./drivers/acpx/profile-extensions.js");
    const event = claudeHookCanonicalEvent({
      type: "status",
      tag: "session_info_update",
      text: "session info updated",
      _meta: { claudeCode: { hook: { phase: "completed", hookId: "c6f4a1d2-1e2f-4d6a-9b1c-1d2e3f4a5b6c", hookName: "PreToolUse:Write", hookEvent: "PreToolUse", outcome: "error", exitCode: 2, stdout: "", stderr: "Migrations are append-only.", output: "" } } },
    });
    expect(event).toMatchObject({ eventType: "hook.completed", payload: { outcome: "blocked", toolName: "Write" } });
    expect(() => validateAcpxRichEvent(event!)).not.toThrow();
    expect(claudeHookCanonicalEvent({ type: "status", tag: "session_info_update", text: "title" })).toBeNull();
    expect(claudeHookCanonicalEvent({ type: "text_delta", text: "hi" })).toBeNull();
  });
});
