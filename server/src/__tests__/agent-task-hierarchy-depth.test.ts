import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import {
  PARENT_WRITE_VALIDATION_DEPTH_CAP,
  PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS,
  loadParentChainBounded,
  planIssueParentChange,
  resolveNewTaskParent,
} from "../services/issue-hierarchy.ts";
import { resolveIssueCreationSource } from "../services/issue-creation-source.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent task hierarchy depth", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-task-depth-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    values: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Task ${id.slice(0, 6)}`,
      status: "todo",
      priority: "medium",
      ...values,
    });
    return id;
  }

  async function seedTree(companyId: string) {
    const suffix = randomUUID().slice(0, 8);
    const rootIdentifier = `ROOT-${suffix}`;
    const childIdentifier = `CHILD-${suffix}`;
    const rootId = await seedIssue(companyId, { identifier: rootIdentifier });
    const childId = await seedIssue(companyId, { parentId: rootId, identifier: childIdentifier });
    return { rootId, childId, rootIdentifier, childIdentifier };
  }

  it("places an agent's child-of-a-child beside the requester and keeps it as the origin", async () => {
    const { companyId } = await seedCompany();
    const { rootId, childId, rootIdentifier, childIdentifier } = await seedTree(companyId);

    // expectedParentId: the route authorized the placed ancestor.
    const created = await issueService(db).create(companyId, {
      title: "Follow-up from the child",
      parentId: childId,
      expectedParentId: rootId,
    });

    expect(created.parentId).toBe(rootId);
    expect(created.originIssueId).toBe(childId);
    expect(created.privacyParentIssueId).toBe(childId);
    expect(created.parentAdjusted).toEqual({
      reason: "max_agent_depth",
      applied: true,
      requestedParent: { id: childId, identifier: childIdentifier },
      effectiveParent: { id: rootId, identifier: rootIdentifier },
    });
  });

  it("lets board users create grandchildren", async () => {
    const { companyId } = await seedCompany();
    const { childId } = await seedTree(companyId);

    const created = await issueService(db).create(companyId, {
      title: "Board grandchild",
      parentId: childId,
      parentDepthPolicy: "allow_nested",
    });

    expect(created.parentId).toBe(childId);
    expect(created.originIssueId).toBe(childId);
    expect(created.parentAdjusted).toBeUndefined();
  });

  it("creates direct children of a top-level task unchanged", async () => {
    const { companyId } = await seedCompany();
    const { rootId } = await seedTree(companyId);

    const created = await issueService(db).create(companyId, { title: "Second child", parentId: rootId });

    expect(created.parentId).toBe(rootId);
    expect(created.originIssueId).toBe(rootId);
    expect(created.parentAdjusted).toBeUndefined();
  });

  it("records the creating run's task as the origin of a top-level task", async () => {
    const { companyId, agentId } = await seedCompany();
    const sourceId = await seedIssue(companyId);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", issueId: sourceId });

    const created = await issueService(db).create(companyId, {
      title: "Standalone follow-up",
      parentId: null,
      createdByAgentId: agentId,
      actorRunId: runId,
    });

    expect(created.parentId).toBeNull();
    expect(created.originIssueId).toBe(sourceId);
    expect(created.originRunId).toBe(runId);
  });

  it("flattens legacy deep trees to their root", async () => {
    const { companyId } = await seedCompany();
    const { rootId, childId } = await seedTree(companyId);
    const grandchildId = await seedIssue(companyId, { parentId: childId });

    const created = await issueService(db).create(companyId, { title: "Under legacy grandchild", parentId: grandchildId, expectedParentId: rootId });

    expect(created.parentId).toBe(rootId);
    expect(created.originIssueId).toBe(grandchildId);
    expect(created.parentAdjusted?.requestedParent?.id).toBe(grandchildId);
  });

  it("blocks the requester, not the root, when a flattened child should block its parent", async () => {
    const { companyId } = await seedCompany();
    const { rootId, childId } = await seedTree(companyId);

    const { issue, parentBlockerAdded } = await issueService(db).createChild(childId, {
      title: "Blocking follow-up",
      blockParentUntilDone: true,
      expectedParentId: rootId,
    });

    expect(issue.parentId).toBe(rootId);
    expect(issue.originIssueId).toBe(childId);
    expect(issue.parentAdjusted?.reason).toBe("max_agent_depth");
    expect(parentBlockerAdded).toBe(true);
    const blockers = await db
      .select({ relatedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, issue.id), eq(issueRelations.type, "blocks")));
    expect(blockers.map((row) => row.relatedIssueId)).toEqual([childId]);
  });

  it("reuses a flattened child for the same idempotency key", async () => {
    const { companyId } = await seedCompany();
    const { childId } = await seedTree(companyId);
    const idempotencyKey = `flatten-${randomUUID()}`;

    const first = await issueService(db).createChild(childId, { title: "Once", idempotencyKey });
    const second = await issueService(db).createChild(childId, { title: "Once", idempotencyKey });

    expect(second.issue.id).toBe(first.issue.id);
  });

  it("places under the real root of a legacy tree deeper than 64 levels", async () => {
    const { companyId } = await seedCompany();
    const rootId = await seedIssue(companyId);
    let deepestId = rootId;
    for (let level = 1; level < 70; level += 1) deepestId = await seedIssue(companyId, { parentId: deepestId });

    const created = await issueService(db).create(companyId, { title: "From the 70th level", parentId: deepestId, expectedParentId: rootId });

    expect(created.parentId).toBe(rootId);
    expect(created.originIssueId).toBe(deepestId);
  });

  it("does not move a task above a low-trust boundary root", async () => {
    const { companyId } = await seedCompany();
    const rootId = await seedIssue(companyId);
    const boundaryId = randomUUID();
    await seedIssue(companyId, {
      id: boundaryId,
      parentId: rootId,
      executionPolicy: {
        authorizationPolicy: {
          trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: boundaryId },
        },
      },
    });

    const placement = await resolveNewTaskParent(db, companyId, boundaryId, "flatten");

    expect(placement).toEqual({ effectiveParentId: boundaryId, adjustment: null });
  });

  it("falls back to top level when a legacy tree is rooted at a conversation", async () => {
    const { companyId, agentId } = await seedCompany();
    const conversationId = await seedIssue(companyId, { conversationAgentId: agentId, conversationUserId: "user-1", conversationState: "active", assigneeAgentId: agentId,
    });
    const legacyChildId = await seedIssue(companyId, { parentId: conversationId });

    const created = await issueService(db).create(companyId, { title: "From legacy chat child", parentId: legacyChildId });

    expect(created.parentId).toBeNull();
    expect(created.originIssueId).toBe(legacyChildId);
    expect(created.parentAdjusted).toMatchObject({ reason: "max_agent_depth", effectiveParent: null });
  });

  it("rejects a create whose locked placement differs from the authorized one", async () => {
    const { companyId } = await seedCompany();
    const { rootId, childId } = await seedTree(companyId);
    const otherRootId = await seedIssue(companyId);
    // The route authorized placement under rootId; the child then moved.
    await db.update(issues).set({ parentId: otherRootId }).where(eq(issues.id, childId));

    await expect(issueService(db).create(companyId, {
      title: "Stale placement",
      parentId: childId,
      expectedParentId: rootId,
    })).rejects.toMatchObject({ status: 409 });
  });

  it("dedupes recent titles per requester, not across siblings placed under the same root", async () => {
    const { companyId } = await seedCompany();
    const { rootId, childId } = await seedTree(companyId);
    const otherChildId = await seedIssue(companyId, { parentId: rootId });

    const first = await issueService(db).create(companyId, { title: "Write tests", parentId: childId, allowDuplicate: false });
    const second = await issueService(db).create(companyId, { title: "Write tests", parentId: otherChildId, allowDuplicate: false });
    const repeat = await issueService(db).create(companyId, { title: "Write tests", parentId: childId, allowDuplicate: false });

    expect(second.id).not.toBe(first.id);
    expect(second.originIssueId).toBe(otherChildId);
    expect(repeat.id).toBe(first.id);
  });

  it("ignores caller-supplied originIssueId", async () => {
    const { companyId } = await seedCompany();
    const { childId } = await seedTree(companyId);
    const forgedId = await seedIssue(companyId);

    const created = await issueService(db).create(companyId, {
      title: "Provenance is server-derived",
      parentId: childId,
      ...({ originIssueId: forgedId } as Record<string, unknown>),
    });

    expect(created.originIssueId).toBe(childId);
  });

  it("rejects a parent from another company on create and move", async () => {
    const { companyId } = await seedCompany();
    const { companyId: otherCompanyId } = await seedCompany();
    const foreignParentId = await seedIssue(otherCompanyId);

    await expect(issueService(db).create(companyId, { title: "Foreign parent", parentId: foreignParentId }))
      .rejects.toMatchObject({ status: 404 });
    await expect(issueService(db).create(companyId, {
      title: "Foreign parent, board", parentId: foreignParentId, parentDepthPolicy: "allow_nested",
    })).rejects.toMatchObject({ status: 404 });

    const movingId = await seedIssue(companyId);
    await expect(issueService(db).update(movingId, { parentId: foreignParentId, parentDepthPolicy: "allow_nested" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("originates from the creating run's task, not the named parent, in detail and lists", async () => {
    const { companyId, agentId } = await seedCompany();
    const { childId } = await seedTree(companyId);
    const runTaskId = await seedIssue(companyId);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", issueId: runTaskId });

    const created = await issueService(db).create(companyId, {
      title: "Named parent from another run", parentId: childId, createdByAgentId: agentId, actorRunId: runId,
    });
    // A run working on runTask filed this under childId: it originates from runTask.
    expect(created.originIssueId).toBe(runTaskId);
    expect(created.privacyParentIssueId).toBe(childId);

    const fromRunTask = await issueService(db).list(companyId, { createdFromIssueId: runTaskId });
    const fromChild = await issueService(db).list(companyId, { createdFromIssueId: childId });
    expect(fromRunTask.map((row) => row.id)).toContain(created.id);
    expect(fromChild.map((row) => row.id)).not.toContain(created.id);
    expect((await resolveIssueCreationSource(db, created))?.sourceIssue.id).toBe(runTaskId);
  });

  it("originates from a legacy run bound only by a task identifier", async () => {
    const { companyId, agentId } = await seedCompany();
    const { childId } = await seedTree(companyId);
    const identifier = `LEG-${randomUUID().slice(0, 6)}`;
    const runTaskId = await seedIssue(companyId, { identifier });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { taskKey: identifier } });

    const created = await issueService(db).create(companyId, {
      title: "From a legacy-bound run", parentId: childId, createdByAgentId: agentId, actorRunId: runId,
    });

    expect(created.originIssueId).toBe(runTaskId);
  });

  it("makes unconfirmed placements standalone instead of writing under an unchecked ancestor", async () => {
    const { companyId } = await seedCompany();
    const { childId } = await seedTree(companyId);

    // Internal callers authorize only the parent they request.
    const created = await issueService(db).create(companyId, { title: "Internal follow-up", parentId: childId });
    expect(created.parentId).toBeNull();
    expect(created.privacyParentIssueId).toBe(childId);
    expect(created.originIssueId).toBe(childId);
    expect(created.parentAdjusted).toMatchObject({ reason: "max_agent_depth", applied: true, effectiveParent: null });

    const { issue } = await issueService(db).createChild(childId, { title: "Internal child helper" });
    expect(issue.parentId).toBeNull();

    const movingId = await seedIssue(companyId);
    const moved = await issueService(db).update(movingId, { parentId: childId, title: "Renamed anyway" });
    expect(moved?.parentId).toBeNull();
    expect(moved?.title).toBe("Renamed anyway");
    expect(moved?.parentAdjusted).toMatchObject({ reason: "max_agent_depth", applied: false, effectiveParent: null });

    // An already-parented task keeps its parent, and the notice names it.
    const otherRootId = await seedIssue(companyId, { identifier: `KEEP-${randomUUID().slice(0, 6)}` });
    const parentedId = await seedIssue(companyId, { parentId: otherRootId });
    const kept = await issueService(db).update(parentedId, { parentId: childId });
    expect(kept?.parentId).toBe(otherRootId);
    expect(kept?.parentAdjusted).toMatchObject({ applied: false, effectiveParent: { id: otherRootId } });
  });

  it("does not expose a private origin on a task its readers may see", async () => {
    const { companyId, agentId } = await seedCompany();
    const openParentId = await seedIssue(companyId);
    const privateTaskId = randomUUID();
    await seedIssue(companyId, { id: privateTaskId, visibility: "private", privacyRootIssueId: privateTaskId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", issueId: privateTaskId });

    const created = await issueService(db).create(companyId, {
      title: "Open work filed from a private task", parentId: openParentId, createdByAgentId: agentId, actorRunId: runId,
    });

    expect(created.visibility).toBe("open");
    expect(created.originIssueId).toBeNull();
    // The audit link stays server-side through the run, checked for access on read.
    expect(created.originRunId).toBe(runId);
    expect((await resolveIssueCreationSource(db, created))?.sourceIssue.id).toBe(privateTaskId);
  });

  it("does not expose a hidden origin or a private sibling's id", async () => {
    const { companyId, agentId } = await seedCompany();
    const runOn = async (taskId: string) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", issueId: taskId });
      return runId;
    };

    const openParentId = await seedIssue(companyId);
    const hiddenTaskId = await seedIssue(companyId, { hiddenAt: new Date() });
    const fromHidden = await issueService(db).create(companyId, {
      title: "From a hidden task", parentId: openParentId, createdByAgentId: agentId, actorRunId: await runOn(hiddenTaskId),
    });
    expect(fromHidden.originIssueId).toBeNull();

    const rootId = randomUUID();
    await seedIssue(companyId, { id: rootId, visibility: "private", privacyRootIssueId: rootId });
    const siblingA = await seedIssue(companyId, { parentId: rootId, visibility: "private", privacyRootIssueId: rootId });
    const siblingB = await seedIssue(companyId, { parentId: rootId, visibility: "private", privacyRootIssueId: rootId });
    const fromSibling = await issueService(db).create(companyId, {
      title: "Filed under a private sibling", parentId: siblingB, createdByAgentId: agentId,
      actorRunId: await runOn(siblingA), expectedParentId: rootId,
    });
    expect(fromSibling.privacyParentIssueId).toBe(siblingB);
    expect(fromSibling.originIssueId).toBeNull();
    expect((await resolveIssueCreationSource(db, fromSibling))?.sourceIssue.id).toBe(siblingA);
  });

  describe("moves", () => {
    it("keeps the requested private parent as the privacy source of a placed move", async () => {
      const { companyId } = await seedCompany();
      const rootId = await seedIssue(companyId);
      const privateChildId = randomUUID();
      await seedIssue(companyId, { id: privateChildId, parentId: rootId, visibility: "private", privacyRootIssueId: privateChildId });
      const movingId = await seedIssue(companyId);

      const updated = await issueService(db).update(movingId, { parentId: privateChildId, expectedParentId: rootId });

      expect(updated?.parentId).toBe(rootId);
      expect(updated?.privacyParentIssueId).toBe(privateChildId);
      expect(updated?.visibility).toBe("private");
      expect(updated?.privacyRootIssueId).toBe(privateChildId);
    });

    it("rejects a move whose placement differs from the authorized one", async () => {
      const { companyId } = await seedCompany();
      const { childId } = await seedTree(companyId);
      const movingId = await seedIssue(companyId);

      await expect(issueService(db).update(movingId, { parentId: childId, expectedParentId: childId }))
        .rejects.toMatchObject({ status: 409 });
    });

    it("places an agent move into a child beside it", async () => {
      const { companyId } = await seedCompany();
      const { rootId, childId } = await seedTree(companyId);
      const movingId = await seedIssue(companyId);

      const updated = await issueService(db).update(movingId, { parentId: childId, expectedParentId: rootId });

      expect(updated?.parentId).toBe(rootId);
      expect(updated?.parentAdjusted).toMatchObject({ reason: "max_agent_depth", applied: true });
    });

    it("skips only the parent change when the moved task has children", async () => {
      const { companyId } = await seedCompany();
      const { rootId } = await seedTree(companyId);
      const movingId = await seedIssue(companyId);
      await seedIssue(companyId, { parentId: movingId });

      const updated = await issueService(db).update(movingId, { parentId: rootId, title: "Renamed" });

      expect(updated?.parentId).toBeNull();
      expect(updated?.title).toBe("Renamed");
      expect(updated?.parentAdjusted).toMatchObject({
        reason: "has_children",
        applied: false,
        requestedParent: { id: rootId },
        effectiveParent: null,
      });
    });

    it("lets board users move to any depth", async () => {
      const { companyId } = await seedCompany();
      const { childId } = await seedTree(companyId);
      const movingId = await seedIssue(companyId);
      await seedIssue(companyId, { parentId: movingId });

      const plan = await planIssueParentChange(
        db,
        { id: movingId, companyId, parentId: null },
        childId,
        "allow_nested",
      );
      expect(plan).toEqual({ parentId: childId, adjustment: null });

      const updated = await issueService(db).update(movingId, { parentId: childId, parentDepthPolicy: "allow_nested" });
      expect(updated?.parentId).toBe(childId);
      expect(updated?.parentAdjusted).toBeUndefined();
    });
  });

  it("resolves creation provenance from the recorded origin task", async () => {
    const { companyId } = await seedCompany();
    const { childId } = await seedTree(companyId);
    const created = await issueService(db).create(companyId, { title: "Flattened", parentId: childId });

    const source = await resolveIssueCreationSource(db, created);

    expect(source?.sourceIssue.id).toBe(childId);
    expect(source?.run).toBeNull();
  });

  describe("parent cycle validation", () => {
    it("rejects a self-parent move and leaves the edge untouched", async () => {
      const { companyId } = await seedCompany();
      const id = await seedIssue(companyId, { identifier: "SELF-1" });

      await expect(issueService(db).update(id, { parentId: id }))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      const [row] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, id));
      expect(row!.parentId).toBeNull();
    });

    it("rejects moving an issue under its own descendant, even for board users", async () => {
      const { companyId } = await seedCompany();
      const { rootId, childId } = await seedTree(companyId);
      await seedIssue(companyId, { parentId: childId, identifier: "GRAND-1" });

      await expect(issueService(db).update(rootId, { parentId: childId, parentDepthPolicy: "allow_nested" }))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      const [row] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, rootId));
      expect(row!.parentId).toBeNull();
    });

    it("rejects both cycles for direct planIssueParentChange callers", async () => {
      const { companyId } = await seedCompany();
      const { rootId, childId } = await seedTree(companyId);

      await expect(planIssueParentChange(db, { id: rootId, companyId, parentId: null }, rootId))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      // A write that re-affirms a poisoned edge already in the data is
      // rejected too, so legacy corruption surfaces instead of persisting.
      await expect(planIssueParentChange(db, { id: rootId, companyId, parentId: childId }, childId))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
    });

    it("rejects re-affirming a poisoned self-parent through issueService.update", async () => {
      const { companyId } = await seedCompany();
      const id = await seedIssue(companyId);
      // Legacy corruption written before the guard existed: parent_id = id.
      await db.update(issues).set({ parentId: id }).where(eq(issues.id, id));

      await expect(issueService(db).update(id, { parentId: id }))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      const [row] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, id));
      expect(row!.parentId).toBe(id);
    });

    it("rejects re-affirming a stored 2-cycle edge through issueService.update", async () => {
      const { companyId } = await seedCompany();
      const aId = await seedIssue(companyId, { identifier: "CY-A" });
      const bId = await seedIssue(companyId, { parentId: aId, identifier: "CY-B" });
      await db.update(issues).set({ parentId: bId }).where(eq(issues.id, aId));

      // A write whose value equals the stored (cyclic) parent still surfaces
      // the corruption.
      await expect(issueService(db).update(aId, { parentId: bId, title: "Renamed" }))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      const [row] = await db.select({ parentId: issues.parentId, title: issues.title }).from(issues).where(eq(issues.id, aId));
      expect(row!.parentId).toBe(bId);
      expect(row!.title).not.toBe("Renamed");
    });

    it("keeps legal moves working: detach, reattach, and a no-op parent patch", async () => {
      const { companyId } = await seedCompany();
      const { rootId, childId } = await seedTree(companyId);

      const detached = await issueService(db).update(childId, { parentId: null });
      expect(detached!.parentId).toBeNull();

      const reattached = await issueService(db).update(childId, { parentId: rootId });
      expect(reattached!.parentId).toBe(rootId);

      const noop = await issueService(db).update(childId, { parentId: rootId, title: "Renamed" });
      expect(noop!.parentId).toBe(rootId);
      expect(noop!.title).toBe("Renamed");
    });

    it("keeps rejecting a cross-company parent on update", async () => {
      const first = await seedCompany();
      const second = await seedCompany();
      const id = await seedIssue(first.companyId);
      const foreignId = await seedIssue(second.companyId);

      await expect(issueService(db).update(id, { parentId: foreignId }))
        .rejects.toMatchObject({ status: 404 });
      const [row] = await db.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, id));
      expect(row!.parentId).toBeNull();
    });
  });

  describe("bounded parent-write validation", () => {
    // A legacy/board chain deeper than the validation window.
    async function seedDeepChain(companyId: string, depth: number) {
      const rootId = await seedIssue(companyId, { identifier: `DEEP-ROOT-${randomUUID().slice(0, 6)}` });
      const ids = [rootId];
      let lastId = rootId;
      for (let level = 1; level < depth; level += 1) {
        lastId = await seedIssue(companyId, { parentId: lastId });
        ids.push(lastId);
      }
      return { rootId, ids, deepestId: lastId };
    }

    it("caps the validation walk on a deep acyclic chain", async () => {
      const { companyId } = await seedCompany();
      const { deepestId } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);

      const chain = await loadParentChainBounded(db, companyId, deepestId);

      expect(chain).toHaveLength(PARENT_WRITE_VALIDATION_DEPTH_CAP);
      expect(chain[0]!.id).toBe(deepestId);
      expect(chain[chain.length - 1]!.parentId).not.toBeNull();
    });

    it("keeps allowing repeated board writes on a deep acyclic chain", async () => {
      const { companyId } = await seedCompany();
      const { deepestId } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);
      const moverId = await seedIssue(companyId);

      const plan = await planIssueParentChange(db, { id: moverId, companyId, parentId: null }, deepestId, "allow_nested");

      expect(plan).toEqual({ parentId: deepestId, adjustment: null });
    });

    it("rejects re-affirming an ancestor past the validation window", async () => {
      const { companyId } = await seedCompany();
      const { ids } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);

      // ids[3] sits beyond the window's reach from the deepest issue, so only
      // the full fallback walk can see the cycle it would close. Running the
      // plan inside a transaction mirrors the runner's relock path: the
      // fallback's savepoint and statement timeout must nest cleanly.
      await db.transaction(async (tx) => {
        await expect(planIssueParentChange(tx, { id: ids[3]!, companyId, parentId: null }, ids[ids.length - 1]!, "allow_nested"))
          .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
      });
    });

    it("restores the caller's statement_timeout after a fallback cycle rejection", async () => {
      const { companyId } = await seedCompany();
      const { ids } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);

      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '250ms', true)`);
        await expect(planIssueParentChange(tx, { id: ids[3]!, companyId, parentId: null }, ids[ids.length - 1]!, "allow_nested"))
          .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
        // The fallback's savepoint was released (the walk succeeded; the 422
        // is thrown afterwards), so a reset to '0' would leak "unlimited"
        // into this transaction. The caller's 250ms limit must survive.
        const [after] = await tx.execute<{ statementTimeout: string }>(
          sql`select current_setting('statement_timeout') as "statementTimeout"`,
        );
        expect(after?.statementTimeout).toBe("250ms");
      });
    });

    it("leaves the caller's default statement_timeout in effect after a fallback walk", async () => {
      const { companyId } = await seedCompany();
      const { deepestId } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);
      const moverId = await seedIssue(companyId);

      await db.transaction(async (tx) => {
        const [before] = await tx.execute<{ statement_timeout: string }>(sql`show statement_timeout`);
        const plan = await planIssueParentChange(tx, { id: moverId, companyId, parentId: null }, deepestId, "allow_nested");
        expect(plan).toEqual({ parentId: deepestId, adjustment: null });
        const [after] = await tx.execute<{ statement_timeout: string }>(sql`show statement_timeout`);
        // No operator limit was configured: '' and '0' both mean "unlimited",
        // so restoring '0' preserves the effective default. The fallback's
        // own 5000ms window must never leak out either way.
        expect(after?.statement_timeout).toBe(before?.statement_timeout || "0");
        expect(after?.statement_timeout).not.toBe(`${PARENT_WRITE_VALIDATION_STATEMENT_TIMEOUT_MS}ms`);
      });
    });

    it("rejects re-affirming an ancestor inside the validation window", async () => {
      const { companyId } = await seedCompany();
      const { ids } = await seedDeepChain(companyId, 40);

      await expect(planIssueParentChange(db, { id: ids[3]!, companyId, parentId: null }, ids[30]!))
        .rejects.toMatchObject({ status: 422, details: { code: "issue_parent_cycle" } });
    });

    it("allows writes under a parent whose window loops without the moving issue", async () => {
      const { companyId } = await seedCompany();
      const { ids } = await seedDeepChain(companyId, 40);
      // Corruption elsewhere in the tree: a forward edge closes a cycle among
      // ids[5]..ids[20]. The window walks into the loop, sees the repeat, and
      // decides without a full walk; the mover is not in the chain, so the
      // write under ids[30] is allowed exactly as before the cap.
      await db.update(issues).set({ parentId: ids[20]! }).where(eq(issues.id, ids[5]!));
      const moverId = await seedIssue(companyId);

      const plan = await planIssueParentChange(db, { id: moverId, companyId, parentId: null }, ids[30]!, "allow_nested");

      expect(plan).toEqual({ parentId: ids[30], adjustment: null });
    });

    it("still places an agent move beside a deep legacy subtree at the real root", async () => {
      const { companyId } = await seedCompany();
      const { rootId, deepestId } = await seedDeepChain(companyId, PARENT_WRITE_VALIDATION_DEPTH_CAP + 6);
      const moverId = await seedIssue(companyId);

      const updated = await issueService(db).update(moverId, { parentId: deepestId, expectedParentId: rootId });

      expect(updated?.parentId).toBe(rootId);
      expect(updated?.parentAdjusted).toMatchObject({
        reason: "max_agent_depth",
        applied: true,
        effectiveParent: { id: rootId },
      });
    });
  });
});
