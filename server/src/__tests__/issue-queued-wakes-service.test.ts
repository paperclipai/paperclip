import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-wakes service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.listQueuedWakesForIssue", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-queued-wakes-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "QW") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    title?: string;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title ?? "Issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  async function insertWake(input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    status: string;
    reason?: string;
    requestedAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "schedule_wakeup",
      triggerDetail: "system",
      reason: input.reason ?? "schedule_wakeup",
      payload: input.issueId ? { issueId: input.issueId } : {},
      status: input.status,
      ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
    });
    return id;
  }

  it("returns queued and deferred_issue_execution wakes for the issue, newest first", async () => {
    const { companyId, agentId } = await createCompany("QWA");
    const issueId = await insertIssue({ companyId, identifier: "QWA-1" });
    const olderQueued = await insertWake({
      companyId,
      agentId,
      issueId,
      status: "queued",
      reason: "ci_poll",
      requestedAt: new Date("2026-06-10T17:00:00.000Z"),
    });
    const newerDeferred = await insertWake({
      companyId,
      agentId,
      issueId,
      status: "deferred_issue_execution",
      reason: "deferred",
      requestedAt: new Date("2026-06-10T18:00:00.000Z"),
    });

    const wakes = await svc.listQueuedWakesForIssue(companyId, issueId);

    expect(wakes.map((w) => w.id)).toEqual([newerDeferred, olderQueued]);
    expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", reason: "deferred" });
    expect(wakes[1]).toMatchObject({ status: "queued", reason: "ci_poll" });
    expect(wakes[0].agentId).toBe(agentId);
    expect(wakes[0].requestedAt).toBeInstanceOf(Date);
  });

  it("excludes claimed, completed, and failed wakes", async () => {
    const { companyId, agentId } = await createCompany("QWB");
    const issueId = await insertIssue({ companyId, identifier: "QWB-1" });
    await insertWake({ companyId, agentId, issueId, status: "claimed" });
    await insertWake({ companyId, agentId, issueId, status: "completed" });
    await insertWake({ companyId, agentId, issueId, status: "failed" });
    const liveQueued = await insertWake({
      companyId,
      agentId,
      issueId,
      status: "queued",
    });

    const wakes = await svc.listQueuedWakesForIssue(companyId, issueId);

    expect(wakes.map((w) => w.id)).toEqual([liveQueued]);
  });

  it("does not return wakes for other issues in the same company", async () => {
    const { companyId, agentId } = await createCompany("QWC");
    const myIssue = await insertIssue({ companyId, identifier: "QWC-1" });
    const otherIssue = await insertIssue({ companyId, identifier: "QWC-2" });
    await insertWake({ companyId, agentId, issueId: otherIssue, status: "queued" });
    const mine = await insertWake({ companyId, agentId, issueId: myIssue, status: "queued" });

    const wakes = await svc.listQueuedWakesForIssue(companyId, myIssue);

    expect(wakes.map((w) => w.id)).toEqual([mine]);
  });

  it("does not return wakes from another company that happen to share the issue id", async () => {
    const { companyId: ownCompanyId, agentId: ownAgentId } = await createCompany("QWD");
    const { companyId: otherCompanyId, agentId: otherAgentId } = await createCompany("QWE");
    const issueId = await insertIssue({ companyId: ownCompanyId, identifier: "QWD-1" });
    await insertWake({
      companyId: otherCompanyId,
      agentId: otherAgentId,
      issueId,
      status: "queued",
    });
    const mine = await insertWake({
      companyId: ownCompanyId,
      agentId: ownAgentId,
      issueId,
      status: "queued",
    });

    const wakes = await svc.listQueuedWakesForIssue(ownCompanyId, issueId);

    expect(wakes.map((w) => w.id)).toEqual([mine]);
  });

  it("returns an empty array when no wakes are queued", async () => {
    const { companyId } = await createCompany("QWF");
    const issueId = await insertIssue({ companyId, identifier: "QWF-1" });

    const wakes = await svc.listQueuedWakesForIssue(companyId, issueId);

    expect(wakes).toEqual([]);
  });
});
