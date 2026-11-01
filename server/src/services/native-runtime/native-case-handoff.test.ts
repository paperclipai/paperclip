import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, caseEvents, caseHandoffs, cases, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { assertAgentRunWriteAllowed } from "../../agent-run-cancellation.js";
import { assertNoCaseHandoffMutation, isCaseHandoffSourceReleased, pendingCaseHandoffForRun, recordCaseHandoffExecutionReleased } from "../heartbeat/case-handoff-lifecycle.js";
import { nativeCaseHandoffResult, assertNativeCaseHandoffResult } from "./native-case-handoff.js";
import { createGovernedWaitEventObservation } from "./native-session-executor.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { recordNativeLocalProcessStop } from "../native-local-process-stop.js";
import { issueService } from "../issues.js";
import { prepareHeartbeatRunScratch, cleanupHeartbeatRunScratch } from "../run-scratch.js";

describe("native persisted case handoff runtime", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("case-handoff-runtime-"); db = createDb(temporary.connectionString); });
  afterAll(async () => { await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), recipient = randomUUID(), issueId = randomUUID(), runId = randomUUID(), caseId = randomUUID(), handoffId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Factory", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values([{ id: agentId, companyId, name: "Triage", role: "ceo", status: "active" }, { id: recipient, companyId, name: "Builder", role: "engineer", status: "active" }]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Build", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId } });
    await db.insert(cases).values({ id: caseId, companyId, caseNumber: 1, identifier: `CASE-${caseId}`, caseType: "work", title: "Build", workIssueId: issueId, handoffVersion: 1 });
    await db.insert(caseHandoffs).values({ id: handoffId, companyId, caseId, issueId, version: 1, fromAgentId: agentId, toAgentId: recipient,
      phase: "implementation", instructions: "Implement the saved specification", actorType: "agent", actorId: agentId, sourceRunId: runId,
      wakeupRequestId: randomUUID(), idempotencyKey: "phase-1", inputFingerprint: "test", state: "awaiting_release" });
    const input = { runId, issueId, completionContract: { revision: "revision-1", criteria: [{ id: "objective" }] } };
    return { companyId, agentId, issueId, runId, handoffId, input };
  }
  it("uses persisted intent to yield after the accepted tool response, without a finish call", async () => {
    const f = await fixture();
    const observation = createGovernedWaitEventObservation(() => nativeCaseHandoffResult(db, f.input));
    const event = { schema: "paperclip.prp.event.v1", sourceEventId: "tool-result", sourceInstanceId: "provider", sourceSeq: 2,
      runId: f.runId, eventType: "item.completed", itemId: "handoff-tool", payload: { kind: "dynamicToolCall" },
      sourceKind: "provider", normalizedSessionId: "session", schemaVersion: 1, priority: "normal", emittedAt: new Date().toISOString() } as unknown as PrpEvent;
    await observation.observe(event, true);
    const result = observation.consume(event)!;
    expect(result).toMatchObject({ reportedWorkDisposition: "yielded", completionClaim: { objectiveSatisfied: false },
      continuation: { kind: "case_handoff", handoffId: f.handoffId } });
    expect(observation.consume(event)).toBeNull();
    await expect(assertNativeCaseHandoffResult(db, f.runId, f.issueId, { ...result, continuation: { ...result.continuation!, handoffId: randomUUID() } })).rejects.toThrow("exact persisted");
    await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date() }).where(eq(caseHandoffs.id, f.handoffId));
    // A later Stop must not strand cleanup of the already-checkpointed yield.
    expect(await assertNativeCaseHandoffResult(db, f.runId, f.issueId, result)).toMatchObject({ id: f.handoffId, state: "cancelled" });
  });
  it("fences late writes and requires executor settlement beyond terminal task status", async () => {
    const f = await fixture();
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, { agentId: f.agentId, runId: f.runId }))).rejects.toThrow("handed off");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await isCaseHandoffSourceReleased(db, f.input)).toBe(false);
    await db.update(caseHandoffs).set({ nextAttemptAt: new Date(Date.now() + 60_000) }).where(eq(caseHandoffs.id, f.handoffId));
    await recordCaseHandoffExecutionReleased(db, f.runId, f.issueId);
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await isCaseHandoffSourceReleased(db, f.input)).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]?.status).toBe("in_progress");
  });
  it("keeps a terminal done intent writable and outside native yield and generic-recovery suppression", async () => {
    const f = await fixture();
    await db.update(caseHandoffs).set({ destinationKind: "done", toAgentId: null, phase: "done", state: "awaiting_completion" })
      .where(eq(caseHandoffs.id, f.handoffId));
    expect(await nativeCaseHandoffResult(db, f.input)).toBeNull();
    // Legacy/native recovery use this same predicate to suppress recovery only
    // when the execution actually transferred work to another phase.
    expect(await pendingCaseHandoffForRun(db, f.runId)).toBeNull();
    await expect(assertNoCaseHandoffMutation(db, f.runId, f.issueId)).resolves.toBeUndefined();
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId,
      { agentId: f.agentId, runId: f.runId }))).resolves.toMatchObject({ status: "running", companyId: f.companyId });
    const forged = { continuation: { kind: "case_handoff", handoffId: f.handoffId } };
    await expect(assertNativeCaseHandoffResult(db, f.runId, f.issueId, forged)).rejects.toThrow("exact persisted");
    await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date() }).where(eq(caseHandoffs.id, f.handoffId));
    await expect(assertNativeCaseHandoffResult(db, f.runId, f.issueId, forged)).rejects.toThrow("exact persisted");
  });
  it("recovers a missing controller marker only after real stopped-process and cleanup evidence", async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "failed", finishedAt: new Date(), processPid: child.pid! }).where(eq(heartbeatRuns.id, f.runId));
    expect(await isCaseHandoffSourceReleased(db, f.input)).toBe(false);
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(await recordNativeLocalProcessStop(db, run!)).toBe(true);
    // A new worker has no process-local state and reconstructs the release.
    expect(await isCaseHandoffSourceReleased(db, f.input)).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]?.resultJson).toHaveProperty("caseHandoffExecutionReleased");
  });
  it("withholds release when the main process exited but its grandchild still owns the process group", async () => {
    const f = await fixture();
    const scratch = await prepareHeartbeatRunScratch({ companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId });
    const parent = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(child.pid));setTimeout(()=>process.exit(0),100);"],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const groupId = parent.pid!;
    try {
      await once(parent.stdout!, "data");
      await once(parent, "exit");
      const groupAlive = (id: number | null | undefined) => { try { process.kill(-id!, 0); return true; } catch { return false; } };
      expect(groupAlive(groupId)).toBe(true);
      await db.update(heartbeatRuns).set({ runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
        processPid: groupId, processGroupId: groupId }).where(eq(heartbeatRuns.id, f.runId));
      const cleanup = await cleanupHeartbeatRunScratch({ scratch, processGroupId: groupId, isProcessGroupAlive: groupAlive });
      expect(cleanup).toMatchObject({ removed: false, reason: "process_group_alive" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(await recordNativeLocalProcessStop(db, run!)).toBe(false);
      expect(await isCaseHandoffSourceReleased(db, f.input)).toBe(false);
    } finally {
      try { process.kill(-groupId, "SIGTERM"); } catch { /* process group already retired */ }
      await rm(scratch.dir, { recursive: true, force: true });
    }
  });
  it("manual reassignment invalidates pending intent and appends case history", async () => {
    const f = await fixture(), next = randomUUID();
    await db.insert(agents).values({ id: next, companyId: f.companyId, name: "Other", role: "engineer", status: "active" });
    await issueService(db).update(f.issueId, { assigneeAgentId: next });
    expect((await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]?.state).toBe("cancelled");
    expect(await db.select().from(caseEvents).where(eq(caseEvents.caseId, (await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)))[0]!.caseId))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "handoff_cancelled" })]));
  });
});
