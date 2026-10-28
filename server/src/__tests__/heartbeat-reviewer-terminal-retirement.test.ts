import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("terminal task reviewer receipt retirement", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-terminal-retirement-");
    db = createDb(fixture.connectionString);
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(namespace: unknown = { version: 1 }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retirement fixture", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle",
      lifecycleState: "ready", adapterType: "process", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review", assigneeAgentId: agentId });
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      reason: "issue_assigned", status: "deferred_issue_execution", requestedByActorType: "system",
      requestedByActorId: "native_review", payload: { issueId, _paperclipReviewerAssignmentContinuation: namespace } }).returning();
    return { companyId, agentId, issueId, receipt };
  }

  async function readReceipt(id: string) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  }

  it("cancelling a task retires its receipt without rewriting its context", async () => {
    const { issueId, receipt } = await seed();
    await issueService(db).update(issueId, { status: "cancelled" });
    const retired = await readReceipt(receipt.id);
    expect(retired).toMatchObject({ status: "cancelled", runId: null, payload: receipt.payload,
      source: receipt.source, reason: receipt.reason, requestedByActorId: receipt.requestedByActorId,
      error: "Task was marked cancelled" });
    expect(retired.finishedAt).toBeInstanceOf(Date);
    await issueService(db).update(issueId, { status: "todo" });
    expect(await readReceipt(receipt.id)).toEqual(retired);
  });

  it.each([null, "malformed", false, { version: 99 }])("terminal completion retires reserved presence %j", async namespace => {
    const { issueId, receipt } = await seed(namespace);
    await issueService(db).update(issueId, { status: "done" });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", error: "Task was marked done", payload: receipt.payload });
  });

  it.each(["queued", "claimed"])("retains temporary holds before retiring %s duty", async status => {
    const { issueId, receipt } = await seed();
    await db.update(agentWakeupRequests).set({ status }).where(eq(agentWakeupRequests.id, receipt.id));
    const before = await readReceipt(receipt.id);
    await issueService(db).update(issueId, { status: "blocked" });
    expect(await readReceipt(receipt.id)).toEqual(before);
    await issueService(db).update(issueId, { status: "cancelled" });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", error: "Task was marked cancelled" });
  });

  it("leaves ordinary, historical, linked and other-task receipts unchanged", async () => {
    const { companyId, agentId, issueId, receipt } = await seed();
    const other = await seed();
    const [sibling] = await db.insert(issues).values({ companyId, title: "Other review", status: "todo" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "assignment" }).returning();
    const rows = await db.insert(agentWakeupRequests).values([
      { ...receipt, id: randomUUID(), payload: { issueId } },
      { ...receipt, id: randomUUID(), status: "cancelled", error: "Original retirement", finishedAt: new Date() },
      { ...receipt, id: randomUUID(), status: "coalesced", runId: run.id, finishedAt: new Date() },
      { ...receipt, id: randomUUID(), status: "claimed", runId: run.id },
      { ...receipt, id: randomUUID(), payload: { ...receipt.payload, issueId: sibling.id } },
    ].map(row => ({ ...row, requestedByActorType: "user", requestedByActorId: "original-requester" }))).returning();
    await issueService(db).update(issueId, { status: "cancelled", assigneeAgentId: null });
    for (const row of [...rows.slice(1), other.receipt]) expect(await readReceipt(row.id)).toEqual(row);
    expect((await readReceipt(rows[0].id)).status).toBe("cancelled");
    expect((await readReceipt(receipt.id)).status).toBe("cancelled");
  });

  it("rolls retirement back with the enclosing transaction", async () => {
    const { issueId, receipt } = await seed();
    await expect(db.transaction(async tx => {
      await issueService(tx).update(issueId, { status: "cancelled" });
      throw new Error("abort terminal update");
    })).rejects.toThrow("abort terminal update");
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue.status).toBe("in_review");
  });
});
