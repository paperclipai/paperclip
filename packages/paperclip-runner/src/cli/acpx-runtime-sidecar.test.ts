import { acpxUsageEstimateNotice, persistedAcpxTurnUsage, persistedCursorUsageNotice } from "../drivers/acpx/usage-accounting.js";
import { stripTypeScriptTypes } from "node:module";
import { cursorPlanToolIdentity } from "../drivers/acpx/cursor-plan-tool-identity.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverAcpxResponse } from "../drivers/acpx/response-delivery.js";
import { normalizeAcpxPermission } from "../drivers/acpx/acp-permission-adapter.js";
import { ACPX_CAPABILITY_PROFILES } from "../drivers/acpx/capability-profiles.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent } from "../provider-events.js";
import { createPiMessageProjection } from "../drivers/acpx/pi-message-projection.js";
import { createCopilotToolEvidence } from "../drivers/acpx/copilot-tool-evidence.js";
import { createCursorToolEvidence } from "../drivers/acpx/cursor-tool-evidence.js";
import { validateAcpxRichEvent } from "../drivers/acpx/profile-extensions.js";
import {
  awaitSidecarCleanupWithin,
  closeActiveSidecarHostWithin,
  closeSidecarHostForCommand,
  combineSidecarAdmissionCleanups,
  combineSidecarHostCleanups,
  hasSidecarSessionOwnership,
  observeSidecarCleanupWithin,
  parseAcpxRunAttachment,
  readSidecarHostStatusWithin,
  recoverAndCombineSidecarHostCleanup,
  recoverSidecarHostCleanup,
  reportAuthoritativeSidecarHostCleanupFailure,
  requireSidecarCommandHost,
  verifyOpenedAcpxSidecarHost,
} from "./acpx-sidecar-lifecycle.js";

const children = new Set<SidecarProcess>();

afterEach(async () => {
  await Promise.all([...children].map((child) => child.close()));
  children.clear();
});

