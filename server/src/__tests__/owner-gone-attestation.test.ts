import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns,
  issueRecoveryActions, issues,
} from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { confirmOwnerGone, OWNER_UNPROVABLE_CAUSE } from "../services/recovery/owner-gone-attestation.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { OWNABLE_KINDS } from "../services/recovery/ownership-registry.js";
import { recoveryService } from "../services/recovery/service.js";

const KIND = "environment_run_lease_active";
const stopEvidence = "The old server container was replaced and is no longer running.";

describe("board confirmation that an unrecorded owner stopped", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-owner-gone-attestation-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => temporary?.cleanup());
  afterEach(() => vi.unstubAllEnvs());

  /** A run lease saved before holders were stamped, on an ephemeral server, after its run finished. */
  async function seed(holder: Record<string, unknown> | null = null) {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "codex_local", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed", invocationSource: "on_demand" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, status: "active",
      leasePolicy: "ephemeral", metadata: holder ? { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: holder } : {} });
    return { companyId, issueId, runId, leaseId };
  }

  const pass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() }))
    .kinds.find(kind => kind.kind === KIND)!;
  const actionFor = async (issueId: string) => (await db.select().from(issueRecoveryActions)
    .where(and(eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, OWNER_UNPROVABLE_CAUSE))))[0];
  const lease = async (leaseId: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;

  it("asks the board on the task, and releases the lease once the board confirms the stop", async () => {
    const { companyId, issueId, runId, leaseId } = await seed();
    expect(await pass()).toMatchObject({ settled: 0, reasons: { no_owner_stamp: 1 } });
    const action = await actionFor(issueId);
    expect(action).toMatchObject({ ownerType: "board", status: "active", evidence: { kind: KIND, recordId: leaseId, runId } });
    await pass();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))).toHaveLength(1);

    await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action!.id, recordId: leaseId,
      stopEvidence, actorId: "board-user", recordVersion: action!.evidence.recordUpdatedAt as string })).resolves.toEqual({ recordId: leaseId, status: "queued" });
    expect(await actionFor(issueId)).toMatchObject({ status: "resolved", evidence: { ownerGone: { actorId: "board-user", stopEvidence } } });
    const [entry] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.ownership_owner_gone_confirmed")));
    expect(entry).toMatchObject({ actorType: "user", actorId: "board-user", runId,
      details: expect.objectContaining({ kind: KIND, recordId: leaseId, stopEvidence }) });

    expect(await pass()).toMatchObject({ settled: 1, reasons: { operator_attested: 1 } });
    expect((await lease(leaseId)).status).toBe("pending_cleanup");
    expect(await pass()).toMatchObject({ settled: 0 });
  });

  it("refuses a stale or mismatched confirmation, and never attests a stamped holder", async () => {
    const { companyId, issueId, leaseId } = await seed();
    await pass();
    const action = (await actionFor(issueId))!;
    await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: randomUUID(),
      stopEvidence, actorId: "board-user", recordVersion: action.evidence.recordUpdatedAt as string })).rejects.toMatchObject({ status: 409 });
    // A holder stamped since the board was asked owns the lease now: its stamp decides.
    await db.update(environmentLeases).set({ metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: {
      bootId: "new-boot", pid: 7, hostHash: "another-host", processStartedAt: null } } }).where(eq(environmentLeases.id, leaseId));
    await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: leaseId,
      stopEvidence, actorId: "board-user", recordVersion: action.evidence.recordUpdatedAt as string })).rejects.toMatchObject({ status: 409 });
    expect(await actionFor(issueId)).toMatchObject({ status: "active" });
    expect((await lease(leaseId)).status).toBe("active");
  });

  it("is never closed by ordinary recovery, even once the task is done", async () => {
    const { companyId, issueId } = await seed();
    await pass();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    await recoveryService(db, { enqueueWakeup: vi.fn() } as never).reconcileActiveRecoveryActions({ companyId });
    expect(await actionFor(issueId)).toMatchObject({ status: "active" });
  });

  it("closes the request without attesting when the lease was released another way", async () => {
    const { companyId, issueId, leaseId } = await seed();
    await pass();
    const action = (await actionFor(issueId))!;
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, leaseId));
    await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: leaseId,
      stopEvidence, actorId: "board-user", recordVersion: action.evidence.recordUpdatedAt as string })).resolves.toEqual({ recordId: leaseId, status: "released" });
    const resolved = await actionFor(issueId);
    expect(resolved).toMatchObject({ status: "resolved", evidence: { ownerGoneNotNeeded: { actorId: "board-user" } } });
    expect(resolved?.evidence).not.toHaveProperty("ownerGone");
    expect((await lease(leaseId)).metadata).not.toHaveProperty("ownerGoneAttestation");
  });

  it("does not ask about an owner Paperclip can judge, or a record with no task", async () => {
    const stamped = await seed({ bootId: "boot", pid: 7, hostHash: "another-host", processStartedAt: null });
    await pass();
    expect(await actionFor(stamped.issueId)).toBeUndefined();
    const orphan = await seed();
    await db.update(environmentLeases).set({ issueId: null }).where(eq(environmentLeases.id, orphan.leaseId));
    await db.update(heartbeatRuns).set({ issueId: null }).where(eq(heartbeatRuns.id, orphan.runId));
    await pass();
    expect(await actionFor(orphan.issueId)).toBeUndefined();
  });

  describe("a settling kind with no attestation field (record-version attestation)", () => {
    const LEGACY = "legacy_controller_lease";
    const legacyPass = async () => (await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() }))
      .kinds.find(kind => kind.kind === LEGACY)!;

    /** A legacy run whose controller was recorded before its PID space was: `missing_identity`. */
    async function seedLegacyRun() {
      const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), bootId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Legacy", issuePrefix: `L${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "codex_local", status: "running" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running", invocationSource: "on_demand",
        runtimeMode: "legacy", controllerBootId: bootId, controllerProcess: { bootId, pid: 4242, hostHash: "" },
        controllerLeaseExpiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date(Date.now() - 60_000) });
      return { companyId, issueId, runId };
    }
    const leaseLive = async (runId: string) =>
      (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.controllerLeaseExpiresAt! > new Date();

    it("asks the board, and settles through the kind's own settle once the board confirms the stop", async () => {
      const { companyId, issueId, runId } = await seedLegacyRun();
      expect(await legacyPass()).toMatchObject({ settled: 0, reasons: { missing_identity: 1 } });
      const action = (await actionFor(issueId))!;
      expect(action).toMatchObject({ ownerType: "board", status: "active",
        evidence: { kind: LEGACY, recordId: runId, recordUpdatedAt: expect.any(String) } });
      // Still unprovable, and never released without the board.
      expect(await legacyPass()).toMatchObject({ settled: 0 });
      expect(await leaseLive(runId)).toBe(true);
      // An unprovable record is not watched: the confirmation itself wakes the reconciler.
      const wakes: string[] = [];
      const stopWatching = subscribeDatabaseWork(db, DELIVERY_QUEUES.ownershipInvariantReport, (event, hints) => {
        if (event === "settled") wakes.push(...(hints ?? []));
      });
      try {
        await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: runId,
          stopEvidence, actorId: "board-user", recordVersion: action.evidence.recordUpdatedAt as string })).resolves.toEqual({ recordId: runId, status: "queued" });
        for (let wait = 0; wait < 50 && !wakes.some(hint => hint.includes(runId)); wait++) await new Promise(resolve => setTimeout(resolve, 20));
      } finally { stopWatching(); }
      expect(wakes.some(hint => hint.includes(runId))).toBe(true);
      expect(await legacyPass()).toMatchObject({ settled: 1, reasons: { operator_attested: 1 } });
      expect(await leaseLive(runId)).toBe(false);
    });

    it("does not ask about a record of these kinds with no owner stamp: its settle could never release it", async () => {
      const { companyId, issueId, runId } = await seedLegacyRun();
      const kind = OWNABLE_KINDS.find(candidate => candidate.id === "sandbox_creation_intent")!;
      expect(kind.ownerGoneAttestation).toBe("record_version");
      const record = { recordId: randomUUID(), companyId, runId, issueId, owner: { kind: "none" as const }, updatedAt: new Date() };
      await kind.onUnprovable!(db, record, { now: new Date(), proof: { verdict: "unprovable", reason: "no_owner_stamp" } as never });
      expect(await actionFor(issueId)).toBeUndefined();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    });

    it("never applies a confirmation to a record that changed since the board was asked", async () => {
      const { companyId, issueId, runId } = await seedLegacyRun();
      await legacyPass();
      const action = (await actionFor(issueId))!;
      await confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: runId,
        stopEvidence, actorId: "board-user", recordVersion: action.evidence.recordUpdatedAt as string });
      // The record moved on (for example, a new controller took it over) after the confirmation.
      await db.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      expect(await legacyPass()).toMatchObject({ settled: 0, reasons: { missing_identity: 1 } });
      expect(await leaseLive(runId)).toBe(true);
      // The board is asked again, about the current version.
      const requests = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.cause, OWNER_UNPROVABLE_CAUSE)));
      expect(requests.map(request => request.status).sort()).toEqual(["active", "resolved"]);
      // Confirming the current version applies, even with the older confirmation still on record.
      const fresh = requests.find(request => request.status === "active")!;
      await confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: fresh.id, recordId: runId,
        stopEvidence, actorId: "board-user", recordVersion: fresh.evidence.recordUpdatedAt as string });
      expect(await legacyPass()).toMatchObject({ settled: 1, reasons: { operator_attested: 1 } });
      expect(await leaseLive(runId)).toBe(false);
    });

    it("refuses a confirmation for a version the record no longer has, then asks about the current one", async () => {
      const { companyId, issueId, runId } = await seedLegacyRun();
      await legacyPass();
      const asked = (await actionFor(issueId))!;
      await db.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: asked.id, recordId: runId,
        stopEvidence, actorId: "board-user", recordVersion: asked.evidence.recordUpdatedAt as string })).rejects.toMatchObject({ status: 409 });
      // The next pass refreshes the open request to the current version; that confirmation applies.
      await legacyPass();
      const refreshed = (await actionFor(issueId))!;
      expect(refreshed.id).toBe(asked.id);
      expect(refreshed.evidence.recordUpdatedAt).not.toBe(asked.evidence.recordUpdatedAt);
      // A form opened before the refresh still names the old version: it cannot approve the new one.
      await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: refreshed.id, recordId: runId,
        stopEvidence, actorId: "board-user", recordVersion: asked.evidence.recordUpdatedAt as string })).rejects.toMatchObject({ status: 409 });
      await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: refreshed.id, recordId: runId,
        stopEvidence, actorId: "board-user" })).rejects.toMatchObject({ status: 409 });
      await confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: refreshed.id, recordId: runId,
        stopEvidence, actorId: "board-user", recordVersion: refreshed.evidence.recordUpdatedAt as string });
      expect(await legacyPass()).toMatchObject({ settled: 1, reasons: { operator_attested: 1 } });
    });

    it("re-checks the confirmed version inside the settle's transaction", async () => {
      const { companyId, issueId, runId } = await seedLegacyRun();
      await legacyPass();
      const kind = OWNABLE_KINDS.find(candidate => candidate.id === LEGACY)!;
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const confirmedVersion = row!.updatedAt;
      // The record moves on between the reconciler's listing and its settle.
      await db.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      const record = { recordId: runId, companyId, runId, issueId, updatedAt: confirmedVersion,
        owner: { kind: "process" as const, stamp: { kind: "local" as const, scope: LEGACY, generation: null, host: null,
          processSpace: "", bootId: row!.controllerBootId!, pid: 4242, processStartedAt: null, processGroupId: null } } };
      await expect(kind.settle!(db, record, { now: new Date(), proof: { verdict: "gone", reason: "operator_attested" } }))
        .resolves.toMatchObject({ settled: false, reason: "record_changed_since_confirmation" });
      expect(await leaseLive(runId)).toBe(true);
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    });
  });
});
