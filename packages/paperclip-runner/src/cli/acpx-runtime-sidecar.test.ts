import { appendSemanticToolReceipt, readNativeSemanticReceipt, semanticInputSha256 } from "../drivers/semantic-tool-receipt.js";
import { startRunnerToolBridge, type RunnerToolCall } from "../drivers/runner-tool-bridge.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";
import { acpxUsageEstimateNotice, persistedAcpxTurnUsage, persistedCursorUsageNotice } from "../drivers/acpx/usage-accounting.js";
import { stripTypeScriptTypes } from "node:module";
import { cursorPlanToolIdentity, cursorToolIdentity } from "../drivers/acpx/cursor-plan-tool-identity.js";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverAcpxResponse } from "../drivers/acpx/response-delivery.js";
import { normalizeAcpxPermission } from "../drivers/acpx/acp-permission-adapter.js";
import { ACPX_CAPABILITY_PROFILES } from "../drivers/acpx/capability-profiles.js";
import { resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { ACPX_SIDECAR_PROTOCOL_VERSION, ACPX_SIDECAR_MAX_FRAME_BYTES, stringifyAcpxSidecarFrame, parseAcpxSidecarRequest, record, text } from "../drivers/acpx/sidecar-protocol.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent } from "../provider-events.js";
import { createPiMessageProjection } from "../drivers/acpx/pi-message-projection.js";
import { createCopilotToolEvidence } from "../drivers/acpx/copilot-tool-evidence.js";
import { createCursorToolEvidence } from "../drivers/acpx/cursor-tool-evidence.js";
import { validateAcpxRichEvent } from "../drivers/acpx/profile-extensions.js";
import {
  awaitSidecarCleanupWithin,
  boundedIdentity,
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

  it.each(["codex", "claude", "grok", "pi", "copilot", null])("preserves existing non-Cursor sidecar identity policy: %s", agent => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("function stableProviderIdentity(");
    const stable = new Function("createHash", "cursorToolIdentity", "openParams", `${stripTypeScriptTypes(source.slice(start, source.indexOf("\nfunction canonicalJson", start)))}; return stableProviderIdentity;`)(createHash, cursorToolIdentity, agent ? { agent } : null);
    for (const kind of ["tool", "message"]) {
      for (const raw of ["safe-tool", "tool/1", "native\u0080tool", "native\u0085tool", "native\u009ftool", "x".repeat(161)]) {
        expect(stable(raw, kind)).toBe(raw);
      }
      for (const raw of ["native\u0000tool", "native\u007ftool", "x".repeat(241)]) {
        const expected = `acpx-${kind}-${createHash("sha256").update("paperclip.acpx.provider-identity.v1\0").update(kind).update("\0").update(raw).digest("hex")}`;
        expect(stable(raw, kind)).toBe(expected);
      }
    }
  });
  it.each(["tool-first", "permission-first"])("uses the same Cursor identity in actual sidecar tool and pending permission paths: %s", async order => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const identityStart = source.indexOf("function stableProviderIdentity(");
    const stableIdentity = new Function("createHash", "cursorToolIdentity", "openParams", `${stripTypeScriptTypes(source.slice(identityStart, source.indexOf("\nfunction canonicalJson", identityStart)))}; return stableProviderIdentity;`)(createHash, cursorToolIdentity, { agent: "cursor" });
    const boundStart = source.indexOf("function boundRuntimeEventForNormalization(");
    const bound = new Function("boundedOptionalText", "stableProviderIdentity", "safeAcpxLocations", "openParams", "safeOutput",
      `${stripTypeScriptTypes(source.slice(boundStart, source.indexOf("\nfunction sanitizeRuntimeEvent", boundStart)))}; return boundRuntimeEventForNormalization;`)(
      (value: unknown, fallback: string, max: number) => typeof value === "string" ? value.slice(0, max) : fallback,
      stableIdentity, () => [], null, () => ({ output: null, outputBytes: 0, outputTruncated: false, outputDigest: null }),
    );
    const start = source.indexOf("  const { signal } = context;", source.indexOf("async function waitForPermission"));
    const end = source.indexOf("\nasync function waitForInput", start);
    const observedIds: string[] = [];
    for (const rawId of ["native\u0000tool", "native\u007ftool", "native\u0085tool", "tool/1", "x".repeat(161), "safe-tool-1"]) {
      const permissions = new Map<string, any>(); const emitted: any[] = []; const notices: any[] = [];
      const evidence = createCursorToolEvidence({ sessionId: "session", turnId: "turn-1", workingDirectory: "/workspace", active: () => true,
        emit: event => { validateAcpxRichEvent(event); notices.push(event); },
      });
      const wait = new Function("permissions", "normalizeAcpxPermission", "emit", `
        let turnId="turn-1", requestSequence=0; const MAX_PENDING_INPUTS=512, openParams={agent:"cursor"};
        const stableRequestId=()=>"request-1", requireAcpxResponseDelivery=c=>c.responseDelivery;
        return async function(activeTurnId, agent, request, context, toolEvidence) { ${source.slice(start, end)}
      `)(permissions, normalizeAcpxPermission, (_event: string, payload: unknown) => emitted.push(payload));
      const origin = { type: "tool_call", tag: "tool_call", toolCallId: rawId, kind: "execute", status: "pending", rawInput: { command: "printf private-command" } };
      // The sidecar emits this bounded runtime event; Rust applies the opaque
      // execution-ID transform later. The direct TS driver normalizer is not
      // this boundary and has a different fallback policy.
      const activity = bound(origin);
      const native = { sessionId: "session", inferredKind: "execute", raw: { sessionId: "session", toolCall: { toolCallId: rawId, kind: "execute" },
        options: [{ kind: "reject_once", optionId: "native-original-denial", name: "Deny" }],
      } };
      const before = structuredClone(native);
      const abort = new AbortController();
      if (order === "tool-first") evidence.tool(origin);
      const pending = wait("turn-1", "cursor", native, { signal: abort.signal, responseDelivery: Promise.resolve() }, evidence);
      if (order === "permission-first") { expect(notices).toEqual([]); evidence.tool(origin); }
      const projectedId = emitted[0].toolCallId;
      observedIds.push(projectedId);
      expect(projectedId).toBe(activity.toolCallId);
      expect(notices.map(event => Object.fromEntries(event.payload.details.map((field: any) => [field.name, field.value])))).toEqual([
        expect.objectContaining({ stage: "tool", toolCallId: projectedId }),
        expect.objectContaining({ stage: "permission_requested", toolCallId: projectedId, requestId: "request-1" }),
      ]);
      const held = permissions.get("request-1")!;
      const decision = held.normalized.resolve({ action: "decline" });
      held.cleanup(); permissions.delete("request-1"); held.settle(decision);
      await expect(pending).resolves.toEqual({ outcome: "reject_once" });
      expect(native).toEqual(before);
      expect(native.raw.toolCall.toolCallId).toBe(rawId);
      expect(JSON.stringify([activity, emitted, notices])).not.toContain("private-command");
    }
    expect(new Set(observedIds).size).toBe(6);
    expect(observedIds.at(-1)).toBe("safe-tool-1");
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
      let host = activeHost, turnId = "turn", activeCopilotEvidence;
      const currentTurnId = "turn", openParams = { agent, workingDirectory: "/workspace" };
      const diagnostic = () => {};
      ${stripTypeScriptTypes(source.slice(start, end))}
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

  it("captures the actual sidecar bridge's Copilot receipt callback before turn replacement", () => {
    const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("        semanticTools: {");
    const end = source.indexOf("        onGoalUpdate:", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const events: unknown[] = [];
    let active = true;
    const evidence = createCopilotToolEvidence({ sessionId: "session-a", turnId: "turn-a", workingDirectory: "/workspace", active: () => active, emit: event => { validateAcpxRichEvent(event); events.push(event); } });
    const create = new Function("params", "activeCopilotEvidence", "waitForTool", `return ({ ${source.slice(start, end)} }).semanticTools;`);
    const options = create({ agent: "copilot", tools: [] }, evidence, () => undefined);
    const captured = options.captureSemanticReceipt();
    const receipt = appendSemanticToolReceipt({ tool: "get_task_context", callId: "1", arguments: {} }, { content: [{ type: "text", text: "{}" }] }).receipt;
    captured(receipt);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ payload: { category: "paperclip_semantic_tool_receipt_v2", provenance: { sessionId: "session-a", turnId: "turn-a" } } });
    active = false; captured(receipt); expect(events).toHaveLength(1);
    for (const agent of ["cursor", "codex", "pi"]) expect(create({ agent, tools: [] }, evidence, () => undefined).captureSemanticReceipt).toBeUndefined();
  });

  it.each(["forwarded", "emit-failed"])("binds native v2 receipts to actual sidecar-normalized input: %s", async mode => {
    const raw = { reportedWorkDisposition: "done", summary: "Complete", evidence: [], verification: [],
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
    const validated = validatePrpStructuredRunResult(raw);
    if (!validated.ok) throw new Error("Invalid fixture");
    const tools = new Map<string, any>(), emitted: any[] = [], notices: any[] = [];
    const projector = createCopilotToolEvidence({ sessionId: "session", turnId: "test-turn", workingDirectory: "/workspace",
      active: () => true, emit: event => { validateAcpxRichEvent(event); notices.push(event); } });
    const handler = loadWaitForTool({ tools, emitted, validate: validatePrpStructuredRunResult,
      ...(mode === "emit-failed" ? { emit: () => { throw new Error("fixture emission failed"); } } : {}) });
    const bridge = await startRunnerToolBridge({ handler, captureSemanticReceipt: () => projector.captureSemanticReceipt() });
    try {
      projector.tool({ type: "tool_call", tag: "tool_call", toolCallId: "native-call", kind: "other", status: "pending", rawInput: raw });
      const response = fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paperclip_finish", arguments: raw } }) });
      if (mode === "forwarded") {
        await vi.waitFor(() => expect(tools.has("3")).toBe(true));
        expect(emitted).toEqual([{ callId: "3", operationId: "paperclip_finish", input: validated.result }]);
        // The receipt hashes the actual emitted input, not a second normalization.
        await loadActualToolCommands(tools).resolve({ callId: "3", turnId: "test-turn", result: { accepted: true }, error: null });
      }
      const body = await (await response).json();
      const receipt = readNativeSemanticReceipt({ contents: body.result.content });
      expect(receipt).toMatchObject({ schema: "paperclip.semantic_tool_receipt.v2", inputSha256: semanticInputSha256(raw),
        normalizedInputSha256: mode === "forwarded" ? semanticInputSha256(emitted[0].input) : null,
        outcome: mode === "forwarded" ? "returned" : "error" });
      expect(semanticInputSha256(raw)).not.toBe(semanticInputSha256(validated.result));
      projector.tool({ type: "tool_call", tag: "tool_call_update", toolCallId: "native-call", status: mode === "forwarded" ? "completed" : "failed",
        rawOutput: { contents: body.result.content } });
      const details = Object.fromEntries(notices.at(-1).payload.details.map((d: any) => [d.name, d.value]));
      expect(details).toMatchObject({ semanticInputSha256: semanticInputSha256(raw),
        semanticNormalizedInputSha256: mode === "forwarded" ? semanticInputSha256(emitted[0].input) : "null" });
      expect(notices.find(event => event.payload.category === "paperclip_semantic_tool_receipt_v2").payload.details).toHaveLength(8);
    } finally {
      for (const pending of tools.values()) pending.cleanup();
      await bridge.close();
    }
  });

  it("does not capture normalized authority when actual sidecar validation fails", async () => {
    const emitted: unknown[] = [], capture = vi.fn(() => vi.fn());
    const wait = loadWaitForTool({ tools: new Map(), emitted, validate: validatePrpStructuredRunResult });
    await expect(wait({ tool: "paperclip_finish", callId: "bad", arguments: {}, signal: new AbortController().signal,
      captureNormalizedInput: capture })).rejects.toThrow("ACPX semantic result failed PRP schema validation");
    expect(capture).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("rejects normalized/envelope expansion at the actual frame writer before committing a receipt", async () => {
    const raw = { reportedWorkDisposition: "done", summary: "Complete", evidence: [{ ref: "" }], verification: [],
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
    const request = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paperclip_finish", arguments: raw } };
    raw.evidence[0]!.ref = "x".repeat(ACPX_SIDECAR_MAX_FRAME_BYTES - 1 - Buffer.byteLength(JSON.stringify(request)));
    expect(Buffer.byteLength(JSON.stringify(request))).toBe(ACPX_SIDECAR_MAX_FRAME_BYTES - 1);
    const validation = validatePrpStructuredRunResult(raw);
    if (!validation.ok) throw new Error("Invalid fixture");
    expect(Buffer.byteLength(JSON.stringify(validation.result))).toBeLessThanOrEqual(ACPX_SIDECAR_MAX_FRAME_BYTES);
    const wire = loadActualSidecarWriter();
    const tools = new Map<string, unknown>(), emitted: unknown[] = [];
    const handler = loadWaitForTool({ tools, emitted, validate: validatePrpStructuredRunResult, emit: wire.emit });
    const bridge = await startRunnerToolBridge({ handler, captureSemanticReceipt: () => () => {} });
    try {
      const body = await (await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(request) })).json();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toBe("ACPX semantic tool call exceeds the sidecar frame limit");
      expect(readNativeSemanticReceipt({ contents: body.result.content })).toMatchObject({ outcome: "error", normalizedInputSha256: null });
      expect(tools.size).toBe(0);
      expect(emitted).toEqual([]);
      expect(wire.writes).toEqual([]);
      expect(wire.errors).toEqual(["[paperclip-acpx-sidecar] output_frame_too_large\n"]);
      expect(wire.sequence()).toBe(0);
      expect(wire.emit("runtime.diagnostic", { code: "bounded", message: "rejected" })).toBe(true);
      expect(JSON.parse(wire.writes[0]!)).toMatchObject({ sequence: 1, eventType: "runtime.diagnostic" });
    } finally { await bridge.close(); }
  });

  it.each(["backpressure", "throws"])("uses actual writer acceptance, preserving %s semantics", async mode => {
    const wire = loadActualSidecarWriter(mode);
    const tools = new Map<string, any>(), emitted: any[] = [], commit = vi.fn(), capture = vi.fn((_input: unknown) => commit);
    const raw = { reportedWorkDisposition: "done", summary: "Complete", evidence: [], verification: [],
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
    const handler = loadWaitForTool({ tools, emitted, validate: validatePrpStructuredRunResult, emit: wire.emit });
    const pending = handler({ tool: "paperclip_finish", callId: "3", arguments: raw, signal: new AbortController().signal, captureNormalizedInput: capture });
    if (mode === "throws") {
      await expect(pending).rejects.toThrow("fixture write failed");
      expect(commit).not.toHaveBeenCalled(); expect(tools.size).toBe(0); expect(wire.sequence()).toBe(0);
    } else {
      expect(commit).not.toHaveBeenCalled(); expect(tools.has("3")).toBe(true); expect(wire.sequence()).toBe(1);
      expect(JSON.parse(wire.writes[0]!).payload.input).toEqual(capture.mock.calls[0]![0]);
      await loadActualToolCommands(tools).resolve({ callId: "3", turnId: "test-turn", result: { accepted: true }, error: null });
      await expect(pending).resolves.toEqual({ accepted: true });
      expect(commit).toHaveBeenCalledOnce();
    }
  });


  it.each(["success", "accepted-false", "error", "cancel", "timeout", "receiver-rejected"])(
    "commits normalized delivery only after the actual tool.resolve handler succeeds: %s",
    async mode => {
      const raw = { reportedWorkDisposition: "done", summary: "Complete", evidence: [{ ref: mode === "receiver-rejected" ? "x".repeat(300 * 1024) : "fixture" }], verification: [],
        completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
      const validation = validatePrpStructuredRunResult(raw);
      if (!validation.ok) throw new Error("Invalid fixture");
      const wire = loadActualSidecarWriter(), tools = new Map<string, unknown>(), emitted: unknown[] = [], receipts: unknown[] = [];
      const commands = loadActualToolCommands(tools);
      const handler = loadWaitForTool({ tools, emitted, validate: validatePrpStructuredRunResult, emit: wire.emit });
      const bridge = await startRunnerToolBridge({ handler, timeoutMs: 500, captureSemanticReceipt: () => receipt => receipts.push(receipt) });
      const headers = { Authorization: `Bearer ${bridge.secret}`, "Content-Type": "application/json" };
      const params = { callId: "3", turnId: "test-turn", result: { accepted: mode !== "accepted-false" }, error: null };
      try {
        const response = fetch(bridge.url, { method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "paperclip_finish", arguments: raw } }) });
        await vi.waitFor(() => expect(tools.has("3")).toBe(true), { interval: 5, timeout: 400 });
        expect(wire.writes).toHaveLength(1);
        expect(JSON.parse(wire.writes[0]!).payload.input).toEqual(validation.result);
        expect(receipts).toEqual([]);
        // These all enter the actual parsed command handler. None may consume
        // the pending call or attest delivery for a different request/turn.
        await expect(commands.resolve({ ...params, callId: "missing" })).rejects.toThrow("stale or unknown");
        await expect(commands.resolve({ ...params, turnId: "foreign" })).rejects.toThrow("stale or unknown");
        commands.setTurn("foreign");
        await expect(commands.resolve(params)).rejects.toThrow("stale or unknown");
        commands.setTurn("test-turn");
        expect(tools.has("3")).toBe(true);
        if (mode === "success" || mode === "accepted-false") {
          await expect(commands.resolve(params)).resolves.toEqual({ resolved: true });
        } else if (mode === "error") {
          await expect(commands.resolve({ ...params, result: undefined, error: { message: "Receiver rejected completion" } })).resolves.toEqual({ resolved: true });
        } else if (mode === "cancel") {
          const cancelled = await fetch(bridge.url, { method: "POST", headers,
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }) });
          expect(cancelled.status).toBe(202);
        } else if (mode === "receiver-rejected") {
          // Actual writer acceptance is not receiver admission. This frame is
          // over Rust's payload bound; no correlated resolution arrives.
          expect(Buffer.byteLength(JSON.stringify(JSON.parse(wire.writes[0]!).payload))).toBeGreaterThan(256 * 1024);
          expect(Buffer.byteLength(wire.writes[0]!)).toBeLessThan(ACPX_SIDECAR_MAX_FRAME_BYTES);
        }
        const body = await (await response).json();
        const delivered = mode === "success" || mode === "accepted-false";
        const receipt = readNativeSemanticReceipt({ contents: body.result.content });
        expect(receipt).toMatchObject({ normalizedInputSha256: delivered ? semanticInputSha256(validation.result) : null,
          inputSha256: semanticInputSha256(raw), outcome: delivered ? "returned" : "error" });
        expect(receipts).toEqual([receipt]);
        expect(tools.size).toBe(0);
        await expect(commands.resolve(params)).rejects.toThrow("stale or unknown");
        expect(receipts).toEqual([receipt]);
      } finally { await bridge.close(); }
    },
  );

  it.each(["value", "property", "collision"])("rejects semantic %s Unicode rewriting before capture or write", async kind => {
    const raw = { reportedWorkDisposition: "done", summary: kind === "value" ? "\ud800" : "Complete", evidence: [{ ref: "fixture" } as Record<string, string>], verification: [],
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
    if (kind !== "value") raw.evidence[0]!["\udc00"] = "one";
    if (kind === "collision") raw.evidence[0]!["\ufffd"] = "two";
    expect(validatePrpStructuredRunResult(raw).ok).toBe(true);
    const wire = loadActualSidecarWriter(), tools = new Map<string, unknown>(), emitted: unknown[] = [], capture = vi.fn(() => vi.fn());
    const handler = loadWaitForTool({ tools, emitted, validate: validatePrpStructuredRunResult, emit: wire.emit });
    await expect(handler({ tool: "paperclip_finish", callId: "3", arguments: raw, signal: new AbortController().signal,
      captureNormalizedInput: capture })).rejects.toThrow("cannot be encoded without changing its identity");
    expect(capture).not.toHaveBeenCalled(); expect(tools.size).toBe(0); expect(emitted).toEqual([]);
    expect(wire.writes).toEqual([]); expect(wire.sequence()).toBe(0);
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

  it.each([
    ["claude", "claude-sonnet-5"],
    ["pi", "openrouter/deepseek/deepseek-v4-flash-0731"],
  ])(
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
  validate?: typeof validatePrpStructuredRunResult;
  emit?: (eventType: string, payload: unknown) => boolean;
}): (call: RunnerToolCall) => Promise<unknown> {
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
    "PRP_BLOCK_TOOL_NAME", "validatePrpStructuredRunResult", "boundedSidecarValue", "record", "MAX_PENDING_TOOLS", "stringifyAcpxSidecarFrame",
    `return (${functionSource});`,
  );
  return factory(
    (value: string) => value,
    input.tools,
    "test-turn",
    (eventType: string, payload: unknown) => { const accepted = input.emit?.(eventType, payload) ?? true; if (accepted) input.emitted.push(payload); return accepted; },
    "paperclip_finish",
    "paperclip_block",
    input.validate ?? ((argumentsValue: unknown) => ({
      ok: true,
      result: argumentsValue,
    })),
    (value: unknown) => value,
    (value: unknown) => value,
    512,
    stringifyAcpxSidecarFrame,
  );
}

/** Actual producer and encoder, with only the destination stream replaced. */
function loadActualSidecarWriter(mode: "normal" | "backpressure" | "throws" = "normal"): {
  emit: (eventType: string, payload: unknown) => boolean; sequence: () => number; writes: string[]; errors: string[];
} {
  const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
  const emitStart = source.indexOf("function emit("), emitEnd = source.indexOf("\nfunction diagnostic", emitStart);
  const writeStart = source.indexOf("function writeFrame("), writeEnd = source.indexOf("\nfunction requireHost", writeStart);
  if (emitStart < 0 || emitEnd < 0 || writeStart < 0 || writeEnd < 0) throw new Error("Actual sidecar writer source not found");
  const writes: string[] = [], errors: string[] = [];
  const process = { stdout: { write: (line: string) => { if (mode === "throws") throw new Error("fixture write failed"); writes.push(line); return mode !== "backpressure"; } },
    stderr: { write: (line: string) => { errors.push(line); return true; } } };
  const writer = new Function("process", "stringifyAcpxSidecarFrame", "ACPX_SIDECAR_PROTOCOL_VERSION", "ACPX_SIDECAR_MAX_FRAME_BYTES", `
    let sequence=0; const runId="test-run", turnId="test-turn";
    ${stripTypeScriptTypes(source.slice(emitStart, emitEnd))}
    ${stripTypeScriptTypes(source.slice(writeStart, writeEnd))}
    return { emit, sequence: () => sequence };
  `)(process, stringifyAcpxSidecarFrame, ACPX_SIDECAR_PROTOCOL_VERSION, ACPX_SIDECAR_MAX_FRAME_BYTES);
  return { ...writer, writes, errors };
}

/** Actual parsed command dispatcher; only the owned pending map/turn are supplied. */
function loadActualToolCommands(tools: Map<string, unknown>): {
  resolve: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  setTurn: (turnId: string | null) => void;
} {
  const source = readFileSync(new URL("./acpx-runtime-sidecar.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function dispatch("), end = source.indexOf("\nasync function pumpTurn(", start);
  const safeStart = source.indexOf("function safeText("), safeEnd = source.indexOf("\nfunction safeMessage(", safeStart);
  if (start < 0 || end < 0 || safeStart < 0 || safeEnd < 0) throw new Error("Actual sidecar command dispatcher not found");
  const dispatcher = new Function("tools", "boundedIdentity", "record", "text", "parseAcpxSidecarRequest", "ACPX_SIDECAR_PROTOCOL_VERSION", `
    let turnId="test-turn", requestId=0;
    ${stripTypeScriptTypes(source.slice(safeStart, safeEnd))}
    ${stripTypeScriptTypes(source.slice(start, end))}
    return {
      resolve: params => dispatch(parseAcpxSidecarRequest({ protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION, id: ++requestId, command: "tool.resolve", params })),
      setTurn: value => { turnId=value; }
    };
  `)(tools, boundedIdentity, record, text, parseAcpxSidecarRequest, ACPX_SIDECAR_PROTOCOL_VERSION);
  return dispatcher;
}
