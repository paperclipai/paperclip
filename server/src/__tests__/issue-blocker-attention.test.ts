import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
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
  }, 20_000);

  afterEach(async () => {
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

  async function activeRun(input: { companyId: string; agentId: string; issueId: string; status?: string; current?: boolean }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
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

  it("does not treat a scheduled retry as actively covered work", async () => {
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
    await activeRun({ companyId, agentId, issueId: blockerId, status: "scheduled_retry" });

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
});
