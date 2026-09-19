import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describeEmbeddedPostgres("provider quota release", () => {
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quota-release-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = `QR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Quota Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function seedAgent(input: {
    companyId: string;
    adapterType: string;
    name?: string;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: input.name ?? `Agent ${input.adapterType}`,
      role: "engineer",
      status: "idle",
      adapterType: input.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  let issueNumber = 0;
  async function seedBlockedQuotaIssue(input: {
    companyId: string;
    prefix: string;
    workerAgentId: string;
    failedAt: Date;
    strandedSince?: Date;
    returnOwnerAgentId?: string | null;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    issueNumber += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Quota stranded work",
      status: "blocked",
      priority: "high",
      assigneeAgentId: null,
      issueNumber,
      identifier: `${input.prefix}-${issueNumber}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.workerAgentId,
      invocationSource: "automation",
      status: "failed",
      errorCode: "provider_quota",
      error: "You've hit your usage limit.",
      startedAt: input.failedAt,
      finishedAt: input.failedAt,
      contextSnapshot: { issueId },
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: input.companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "system",
        ownerAgentId: null,
        previousOwnerAgentId: input.workerAgentId,
        returnOwnerAgentId:
          input.returnOwnerAgentId === undefined
            ? input.workerAgentId
            : input.returnOwnerAgentId,
        cause: "provider_quota",
        fingerprint: `provider_quota:${issueId}`,
        evidence: { latestRunId: runId, latestRunErrorCode: "provider_quota" },
        nextAction: "Wait for provider quota recovery.",
        createdAt: input.strandedSince ?? input.failedAt,
        updatedAt: input.strandedSince ?? input.failedAt,
      })
      .returning();
    return { issueId, runId, actionId: action!.id };
  }

  /** Terminal runs that establish what a family's quota state currently is. */
  async function seedFamilyRuns(input: {
    companyId: string;
    agentId: string;
    succeededAt?: Date[];
    quotaFailedAt?: Date[];
    quotaError?: string;
  }) {
    const rows = [
      ...(input.succeededAt ?? []).map((finishedAt) => ({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "automation",
        status: "succeeded",
        startedAt: finishedAt,
        finishedAt,
      })),
      ...(input.quotaFailedAt ?? []).map((finishedAt) => ({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "automation",
        status: "failed",
        errorCode: "provider_quota",
        error: input.quotaError ?? "You've hit your usage limit.",
        startedAt: finishedAt,
        finishedAt,
      })),
    ];
    if (rows.length > 0) await db.insert(heartbeatRuns).values(rows);
  }

  function makeRecovery() {
    const enqueueWakeup = vi.fn(async () => null);
    return { enqueueWakeup, recovery: recoveryService(db, { enqueueWakeup }) };
  }

  it("returns a quota-blocked issue to work once its adapter family recovers", async () => {
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "claude_local" });
    const { issueId, actionId } = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt: new Date(now.getTime() - 3 * HOUR),
    });
    // Two successes after the failure, the newest inside the freshness window.
    await seedFamilyRuns({
      companyId,
      agentId: worker,
      succeededAt: [
        new Date(now.getTime() - 40 * MINUTE),
        new Date(now.getTime() - 10 * MINUTE),
      ],
    });

    const { enqueueWakeup, recovery } = makeRecovery();
    const result = await recovery.promoteQuotaBlockedIssues(now);

    expect(result).toMatchObject({ released: 1, canaries: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({
      status: "todo",
      // The work goes back to the agent that was doing it, not to a recovery
      // owner who cannot continue it.
      assigneeAgentId: worker,
    });
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(action?.resolutionNote).toBe("quota_family_green:claude_local");
    expect(enqueueWakeup).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ reason: "issue_assigned" }),
    );
  });

  it("holds a quota-blocked issue while its adapter family is still walled", async () => {
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "codex_local" });
    const { issueId, actionId } = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt: new Date(now.getTime() - 3 * HOUR),
    });
    // The newest quota failure outlives every success: the wall is still up.
    await seedFamilyRuns({
      companyId,
      agentId: worker,
      succeededAt: [new Date(now.getTime() - 5 * HOUR)],
      quotaFailedAt: [new Date(now.getTime() - 5 * MINUTE)],
    });

    const { enqueueWakeup, recovery } = makeRecovery();
    const result = await recovery.promoteQuotaBlockedIssues(now);

    expect(result).toMatchObject({ released: 0, held: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(action?.status).toBe("active");
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("gates each adapter family separately inside one company", async () => {
    // 16 September: claude_local was serving again while codex_local stayed
    // down for another six days. A company-wide signal released the codex work
    // straight back into the wall.
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const claudeWorker = await seedAgent({
      companyId,
      adapterType: "claude_local",
      name: "Claude worker",
    });
    const codexWorker = await seedAgent({
      companyId,
      adapterType: "codex_local",
      name: "Codex worker",
    });
    const claudeIssue = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: claudeWorker,
      failedAt: new Date(now.getTime() - 3 * HOUR),
    });
    const codexIssue = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: codexWorker,
      failedAt: new Date(now.getTime() - 3 * HOUR),
    });
    await seedFamilyRuns({
      companyId,
      agentId: claudeWorker,
      succeededAt: [
        new Date(now.getTime() - 40 * MINUTE),
        new Date(now.getTime() - 10 * MINUTE),
      ],
    });
    await seedFamilyRuns({
      companyId,
      agentId: codexWorker,
      quotaFailedAt: [new Date(now.getTime() - 20 * MINUTE)],
    });

    const { recovery } = makeRecovery();
    const result = await recovery.promoteQuotaBlockedIssues(now);

    expect(result).toMatchObject({ released: 1, held: 1 });
    expect(result.issueIds).toEqual([claudeIssue.issueId]);
    const [codex] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, codexIssue.issueId));
    expect(codex?.status).toBe("blocked");
  });

  it("holds a silent family that reported a future reset instead of probing it", async () => {
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "codex_local" });
    const failedAt = new Date(now.getTime() - 5 * HOUR);
    await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt,
    });
    // Silent since the failure, but the provider named a date days out. The
    // hint may only hold work back, never release it.
    await seedFamilyRuns({
      companyId,
      agentId: worker,
      quotaFailedAt: [failedAt],
      quotaError: `You've hit your usage limit. Try again at ${monthAbbrev(
        new Date(now.getTime() + 6 * 24 * HOUR),
      )} ${new Date(now.getTime() + 6 * 24 * HOUR).getUTCDate()}, ${new Date(
        now.getTime() + 6 * 24 * HOUR,
      ).getUTCFullYear()} 12:34 AM`,
    });

    const { recovery } = makeRecovery();
    const result = await recovery.promoteQuotaBlockedIssues(now);

    expect(result).toMatchObject({ released: 0, canaries: 0, held: 1 });
  });

  it("releases exactly one canary when a silent family can produce no evidence", async () => {
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "claude_local" });
    const failedAt = new Date(now.getTime() - 5 * HOUR);
    const oldest = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt,
      strandedSince: new Date(now.getTime() - 20 * HOUR),
    });
    await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt,
      strandedSince: new Date(now.getTime() - 4 * HOUR),
    });
    await seedFamilyRuns({
      companyId,
      agentId: worker,
      quotaFailedAt: [failedAt],
      quotaError: "Provider quota exceeded.",
    });

    const { recovery } = makeRecovery();
    const result = await recovery.promoteQuotaBlockedIssues(now);

    expect(result).toMatchObject({ released: 1, canaries: 1, held: 1 });
    expect(result.issueIds).toEqual([oldest.issueId]);
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, oldest.issueId));
    expect(action?.resolutionNote).toBe("quota_family_canary:claude_local");

    // A second tick inside the cooldown must not release another canary.
    const second = await recovery.promoteQuotaBlockedIssues(
      new Date(now.getTime() + 30 * MINUTE),
    );
    expect(second).toMatchObject({ released: 0, canaries: 0 });
  });

  it("ignores blocked issues stranded by anything other than a quota wall", async () => {
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "claude_local" });
    const { issueId } = await seedBlockedQuotaIssue({
      companyId,
      prefix,
      workerAgentId: worker,
      failedAt: new Date(now.getTime() - 3 * HOUR),
    });
    await db
      .update(issueRecoveryActions)
      .set({ evidence: { latestRunErrorCode: "adapter_failed" } })
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    await seedFamilyRuns({
      companyId,
      agentId: worker,
      succeededAt: [
        new Date(now.getTime() - 40 * MINUTE),
        new Date(now.getTime() - 10 * MINUTE),
      ],
    });

    const { recovery } = makeRecovery();
    expect(await recovery.promoteQuotaBlockedIssues(now)).toMatchObject({
      released: 0,
      held: 0,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("blocked");
  });

  it("keeps a quota-stranded issue out of blocked in the first place", async () => {
    // The provider is unavailable, this issue is not. Escalating it to
    // `blocked` hands it to a recovery owner who cannot lift the wall, and
    // nothing ever hands it back.
    const now = new Date();
    const { companyId, prefix } = await seedCompany();
    const worker = await seedAgent({ companyId, adapterType: "claude_local" });
    const issueId = randomUUID();
    issueNumber += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work interrupted by a quota wall",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: worker,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: worker,
      invocationSource: "automation",
      status: "failed",
      errorCode: "provider_quota",
      error: "You've hit your usage limit.",
      startedAt: new Date(now.getTime() - MINUTE),
      finishedAt: new Date(now.getTime() - MINUTE),
      contextSnapshot: { issueId },
    });

    const { recovery } = makeRecovery();
    await recovery.escalateStrandedAssignedIssue({
      issue: issue!,
      previousStatus: "in_progress",
      latestRun: {
        id: runId,
        agentId: worker,
        status: "failed",
        error: "You've hit your usage limit.",
        errorCode: "provider_quota",
        contextSnapshot: { issueId },
      } as never,
    });

    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after).toMatchObject({
      status: "in_progress",
      assigneeAgentId: worker,
    });
    // The wait is still recorded, so the release routine can find the issue.
    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(action).toMatchObject({ cause: "provider_quota", status: "active" });
  });
});

function monthAbbrev(date: Date) {
  return [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getUTCMonth()]!;
}
