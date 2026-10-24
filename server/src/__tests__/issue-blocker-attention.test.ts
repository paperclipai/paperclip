import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
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
import { buildIssueGraphLivenessIncidentKey } from "../services/recovery/origins.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

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

  async function createCompany(prefix = "PBA") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      },
      {
        id: pausedAgentId,
        companyId,
        name: `${prefix} Paused`,
        role: "engineer",
        status: "paused",
      },
    ]);
    return { companyId, agentId, pausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    originFingerprint?: string | null;
    executionState?: Record<string, unknown> | null;
    description?: string | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      description: input.description ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function activeRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    current?: boolean;
    scheduledRetryAt?: Date;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
      scheduledRetryAt: input.scheduledRetryAt,
    });
    if (input.current !== false) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, input.issueId));
    }
    return runId;
  }

  it("classifies a blocked parent as covered when its child has a running execution path", async () => {
    const { companyId, agentId } = await createCompany("PBC");
    const parentId = await insertIssue({ companyId, identifier: "PBC-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PBC-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: childId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBC-2",
    });
  });

  it("classifies an assigned backlog blocker leaf without a waiting path as attention-needed", async () => {
    const { companyId, agentId } = await createCompany("PBB");
    const parentId = await insertIssue({ companyId, identifier: "PBB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBB-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBB-2",
    });
  });

  it("treats a human-owned backlog blocker as a covered waiting path", async () => {
    const { companyId } = await createCompany("PBU");
    const parentId = await insertIssue({ companyId, identifier: "PBU-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBU-2",
      title: "Human-owned parked blocker",
      status: "backlog",
      assigneeUserId: "board-user-1",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBU-2",
    });
  });

  it("keeps mixed blockers attention-required when any path lacks active work", async () => {
    const { companyId, agentId } = await createCompany("PBM");
    const parentId = await insertIssue({ companyId, identifier: "PBM-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PBM-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    const idleBlockerId = await insertIssue({
      companyId,
      identifier: "PBM-3",
      title: "Idle blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: idleBlockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBM-3",
    });
  });

  it("ignores cancelled direct children when counting unresolved blocker attention", async () => {
    const { companyId, agentId } = await createCompany("PBD");
    const parentId = await insertIssue({ companyId, identifier: "PBD-1", title: "Parent", status: "blocked" });
    const activeBlockerOneId = await insertIssue({
      companyId,
      identifier: "PBD-2",
      title: "Running dependency one",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const activeBlockerTwoId = await insertIssue({
      companyId,
      identifier: "PBD-3",
      title: "Running dependency two",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBD-4",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeBlockerOneId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: activeBlockerTwoId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeBlockerOneId });
    await activeRun({ companyId, agentId, issueId: activeBlockerTwoId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    expect(parent?.blockerAttention?.sampleBlockerIdentifier).not.toBe("PBD-4");
  });

  it("covers recursive blocker chains when the downstream leaf has active work", async () => {
    const { companyId, agentId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({ companyId, identifier: "PBR-2", title: "Blocked dependency", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBR-3",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: blockerId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-3",
    });
  });

  it("does not let another company's active run cover the blocker", async () => {
    const { companyId, agentId } = await createCompany("PBS");
    const other = await createCompany("PBT");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Same-company blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId: other.companyId, agentId: other.agentId, issueId: blockerId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBS-2",
    });
  });

  it("does not cover a blocker from a stale run the issue no longer owns", async () => {
    const { companyId, agentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Previously running blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, current: false });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBX-2",
    });
  });

  it("flags a chain whose leaf is in_review without an action path as stalled", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBV-2",
      sampleStalledBlockerIdentifier: "PBV-2",
    });
  });

  it("does not flag an in_review leaf as stalled when an active run is still progressing it", async () => {
    const { companyId, agentId } = await createCompany("PBW");
    const parentId = await insertIssue({ companyId, identifier: "PBW-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBW-2",
      title: "Active review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: reviewLeafId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      stalledBlockerCount: 0,
    });
  });

  it("flags a deep chain whose leaf is stalled in_review through multiple layers", async () => {
    const { companyId, agentId } = await createCompany("PBZ");
    const rootId = await insertIssue({ companyId, identifier: "PBZ-1", title: "Root", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PBZ-2", title: "Mid blocker", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBZ-3",
      title: "Stalled leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const root = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBZ-3",
    });
  });

  it("returns the direct path and link details when an intermediate blocker is selected", async () => {
    const { companyId, agentId } = await createCompany("PBI");
    const rootId = await insertIssue({ companyId, identifier: "PBI-1", title: "Root", status: "blocked" });
    const directId = await insertIssue({
      companyId,
      identifier: "PBI-2",
      title: "Direct blocker",
      status: "blocked",
    });
    const intermediateId = await insertIssue({
      companyId,
      identifier: "PBI-3",
      title: "Stalled intermediate review",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBI-4",
      title: "Downstream leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: directId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: intermediateId, blockedIssueId: directId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: intermediateId });

    const root = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      directBlockerIssueId: directId,
      terminalBlockerIssueId: intermediateId,
      terminalBlocker: {
        id: intermediateId,
        identifier: "PBI-3",
        title: "Stalled intermediate review",
      },
    });
  });

  it("prefers needs_attention over stalled when the chain also has a hard attention case", async () => {
    const { companyId, agentId } = await createCompany("PBQ");
    const parentId = await insertIssue({ companyId, identifier: "PBQ-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-3",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBQ-2",
    });
  });

  it("treats open liveness escalation blockers as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBL");
    const parentId = await insertIssue({ companyId, identifier: "PBL-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBL-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const incidentKey = [
      "harness_liveness",
      companyId,
      parentId,
      "blocked_by_cancelled_issue",
      cancelledLeafId,
    ].join(":");
    const escalationId = await insertIssue({
      companyId,
      identifier: "PBL-3",
      title: "Liveness escalation",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: incidentKey,
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: escalationId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked,todo" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
    });
  });

  it("does not treat cancelled liveness escalation issues as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBLX");
    const parentId = await insertIssue({ companyId, identifier: "PBLX-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBLX-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBLX-3",
      title: "Cancelled liveness escalation",
      status: "cancelled",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        parentId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { attention: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      leafIssue: { id: cancelledLeafId, identifier: "PBLX-2" },
    });
  });

  it("does not treat an expired scheduled retry as actively covered work", async () => {
    const pinnedNow = new Date("2026-08-20T12:00:00.000Z");
    const expiredRetryAt = new Date(pinnedNow.getTime() - 60_000);
    const { companyId, agentId } = await createCompany("PBY");
    const parentId = await insertIssue({ companyId, identifier: "PBY-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBY-2",
      title: "Retrying blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({
      companyId,
      agentId,
      issueId: blockerId,
      status: "scheduled_retry",
      scheduledRetryAt: expiredRetryAt,
    });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBY-2",
    });
  });

  it("returns blocked inbox attention for an unassigned blocker leaf and supports count/search", async () => {
    const { companyId } = await createCompany("BIA");
    const parentId = await insertIssue({ companyId, identifier: "BIA-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIA-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", q: "BIA-2" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parentId);
    expect(rows[0]?.blockedBy).toEqual([
      expect.objectContaining({ id: blockerId, identifier: "BIA-2" }),
    ]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      owner: { type: "unknown", agentId: null, userId: null },
      action: { label: "Assign blocker" },
      leafIssue: { id: blockerId, identifier: "BIA-2" },
      redaction: { secretFieldsOmitted: true },
    });
    await expect(svc.count(companyId, { attention: "blocked" })).resolves.toBe(1);
  });

  it("preserves attention ordering and pagination with many healthy tasks", async () => {
    const { companyId, agentId } = await createCompany("BIP");
    const criticalParentId = await insertIssue({
      companyId,
      identifier: "BIP-1",
      title: "Critical dependency",
      status: "blocked",
    });
    const unassignedBlockerId = await insertIssue({
      companyId,
      identifier: "BIP-2",
      title: "Unassigned dependency",
      status: "todo",
    });
    const highParentId = await insertIssue({
      companyId,
      identifier: "BIP-3",
      title: "Parked dependency",
      status: "blocked",
    });
    const backlogBlockerId = await insertIssue({
      companyId,
      identifier: "BIP-4",
      title: "Assigned backlog dependency",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: unassignedBlockerId, blockedIssueId: criticalParentId });
    await block({ companyId, blockerIssueId: backlogBlockerId, blockedIssueId: highParentId });
    for (let index = 5; index < 105; index += 1) {
      await insertIssue({
        companyId,
        identifier: `BIP-${index}`,
        title: `Healthy task ${index}`,
        status: "todo",
      });
    }

    const firstPage = await svc.list(companyId, { attention: "blocked", limit: 1 });
    const secondPage = await svc.list(companyId, { attention: "blocked", limit: 1, offset: 1 });

    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]).toMatchObject({
      id: criticalParentId,
      blockedInboxAttention: { reason: "blocked_by_unassigned_issue" },
    });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]).toMatchObject({
      id: highParentId,
      blockedInboxAttention: { reason: "blocked_by_assigned_backlog_issue" },
    });
  });

  it.skipIf(process.env.PAPERCLIP_RUN_ISSUE_PERF !== "1")(
    "profiles blocked issue listing with 100, 1,000, and 10,000 task dependency chains",
    async () => {
      const sizes = process.env.PAPERCLIP_ISSUE_PERF_SIZES
        ?.split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0) ?? [100, 1_000, 10_000];
      for (const size of sizes) {
        const phaseMs: Record<string, number> = {};
        const phaseSql: Record<string, { count: number; elapsedMs: number; returnedRows: number }> = {};
        const querySignatures = new Map<string, number>();
        const client = db.$client as typeof db.$client & { unsafe: (...args: any[]) => Promise<any> };
        const originalUnsafe = client.unsafe.bind(client);
        const measure = async <T>(phase: string, action: () => Promise<T> | T) => {
          const started = performance.now();
          const metrics = { count: 0, elapsedMs: 0, returnedRows: 0 };
          phaseSql[phase] = metrics;
          client.unsafe = ((...args: any[]) => {
            metrics.count += 1;
            const signature = String(args[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
            querySignatures.set(signature, (querySignatures.get(signature) ?? 0) + 1);
            const queryStarted = performance.now();
            const query = originalUnsafe(...args) as any;
            let recorded = false;
            const record = (result: unknown) => {
              if (recorded) return;
              recorded = true;
              metrics.elapsedMs += performance.now() - queryStarted;
              metrics.returnedRows += Array.isArray(result) ? result.length : 0;
            };
            return new Proxy(query, {
              get(target, property, receiver) {
                if (property === "values" || property === "raw") {
                  const method = Reflect.get(target, property, receiver);
                  return (...methodArgs: unknown[]) => Promise.resolve(method.apply(target, methodArgs)).then((result: unknown) => {
                    record(result);
                    return result;
                  }, (error: unknown) => {
                    record(undefined);
                    throw error;
                  });
                }
                if (property === "then") {
                  return (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                    target.then((result: unknown) => {
                      record(result);
                      return resolve ? resolve(result) : result;
                    }, (error: unknown) => {
                      record(undefined);
                      if (reject) return reject(error);
                      throw error;
                    });
                }
                const value = Reflect.get(target, property, receiver);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          }) as typeof client.unsafe;
          try {
            const value = await action();
            phaseMs[phase] = performance.now() - started;
            return value;
          } finally {
            client.unsafe = originalUnsafe;
          }
        };
        const { companyId, agentId } = await measure("seed_company", () => createCompany(`BP${size}`));
        const { issueRows, relationRows } = await measure("data_generation", () => {
          const ids = Array.from({ length: size }, () => randomUUID());
          return {
            issueRows: ids.map((id, index) => ({
              id,
              companyId,
              identifier: `BP${size}-${index}`,
              title: `Synthetic dependency ${index}`,
              status: index === 0 ? "todo" : "blocked",
              assigneeAgentId: index === 0 ? null : agentId,
              originKind: "manual",
              originFingerprint: `bp-${size}-${index}`,
            })),
            relationRows: ids.slice(1).map((blockedIssueId, index) => ({
              companyId,
              issueId: ids[index]!,
              relatedIssueId: blockedIssueId,
              type: "blocks" as const,
            })),
          };
        });
        await measure("seed_issues", async () => {
          for (let start = 0; start < issueRows.length; start += 500) {
            await db.insert(issues).values(issueRows.slice(start, start + 500));
          }
        });
        await measure("seed_relations", async () => {
          for (let start = 0; start < relationRows.length; start += 500) {
            await db.insert(issueRelations).values(relationRows.slice(start, start + 500));
          }
        });

        let rows: Awaited<ReturnType<typeof svc.list>>;
        rows = await measure("service_list_total", () => svc.list(companyId, { attention: "blocked", limit: 200 }));
        const queryMetrics = phaseSql.service_list_total!;
        phaseMs.classification_and_service_overhead = Math.max(0, phaseMs.service_list_total! - queryMetrics.elapsedMs);
        const elapsedMs = phaseMs.service_list_total!;
        console.info(
          `blocked_issue_list tasks=${size} relations=${relationRows.length} returned=${rows.length} data_generation_ms=${phaseMs.data_generation!.toFixed(1)} seed_company_ms=${phaseMs.seed_company!.toFixed(1)} seed_company_queries=${phaseSql.seed_company!.count} seed_company_sql_ms=${phaseSql.seed_company!.elapsedMs.toFixed(1)} seed_issues_ms=${phaseMs.seed_issues!.toFixed(1)} seed_issues_queries=${phaseSql.seed_issues!.count} seed_issues_sql_ms=${phaseSql.seed_issues!.elapsedMs.toFixed(1)} seed_relations_ms=${phaseMs.seed_relations!.toFixed(1)} seed_relations_queries=${phaseSql.seed_relations!.count} seed_relations_sql_ms=${phaseSql.seed_relations!.elapsedMs.toFixed(1)} service_total_ms=${elapsedMs.toFixed(1)} service_sql_ms=${queryMetrics.elapsedMs.toFixed(1)} service_queries=${queryMetrics.count} service_sql_rows=${queryMetrics.returnedRows} classification_and_overhead_ms=${phaseMs.classification_and_service_overhead!.toFixed(1)}`,
        );
        console.info(`blocked_issue_list_sql_top tasks=${size} signatures=${JSON.stringify([...querySignatures].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
        expect(rows).toHaveLength(Math.min(size - 1, 200));
        expect(rows.every((row) => row.blockedInboxAttention?.kind === "blocked")).toBe(true);
        expect(queryMetrics.count).toBeLessThan(1_000);

        await measure("cleanup", async () => {
          await db.delete(issueRelations).where(eq(issueRelations.companyId, companyId));
          await db.delete(issues).where(eq(issues.companyId, companyId));
          await db.delete(agents).where(eq(agents.companyId, companyId));
          await db.delete(companies).where(eq(companies.id, companyId));
        });
        console.info(`blocked_issue_list_cleanup tasks=${size} elapsed_ms=${phaseMs.cleanup!.toFixed(1)} queries=${phaseSql.cleanup!.count} sql_ms=${phaseSql.cleanup!.elapsedMs.toFixed(1)}`);
      }
    },
    360_000,
  );

  it("surfaces cancelled-blocker attention on an assigned todo source", async () => {
    const { companyId, agentId } = await createCompany("BICX");
    const sourceId = await insertIssue({
      companyId,
      identifier: "BICX-1",
      title: "Dispatch-suppressed source",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BICX-2",
      title: "Cancelled dependency",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: sourceId });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const source = rows.find((issue) => issue.id === sourceId);

    expect(source?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      owner: { type: "agent", agentId },
      action: { label: "Replace blocker" },
      leafIssue: { id: blockerId, identifier: "BICX-2" },
    });
  });

  it("redacts external wait details from blocked inbox payloads and search", async () => {
    const { companyId } = await createCompany("BIX");
    const owner = "Private Vendor Security Team";
    const action = "Send the confidential access token for customer Alpha";
    const issueId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked on vendor",
      status: "blocked",
      description: [
        "Public context stays visible.",
        `external owner: ${owner}`,
        `external action: ${action}`,
        "Continue after the vendor confirms receipt.",
      ].join("\n"),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const issue = rows.find((row) => row.id === issueId);

    expect(issue?.description).toContain("Public context stays visible.");
    expect(issue?.description).toContain("Continue after the vendor confirms receipt.");
    expect(issue?.description).not.toContain(owner);
    expect(issue?.description).not.toContain(action);
    expect(issue?.blockedInboxAttention).toMatchObject({
      state: "external_wait",
      reason: "external_owner_action",
      owner: { type: "external", label: null },
      action: { label: "External owner action", detail: null },
      redaction: { externalDetailsRedacted: true, secretFieldsOmitted: true },
    });
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(owner);
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(action);

    await expect(svc.list(companyId, { attention: "blocked", q: owner })).resolves.toEqual([]);
    await expect(svc.count(companyId, { attention: "blocked", q: action })).resolves.toBe(0);
    await expect(svc.count(companyId, { attention: "blocked", q: "Public context" })).resolves.toBe(1);
  });

  it("excludes healthy active blockers from blocked inbox attention", async () => {
    const { companyId, agentId } = await createCompany("BIB");
    const parentId = await insertIssue({ companyId, identifier: "BIB-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIB-2",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
  });

  it("classifies assigned backlog and invalid review leaves for blocked inbox attention", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BIC");
    const backlogParentId = await insertIssue({ companyId, identifier: "BIC-1", title: "Blocked by parked work", status: "blocked" });
    const backlogLeafId = await insertIssue({
      companyId,
      identifier: "BIC-2",
      title: "Parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: backlogLeafId, blockedIssueId: backlogParentId });

    const reviewId = await insertIssue({
      companyId,
      identifier: "BIC-3",
      title: "Invalid review",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedAgentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(backlogParentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: backlogLeafId },
    });
    expect(byId.get(reviewId)?.blockedInboxAttention).toMatchObject({
      reason: "invalid_review_participant",
      severity: "critical",
      action: { label: "Repair review participant" },
    });
  });

  it("classifies recovery issues and missing successful-run dispositions", async () => {
    const { companyId, agentId } = await createCompany("BID");
    const sourceId = await insertIssue({ companyId, identifier: "BID-1", title: "Stopped source", status: "blocked" });
    const leafId = await insertIssue({ companyId, identifier: "BID-2", title: "Stopped leaf", status: "todo" });
    const recoveryId = await insertIssue({
      companyId,
      identifier: "BID-3",
      title: "Recovery issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: buildIssueGraphLivenessIncidentKey({
        companyId,
        issueId: sourceId,
        state: "blocked_by_unassigned_issue",
        blockerIssueId: leafId,
      }),
    });
    const handoffId = await insertIssue({
      companyId,
      identifier: "BID-4",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "Progress was made" },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(recoveryId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      leafIssue: { id: leafId },
      recoveryIssue: { id: recoveryId },
    });
    expect(byId.get(handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId },
      action: { label: "Choose disposition" },
    });

    const handoffRunId = await activeRun({ companyId, agentId, issueId: handoffId, current: false });
    const liveRows = await svc.list(companyId, { attention: "blocked" });
    expect(liveRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, handoffRunId));
    const stoppedRows = await svc.list(companyId, { attention: "blocked" });
    expect(stoppedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    const scheduledRetryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: scheduledRetryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      contextSnapshot: { taskId: handoffId },
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryAttempt: 1,
    });
    const scheduledRows = await svc.list(companyId, { attention: "blocked" });
    expect(scheduledRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, scheduledRetryRunId));
    const exhaustedRows = await svc.list(companyId, { attention: "blocked" });
    expect(exhaustedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_escalated",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID() },
    });
    const escalatedRows = await svc.list(companyId, { attention: "blocked" });
    expect(escalatedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    const escalatedLiveRunId = await activeRun({ companyId, agentId, issueId: handoffId, current: false });
    const escalatedLiveRows = await svc.list(companyId, { attention: "blocked" });
    expect(escalatedLiveRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, escalatedLiveRunId));
    const escalatedStoppedRows = await svc.list(companyId, { attention: "blocked" });
    expect(escalatedStoppedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });
  });

  it("applies assigneeAgentId='null' as an IS NULL filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAN");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: "null" });
    expect(rows.map((row) => row.id)).toEqual([unassignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("applies a UUID assigneeAgentId filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAU");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: agentId });
    expect(rows.map((row) => row.id)).toEqual([assignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: agentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values on the blocked-inbox path", async () => {
    const { companyId } = await createCompany("BAM");
    await expect(
      svc.list(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
    await expect(
      svc.count(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });
});
