import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { AttentionAudience, AttentionFeedView } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attention audience tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PAP-749 task 1a: two-user service tests for resolveAttentionAudience and the
// view= partition. The audience controls where a card shows; it never changes
// who may act, and it is never derived from responsibleUserId.
describeEmbeddedPostgres("attention audience service (PAP-749 task 1a)", () => {
  const SCOTT = "scott";
  const DOTTA = "dotta";

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-audience-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix = "AUD") {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const errorAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId, companyId, name: "Worker", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
      {
        id: errorAgentId, companyId, name: "Broken Agent", role: "engineer", status: "error",
        errorReason: "adapter config missing",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      },
    ]);
    return { companyId, workerId, errorAgentId, prefix };
  }

  let issueSeq = 0;
  async function insertIssue(input: {
    companyId: string;
    id?: string;
    status?: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    createdByAgentId?: string | null;
    createdByUserId?: string | null;
    responsibleUserId?: string | null;
    originKind?: string;
    conversationAgentId?: string | null;
    conversationUserId?: string | null;
    conversationState?: string | null;
    executionState?: Record<string, unknown> | null;
  }) {
    const id = input.id ?? randomUUID();
    issueSeq += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: `${issueSeq}`,
      title: `Issue ${issueSeq}`,
      status: input.status ?? "in_progress",
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      originKind: input.originKind ?? "manual",
      originFingerprint: `fp-${issueSeq}`,
      conversationAgentId: input.conversationAgentId ?? null,
      conversationUserId: input.conversationUserId ?? null,
      conversationState: input.conversationState ?? null,
      executionState: input.executionState ?? null,
    });
    return id;
  }

  async function insertConfirmation(input: {
    companyId: string;
    issueId: string;
    workerId: string;
    addresseeUserId?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      title: "Approve the plan",
      createdByAgentId: input.workerId,
      addresseeUserId: input.addresseeUserId ?? null,
      payload: { version: 1, prompt: "Approve this plan?" },
    });
    return id;
  }

  function list(companyId: string, userId: string, view?: AttentionFeedView) {
    return attentionService(db).list(companyId, { userId, view });
  }

  function audienceOf(items: Array<{ subject: { id: string }; audience: AttentionAudience }>, sourceId: string) {
    return items.find((item) => item.subject.id === sourceId)?.audience ?? null;
  }

  it("resolves the audience for each source kind and step without a user-visible change in view=all", async () => {
    const { companyId, workerId } = await seedCompany();

    // Step 4 (instigator): a human-created task by Scott, with a no-addressee confirmation.
    const scottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const scottInstigated = await insertConfirmation({ companyId, issueId: scottTask, workerId });

    // Step 4 for Dotta, to prove Scott still sees it in `all` (pre-PAP-749 behaviour).
    const dottaTask = await insertIssue({ companyId, createdByUserId: DOTTA, originKind: "manual" });
    const dottaInstigated = await insertConfirmation({ companyId, issueId: dottaTask, workerId });

    // Step 1 (addressee): confirmation explicitly addressed to Scott.
    const addressedTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "task_watchdog" });
    const addressedToScott = await insertConfirmation({ companyId, issueId: addressedTask, workerId, addresseeUserId: SCOTT });

    // Step 2 (conversation): a chat container whose user is Scott.
    const chatTask = await insertIssue({
      companyId, status: "in_review", assigneeAgentId: workerId,
      conversationAgentId: workerId, conversationUserId: SCOTT, conversationState: "waiting",
    });
    const chatConfirmation = await insertConfirmation({ companyId, issueId: chatTask, workerId });

    // "requester": an approval requested by Scott.
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId, companyId, type: "request_board_approval", status: "pending",
      requestedByUserId: SCOTT, payload: { title: "Ship it" },
    });

    // Pool (step 6) + responsibleUserId guard: agent/routine-created work, no addressee,
    // responsibleUserId = Scott. It must NOT route to Scott.
    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const poolConfirmation = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const feed = await list(companyId, SCOTT, "all");
    const items = feed.items;

    // Each source kind / step resolves to the expected audience.
    expect(audienceOf(items, scottInstigated)).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });
    expect(audienceOf(items, addressedToScott)).toEqual({ kind: "user", userId: SCOTT, reason: "addressee" });
    expect(audienceOf(items, chatConfirmation)).toEqual({ kind: "user", userId: SCOTT, reason: "conversation" });
    expect(audienceOf(items, approvalId)).toEqual({ kind: "user", userId: SCOTT, reason: "requester" });

    // The routine/agent-created card is a pool card; responsibleUserId did NOT route it to Scott.
    expect(audienceOf(items, poolConfirmation)).toEqual({ kind: "pool", userId: null, reason: "none" });

    // The company operations alert (the errored agent) is a Company card.
    const errorCard = items.find((item) => item.sourceKind === "agent_error_alert");
    expect(errorCard?.audience).toEqual({ kind: "company", userId: null, reason: "none" });

    // No user-visible change in `all`: Scott still sees Dotta's instigated card (it has no addressee),
    // exactly as before PAP-749. Only an interaction addressed to another user stays hidden.
    expect(audienceOf(items, dottaInstigated)).toEqual({ kind: "user", userId: DOTTA, reason: "instigator" });
  });

  it("keeps an interaction addressed to another user hidden in every view (pre-PAP-749 behaviour)", async () => {
    const { companyId, workerId } = await seedCompany("ADX");
    const task = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "task_watchdog" });
    const addressedToDotta = await insertConfirmation({ companyId, issueId: task, workerId, addresseeUserId: DOTTA });

    const scottAll = await list(companyId, SCOTT, "all");
    expect(scottAll.items.some((item) => item.subject.id === addressedToDotta)).toBe(false);

    const dottaAll = await list(companyId, DOTTA, "all");
    expect(audienceOf(dottaAll.items, addressedToDotta)).toEqual({ kind: "user", userId: DOTTA, reason: "addressee" });
  });

  it("partitions the feed by view: mine, unassigned, and company", async () => {
    const { companyId, workerId } = await seedCompany("PRT");

    const scottTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const scottCard = await insertConfirmation({ companyId, issueId: scottTask, workerId });

    const dottaTask = await insertIssue({ companyId, createdByUserId: DOTTA, originKind: "manual" });
    const dottaCard = await insertConfirmation({ companyId, issueId: dottaTask, workerId });

    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const poolCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    const scottMine = await list(companyId, SCOTT, "mine");
    const scottMineIds = scottMine.items.map((item) => item.subject.id);
    expect(scottMineIds).toContain(scottCard);
    expect(scottMineIds).not.toContain(dottaCard);
    expect(scottMineIds).not.toContain(poolCard);
    expect(scottMine.items.every((item) => item.audience.kind === "user" && item.audience.userId === SCOTT)).toBe(true);

    const dottaMine = await list(companyId, DOTTA, "mine");
    const dottaMineIds = dottaMine.items.map((item) => item.subject.id);
    expect(dottaMineIds).toContain(dottaCard);
    expect(dottaMineIds).not.toContain(scottCard);

    const unassigned = await list(companyId, SCOTT, "unassigned");
    const unassignedIds = unassigned.items.map((item) => item.subject.id);
    expect(unassignedIds).toContain(poolCard);
    expect(unassignedIds).not.toContain(scottCard);
    expect(unassigned.items.every((item) => item.audience.kind === "pool")).toBe(true);

    const company = await list(companyId, SCOTT, "company");
    expect(company.items.length).toBeGreaterThan(0);
    expect(company.items.every((item) => item.audience.kind === "company")).toBe(true);
    expect(company.items.some((item) => item.sourceKind === "agent_error_alert")).toBe(true);
  });

  it("routes ownerless cards to the company default decision owner, and to Unassigned once cleared (PAP-749 task 1d-lite)", async () => {
    const { companyId, workerId } = await seedCompany("DDO");

    // An agent/routine card with no human signal — a pool card by default.
    const routineTask = await insertIssue({
      companyId, createdByAgentId: workerId, originKind: "routine_execution", responsibleUserId: SCOTT,
    });
    const ownerlessCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: DOTTA, status: "active", membershipRole: "admin",
    });

    // With the default decision owner set to Dotta, the ownerless card routes to
    // Dotta's "For you" list, with reason escalation_owner — not the pool.
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));

    const dottaMineSet = await list(companyId, DOTTA, "mine");
    expect(audienceOf(dottaMineSet.items, ownerlessCard)).toEqual({ kind: "user", userId: DOTTA, reason: "escalation_owner" });

    const unassignedSet = await list(companyId, SCOTT, "unassigned");
    expect(unassignedSet.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);

    // responsibleUserId is still never a routing signal: Scott does not get it.
    const scottMineSet = await list(companyId, SCOTT, "mine");
    expect(scottMineSet.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);

    // Clearing the owner sends the same card back to the claimable pool.
    await db.update(companies).set({ defaultDecisionOwnerUserId: null }).where(eq(companies.id, companyId));

    const unassignedCleared = await list(companyId, SCOTT, "unassigned");
    expect(audienceOf(unassignedCleared.items, ownerlessCard)).toEqual({ kind: "pool", userId: null, reason: "none" });

    const dottaMineCleared = await list(companyId, DOTTA, "mine");
    expect(dottaMineCleared.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);
  });

  it("sends ownerless cards to Unassigned when the default decision owner is no longer an active member", async () => {
    const { companyId, workerId } = await seedCompany("DDI");
    const routineTask = await insertIssue({ companyId, createdByAgentId: workerId, originKind: "routine_execution" });
    const ownerlessCard = await insertConfirmation({ companyId, issueId: routineTask, workerId });

    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: DOTTA, status: "suspended", membershipRole: "admin",
    });
    await db.update(companies).set({ defaultDecisionOwnerUserId: DOTTA }).where(eq(companies.id, companyId));

    const unassigned = await list(companyId, SCOTT, "unassigned");
    expect(audienceOf(unassigned.items, ownerlessCard)).toEqual({ kind: "pool", userId: null, reason: "none" });
    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(dottaMine.items.some((item) => item.subject.id === ownerlessCard)).toBe(false);
  });

  it("routes a delegated child card to the instigator of its parent", async () => {
    const { companyId, workerId } = await seedCompany("CHN");

    // Scott creates the parent human task; an agent spins up a child under it.
    const parentTask = await insertIssue({ companyId, createdByUserId: SCOTT, originKind: "manual" });
    const childTask = await insertIssue({
      companyId, parentId: parentTask, createdByAgentId: workerId, originKind: "manual",
    });
    const childCard = await insertConfirmation({ companyId, issueId: childTask, workerId });

    const scottMine = await list(companyId, SCOTT, "mine");
    expect(audienceOf(scottMine.items, childCard)).toEqual({ kind: "user", userId: SCOTT, reason: "instigator" });

    const dottaMine = await list(companyId, DOTTA, "mine");
    expect(dottaMine.items.some((item) => item.subject.id === childCard)).toBe(false);
  });
});
