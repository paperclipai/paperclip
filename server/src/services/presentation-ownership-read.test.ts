import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, completionContracts, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { eq, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { NativeRunCoordinatorStore } from "./native-runtime/native-run-coordinator-store.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { isExternalChatPresentationContext } from "./heartbeat-run-summary.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "./native-runtime/native-run-finalizer.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("presentation and ownership PostgreSQL read projections", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("presentation-ownership-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Read fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Read agent", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Read task", status: "blocked", assigneeAgentId: agentId });
    const payload = randomBytes(128 * 1024).toString("base64");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
      status: "failed", runtimeMode: "legacy", finishedAt: new Date("2020-01-01T00:00:00Z"),
      contextSnapshot: { issueId, source: "chat:fixture", prompt: payload,
        paperclipWake: { externalInteractionContinuation: true, prompt: payload } },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", instructions: payload }, nativeExecutionInput: { prompt: payload } },
      resultJson: { unknownFutureRecoveryReceipt: { preserved: true } }, stdoutExcerpt: payload, stderrExcerpt: payload,
      ...patch,
    }).returning();
    return { companyId, agentId, issueId, run };
  }

  function captureReads(fullRows = false) {
    const rows: unknown[][] = [];
    function recordSelects<T extends Pick<Db, "select">>(executor: T): T {
      return new Proxy(executor, { get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = target.select(...fields), from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const selection = fields[0];
            const nested = selection && "run" in selection && "activeLease" in selection;
            const repairSource = selection && "nativeSessionId" in selection && "completionContractId" in selection && "finishedAt" in selection;
            const sourceRead = args[0] === heartbeatRuns && (nested || repairSource);
            const query = fullRows && sourceRead
              ? (nested ? target.select({ run: heartbeatRuns, activeLease: selection.activeLease as SQL }) : target.select()).from(heartbeatRuns)
              : from(...args);
            if (sourceRead) {
              const execute = query.execute.bind(query);
              query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                const result = await execute(...executeArgs); rows.push(result); return result;
              };
            }
            return query;
          }) as typeof builder.from;
          return builder;
        };
      }});
    }
    const root = recordSelects(db);
    const transaction: Db["transaction"] = (callback, config) => db.transaction(tx => callback(recordSelects(tx)), config);
    const recorded = new Proxy(root, { get(target, key) { return key === "transaction" ? transaction : Reflect.get(target, key); } });
    return { recorded, rows };
  }

  async function compareOwnership(f: Awaited<ReturnType<typeof fixture>>) {
    const baseline = captureReads(true), projected = captureReads();
    const expected = await getConversationOwnershipBlocker(baseline.recorded, f.companyId, f.issueId);
    const actual = await getConversationOwnershipBlocker(projected.recorded, f.companyId, f.issueId);
    expect(actual).toEqual(expected);
    expect(projected.rows.flat()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected.rows))).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(baseline.rows))).toBeGreaterThan(128 * 1024);
    return actual;
  }

  it("keeps current process authority without reading execution payloads", async () => {
    const f = await fixture({ processPid: process.pid });
    expect(await compareOwnership(f)).toMatchObject({ runId: f.run.id, cause: "execution_owner_active" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    expect(await getConversationOwnershipBlocker(db, randomUUID(), f.issueId)).toBeNull();
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("retains an active lease until the current database row releases it", async () => {
    const f = await fixture();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id,
      issueId: f.issueId, provider: "daytona", providerLeaseId: "fixture-lease", status: "active" }).returning();
    expect(await compareOwnership(f)).toMatchObject({ runId: f.run.id, cause: "execution_owner_active" });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]).toEqual(lease);
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(environmentLeases.id, lease.id));
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("keeps unconfirmed remote cleanup and all recovery evidence", async () => {
    const f = await fixture();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.run.id,
      issueId: f.issueId, provider: "daytona", providerLeaseId: "retained-fixture", status: "released",
      releasedAt: new Date("2020-01-01T00:00:00Z"), cleanupStatus: "success" }).returning();
    const result = { ...f.run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] } };
    await db.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await compareOwnership(f)).toMatchObject({ runId: f.run.id, cause: "execution_owner_active" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].resultJson).toEqual(result);
  });

  async function compareRepair(f: Awaited<ReturnType<typeof fixture>>) {
    const baseline = captureReads(true), projected = captureReads();
    const input = { companyId: f.companyId, issueId: f.issueId, runId: f.run.id };
    expect(await repairCommittedNativeChatResponse(projected.recorded, input))
      .toBe(await repairCommittedNativeChatResponse(baseline.recorded, input));
    expect(projected.rows.flat()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(projected.rows))).toBeLessThan(4096);
    expect(Buffer.byteLength(JSON.stringify(baseline.rows))).toBeGreaterThan(128 * 1024);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
    return projected.rows.flat()[0] as { contextSnapshot: Record<string, unknown> | null; resultJson: unknown };
  }

  it("preserves selected answers without downloading prompts, profiles, or excerpts", async () => {
    const f = await fixture({ runtimeMode: "native", status: "succeeded", resultJson: {
      presentationDecision: { commentId: randomUUID() }, unknownFutureReceipt: { preserved: true } } });
    const row = await compareRepair(f);
    expect(row.resultJson).toEqual(f.run.resultJson);
    expect(await repairCommittedNativeChatResponse(db, { companyId: randomUUID(), issueId: f.issueId, runId: f.run.id })).toBe(false);
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
    expect(await repairCommittedNativeChatResponse(db, { companyId: f.companyId, issueId: other.id, runId: f.run.id })).toBe(false);
  });

  async function unpublishedAcceptedReply() {
    const payload = randomBytes(128 * 1024).toString("base64");
    const f = await fixture({ runtimeMode: "native", status: "running", finishedAt: null,
      contextSnapshot: { source: "internal", prompt: payload, paperclipWake: { prompt: payload } } });
    const [contract] = await db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", objective: "Finish the fixture task", criteria: [] },
      canonicalSha256: "read-fixture-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    const sessionId = randomUUID(), runnerId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract.id, completionContractSha256: contract.canonicalSha256 }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ status: "in_progress", executionRunId: f.run.id }).where(eq(issues.id, f.issueId));
    const port = new NativeRunCoordinatorStore(db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.run.id, agentId: f.agentId, normalizedSessionId: sessionId, completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256, runnerSourceInstanceId: runnerId,
      completionContractRevision: "test", completionContractCriterionIds: [] });
    const reply = "The accepted provider reply is preserved exactly.";
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.run.id, agentId: f.agentId,
      seq: 1_000_000, eventType: "item.completed", payload: { prpEvent: { turnId: "reply-turn", sourceEventId: "fixture-final-answer",
        payload: { kind: "agentMessage", channel: "final", text: reply } } } });
    await port.completeRun({ result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "The accepted summary differs from its final answer.", completionClaim: { contractRevision: "test",
        objectiveSatisfied: true, criteria: [], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" },
      turnId: "reply-turn" });
    await finalizeNativeRun({ db, runId: f.run.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toMatchObject({ phase: "committed" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id))).toEqual([]);
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(before.resultJson?.presentationDecision).toBeUndefined();
    return { ...f, before, reply };
  }

  it("publishes the same accepted reply and decision from equivalent full-row and projected starting states", async () => {
    const outcomes: unknown[] = [];
    for (const fullRows of [true, false]) {
      const f = await unpublishedAcceptedReply(), captured = captureReads(fullRows);
      const input = { companyId: f.companyId, issueId: f.issueId, runId: f.run.id };
      expect(await repairCommittedNativeChatResponse(captured.recorded, input)).toBe(true);
      const comments = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id));
      expect(comments).toHaveLength(1); expect(comments[0].body).toBe(f.reply);
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      const decision = after.resultJson!.presentationDecision as Record<string, unknown>;
      expect(decision.commentId).toBe(comments[0].id);
      const { commentId: _, ...stableDecision } = decision;
      outcomes.push({ body: comments[0].body, decision: stableDecision });
      expect(after.resultJson).toMatchObject(f.before.resultJson!);
      expect(after.contextSnapshot).toEqual(f.before.contextSnapshot);
      expect(after.runnerProfileJson).toEqual(f.before.runnerProfileJson);
      expect(after.stdoutExcerpt).toBe(f.before.stdoutExcerpt);
      expect(after.stderrExcerpt).toBe(f.before.stderrExcerpt);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.run.id))).toHaveLength(1);
      expect(await repairCommittedNativeChatResponse(db, input)).toBe(false);
      expect(await db.select().from(issueComments).where(eq(issueComments.createdByRunId, f.run.id))).toHaveLength(1);
      expect(captured.rows.flat()).toHaveLength(1);
      if (fullRows) expect(Buffer.byteLength(JSON.stringify(captured.rows))).toBeGreaterThan(128 * 1024);
      else expect(Buffer.byteLength(JSON.stringify(captured.rows))).toBeLessThan(4096);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it.each([null, [], "scalar", 42, { source: 42, skipIssueComment: "true", paperclipWake: [] },
    { source: "issue.comment.created", externalChatContinuation: true },
    { source: "chat:fixture", skipIssueComment: true, paperclipWake: { externalInteractionContinuation: "true" } },
    { source: "internal", paperclipWake: { externalInteractionContinuation: true } },
  ].map(context => ({ context })))("preserves typed publication flags for $context", async ({ context }) => {
    const f = await fixture({ runtimeMode: "native", status: "succeeded", contextSnapshot: context as Record<string, unknown> | null });
    const row = await compareRepair(f);
    expect(isExternalChatPresentationContext(row.contextSnapshot)).toBe(isExternalChatPresentationContext(context));
    const original = context && typeof context === "object" && !Array.isArray(context) ? context : {};
    expect(row.contextSnapshot?.skipIssueComment === true).toBe((original as Record<string, unknown>).skipIssueComment === true);
  });

  it.each([null, ["stdout", { receipt: true }], "scalar", 42].map(result => ({ result })))("preserves non-object result evidence $result", async ({ result }) => {
    const f = await fixture({ runtimeMode: "native", status: "succeeded", resultJson: result as Record<string, unknown> | null });
    expect((await compareRepair(f)).resultJson).toEqual(result);
  });
});