describe("qualified ACPX runtime sidecar", () => {
  it("projects the actual sidecar terminal diagnostic block without authoritative accounting", () => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("      try {", source.indexOf("      const usageAfter = await readSidecarHostStatusWithin(activeHost);"));
    const end = source.indexOf("      const usage = persistedAcpxTurnUsage(", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const emitted: unknown[] = [];
    const project = new Function("persistedCursorUsageNotice", "validateAcpxRichEvent", "emit", "usageBefore", "usageAfter", "agent", `
      const currentTurnId="turn", runtimeTurn={requestId:"request-1"}, openParams={agent};
      ${stripTypeScriptTypes(source.slice(start, end))}
    `).bind(null, persistedCursorUsageNotice, validateAcpxRichEvent, (...args: unknown[]) => emitted.push(args));
    const before = { promptMessageIds: [], requestTokenUsage: {} };
    const after = { lastRequestId: "request-1", promptMessageIds: ["prompt-1"], requestTokenUsage: {}, cursorPromptUsage: {
      request_id: "request-1", prompt_message_id: "prompt-1", receipt: {
        schema: "paperclip.cursor.native-usage.v1", source: "native_turn_ended", promptId: "12345678-1234-1234-1234-123456789abc", completeness: "partial",
        reasons: ["native_counter_semantics_unverified"], observations: [], limits: { maxObservations: 64, maxInvocations: 64, maxBytes: 16384 }, truncated: false,
      },
    } };
    project(before, after, "cursor");
    expect(emitted).toEqual([["runtime.rich_event", expect.objectContaining({ eventType: "provider.notice.recorded", payload: expect.objectContaining({ category: "cursor_native_usage_observed" }) }), "turn"]]);
    emitted.length = 0;
    for (const agent of ["copilot", "pi", "codex"]) project(before, after, agent);
    project(after, after, "cursor");
    project(before, { ...after, lastRequestId: "stale" }, "cursor");
    expect(emitted).toEqual([]);
  });

  it.each(["projection", "validation", "emission"])("preserves standard usage when optional Cursor notice %s fails", async failure => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("    try {\n      const usageAfter = await readSidecarHostStatusWithin(activeHost);");
    const end = source.indexOf("    terminal = boundedSidecarValue(result);", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const emitted: unknown[] = [], diagnostics: unknown[] = [];
    const after = { lastRequestId: "request-1", requestTokenUsage: { "prompt-1": { input_tokens: 12, output_tokens: 3 } } };
    const project = new Function("readSidecarHostStatusWithin", "persistedCursorUsageNotice", "persistedAcpxTurnUsage", "acpxUsageEstimateNotice", "validateAcpxRichEvent", "emit", "diagnostic", `
      return (async () => {
        const activeHost={}, currentTurnId="turn", runtimeTurn={requestId:"request-1"}, openParams={agent:"cursor"};
        const usageBefore={requestTokenUsage:{}}, sanitizeRuntimeEvent=value=>value, safeMessage=()=>"fixture error";
        ${stripTypeScriptTypes(source.slice(start, end))}
      })();
    `);
    await project(async () => after,
      () => { if (failure === "projection") throw new Error("optional projection failed"); return { eventType: "provider.notice.recorded" }; },
      persistedAcpxTurnUsage, acpxUsageEstimateNotice,
      () => { if (failure === "validation") throw new Error("optional validation failed"); },
      (type: string, payload: unknown, turn: string) => {
        if (type === "runtime.rich_event" && failure === "emission") throw new Error("optional emission failed");
        emitted.push([type, payload, turn]);
      },
      (...args: unknown[]) => diagnostics.push(args),
    );
    expect(emitted).toEqual([["runtime.event", expect.objectContaining({ tag: "usage_update", breakdown: expect.objectContaining({ inputTokens: 12, outputTokens: 3 }) }), "turn"]]);
    expect(diagnostics).toEqual([]);
  });

  it("emits the native plan tool identity from the actual sidecar input boundary", async () => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function waitForExtensionInput(");
    const end = source.indexOf("\nfunction elicitationResponse(", start);
    const code = stripTypeScriptTypes(source.slice(start, end));
    const emitted: any[] = [], inputs = new Map();
    const invoke = new Function("cursorPlanToolIdentity", "requireAcpxResponseDelivery", "emit", "inputs", `
      const turnId="turn", openParams={agent:"cursor"}, initializedAgent="cursor", MAX_PENDING_INPUTS=16;
      let requestSequence=0;
      const stableRequestId=()=>"input-request";
      ${code}
      return waitForExtensionInput;
    `)(cursorPlanToolIdentity, (context: any) => context.responseDelivery, (...args: any[]) => emitted.push(args), inputs);
    const abort = new AbortController();
    const pending = invoke("turn", { method: "cursor/create_plan", details: { toolCallId: "tool with spaces" }, questionSet: { schema: "paperclip.question_set.v1", questions: [] }, cancel: () => ({ cancelled: true }) }, { requestId: 0, signal: abort.signal, responseDelivery: Promise.resolve() });
    expect(emitted).toEqual([["runtime.input_requested", expect.objectContaining({ toolCallId: "tool with spaces", origin: { adapter: "acpx-runtime-sidecar", provider: "cursor", method: "cursor/create_plan" } }), "turn"]]);
    abort.abort(); await expect(pending).resolves.toEqual({ cancelled: true });
    expect(inputs.size).toBe(0);
  });
  it.each(["cursor", "copilot", "pi"])("binds native tool evidence to the active sidecar turn for %s", agent => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("    const evidenceFactory =");
    const end = source.indexOf("    let usageBefore:", start);
    expect(start).toBeGreaterThan(0);
    const emitted: unknown[] = [];
    const create = new Function("createCopilotToolEvidence", "createCursorToolEvidence", "validateAcpxRichEvent", "emit", "agent", `
      const activeHost = { identity: () => ({ backendSessionId: "session" }) };
      let host = activeHost, turnId = "turn";
      const currentTurnId = "turn", openParams = { agent, workingDirectory: "/workspace" };
      const diagnostic = () => {};
      ${source.slice(start, end).replaceAll("openParams!", "openParams")}
      return { evidence: toolEvidence, retire: () => { turnId = null; } };
    `)(createCopilotToolEvidence, createCursorToolEvidence, validateAcpxRichEvent, (...args: unknown[]) => emitted.push(args), agent);
    const tool = { type: "tool_call", tag: "tool_call", toolCallId: "tool", kind: "execute", status: "pending", rawInput: { command: "printf private-value" } };
    create.evidence?.tool(tool);
    expect(emitted).toHaveLength(agent === "pi" ? 0 : 1);
    if (agent !== "pi") expect(emitted[0]).toEqual(["runtime.rich_event", expect.objectContaining({ payload: expect.objectContaining({
      category: `${agent}_tool_evidence_v1`, provenance: expect.objectContaining({ sessionId: "session", turnId: "turn" }),
    }) }), "turn"]);
    expect(JSON.stringify(emitted)).not.toContain("private-value");
    create.retire();
    create.evidence?.tool({ ...tool, tag: "tool_call_update", status: "failed" });
    expect(emitted).toHaveLength(agent === "pi" ? 0 : 1);
  });

  it("passes only validated Pi native boundaries and history through the real text sanitizer", () => {
    const source = readFileSync(fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)), "utf8");
    const start = source.indexOf('  if (event.type === "text_delta") {', source.indexOf("function sanitizeRuntimeEvent"));
    const end = source.indexOf('  if (event.type === "status") {', start);
    expect(start).toBeGreaterThan(0);
    const sanitize = new Function("boundedOptionalText", "stableProviderIdentity", `return event => {${source.slice(start, end)} return null;}`)(
      (value: string) => value, (value: string) => `stable-${value}`,
    );
    const projection = createPiMessageProjection<{ type: string; text: string; stream: string; messageId: string; meta: Record<string, string> }>();
    const event = (kind: string) => ({ type: "text_delta", text: "", stream: "output", messageId: `pi-message-${"a".repeat(64)}`,
      meta: { origin: "pi-native-assistant", source: "pi-rpc-message-v1", kind, secret: "DROP_ME" } });
    const startFrame = sanitize(projection.normalize(event("start")));
    const endFrame = sanitize(projection.normalize(event("end:toolUse")));
    expect(startFrame).toMatchObject({ text: "", piMessageBoundary: { phase: "start" } });
    expect(endFrame).toMatchObject({ text: "", piMessageBoundary: { phase: "end", stopReason: "toolUse" } });
    expect(startFrame.messageId).toBe(endFrame.messageId);
    expect(JSON.stringify([startFrame, endFrame])).not.toContain("DROP_ME");
    projection.settle();
    const loaded = createPiMessageProjection<ReturnType<typeof event>>();
    const history = sanitize(loaded.normalize({ ...event("history"), messageId: `pi-history-message-${"b".repeat(64)}`,
      text: "old reply", meta: { origin: "pi-history-assistant", source: "pi-session-history-v1", kind: "history" } }));
    expect(history).toMatchObject({ text: "old reply", piMessageHistory: true }); loaded.settle();
  });
  it.each(["pi", "copilot", "cursor", "codex", "claude"])("offers verified session permission grants only for %s", async agent => {
    const source = readFileSync(fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)), "utf8");
    const start = source.indexOf("  const { signal } = context;", source.indexOf("async function waitForPermission"));
    const end = source.indexOf("\nasync function waitForInput", start);
    expect(start).toBeGreaterThan(0);
    const permissions = new Map<string, unknown>();
    const emitted: Array<{ choices: Array<{ key: string }>; origin: unknown }> = [];
    const wait = new Function("permissions", "openParams", "normalizeAcpxPermission", "emit",
      `let turnId = "turn-1", requestSequence = 0; const MAX_PENDING_INPUTS = 512;
       const stableRequestId = () => "request-1"; const requireAcpxResponseDelivery = c => c.responseDelivery;
       return async function(activeTurnId, agent, request, context, toolEvidence) { ${source.slice(start, end)}`)(
      permissions, { agent }, normalizeAcpxPermission, (_event: string, payload: { choices: Array<{ key: string }>; origin: unknown }) => emitted.push(payload),
    );
    const abort = new AbortController();
    const pending = wait("turn-1", agent, { sessionId: "session", inferredKind: "edit", raw: {
      sessionId: "session", toolCall: { toolCallId: "call", title: "Edit file" },
      options: ["allow_once", "allow_always", "reject_once"].map(kind => ({ kind, optionId: kind, name: kind })),
    } }, { signal: abort.signal, responseDelivery: Promise.resolve() });
    expect(emitted[0]!.origin).toEqual({ adapter: "acpx-runtime-sidecar", provider: agent, method: "session/request_permission" });
    expect(emitted[0]!.choices.some(choice => choice.key === "accept_for_session")).toBe(agent === "pi" || agent === "copilot");
    abort.abort();
    await expect(pending).resolves.toEqual({ outcome: "cancel" });
    expect(permissions.size).toBe(0);
  });
  it.each(["safe", "missing", "conflicting", "outside"])("puts Copilot target context in the first permission frame (%s)", async scenario => {
    const safe = scenario === "safe";
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("  const { signal } = context;", source.indexOf("async function waitForPermission"));
    const end = source.indexOf("\nasync function waitForInput", start);
    const permissions = new Map<string, { normalized: ReturnType<typeof normalizeAcpxPermission> }>();
    const emitted: Array<{ title: string; choices: Array<{ key: string }> }> = [];
    const wait = new Function("permissions", "openParams", "normalizeAcpxPermission", "emit",
      `let turnId = "turn-1", requestSequence = 0; const MAX_PENDING_INPUTS = 512;
       const stableRequestId = () => "request-1"; const requireAcpxResponseDelivery = c => c.responseDelivery;
       return async function(activeTurnId, agent, request, context, toolEvidence) { ${source.slice(start, end)}`)(
      permissions, { agent: "copilot", workingDirectory: "/workspace" }, normalizeAcpxPermission,
      (_event: string, payload: typeof emitted[number]) => emitted.push(payload),
    );
    const abort = new AbortController();
    const pending = wait("turn-1", "copilot", { inferredKind: "edit", raw: {
      sessionId: "native-session", toolCall: { toolCallId: "call", title: "Create file", kind: "edit",
        rawInput: { ...(scenario === "missing" ? {} : { path: scenario === "outside" ? "../outside.txt" : "/workspace/new.txt" }),
          ...(scenario === "conflicting" ? { fileName: "other.txt" } : {}), content: "PRIVATE_CONTENT" } },
      options: ["allow_once", "allow_always", "reject_once"].map(kind => ({ kind, optionId: kind, name: kind })),
    } }, { signal: abort.signal, responseDelivery: Promise.resolve() });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.title).toBe(safe ? "Change file: new.txt" : "File change requested; target unavailable. Deny or cancel this request.");
    expect(emitted[0]!.choices.map(x => x.key)).toEqual(safe
      ? ["accept", "accept_for_session", "decline", "cancel"] : ["decline", "cancel"]);
    expect(JSON.stringify(emitted)).not.toContain("PRIVATE_CONTENT");
    if (!safe) for (const action of ["accept", "accept_for_session"] as const) {
      expect(() => permissions.get("request-1")!.normalized.resolve({ action })).toThrow("offered choice");
    }
    abort.abort(); await expect(pending).resolves.toEqual({ outcome: "cancel" });
    expect(permissions.size).toBe(0);
  });
  it("returns the sidecar retirement flag only after cancellation settlement and rejects stale turns", async () => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf('    const expected = boundedIdentity', source.indexOf('if (request.command === "turn.cancel")'));
    const end = source.indexOf('\n  if (request.command === "permission.resolve")', start);
    let settle!: () => void;
    const cleanup = new Promise<void>(resolve => { settle = resolve; });
    let closed = false;
    const host = { interruptActiveTurn: vi.fn(async () => { await cleanup; closed = true; }), isClosed: () => closed };
    const cancel = new Function("requireHost", `
      const turnId = "active-turn";
      const boundedIdentity = x => x, boundedOptionalText = (x, fallback) => x ?? fallback;
      return async function(request) { ${source.slice(start, end)}
    `)(() => host);
    await expect(cancel({ params: { turnId: "stale" } })).rejects.toThrow("stale");
    expect(host.interruptActiveTurn).not.toHaveBeenCalled();
    const pending = cancel({ params: { turnId: "active-turn", reason: "Stop" } });
    let acknowledged = false; void pending.then(() => { acknowledged = true; });
    await Promise.resolve(); expect(acknowledged).toBe(false);
    settle(); await expect(pending).resolves.toEqual({ cancelled: true, sessionClosed: true });
    host.interruptActiveTurn.mockRejectedValueOnce(new Error("provider cleanup incomplete"));
    await expect(cancel({ params: { turnId: "active-turn" } })).rejects.toThrow("cleanup incomplete");
  });

  it("emits permission delivery evidence only after the actual response write settles", async () => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf('    const requestId = boundedIdentity', source.indexOf('if (request.command === "permission.resolve")'));
    const end = source.indexOf('\n  if (request.command === "input.resolve")', start);
    const execute = new Function("permissions", "deliverAcpxResponse", "parseHarnessRuntimeRequestResolution", `
      const turnId = "turn"; const boundedIdentity = x => x;
      return async function(request) { ${source.slice(start, end)}
    `);
    for (const reject of [false, true]) {
      let resolve!: () => void, fail!: (error: Error) => void;
      const delivery = new Promise<void>((r, j) => { resolve = r; fail = j; });
      const deliveredEvidence = vi.fn(), settle = vi.fn();
      const permissions = new Map([["request", { turnId: "turn", normalized: { resolve: () => ({ outcome: "reject_once" }) }, cleanup() {}, settle, responseDelivery: delivery, deliveredEvidence }]]);
      const run = execute(permissions, deliverAcpxResponse, () => ({ action: "decline" }))({ params: { requestId: "request", turnId: "turn" } });
      expect(settle).toHaveBeenCalledWith({ outcome: "reject_once" });
      expect(deliveredEvidence).not.toHaveBeenCalled();
      if (reject) { fail(new Error("write failed")); await expect(run).rejects.toThrow("write failed"); expect(deliveredEvidence).not.toHaveBeenCalled(); }
      else { resolve(); await expect(run).resolves.toEqual({ resolved: true }); expect(deliveredEvidence).toHaveBeenCalledExactlyOnceWith("reject_once"); }
    }
  });
  it("preserves ACP input presence through the bounded sidecar handoff", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("function boundRuntimeEventForNormalization");
    const end = source.indexOf("\nfunction sanitizeRuntimeEvent", start);
    if (start < 0 || end < 0) throw new Error("sidecar normalization source not found");
    const functionSource = source
      .slice(start, end)
      .replace(
        /function boundRuntimeEventForNormalization\(\n  event: AcpRuntimeEvent,\n\): AcpRuntimeEvent \{/,
        "function boundRuntimeEventForNormalization(event) {",
      )
      .replace("  } as BoundedRuntimeToolEvent;", "  };");
    const bound = new Function(
      "boundedOptionalText", "stableProviderIdentity", "safeAcpxLocations", "openParams", "safeOutput",
      `return (${functionSource});`,
    )(
      (value: unknown, fallback: string, max: number) => typeof value === "string" ? value.slice(0, max) : fallback,
      (value: string) => value,
      () => [],
      null,
      () => ({ output: null, outputBytes: 0, outputTruncated: false, outputDigest: null }),
    ) as (event: Record<string, unknown>) => Record<string, unknown>;
    const bounded = bound({
      type: "tool_call", toolCallId: "provider-tool", title: "search", kind: "other",
      status: "pending", rawInput: { secret: "must not cross" }, rawOutput: null,
    });
    expect(bounded.inputUpdated).toBe(true);
    expect(bounded).not.toHaveProperty("rawInput");
    const canonical = canonicalProviderEventsFromAcpxRuntimeEvent(bounded as never, "fallback")[0]!;
    expect(canonical.payload).toMatchObject({ inputUpdated: true });
    expect(JSON.stringify(canonical.payload)).not.toContain("must not cross");
    expect(source).toContain("? boundedTool.inputUpdated");
  });

  it.each(["paperclip_finish", "paperclip_block"])(
    "bounds pending %s calls before reserved handling and resumes admission",
    async (operationId) => {
      const tools = new Map<string, unknown>();
      for (let index = 0; index < 512; index++) tools.set(`pending-${index}`, {});
      const emitted: unknown[] = [];
      const waitForTool = loadWaitForTool({ tools, emitted });
      const signal = new AbortController();
      await expect(waitForTool({
        callId: `${operationId}-at-capacity`, tool: operationId,
        arguments: operationId === "paperclip_block" ? { reportedWorkDisposition: "blocked" } : { reportedWorkDisposition: "done" },
        signal: signal.signal,
      })).rejects.toThrow("ACPX pending tool limit reached");
      expect(emitted).toEqual([]);
      expect(tools.size).toBe(512);

      tools.delete("pending-0");
      const admitted = waitForTool({
        callId: `${operationId}-after-release`, tool: operationId,
        arguments: operationId === "paperclip_block" ? { reportedWorkDisposition: "blocked" } : { reportedWorkDisposition: "done" },
        signal: signal.signal,
      });
      await Promise.resolve();
      expect(tools.has(`${operationId}-after-release`)).toBe(true);
      signal.abort();
      await expect(admitted).rejects.toThrow("ACPX tool call was cancelled");
      expect(tools.size).toBe(511);
    },
  );

  it("shuts down without using readline after stdin closes", async () => {
    const sidecar = startSidecar();
    sidecar.write(initializeRequest(1, "codex"));
    await expect(
      sidecar.next((frame) => frame.id === 1),
    ).resolves.toMatchObject({
      id: 1,
      ok: true,
    });

    await sidecar.close();

    expect(sidecar.stderr()).not.toContain("ERR_USE_AFTER_CLOSE");
  });

  it("keeps session admission closed while any cleanup owner remains", () => {
    const cleanup = Promise.resolve();

    expect(hasSidecarSessionOwnership(null, null, null)).toBe(false);
    expect(hasSidecarSessionOwnership({}, null, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, cleanup, null)).toBe(true);
    expect(hasSidecarSessionOwnership(null, null, cleanup)).toBe(true);
  });

  it("allows only an explicit cleanup retry to reach a retained host", () => {
    const host = { identity: () => ({ kind: "acpx" }) };
    const cleanup = new Promise<void>(() => undefined);

    expect(() => requireSidecarCommandHost(host, cleanup)).toThrow(
      "cleanup is in progress",
    );
    expect(
      requireSidecarCommandHost(host, cleanup, { allowCleanupRetry: true }),
    ).toBe(host);
    expect(() =>
      requireSidecarCommandHost(null, cleanup, { allowCleanupRetry: true }),
    ).toThrow("session is not open");
  });

  it("closes an opened host when post-open verification fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(verifyOpenedAcpxSidecarHost(host, () => ({}))).rejects.toThrow(
      "status failed",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({
      reason: "ACPX session open verification failed",
    });
  });

  it("bounds failed-admission cleanup when the host does not settle", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn().mockRejectedValue(new Error("status failed")),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1, retainCleanup),
    ).rejects.toThrow("verification and provider cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
    finishCleanup();
    await cleanup;
  });

  it("bounds shutdown waiting without releasing retained cleanup ownership", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "deferred",
    );
    let settled = false;
    void cleanup.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    finishCleanup();
    await cleanup;
    expect(settled).toBe(true);
    await expect(awaitSidecarCleanupWithin(cleanup, 1)).resolves.toBe(
      "settled",
    );
  });

  it("preserves retained cleanup failure for shutdown accounting", async () => {
    const failure = new Error("provider cleanup failed");
    await expect(
      observeSidecarCleanupWithin(Promise.reject(failure), 1),
    ).resolves.toEqual({ status: "failed", error: failure });
    await expect(
      observeSidecarCleanupWithin(new Promise<void>(() => undefined), 1),
    ).resolves.toEqual({ status: "deferred" });
  });

  it("preserves failed-admission rejection until every cleanup settles", async () => {
    let finishCleanup!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const retained = combineSidecarAdmissionCleanups([
      Promise.reject(new Error("provider survived termination")),
      pending,
    ]);
    let settled = false;
    void retained.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup();
    await expect(retained).rejects.toThrow(
      "did not release provider ownership",
    );
  });

  it("bounds active-host cleanup during sidecar shutdown", async () => {
    const cleanup = new Promise<void>(() => undefined);
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeActiveSidecarHostWithin({ close }, "SIGTERM", 1, retainCleanup),
    ).resolves.toBe("deferred");
    expect(close).toHaveBeenCalledWith({ reason: "SIGTERM" });
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);
  });

  it("bounds command cleanup without replacing its exact owner", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const close = vi.fn(() => cleanup);
    const retainCleanup = vi.fn();

    await expect(
      closeSidecarHostForCommand({ close }, "session close", 1, retainCleanup),
    ).rejects.toThrow("cleanup exceeded its command timeout");
    expect(close).toHaveBeenCalledOnce();
    expect(retainCleanup).toHaveBeenCalledWith(cleanup);

    finishCleanup();
    await cleanup;
  });

  it("preserves a settled command cleanup failure", async () => {
    const cleanup = Promise.reject(new Error("runtime close failed"));
    await expect(
      closeSidecarHostForCommand({ close: () => cleanup }, "session close", 10),
    ).rejects.toThrow("runtime close failed");
  });

  it("recovers a rejected active-host cleanup sequentially", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockResolvedValue(undefined);
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated active-host cleanup failures", async () => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("close failed"));
    const host = { close };
    const initialCleanup = host.close();

    await expect(
      recoverSidecarHostCleanup(host, initialCleanup),
    ).rejects.toThrow("close failed");
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("retains a pending cleanup owner after a command retry succeeds", async () => {
    let finishPending!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishPending = resolve;
    });
    const successfulRetry = Promise.resolve();
    const owner = combineSidecarHostCleanups([pending, successfulRetry]);
    let settled = false;
    void owner.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishPending();
    await expect(owner).resolves.toBeUndefined();
  });

  it("accepts a coalesced rejection after sequential recovery succeeds", async () => {
    let rejectCoalesced!: (error: unknown) => void;
    const coalesced = new Promise<void>((_resolve, reject) => {
      rejectCoalesced = reject;
    });
    const close = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(coalesced)
      .mockReturnValueOnce(coalesced)
      .mockResolvedValue(undefined);
    const host = { close };
    const recoveredPrior = recoverSidecarHostCleanup(host, host.close());
    const owner = recoverAndCombineSidecarHostCleanup(
      host,
      host.close(),
      recoveredPrior,
    );
    let settled = false;
    void owner
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await Promise.resolve();
    expect(settled).toBe(false);
    rejectCoalesced(new Error("coalesced close failed before recovery"));
    await expect(owner).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(4);
  });

  it("rejects when every active-host cleanup owner fails", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("recovery exhausted")),
      Promise.reject(new Error("retry failed")),
    ]);

    await expect(owner).rejects.toThrow("did not release provider ownership");
  });

  it("accepts a later recovery after an older owner exhausts", async () => {
    await expect(
      combineSidecarHostCleanups([
        Promise.reject(new Error("older recovery exhausted")),
        Promise.resolve(),
      ]),
    ).resolves.toBeUndefined();
  });

  it("does not escalate a superseded cleanup owner failure", async () => {
    let rejectOlder!: (error: unknown) => void;
    const older = new Promise<void>((_resolve, reject) => {
      rejectOlder = reject;
    });
    const replacement = combineSidecarHostCleanups([
      older,
      Promise.resolve(),
    ]);
    const reportFailure = vi.fn();
    void older.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        replacement,
        older,
        error,
        reportFailure,
      );
    });

    rejectOlder(new Error("older recovery exhausted"));
    await expect(replacement).resolves.toBeUndefined();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("escalates only an authoritative cleanup owner's terminal failure", async () => {
    const owner = combineSidecarHostCleanups([
      Promise.reject(new Error("older recovery exhausted")),
      Promise.reject(new Error("replacement recovery exhausted")),
    ]);
    const reportFailure = vi.fn();

    await owner.catch((error: unknown) => {
      reportAuthoritativeSidecarHostCleanupFailure(
        false,
        owner,
        owner,
        error,
        reportFailure,
      );
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);

    reportAuthoritativeSidecarHostCleanupFailure(
      true,
      owner,
      owner,
      new Error("shutdown cleanup failed"),
      reportFailure,
    );
    expect(reportFailure).toHaveBeenCalledOnce();
  });

  it("bounds status verification before cleaning up the opened host", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const host = {
      identity: () => ({ kind: "acpx" }),
      status: vi.fn(() => new Promise<never>(() => undefined)),
      close,
    };

    await expect(
      verifyOpenedAcpxSidecarHost(host, () => ({}), 1),
    ).rejects.toThrow("status read exceeded its timeout");
    expect(close).toHaveBeenCalledOnce();
  });

  it("bounds ordinary status reads so serialized shutdown can proceed", async () => {
    const host = {
      status: vi.fn(() => new Promise<never>(() => undefined)),
    };

    await expect(readSidecarHostStatusWithin(host, 1)).rejects.toThrow(
      "status read exceeded its timeout",
    );
  });

  it("validates a complete run attachment before it can be committed", () => {
    let attachedRunId: string | null = null;
    const attach = (params: Record<string, unknown>) => {
      const attachment = parseAcpxRunAttachment(params);
      attachedRunId = attachment.runId;
      return attachment;
    };

    expect(() => attach({ runId: "run-1", catalogRevision: 0 })).toThrow(
      "catalogRevision must be a positive integer",
    );
    expect(attachedRunId).toBeNull();
    expect(attach({ runId: "run-1", catalogRevision: 2 })).toEqual({
      runId: "run-1",
      catalogRevision: 2,
    });
    expect(attachedRunId).toBe("run-1");
  });

  it("recovers after malformed input and reports its qualified Codex profile", async () => {
    const sidecar = startSidecar();
    sidecar.write({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 1,
      command: "initialize",
      params: {},
      unexpected: true,
    });
    await expect(
      sidecar.next((frame) => frame.eventType === "runtime.diagnostic"),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      eventType: "runtime.diagnostic",
      payload: { code: "malformed_frame" },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      id: 2,
      ok: true,
      result: {
        profile: {
          agent: "codex",
          qualificationModel: "gpt-5.6-sol",
        },
        capabilities: {
          persistentSessions: true,
          exactModelVerification: true,
          structuredInput: "paperclip.question_set.v1",
        },
      },
    });
    expect(sidecar.stderr()).toContain("malformed_frame");

    sidecar.write(initializeRequest(3, "codex"));
    await expect(
      sidecar.next((frame) => frame.id === 3),
    ).resolves.toMatchObject({
      id: 3,
      ok: false,
      error: { message: "ACPX sidecar is already initialized" },
    });
  });

  it.each([["claude", "claude-sonnet-5"]])(
    "reports the qualified %s profile",
    async (agent, model) => {
      const sidecar = startSidecar();
      sidecar.write(initializeRequest(1, agent, model));

      await expect(
        sidecar.next((frame) => frame.id === 1),
      ).resolves.toMatchObject({
        id: 1,
        ok: true,
        result: { profile: { agent, qualificationModel: model } },
      });
    },
  );

  it.each([
    ["pi", "openrouter/deepseek/deepseek-v4-flash-0731"],
    ["cursor", "explicit-cursor-model"],
    ["copilot", "explicit-copilot-model"],
  ] as const)("initializes the declared %s candidate without promoting its profile", async (agent, model) => {
    const sidecar = startSidecar();
    sidecar.write(initializeRequest(1, agent, model));
    const frame = await sidecar.next((value) => value.id === 1);
    expect(frame).toMatchObject({ id: 1, ok: true });
    const result = frame.result as Record<string, unknown>;
    expect(result.profile).toEqual(resolveQualifiedAcpxProfile(agent, model));
    expect(result.profile).toMatchObject({ reportedModelId: model });
    expect(ACPX_CAPABILITY_PROFILES[agent].qualification).toBe("pending");
  });

  it("fails closed after an unsupported provider bootstrap", async () => {
    const sidecar = startSidecar();
    sidecar.write(
      initializeRequest(
        1,
        "unknown-provider",
        "openrouter/deepseek/deepseek-v4-flash-0731",
      ),
    );

    await expect(
      sidecar.next((frame) => frame.id === 1),
    ).resolves.toMatchObject({
      id: 1,
      ok: false,
      error: {
        code: "acpx_sidecar_command_failed",
        message: "ACPX agent must be claude, codex, grok, cursor, copilot, or pi",
        retryable: false,
      },
    });

    sidecar.write(initializeRequest(2, "codex"));

    await expect(
      sidecar.next((frame) => frame.id === 2),
    ).resolves.toMatchObject({
      id: 2,
      ok: false,
      error: {
        message: expect.stringContaining(
          "ACPX provider bootstrap failed before initialize",
        ),
        retryable: false,
      },
    });
  });
});

