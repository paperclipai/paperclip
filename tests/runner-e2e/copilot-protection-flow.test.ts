import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile, unlink, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCopilotToolEvidence } from "../../packages/paperclip-runner/src/drivers/acpx/copilot-tool-evidence.js";
import { validateAcpxRichEvent } from "../../packages/paperclip-runner/src/drivers/acpx/profile-extensions.js";
import { copilotOrigin, readCopilotToolEvidence } from "./copilot-evidence.js";
import { gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite } from "./copilot-protection-cases.js";
import { createAttachedCommandFixture, watchDeniedTarget, exists, isPerTurnRunProcess } from "./copilot-local-fixtures.js";
import { runnerMatrix } from "./catalog.js";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";

const fixture = JSON.parse(await readFile(new URL("../../packages/paperclip-runner/src/drivers/acpx/fixtures/copilot-tool-evidence.json", import.meta.url), "utf8"));
function projected(name: string) {
  const frames = fixture[name], rows: any[] = []; let clock = 10;
  const projector = createCopilotToolEvidence({ sessionId: frames[0].params.sessionId, turnId: "turn", workingDirectory: "/fixture/workspace", active: () => true,
    emit: event => { validateAcpxRichEvent(event); rows.push({ seq: rows.length + 1, eventType: event.eventType, payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceKind: "runner", eventType: event.eventType, runId: "run", turnId: "turn", emittedAt: new Date(clock++).toISOString(), payload: event.payload } } }); } });
  for (const frame of frames) {
    if (frame.method === "session/update") projector.tool({ ...frame.params.update, type: "tool_call", tag: frame.params.update.sessionUpdate });
    else projector.permission({ raw: frame.params }, "permission", ["decline"])?.("reject_once");
  }
  return { rows, notices: readCopilotToolEvidence(rows, "run") };
}
describe("Copilot Product protection integration", () => {
  it("registers exactly two explicit local cells with honest terminal expectations", () => {
    const cells = runnerMatrix.filter(x => x.suite.id === "copilot-protection");
    expect(cells).toHaveLength(2); expect(cells.every(c => c.environment.id === "local" && c.profile.qualificationCandidate === "copilot" && c.task.expectedRunCount === 1)).toBe(true);
    expect(cells.find(c => c.task.id === "native-permission-deny-write")!.task.expectedTerminalState).toEqual({ issue: "in_progress", run: "cancelled" });
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(x => x.suite.id === "copilot-protection")).toBe(false);
  });
  it("feeds actual native denied-edit wire through canonical persistence shape and the Product oracle", () => {
    const { notices } = projected("deny-write");
    const request = notices.find(n => n.stage === "permission_requested")!, delivered = notices.find(n => n.stage === "permission_delivered")!, failed = notices.find(n => n.status === "failed")!;
    const e = { expected: copilotOrigin(request), requestId: "permission", expectedRelativePath: "copilot-denied-nonce.txt",
      request: { ...request, requestId: "permission", method: "session/request_permission" as const, targetRelativePath: request.target!, offeredActions: request.declineOffered ? ["decline"] : [] },
      decision: { ...delivered, requestId: "permission", browserRequestId: "permission", action: delivered.outcome === "reject_once" ? "decline" : "accept" },
      deliveredDecision: { ...delivered, requestId: "permission", outcome: delivered.outcome! },
      toolResult: { ...failed, status: "failed" as const }, terminal: { runId: "run", turnId: "turn", observedAtMs: 50, status: "cancelled" as const }, cancellation: { requestedAtMs: 40, scope: "run", acknowledged: true },
      cleanup: { observedAtMs: 60, ownedProcessesRemaining: 0 }, nativeAttemptsForTarget: 1,
      fileObservations: (["before-request", "pending", "after-decision", "terminal", "after-cleanup"] as const).map((phase, index) => ({ phase, observedAtMs: [0, request.observedAtMs, 30, 50, 60][index]!, exists: false })), mutationObservation: { startedAtMs: 0, endedAtMs: 60, complete: true, targetMutationCount: 0 } };
    expect(request.target).toBe("copilot-denied-nonce.txt");
    expect(gradeCopilotDeniedWrite(e).passed).toBe(true);
    e.request.targetRelativePath = "foreign.txt"; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
    e.request.targetRelativePath = e.expectedRelativePath; e.cancellation.acknowledged = false; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("feeds actual attached wire through canonical notices and rejects early terminal or missing linkage", () => {
    const { notices } = projected("attached-shell"); const call = notices.find(n => n.commandSha256)!;
    const started = notices.find(n => n.shellState === "started")!, result = notices.find(n => n.shellState === "completed")!;
    const e = { expected: copilotOrigin(call), nativeCall: { ...call, operation: call.operation!, mode: call.mode!, detach: call.detach!, commandSha256: call.commandSha256! }, expectedCommandSha256: call.commandSha256!, expectedShellId: started.shellId!,
      commandExit: { observedAtMs: result.observedAtMs - 1, code: 0, ownedProcessIdentityVerified: true, commandSha256: call.commandSha256! },
      nativeShellResult: { ...result, shellId: result.shellId!, commandToolCallId: result.commandToolCallId!, status: result.status!, exitCode: result.exitCode! },
      terminal: { observedAtMs: 50, runId: "run", turnId: "turn", status: "succeeded" as const }, cleanup: { observedAtMs: 60, ownedProcessesRemaining: 0 }, terminalMarkerMatches: true, afterCleanupMarkerMatches: true };
    expect(gradeCopilotAttachedSettlement(e).passed).toBe(true);
    e.terminal.observedAtMs = call.observedAtMs + 1; expect(gradeCopilotAttachedSettlement(e).passed).toBe(false);
    e.terminal.observedAtMs = 50; e.nativeShellResult.commandToolCallId = "foreign"; expect(gradeCopilotAttachedSettlement(e).passed).toBe(false);
  });
  it("rejects foreign, redacted, malformed and explicitly incomplete persisted notices", () => {
    for (const mutate of [
      (r: any) => { r.payload.prpEvent.runId = "other"; },
      (r: any) => { r.payload.prpEvent.payload.provenance.turnId = "old"; },
      (r: any) => { r.payload.prpEvent.payload.details.push({ name: "stage", value: "tool" }); },
      (r: any) => { r.payload.prpEvent.payload.details[0].value = "evidence_incomplete"; },
      (r: any) => { r.payload.prpEvent.payload.details[1].value = "[REDACTED]"; },
    ]) { const { rows } = projected("attached-shell"); mutate(rows[0]); expect(() => readCopilotToolEvidence(rows, "run")).toThrow(); }
    expect(readCopilotToolEvidence([], "run")).toEqual([]); // Missing proof never fabricates an event.
  });
  it("observes a transient create/delete even when final stat is absent", async () => {
    const root = await mkdtemp("/tmp/pc-copilot-watch-"); const watcher = watchDeniedTarget(root, "denied");
    try { await writeFile(join(root, "denied"), "x"); await unlink(join(root, "denied")); await new Promise(r => setTimeout(r, 30)); const proof = watcher.finish(); expect(proof.targetMutationCount > 0 || !proof.complete).toBe(true); expect(await exists(join(root, "denied"))).toBe(false); }
    finally { watcher.finish(); await rm(root, { recursive: true, force: true }); }
  });
  it("rejects replacement or disappearance of the watched parent directory", async () => {
    const base = await mkdtemp("/tmp/pc-copilot-parent-"); const root = join(base, "workspace"); await mkdir(root);
    const watcher = watchDeniedTarget(root, "denied");
    try { await rename(root, join(base, "old")); await mkdir(root); expect(watcher.finish().complete).toBe(false); }
    finally { watcher.finish(); await rm(base, { recursive: true, force: true }); }
    const gone = await mkdtemp("/tmp/pc-copilot-parent-"); const deleted = watchDeniedTarget(gone, "denied");
    await rm(gone, { recursive: true }); expect(deleted.finish().complete).toBe(false);
  });
  it("binds cleanup to the exact per-turn runner PID/start/run, never a warm or reused process", () => {
    const startedAt = new Date(1_700_000_000_000).toISOString();
    const authority = { pid: 100, groupId: 100, startedAt, runId: "run-id" };
    const observed = { pid: 100, parent: 1, start: new Date(startedAt).toString() };
    const args = "/private/runner --run-id run-id --lifecycle-mode per_turn";
    expect(isPerTurnRunProcess(authority, observed, args)).toBe(true);
    for (const bad of [args.replace("per_turn", "warm"), args.replace("run-id run-id", "run-id other"), args + " --run-id run-id", "/server"]) expect(isPerTurnRunProcess(authority, observed, bad)).toBe(false);
    expect(isPerTurnRunProcess({ ...authority, groupId: 101 }, observed, args)).toBe(false);
    expect(isPerTurnRunProcess(authority, { ...observed, start: new Date(1_700_000_001_000).toString() }, args)).toBe(false);
  });
  it("reaps a real finite child before its provider-style client can exit", async () => {
    const root = await mkdtemp("/tmp/pc-copilot-command-"); const fixture = await createAttachedCommandFixture(join(root, "marker"), 150);
    try {
      const client = spawn("/bin/sh", ["-c", fixture.command], { stdio: "ignore" });
      const code = await new Promise<number | null>(resolve => client.once("exit", resolve)); const observedAtMs = Date.now(); const proof = fixture.snapshot();
      expect(code).toBe(0); expect(proof).toMatchObject({ connections: 1, failure: null, childGone: true, clientGone: true });
      expect(proof.commandExit?.code).toBe(0); expect(proof.commandExit!.observedAtMs).toBeLessThanOrEqual(observedAtMs);
      expect(await readFile(join(root, "marker"), "utf8")).toBe(fixture.marker);
    } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
  });
});
