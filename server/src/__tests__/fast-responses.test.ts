import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import {
  createDb,
  companies,
  projects,
  agents,
  companyMemberships,
  companyFastResponses,
  costEvents,
  costAdjustments,
  activityLog,
  fastResponseRequests,
  connectionGrants,
  connectionGrantMembers,
  budgetPolicies,
  budgetReservations,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueComments,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  enqueueFastResponse,
  supersedeFastResponse,
  fastResponseTurnQueued,
  fastResponseService,
} from "../services/fast-responses.js";
import {
  fastResponseReceipt,
  type FastResponseOutcome,
} from "../services/fast-response-provider.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { settleConversationTurn } from "../services/agent-conversations.js";
import { buildLowTrustSourceTrust, LOW_TRUST_QUARANTINED_BODY } from "../services/source-trust.js";
import { deliverBudgetEnforcement, flushBudgetEvaluationWork } from "../services/budgets.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { deleteAgentDependencies } from "../services/agent-deletion.js";
import { billingReconciliationService } from "../services/billing-reconciliation.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined,
  db: ReturnType<typeof createDb>,
  home: string;
beforeAll(async () => {
  home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "paperclip-fast-response-")),
  );
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "fast-response-fixture");
  const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (external && !new URL(external).pathname.endsWith("_test")) throw new Error("Fast-response tests require a database ending in _test");
  database = external ? undefined : await startEmbeddedPostgresTestDatabase(
    "paperclip-fast-response-db-",
  );
  db = createDb(external ?? database!.connectionString);
}, 90000);
afterAll(async () => {
  await db?.$client.end({ timeout: 1 });
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});
const outcome: FastResponseOutcome = {
  text: "I’ll check the settings panel’s border styling and work on the fix.",
  receipt: fastResponseReceipt({
    usage: { inputTokens: 80, outputTokens: 16 },
    response: { id: "response-1", body: { usage: { cost: 0.00001 } } },
  }),
};
let sequence = 0;
async function fixture() {
  await instanceSettingsService(db).updateExperimental({ enableFastResponses: true });
  const companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Fast response tests",
    issuePrefix: `FR${++sequence}`,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Alex",
    adapterType: "codex_local",
  });
  await db.insert(companyMemberships).values(
    ["alice", "bob"].map((principalId) => ({
      companyId,
      principalId,
      principalType: "user",
      status: "active",
      membershipRole: "owner",
    })),
  );
  const binding = await aiConnectionService(db).save(
    companyId,
    "alice",
    {
      provider: "openrouter",
      method: "api_key",
      name: "Fast key",
      ownership: "shared",
      apiKey: "fixture-key",
      agentIds: [],
      allAgents: true,
    },
    "fixture-key",
  );
  const provider = vi.fn().mockResolvedValue(structuredClone(outcome)),
    service = fastResponseService(db, { provider });
  const config = {
    connectionId: binding.connectionId,
    grantId: binding.grantId,
    enabled: true,
    model: "openai/gpt-oss-120b",
    allowSponsored: true,
  };
  await service.configure(companyId, "alice", config);
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Settings panel",
    status: "in_progress",
    assigneeAgentId: agentId,
  });
  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId,
      issueId,
      authorUserId: "alice",
      body: "Fix the border styling",
    })
    .returning();
  const source = {
    companyId,
    agentId,
    issueId,
    responsibleUserId: "alice",
    sourceCommentId: comment.id,
    sourceKey: `comment:${comment.id}`,
    acceptedAt: comment.createdAt,
  };
  const enqueue = async () => {
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, source),
    );
    return (
      await db
        .select()
        .from(fastResponseRequests)
        .where(eq(fastResponseRequests.companyId, companyId))
    )[0];
  };
  return {
    companyId,
    agentId,
    issueId,
    comment,
    source,
    config,
    binding,
    provider,
    service,
    enqueue,
  };
}
describe("fast response accepted turns", () => {
  it("returns acknowledgement text and a committed charge before slow budget stop delivery", async () => {
    const f = await fixture();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      windowKind: "calendar_month_utc", amount: 1, notifyEnabled: false });
    f.provider.mockResolvedValue({ ...structuredClone(outcome), receipt: { ...outcome.receipt, costCents: "2.0000000" } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelWorkForScope = vi.fn(() => gate);
    const service = fastResponseService(db, { provider: f.provider, budgetHooks: { cancelWorkForScope } });
    const pending = service.test(f.companyId, "alice");
    let delivery: Promise<void> | undefined;
    let finished = false;
    void pending.then(() => { finished = true; }, () => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 3000 });
      expect(await pending).toMatchObject({ status: "succeeded", text: outcome.text });
      expect(f.provider).toHaveBeenCalledOnce();
      expect(cancelWorkForScope).not.toHaveBeenCalled();
      const events = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ usageKind: "fast_response", costCents: 2 });
      await flushBudgetEvaluationWork(db, { companyId: f.companyId });
      const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, f.companyId));
      expect(policy.enforcementVersion).toBeGreaterThan(policy.enforcementDeliveredVersion);
      delivery = deliverBudgetEnforcement(db, { cancelWorkForScope }, f.companyId);
      await vi.waitFor(() => expect(cancelWorkForScope).toHaveBeenCalledOnce());
      expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))[0].enforcementDeliveredVersion).toBe(policy.enforcementDeliveredVersion);
      release(); await delivery;
      expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))[0].enforcementDeliveredVersion).toBe(policy.enforcementVersion);
    } finally { release(); await pending.catch(() => undefined); await delivery?.catch(() => undefined); }
  });
  it.each(["company", "agent", "policy"] as const)("settles while an unrelated %s accounting row is locked", async locked => {
    const f = await fixture(), request = await f.enqueue();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      windowKind: "calendar_month_utc", amount: 100, notifyEnabled: false }).returning();
    let providerEntered!: () => void, finishProvider!: () => void, unlock!: () => void, lockedRow!: () => void;
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const providerGate = new Promise<void>(resolve => { finishProvider = resolve; });
    const lockGate = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { lockedRow = resolve; });
    f.provider.mockImplementationOnce(async () => { providerEntered(); await providerGate; return structuredClone(outcome); });
    const pending = f.service.process(request);
    await entered;
    const blocker = db.transaction(async tx => {
      if (locked === "company") await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      if (locked === "agent") await tx.select().from(agents).where(eq(agents.id, f.agentId)).for("no key update");
      if (locked === "policy") await tx.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id)).for("no key update");
      lockedRow(); await lockGate;
    });
    let finished = false;
    void pending.finally(() => { finished = true; }).catch(() => undefined);
    try {
      await acquired; finishProvider();
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 3000 });
      expect(await pending).toMatchObject({ status: "succeeded", text: outcome.text });
      expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe("settled");
    } finally { unlock(); finishProvider(); await blocker; await pending.catch(() => undefined); }
  });
  it.each(["company", "project"] as const)("denies paid admission when %s manual pause wins its control fence", async scope => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Control fence" }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    const request = await f.enqueue();
    let unlock!: () => void, locked!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<number>(resolve => { locked = resolve; });
    const holding = db.transaction(async tx => {
      if (scope === "company") await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      else await tx.select().from(projects).where(eq(projects.id, project.id)).for("no key update");
      const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked(row.pid); await gate;
      if (scope === "company") await tx.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.companyId));
      else await tx.update(projects).set({ pauseReason: "manual", pausedAt: new Date() }).where(eq(projects.id, project.id));
    });
    const pid = await acquired;
    const pending = f.service.process(request);
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`);
        expect(row.count).toBeGreaterThan(0);
      }, { timeout: 3000 });
      unlock(); await holding;
      expect(await pending).toMatchObject({ status: "unavailable" });
      expect(f.provider).not.toHaveBeenCalled();
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.id, request.id)))[0].status).toBe("skipped");
    } finally { unlock(); await holding; await pending.catch(() => undefined); }
  });
  it.each([
    { recoveryFirst: true, priced: true, corrected: false }, { recoveryFirst: false, priced: true, corrected: false },
    { recoveryFirst: true, priced: false, corrected: false }, { recoveryFirst: false, priced: false, corrected: false },
    { recoveryFirst: true, priced: true, corrected: true },
  ])("keeps a real result with recovery first: $recoveryFirst, priced: $priced, corrected: $corrected", async ({ recoveryFirst, priced, corrected }) => {
    const f = await fixture(), request = await f.enqueue();
    const realOutcome: FastResponseOutcome = priced ? structuredClone(outcome) : { ...structuredClone(outcome), receipt: {
      ...outcome.receipt, costCents: null, costStatus: "unpriced", pricingProvenance: { source: "unknown" } } };
    let finishProvider!: () => void, providerEntered!: () => void;
    const gate = new Promise<void>(resolve => { finishProvider = resolve; });
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    f.provider.mockImplementationOnce(async () => { providerEntered(); await gate; return realOutcome; });
    const pending = f.service.process(request);
    await entered;
    await db.update(fastResponseRequests).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(fastResponseRequests.id, request.id));
    let originalHash: string | null = null;
    try {
      if (recoveryFirst) {
        await Promise.all([f.service.sweepPending(), f.service.sweepPending()]);
        const [event] = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
        expect(event.costStatus).toBe("unpriced"); originalHash = event.receiptHash;
        if (corrected) await billingReconciliationService(db).adjust(f.companyId, event.id, { idempotencyKey: "invoice-before-receipt",
          expectedCents: "0", correctedCents: "0.005", reason: "Verified invoice before provider completed", pricing: { source: "operator" } }, "alice");
      }
      finishProvider();
      expect(await pending).toMatchObject({ status: "succeeded", text: outcome.text });
      await f.service.sweepPending();
      const events = await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ costStatus: priced ? "reported" : "unpriced", costCents: corrected ? 0.005 : priced ? 0.001 : 0 });
      expect(events[0]).toMatchObject({ inputTokens: 80, cachedInputTokens: 0, outputTokens: 16,
        providerRequestId: outcome.receipt.providerRequestId });
      const corrections = await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, f.companyId));
      expect(corrections).toHaveLength(recoveryFirst ? corrected ? 2 : 1 : 0);
      if (recoveryFirst) {
        expect(events[0]).toMatchObject({ receiptHash: originalHash, reportedCostCents: "0.0000000",
          reportedUsageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerRequestId: null } });
        expect(corrections.find(row => row.idempotencyKey.endsWith(":late-receipt") || row.idempotencyKey.endsWith(":late-usage"))?.previousUsageJson)
          .toMatchObject({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, providerRequestId: null });
        if (priced && !corrected) expect(JSON.parse(corrections[0].pricing.evidence as string)).toMatchObject({ inputTokens: 80, outputTokens: 16 });
      }
      if (corrected) {
        expect(events[0].pricingProvenance).toEqual({ source: "operator" });
        const observed = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "accounting.late_receipt_observed")));
        expect(observed).toHaveLength(1);
        expect(observed[0].details).toMatchObject({ effectiveCostCents: "0.0050000", costCents: "0.0010000", inputTokens: 80, outputTokens: 16 });
      }
      expect((await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.id, request.id)))[0]).toMatchObject({
        status: "succeeded", costEventId: events[0].id, inputTokens: 80, outputTokens: 16 });
      expect((await db.select().from(budgetReservations).where(eq(budgetReservations.companyId, f.companyId)))[0].state).toBe(priced ? "settled" : "held");
      expect(await db.select().from(issueComments).where(and(eq(issueComments.companyId, f.companyId), eq(issueComments.origin, "fast_response"))))
        .toHaveLength(recoveryFirst ? 0 : 1);
      expect(f.provider).toHaveBeenCalledOnce();
    } finally { finishProvider(); await pending.catch(() => undefined); }
  });
  it("does not enqueue or infer while the experimental setting is disabled", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableFastResponses: false });
    expect(await f.enqueue()).toBeUndefined();
    expect(await f.service.availability(f.companyId, "alice")).toMatchObject({ available: false });
    expect(await f.service.test(f.companyId, "alice")).toMatchObject({ status: "unavailable", reason: "disabled" });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("suppresses pending work when the experimental setting is switched off", async () => {
    const f = await fixture();
    const request = await f.enqueue();
    await instanceSettingsService(db).updateExperimental({ enableFastResponses: false });
    await f.service.process(request);
    expect(f.provider).not.toHaveBeenCalled();
    const [row] = await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.id, request.id));
    expect(row).toMatchObject({ status: "skipped", publicationStatus: "suppressed", commentId: null });
  });

  it("retains charges but suppresses a response when disabled during inference", async () => {
    const f = await fixture();
    const request = await f.enqueue();
    f.provider.mockImplementationOnce(async () => {
      await instanceSettingsService(db).updateExperimental({ enableFastResponses: false });
      return structuredClone(outcome);
    });
    await f.service.process(request);
    const [row] = await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.id, request.id));
    expect(row).toMatchObject({ status: "succeeded", publicationStatus: "suppressed", commentId: null });
    expect(row.costEventId).toBeTruthy();
  });

  it.each(["recent", "source"] as const)("keeps quarantined %s text out of the acknowledgement prompt", async location => {
    const f = await fixture();
    const untrusted = "QUARANTINED_PRIVATE_FINDING_DO_NOT_PROMOTE";
    const sourceTrust = buildLowTrustSourceTrust({ issueId: f.issueId, agentId: f.agentId });
    if (location === "source") {
      await db.update(issueComments).set({ body: untrusted, sourceTrust }).where(eq(issueComments.id, f.comment.id));
    } else {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
        body: untrusted, sourceTrust, createdAt: new Date(f.source.acceptedAt.getTime() - 1) });
    }
    await f.service.process(await f.enqueue());
    expect(f.provider).toHaveBeenCalledTimes(1);
    const prompt = f.provider.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain(untrusted);
    expect(prompt).toContain(LOW_TRUST_QUARANTINED_BODY);
    const [receipt] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.origin, "fast_response")));
    expect(receipt.body).not.toContain(untrusted);
    expect(receipt.sourceTrust).toEqual(location === "source" ? sourceTrust : null);
  });
  it("distinguishes the current turn's running agent from older or queued work", async () => {
    const f = await fixture();
    expect(await fastResponseTurnQueued(db, f.source)).toBe(false);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.agentId,
        status: "running",
        contextSnapshot: { issueId: f.issueId, wakeCommentId: f.comment.id },
        createdAt: new Date(f.source.acceptedAt.getTime() - 1),
      })
      .returning();
    expect(await fastResponseTurnQueued(db, f.source)).toBe(false);
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: { issueId: f.issueId, wakeCommentId: randomUUID() },
      })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await fastResponseTurnQueued(db, f.source)).toBe(true);
    await db
      .update(heartbeatRuns)
      .set({
        status: "queued",
        createdAt: new Date(f.source.acceptedAt.getTime() + 1),
      })
      .where(eq(heartbeatRuns.id, run.id));
    expect(await fastResponseTurnQueued(db, f.source)).toBe(true);
  });
  it("starts disabled, and disabled turns have no request or cost", async () => {
    const f = await fixture();
    await db
      .delete(companyFastResponses)
      .where(eq(companyFastResponses.companyId, f.companyId));
    expect(await f.service.settings(f.companyId)).toMatchObject({
      enabled: false,
      allowSponsored: true,
    });
    expect(await f.enqueue()).toBeUndefined();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent workers and persists provenance without fabricating a run", async () => {
    const f = await fixture();
    const row = await f.enqueue();
    await f.enqueue();
    await Promise.all([f.service.process(row), f.service.process(row)]);
    expect(f.provider).toHaveBeenCalledTimes(1);
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, f.companyId),
          eq(issueComments.origin, "fast_response"),
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      authorAgentId: f.agentId,
      createdByRunId: null,
      fastResponseRequestId: row.id,
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(0);
    await db
      .update(issues)
      .set({
        conversationAgentId: f.agentId,
        conversationUserId: "alice",
        conversationState: "active",
      })
      .where(eq(issues.id, f.issueId));
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.agentId,
        status: "succeeded",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: f.issueId, wakeCommentId: f.comment.id },
      })
      .returning();
    expect(await settleConversationTurn(db, run)).toBe(false);
    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.companyId, f.companyId));
    expect(event).toMatchObject({
      usageKind: "fast_response",
      heartbeatRunId: null,
      costCents: 0.001,
      responsibleUserId: "alice",
    });
    expect(
      (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]
        .status,
    ).toBe("in_progress");
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.fastResponseRequestId, row.id))
      )[0].state,
    ).toBe("settled");
  });
  it.each([
    "reply",
    "cancel",
    "delete",
    "reassign",
    "edit",
    "revoke",
    "reset",
    "stream",
    "board_stream",
  ])(
    "suppresses output after %s but retains its actual cost",
    async (change) => {
      const f = await fixture(),
        row = await f.enqueue();
      if (change === "reset") {
        await db
          .update(fastResponseRequests)
          .set({ sessionGeneration: 0 })
          .where(eq(fastResponseRequests.id, row.id));
        row.sessionGeneration = 0;
      }
      f.provider.mockImplementationOnce(async () => {
        if (change === "reset")
          await db
            .update(issues)
            .set({ conversationSessionGeneration: 1 })
            .where(eq(issues.id, f.issueId));
        if (change === "board_stream")
          await supersedeFastResponse(db, f.companyId, f.comment.id);
        if (change === "stream") {
          const [run] = await db
            .insert(heartbeatRuns)
            .values({
              companyId: f.companyId,
              agentId: f.agentId,
              status: "running",
              invocationSource: "on_demand",
              contextSnapshot: {
                issueId: f.issueId,
                wakeCommentId: f.comment.id,
              },
            })
            .returning();
          await db.insert(heartbeatRunEvents).values({
            companyId: f.companyId,
            agentId: f.agentId,
            runId: run.id,
            seq: 1,
            eventType: "item.delta",
            payload: {
              prpEvent: {
                payload: {
                  kind: "agentMessage",
                  text: "Here is the recommendation",
                },
              },
            },
          });
        }
        if (change === "reply")
          await db.insert(issueComments).values({
            companyId: f.companyId,
            issueId: f.issueId,
            authorAgentId: f.agentId,
            body: "I fixed the border.",
          });
        if (change === "cancel")
          await db
            .update(issues)
            .set({ status: "cancelled" })
            .where(eq(issues.id, f.issueId));
        if (change === "delete")
          await db.delete(issues).where(eq(issues.id, f.issueId));
        if (change === "reassign")
          await db
            .update(issues)
            .set({ assigneeAgentId: null })
            .where(eq(issues.id, f.issueId));
        if (change === "edit")
          await db
            .update(issueComments)
            .set({ body: "Never mind", updatedAt: new Date(Date.now() + 100) })
            .where(eq(issueComments.id, f.comment.id));
        if (change === "revoke")
          await db
            .update(connectionGrants)
            .set({ status: "revoked" })
            .where(eq(connectionGrants.id, f.binding.grantId));
        return structuredClone(outcome);
      });
      await f.service.process(row);
      const [result] = await db
        .select()
        .from(fastResponseRequests)
        .where(eq(fastResponseRequests.id, row.id));
      expect(result).toMatchObject({
        status: "succeeded",
        publicationStatus: "suppressed",
        commentId: null,
      });
      expect(
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.companyId)),
      ).toHaveLength(1);
    },
  );
  it("does not call a provider for expired or denied linked-user turns", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    await db.insert(connectionGrantMembers).values({
      companyId: f.companyId,
      grantId: f.binding.grantId,
      subjectType: "user",
      subjectId: "bob",
    });
    expect(await f.service.process(row)).toMatchObject({
      status: "unavailable",
    });
    expect(f.provider).not.toHaveBeenCalled();
    const g = await fixture(),
      expired = await g.enqueue();
    await g.service.process({ ...expired, expiresAt: new Date(0) });
    expect(g.provider).not.toHaveBeenCalled();
  });
  it("never regenerates interrupted attempts and keeps unknown charges reserved", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    f.provider.mockResolvedValueOnce({
      errorCode: "timeout",
      receipt: fastResponseReceipt(),
    });
    await f.service.process(row);
    await f.service.sweepPending();
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .select()
          .from(fastResponseRequests)
          .where(eq(fastResponseRequests.id, row.id))
      )[0].status,
    ).toBe("unknown");
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.fastResponseRequestId, row.id))
      )[0].state,
    ).toBe("held");
    await expect(withAccountingTransaction(db, f.companyId, tx => deleteAgentDependencies(tx, f.companyId, f.agentId)))
      .rejects.toMatchObject({ status: 409, details: { code: "agent_fast_response_accounting_pending" } });
  });
  it("sponsors accepted unlinked senders using only destination-authorized context", async () => {
    const f = await fixture();
    await db
      .update(issues)
      .set({ title: "PRIVATE INTERNAL TITLE" })
      .where(eq(issues.id, f.issueId));
    const external = {
      ...f.source,
      responsibleUserId: null,
      sponsored: true,
      endpointId: randomUUID(),
    };
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, external),
    );
    const [row] = await db
      .select()
      .from(fastResponseRequests)
      .where(eq(fastResponseRequests.companyId, f.companyId));
    const authorizeExternal = vi.fn().mockResolvedValue({
      agentName: "Alex",
      message: "Review this border",
      queued: true,
    });
    const service = fastResponseService(db, {
      provider: f.provider,
      authorizeExternal,
    });
    await service.process(row);
    expect(authorizeExternal).toHaveBeenCalled();
    expect(f.provider).toHaveBeenCalledTimes(1);
    const prompt = f.provider.mock.calls[0][0].prompt;
    expect(prompt).toContain("Review this border");
    expect(prompt).toContain('"state":"queued"');
    expect(prompt).not.toContain("PRIVATE INTERNAL TITLE");
    expect(
      (
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.companyId))
      )[0],
    ).toMatchObject({ responsibleUserId: null, usageKind: "fast_response" });
  });
  it("never treats a denied linked user as company sponsored", async () => {
    const f = await fixture();
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, {
        ...f.source,
        sponsored: true,
        endpointId: randomUUID(),
      }),
    );
    const [row] = await db
      .select()
      .from(fastResponseRequests)
      .where(eq(fastResponseRequests.companyId, f.companyId));
    await f.service.process(row);
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("expires unstarted backlog without an inference attempt", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    await db
      .update(fastResponseRequests)
      .set({ expiresAt: new Date(0) })
      .where(eq(fastResponseRequests.id, row.id));
    await f.service.sweepPending();
    expect(f.provider).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(fastResponseRequests)
          .where(eq(fastResponseRequests.id, row.id))
      )[0],
    ).toMatchObject({ status: "skipped", errorCode: "expired" });
  });
  it("honors the company reservation budget before dispatch", async () => {
    const f = await fixture();
    await db
      .insert(budgetPolicies)
      .values({
        companyId: f.companyId,
        scopeType: "company",
        scopeId: f.companyId,
        windowKind: "calendar_month_utc",
        amount: 1,
        reservationCents: "2",
        notifyEnabled: false,
      });
    const row = await f.enqueue();
    expect(await f.service.process(row)).toMatchObject({
      status: "unavailable",
    });
    expect(f.provider).not.toHaveBeenCalled();
    expect(
      await db
        .select()
        .from(costEvents)
        .where(eq(costEvents.companyId, f.companyId)),
    ).toHaveLength(0);
  });
  it("releases the reservation after a known provider rejection", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    f.provider.mockResolvedValueOnce({
      errorCode: "provider_auth_failed",
      noProviderWork: true,
      receipt: {
        inputTokens: 0,
        outputTokens: 0,
        costCents: "0",
        costStatus: "estimated",
        providerRequestId: null,
        pricingProvenance: { source: "unknown" },
      },
    });
    await f.service.process(row);
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.fastResponseRequestId, row.id))
      )[0].state,
    ).toBe("released");
    expect(
      (
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.companyId))
      )[0].costCents,
    ).toBe(0);
  });
  it("tests the fixed sample without posting a conversation message", async () => {
    const f = await fixture();
    const result = await f.service.test(f.companyId, "alice");
    expect(result.status).toBe("succeeded");
    expect(f.provider.mock.calls[0][0].prompt).toContain("settings panel");
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.companyId, f.companyId)),
    ).toHaveLength(1);
  });
});