function initializeRequest(
  id: number,
  agent: string,
  model = "gpt-5.6-sol",
): Record<string, unknown> {
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id,
    command: "initialize",
    params: { agent, model },
  };
}

function startSidecar(): SidecarProcess {
  const sidecar = new SidecarProcess();
  children.add(sidecar);
  return sidecar;
}

class SidecarProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #frames: Array<Record<string, unknown>> = [];
  readonly #signals: Array<() => void> = [];
  #stderr = "";
  #closed = false;

  constructor() {
    this.#child = spawn(
      fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)),
      [fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        this.#frames.push(JSON.parse(line) as Record<string, unknown>);
        for (const signal of this.#signals.splice(0)) signal();
      }
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
  }

  write(value: Record<string, unknown>): void {
    this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stderr(): string {
    return this.#stderr;
  }

  async next(
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = this.#frames.findIndex(predicate);
      if (index >= 0) return this.#frames.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for sidecar frame. stderr=${JSON.stringify(this.#stderr)}`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.#signals.indexOf(signal);
          if (index >= 0) this.#signals.splice(index, 1);
          reject(new Error("Timed out waiting for sidecar output"));
        }, remaining);
        const signal = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#signals.push(signal);
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    const exit = new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
    });
    const timeout = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
    await Promise.race([exit, timeout]);
  }
}

