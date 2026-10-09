import { matchCopilotFixtureCommand } from "./copilot-protection-evidence.js";
import { writeFileSync, unlinkSync, utimesSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile, unlink, rename, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCopilotToolEvidence } from "../../packages/paperclip-runner/src/drivers/acpx/copilot-tool-evidence.js";
import { validateAcpxRichEvent } from "../../packages/paperclip-runner/src/drivers/acpx/profile-extensions.js";
import { copilotOrigin, readCopilotToolEvidence } from "./copilot-evidence.js";
import { copilotProtectionCases, gradeCopilotAttachedSettlement, gradeCopilotDeniedWrite } from "./copilot-protection-cases.js";
import { createAttachedCommandFixture, createDeniedTargetFixture, bindDeniedTargetPrompt, watchDeniedTarget, exists, isPerTurnRunProcess, retainRunProcessIdentity } from "./copilot-local-fixtures.js";
import { runnerMatrix, suiteDefinitionHash } from "./catalog.js";
import { selectRunnerExecutions, parseRunnerSelectors } from "./selectors.js";

const fixture = JSON.parse(await readFile(new URL("../../packages/paperclip-runner/src/drivers/acpx/fixtures/copilot-tool-evidence.json", import.meta.url), "utf8"));
function projected(name: string, target = "copilot-denied-nonce.txt") {
  const frames = JSON.parse(JSON.stringify(fixture[name]).replaceAll("copilot-denied-nonce.txt", target)), rows: any[] = []; let clock = 10;
  const projector = createCopilotToolEvidence({ sessionId: frames[0].params.sessionId, turnId: "turn", workingDirectory: "/fixture/workspace", active: () => true,
    emit: event => { validateAcpxRichEvent(event); rows.push({ seq: rows.length + 1, eventType: event.eventType, payload: { prpEvent: { schema: "paperclip.prp.event.v1", sourceKind: "runner", eventType: event.eventType, runId: "run", turnId: "turn", emittedAt: new Date(clock++).toISOString(), payload: event.payload } } }); } });
  for (const frame of frames) {
    if (frame.method === "session/update") projector.tool({ ...frame.params.update, type: "tool_call", tag: frame.params.update.sessionUpdate });
    else projector.permission({ raw: frame.params }, "permission", ["decline"])?.("reject_once");
  }
  return { rows, notices: readCopilotToolEvidence(rows, "run") };
}
describe("Copilot Product protection integration", () => {
  it("registers two explicit cases on both environments with honest terminal expectations", () => {
    const cells = runnerMatrix.filter(x => x.suite.id === "copilot-protection");
    expect(cells[0]!.suite.definitionMetadata).toMatchObject({ version: 23, titleCreation: "explicit-search-composer", taskBinding: "browser-creation-response-id", naturalSettlementObservationMs: 2000, denialTerminal: "correlated-provider-settlement-and-audited-run-stop",
      denialSettlementEvidence: "paperclip.e2e.copilot-denial-settlement.v4", activeTurnCancellation: "not-implied-by-completed-provider-turn" });
    expect(suiteDefinitionHash(cells[0]!.suite)).not.toBe(suiteDefinitionHash({ ...cells[0]!.suite, definitionMetadata: { version: 2 } }));
    expect(cells).toHaveLength(4); expect(new Set(cells.map(c => c.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(cells.every(c => c.profile.qualificationCandidate === "copilot" && c.task.expectedRunCount === 1)).toBe(true);
    expect(cells.find(c => c.task.id === "native-permission-deny-write")!.task.expectedTerminalState).toEqual({ issue: "in_progress", run: "cancelled" });
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(x => x.suite.id === "copilot-protection")).toBe(false);
  });
  it.each(["copilot-denied-nonce.txt", "pc-denied-ABC123/copilot-denied-nonce.txt"])("feeds native denied-edit wire through canonical persistence and exact target oracle: %s", target => {
    const { notices } = projected("deny-write", target);
    const request = notices.find(n => n.stage === "permission_requested")!, delivered = notices.find(n => n.stage === "permission_delivered")!, failed = notices.find(n => n.status === "failed")!;
    const e = { expected: copilotOrigin(request), requestId: "permission", expectedRelativePath: target,
      request: { ...request, requestId: "permission", method: "session/request_permission" as const, targetRelativePath: request.target!, offeredActions: request.declineOffered ? ["decline"] : [] },
      decision: { ...delivered, requestId: "permission", browserRequestId: "permission", action: delivered.outcome === "reject_once" ? "decline" : "accept" },
      deliveredDecision: { ...delivered, requestId: "permission", outcome: delivered.outcome! },
      toolResult: { ...failed, status: "failed" as const }, terminal: { runId: "run", turnId: "turn", observedAtMs: 50, status: "cancelled" as const }, settlement: { schema: "paperclip.e2e.copilot-denial-settlement.v4" as const, ...copilotOrigin(request), requestId: "permission",
        branch: "provider_cancelled_or_interrupted" as const, providerCancellationTerminalObserved: true,
        preStop: { schema: "paperclip.e2e.copilot-pre-stop-observation.v2" as const, ...copilotOrigin(request), requestId: "permission", companyId: "company", normalizedSessionId: "normalized", sourceInstanceId: "runner", failedToolSourceSeq: 5, failedToolRowSha256: `sha256:${"a".repeat(64)}`, terminal: null, apiReadCompletedMonotonicNs: "10", cancellationRequestId: "11111111-1111-4111-8111-111111111111" }, stopDispatchMonotonicNs: "20",
      stopAcknowledgement: { schema: "paperclip.e2e.copilot-stop-acknowledgement.v1" as const, companyId: "company", runId: "run", issueId: "issue", callerUserId: "local-board", fixtureCorrelationId: "11111111-1111-4111-8111-111111111111", dispatchMonotonicNs: "20", apiResponseObservedMonotonicNs: "21", intentId: "native-cancellation:11111111-1111-4111-8111-111111111111", intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit", responseMetadataSha256: `sha256:${"c".repeat(64)}` },
      providerTerminal: { rowSha256: `sha256:${"b".repeat(64)}`, failedToolRowSha256: `sha256:${"a".repeat(64)}`, eventType: "turn.cancelled" as const, normalizedSessionId: "normalized", sourceInstanceId: "runner", requestSourceSeq: 1, resolvedSourceSeq: 2, deliveredSourceSeq: 3, failedNoticeSourceSeq: 4, failedToolSourceSeq: 5, failedToolRowCreatedAtMs: 31, sourceSeq: 6, emittedAtMs: 50, rowCreatedAtMs: 51 },
        runStop: { companyId: "company", issueId: "issue", scope: "run" as const, status: "cancelled" as const, issueStatus: "in_progress" as const, intentId: "native-cancellation:11111111-1111-4111-8111-111111111111", intentAuditId: "intent-audit", acknowledgementAuditId: "ack-audit", requestedAtMs: 40, recordedAtMs: 41, acknowledgedAtMs: 52, finishedAtMs: 53 } },
      cleanup: { observedAtMs: 60, ownedProcessesRemaining: 0 }, nativeAttemptsForTarget: 1,
      fileObservations: (["before-request", "pending", "after-decision", "terminal", "after-cleanup"] as const).map((phase, index) => ({ phase, observedAtMs: [0, request.observedAtMs, 30, 50, 60][index]!, exists: false, providerCursor: index === 0 ? null : { runId: "run", turnId: "turn", normalizedSessionId: "normalized", sourceInstanceId: "runner", sourceSeq: [0, 1, 4, 6, 6][index]! } })), mutationObservation: { startedAtMs: 0, endedAtMs: 60, complete: true, targetMutationCount: 0 } };
    expect(request.target).toBe(target);
    expect(gradeCopilotDeniedWrite(e).passed).toBe(true);
    e.request.targetRelativePath = "foreign.txt"; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
    e.request.targetRelativePath = e.expectedRelativePath; e.settlement.runStop.acknowledgementAuditId = ""; expect(gradeCopilotDeniedWrite(e).passed).toBe(false);
  });
  it("feeds actual attached wire through canonical notices and rejects early terminal or missing linkage", () => {
    const { notices } = projected("attached-shell"); const call = notices.find(n => n.commandSha256)!;
    const started = notices.find(n => n.shellState === "started")!, result = notices.find(n => n.shellState === "completed")!;
    const e = { expected: copilotOrigin(call), nativeCall: { ...call, operation: call.operation!, mode: call.mode!, detach: call.detach!, commandSha256: call.commandSha256! }, expectedCommand: fixture["attached-shell"][0].params.update.rawInput.command, commandMatch: matchCopilotFixtureCommand(fixture["attached-shell"][0].params.update.rawInput.command, call.commandSha256!), expectedCommandSha256: call.commandSha256!, expectedShellId: started.shellId!,
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
  it("isolates the denied parent from unrelated workspace startup churn and binds the prompt", async () => {
    const root = await mkdtemp("/tmp/pc-denial-isolated-");
    const fixture = await createDeniedTargetFixture(root, "copilot-denied-nonce.txt");
    try {
      const prompt = bindDeniedTargetPrompt(copilotProtectionCases[0].prompt("nonce"), "copilot-denied-nonce.txt", fixture.targetRelativePath);
      expect(prompt).toContain(`creating ${fixture.targetRelativePath} with DENIED-nonce`);
      expect(fixture.targetRelativePath).toMatch(/^pc-denied-[a-zA-Z0-9]+\/copilot-denied-nonce\.txt$/);
      await mkdir(join(root, "startup")); await writeFile(join(root, "startup", "runtime.json"), "{}");
      await writeFile(join(root, "transient"), "x"); await unlink(join(root, "transient"));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fixture.watcher.finish()).toMatchObject({ complete: true, targetMutationCount: 0, reasons: [] });
    } finally { fixture.watcher.finish(); await rm(root, { recursive: true, force: true }); }
  });
  it("retains a coverage gap when create/delete occurs before callbacks can arrive", async () => {
    const root = await mkdtemp("/tmp/pc-denial-gap-");
    // Make the pre-mutation version distinct even on filesystems that coalesce
    // directory timestamps within one clock tick. Assertions remain immediate.
    utimesSync(root, new Date(0), new Date(0));
    const watcher = watchDeniedTarget(root, "denied"), targetPath = join(root, "denied");
    try {
      writeFileSync(targetPath, "x"); unlinkSync(targetPath);
      const receipt = watcher.finish();
      expect(receipt).toMatchObject({ complete: false, targetMutationCount: 0 });
      expect(receipt.reasons).toContain("coverage-gap-parent-version-changed");
      expect(receipt.finalParent).not.toEqual(receipt.initialParent);
      expect(watcher.finish()).toBe(receipt);
    } finally { watcher.finish(); await rm(root, { recursive: true, force: true }); }
  });
  it("refuses a preexisting target, symlink parent and ambiguous prompt", async () => {
    const root = await mkdtemp("/tmp/pc-denial-invalid-");
    try {
      await writeFile(join(root, "denied"), "present");
      expect(() => watchDeniedTarget(root, "denied")).toThrow(/initially be absent/);
      await symlink(root, join(root, "link"));
      expect(() => watchDeniedTarget(join(root, "link"), "absent")).toThrow(/real directory/);
      expect(() => watchDeniedTarget(root, "../denied")).toThrow(/Invalid/);
      expect(() => bindDeniedTargetPrompt("no target", "denied", "pc-denied-a/denied")).toThrow(/exact target once/);
      expect(() => bindDeniedTargetPrompt("denied and denied", "denied", "pc-denied-a/denied")).toThrow(/exact target once/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("observes a transient create/delete even when final stat is absent", async () => {
    const root = await mkdtemp("/tmp/pc-copilot-watch-"); const watcher = watchDeniedTarget(root, "denied");
    try { await writeFile(join(root, "denied"), "x"); await unlink(join(root, "denied")); await new Promise(r => setTimeout(r, 30)); const proof = watcher.finish(); expect(proof.targetMutationCount > 0 || !proof.complete).toBe(true); expect(await exists(join(root, "denied"))).toBe(false); }
    finally { watcher.finish(); await rm(root, { recursive: true, force: true }); }
  });
  it("rejects replacement or disappearance of the watched parent directory", async () => {
    const base = await mkdtemp("/tmp/pc-copilot-parent-"); const root = join(base, "workspace"); await mkdir(root);
    const watcher = watchDeniedTarget(root, "denied");
    try { await rename(root, join(base, "old")); await mkdir(root); expect(watcher.finish().complete).toBe(false); expect(watcher.finish().reasons).toContain("parent-identity-changed"); }
    finally { watcher.finish(); await rm(base, { recursive: true, force: true }); }
    const gone = await mkdtemp("/tmp/pc-copilot-parent-"); const deleted = watchDeniedTarget(gone, "denied");
    await rm(gone, { recursive: true }); expect(deleted.finish().complete).toBe(false); expect(deleted.finish().reasons).toContain("parent-unavailable-at-finish");
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
  it("retains lost process identity after a later empty retirement sample", () => {
    let sample = { captured: true, live: [100], identityChanged: false };
    sample = retainRunProcessIdentity(sample, { captured: true, live: [], identityChanged: true });
    sample = retainRunProcessIdentity(sample, { captured: true, live: [], identityChanged: false });
    expect(sample).toEqual({ captured: true, live: [], identityChanged: true });
    expect(retainRunProcessIdentity({ captured: true, live: [100] }, { captured: true, live: [] }).identityChanged).toBe(false);
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
  it("holds only the owned child until the controller releases the observed finish boundary", async () => {
    const root = await mkdtemp("/tmp/pc-copilot-gated-command-"); const fixture = await createAttachedCommandFixture(join(root, "marker"), 100, true);
    const client = spawn("/bin/sh", ["-c", fixture.command], { stdio: "ignore" });
    const exited = new Promise<number | null>(resolve => client.once("exit", resolve));
    try {
      const deadline = Date.now() + 3000;
      while (!fixture.snapshot().childPid && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(fixture.snapshot()).toMatchObject({ connections: 1, failure: null, commandExit: null, childGone: false, clientGone: false });
      const release = fixture.releaseAfterFinish();
      expect(() => fixture.releaseAfterFinish()).toThrow();
      expect(await exited).toBe(0);
      expect(fixture.snapshot().commandExit!.observedAtMs).toBeGreaterThan(release.releasedAtMs);
      expect(await readFile(join(root, "marker"), "utf8")).toBe(fixture.marker);
    } finally { await fixture.close(); await exited; await rm(root, { recursive: true, force: true }); }
  });
});

it("rejects remote protection before any API access without bootstrap and pre-teardown authority", async () => {
  const { runCopilotProtectionFlow } = await import("./copilot-protection-flow.js");
  let calls = 0;
  await expect(runCopilotProtectionFlow({ execution: { environment: { id: "daytona" }, profile: { qualificationCandidate: "copilot" }, task: { id: "native-permission-deny-write" } }, api: { get: async () => { calls++; } } } as any)).rejects.toThrow(/bootstrap and pre-teardown/);
  expect(calls).toBe(0);
});
