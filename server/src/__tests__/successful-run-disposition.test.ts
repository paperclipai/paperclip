import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { recordSuccessfulRunDisposition } from "../services/recovery/successful-run-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres successful-run disposition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recordSuccessfulRunDisposition", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-successful-run-disposition-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "DSP") {
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
    title: string;
    status: string;
    assigneeAgentId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  async function insertRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      contextSnapshot: { issueId: input.issueId },
    });
    return runId;
  }

  async function attentionReasonFor(companyId: string, issueId: string): Promise<string | null> {
    const rows = await svc.list(companyId, { attention: "blocked" });
    const row = rows.find((entry) => entry.id === issueId);
    return row?.blockedInboxAttention?.reason ?? null;
  }

  async function seedHandoffRequired(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    sourceRunId: string;
  }) {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.agentId,
      runId: input.sourceRunId,
      details: { sourceRunId: input.sourceRunId, detectedProgressSummary: "Progress was made" },
    });
  }

  it("clears the missing_successful_run_disposition attention once a run is dispositioned", async () => {
    const { companyId, agentId } = await createCompany("DSA");
    const issueId = await insertIssue({
      companyId,
      identifier: "DSA-1",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const sourceRunId = await insertRun({ companyId, agentId, issueId });
    await seedHandoffRequired({ companyId, agentId, issueId, sourceRunId });

    expect(await attentionReasonFor(companyId, issueId)).toBe("missing_successful_run_disposition");

    const result = await recordSuccessfulRunDisposition(db, {
      companyId,
      issueId,
      issueIdentifier: "DSA-1",
      runId: sourceRunId,
      disposition: "done",
      actor: { actorType: "agent", actorId: agentId, agentId, runId: sourceRunId },
    });

    expect(result.alreadyDispositioned).toBe(false);
    expect(await attentionReasonFor(companyId, issueId)).toBeNull();
  });

  it("is idempotent: dispositioning the same run twice is a no-op", async () => {
    const { companyId, agentId } = await createCompany("DSB");
    const issueId = await insertIssue({
      companyId,
      identifier: "DSB-1",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const sourceRunId = await insertRun({ companyId, agentId, issueId });
    await seedHandoffRequired({ companyId, agentId, issueId, sourceRunId });

    const first = await recordSuccessfulRunDisposition(db, {
      companyId,
      issueId,
      runId: sourceRunId,
      disposition: "done",
      actor: { actorType: "user", actorId: "board", agentId: null, runId: null },
    });
    expect(first.alreadyDispositioned).toBe(false);

    const second = await recordSuccessfulRunDisposition(db, {
      companyId,
      issueId,
      runId: sourceRunId,
      disposition: "done",
      actor: { actorType: "user", actorId: "board", agentId: null, runId: null },
    });
    expect(second.alreadyDispositioned).toBe(true);

    // Still cleared, and only one resolved row exists.
    expect(await attentionReasonFor(companyId, issueId)).toBeNull();
    const resolvedRows = await svc.list(companyId, { attention: "blocked" });
    expect(resolvedRows.find((entry) => entry.id === issueId)).toBeUndefined();
  });

  it("does not treat the actor's own run as already-dispositioned (no row.runId fallback)", async () => {
    // Regression: the resolved activity row stores the *actor* run in
    // activityLog.runId and the dispositioned *source* run in details.sourceRunId.
    // Dispositioning source run X via actor run R must NOT later report run R
    // itself as already-dispositioned just because R authored X's resolution.
    const { companyId, agentId } = await createCompany("DSC");
    const issueId = await insertIssue({
      companyId,
      identifier: "DSC-1",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const sourceRunId = await insertRun({ companyId, agentId, issueId });
    const actorRunId = await insertRun({ companyId, agentId, issueId });
    await seedHandoffRequired({ companyId, agentId, issueId, sourceRunId });

    // Disposition source run X, attributing the action to actor run R.
    const first = await recordSuccessfulRunDisposition(db, {
      companyId,
      issueId,
      runId: sourceRunId,
      disposition: "done",
      actor: { actorType: "agent", actorId: agentId, agentId, runId: actorRunId },
    });
    expect(first.alreadyDispositioned).toBe(false);

    // Now a genuinely new disposition targeting the actor run R must be treated
    // as fresh, not falsely short-circuited by a row.runId fallback.
    const second = await recordSuccessfulRunDisposition(db, {
      companyId,
      issueId,
      runId: actorRunId,
      disposition: "done",
      actor: { actorType: "user", actorId: "board", agentId: null, runId: null },
    });
    expect(second.alreadyDispositioned).toBe(false);
  });
});