function loadWaitForTool(input: {
  tools: Map<string, unknown>;
  emitted: unknown[];
}): (call: { callId: string; tool: string; arguments: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown> {
  const source = readFileSync(
    fileURLToPath(new URL("./acpx-runtime-sidecar.ts", import.meta.url)),
    "utf8",
  );
  const start = source.indexOf("async function waitForTool");
  const end = source.indexOf("\nasync function waitForPermission", start);
  if (start < 0 || end < 0) throw new Error("waitForTool source not found");
  const functionSource = source
    .slice(start, end)
    .replace(
      "async function waitForTool(call: RunnerToolCall): Promise<unknown>",
      "async function waitForTool(call)",
    );
  const factory = new Function(
    "boundedIdentity", "tools", "turnId", "emit", "PRP_COMPLETION_TOOL_NAME",
    "PRP_BLOCK_TOOL_NAME", "validatePrpStructuredRunResult", "boundedSidecarValue", "record", "MAX_PENDING_TOOLS",
    `return (${functionSource});`,
  );
  return factory(
    (value: string) => value,
    input.tools,
    "test-turn",
    (_eventType: string, payload: unknown) => input.emitted.push(payload),
    "paperclip_finish",
    "paperclip_block",
    (argumentsValue: unknown) => ({
      ok: true,
      result: argumentsValue,
    }),
    (value: unknown) => value,
    (value: unknown) => value,
    512,
  );
}
