import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, environmentLeases } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const KIND = "environment_pending_cleanup";

suite("pending-cleanup obligation owned by the cleanup queue", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-pending-cleanup-queue-owner-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "PCQ",
      requireBoardApprovalForNewAgents: false });
  }, 30_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function item(updatedAt: Date, metadata: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, status: "pending_cleanup", cleanupStatus: "failed",
      provider: "fake", providerLeaseId: `sandbox://fake/${id}`, updatedAt, metadata });
    return id;
  }

  async function pass() {
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    return { kind: report.kinds.find(entry => entry.kind === KIND)!,
      violations: report.violations.filter(violation => violation.kind === KIND) };
  }

  it("names the cleanup queue as owner while the item's retry deadline is current, so I1 reports no gap", async () => {
    await item(new Date());
    await item(new Date(Date.now() - 60 * 60_000), { pendingCleanupRetryAttempts: 5,
      pendingCleanupRetryAfterMs: Date.now() + 20 * 60_000 });
    const { kind, violations } = await pass();
    expect(kind).toMatchObject({ inProgress: 2, verdicts: { alive: 2 }, reasons: { queue_scheduled: 2 } });
    expect(violations).toEqual([]);
  });

  it("reports an item the queue has not acted on long past its deadline as a visible-next-action gap", async () => {
    const overdue = await item(new Date(Date.now() - 60 * 60_000), { pendingCleanupRetryAttempts: 1 });
    const { kind, violations } = await pass();
    expect(kind).toMatchObject({ verdicts: { unprovable: 1 }, reasons: { queue_overdue: 1 } });
    expect(violations).toEqual([expect.objectContaining({ rule: "I7_visible_next_action", recordId: overdue,
      reason: "queue_overdue" })]);
  });

  it("never reports a settled orphan's first attempt as overdue just because the worker's deadline is 'now'", async () => {
    // The orphaned-run-lease settle keeps updatedAt and saves when it queued the item.
    await item(new Date(Date.now() - 60 * 60_000), { pendingCleanupRetryAttempts: 0,
      pendingCleanupRecoveredAtMs: Date.now() });
    await db.update(environmentLeases).set({ failureReason: "orphaned_active_lease_recovered" });
    const { kind, violations } = await pass();
    expect(kind).toMatchObject({ verdicts: { alive: 1 }, reasons: { queue_scheduled: 1 } });
    expect(violations).toEqual([]);
  });

  it("wakes the reconciler when a scheduled item would become overdue", async () => {
    const updatedAt = new Date(Date.now() - 60_000);
    await item(updatedAt);
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    // Due at updatedAt + one retry interval; overdue after two more.
    const expected = updatedAt.getTime() + 5 * 60_000 + 10 * 60_000;
    expect(Math.abs((report.nextDueAt?.getTime() ?? 0) - expected)).toBeLessThan(5_000);
  });

  it("keeps an escalated item with the sweep's 30-minute cooldown scheduled, due at its saved deadline", async () => {
    // The sweep escalates well after boot: let the clock pass the reader's 1 s slack.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const retryAfterMs = Date.now() + 30 * 60_000;
    await item(new Date(Date.now() - 60 * 60_000), { pendingCleanupRetryAttempts: 5,
      pendingCleanupRetryAfterMs: retryAfterMs });
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    expect(report.kinds.find(entry => entry.kind === KIND)).toMatchObject({ verdicts: { alive: 1 },
      reasons: { queue_scheduled: 1 } });
    expect(report.violations.filter(violation => violation.kind === KIND)).toEqual([]);
    expect(Math.abs((report.nextDueAt?.getTime() ?? 0) - (retryAfterMs + 10 * 60_000))).toBeLessThan(5_000);
  });

  it("does not list an item a claimant holds in flight (that is the teardown claim)", async () => {
    await item(new Date(Date.now() - 60 * 60_000), { pendingCleanupInFlight: true, pendingCleanupAttemptId: "claim" });
    const { kind } = await pass();
    expect(kind).toMatchObject({ inProgress: 0 });
  });
});
