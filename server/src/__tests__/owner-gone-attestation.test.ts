import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns,
  issueRecoveryActions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
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
      stopEvidence, actorId: "board-user" })).resolves.toEqual({ recordId: leaseId, status: "queued" });
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
      stopEvidence, actorId: "board-user" })).rejects.toMatchObject({ status: 409 });
    // A holder stamped since the board was asked owns the lease now: its stamp decides.
    await db.update(environmentLeases).set({ metadata: { [ENVIRONMENT_LEASE_CONTROLLER_KEY]: {
      bootId: "new-boot", pid: 7, hostHash: "another-host", processStartedAt: null } } }).where(eq(environmentLeases.id, leaseId));
    await expect(confirmOwnerGone({ db, kinds: OWNABLE_KINDS, companyId, issueId, actionId: action.id, recordId: leaseId,
      stopEvidence, actorId: "board-user" })).rejects.toMatchObject({ status: 409 });
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
      stopEvidence, actorId: "board-user" })).resolves.toEqual({ recordId: leaseId, status: "released" });
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
});
