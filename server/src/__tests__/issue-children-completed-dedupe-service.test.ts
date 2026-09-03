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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue_children_completed dedupe tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "issueService.getWakeableParentAfterChildCompletion — 10-min issue_children_completed dedupe (PR #6120)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let svc!: ReturnType<typeof issueService>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-children-completed-dedupe-");
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

    async function createCompany(prefix: string) {
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
      parentId?: string | null;
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
        parentId: input.parentId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
        originKind: "manual",
        originFingerprint: "default",
      });
      return id;
    }

    async function insertWakeup(input: {
      companyId: string;
      agentId: string;
      reason: string;
      issueId: string;
      offsetMs: number; // negative means in the past
    }) {
      const createdAt = new Date(Date.now() + input.offsetMs);
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        reason: input.reason,
        payload: { issueId: input.issueId },
        createdAt,
      });
    }

    async function makeFamilyWithAllChildrenDone(prefix: string) {
      const { companyId, agentId } = await createCompany(prefix);
      const parentId = await insertIssue({
        companyId,
        identifier: `${prefix}-1`,
        title: "parent",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await insertIssue({
        companyId,
        identifier: `${prefix}-2`,
        title: "child A",
        status: "done",
        parentId,
        assigneeAgentId: agentId,
      });
      await insertIssue({
        companyId,
        identifier: `${prefix}-3`,
        title: "child B",
        status: "cancelled",
        parentId,
        assigneeAgentId: agentId,
      });
      return { companyId, agentId, parentId };
    }

    it("returns the wakeable parent when no recent issue_children_completed wake exists", async () => {
      const { parentId } = await makeFamilyWithAllChildrenDone("DDA");
      const result = await svc.getWakeableParentAfterChildCompletion(parentId);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(parentId);
    });

    it("returns null when an issue_children_completed wake was enqueued in the last 10 minutes", async () => {
      const { companyId, agentId, parentId } = await makeFamilyWithAllChildrenDone("DDB");
      await insertWakeup({
        companyId,
        agentId,
        reason: "issue_children_completed",
        issueId: parentId,
        offsetMs: -2 * 60 * 1000, // 2 minutes ago
      });
      const result = await svc.getWakeableParentAfterChildCompletion(parentId);
      expect(result).toBeNull();
    });

    it("does not suppress a parent whose recent wake is older than the 10-min window", async () => {
      const { companyId, agentId, parentId } = await makeFamilyWithAllChildrenDone("DDC");
      await insertWakeup({
        companyId,
        agentId,
        reason: "issue_children_completed",
        issueId: parentId,
        offsetMs: -20 * 60 * 1000, // 20 minutes ago
      });
      const result = await svc.getWakeableParentAfterChildCompletion(parentId);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(parentId);
    });

    it("does not suppress a parent whose recent wake had a different reason", async () => {
      const { companyId, agentId, parentId } = await makeFamilyWithAllChildrenDone("DDD");
      await insertWakeup({
        companyId,
        agentId,
        reason: "issue_commented",
        issueId: parentId,
        offsetMs: -1 * 60 * 1000,
      });
      const result = await svc.getWakeableParentAfterChildCompletion(parentId);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(parentId);
    });

    it("does not suppress unrelated parents in the same company that share the same recent reason", async () => {
      const { companyId, agentId } = await createCompany("DDE");
      // Family 1 — recently woken
      const parent1 = await insertIssue({
        companyId,
        identifier: "DDE-1",
        title: "parent 1",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await insertIssue({
        companyId,
        identifier: "DDE-2",
        title: "child 1A",
        status: "done",
        parentId: parent1,
        assigneeAgentId: agentId,
      });
      // Family 2 — never woken
      const parent2 = await insertIssue({
        companyId,
        identifier: "DDE-3",
        title: "parent 2",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await insertIssue({
        companyId,
        identifier: "DDE-4",
        title: "child 2A",
        status: "done",
        parentId: parent2,
        assigneeAgentId: agentId,
      });
      // Wake parent 1 only
      await insertWakeup({
        companyId,
        agentId,
        reason: "issue_children_completed",
        issueId: parent1,
        offsetMs: -1 * 60 * 1000,
      });

      const blocked = await svc.getWakeableParentAfterChildCompletion(parent1);
      const passes = await svc.getWakeableParentAfterChildCompletion(parent2);
      expect(blocked).toBeNull();
      expect(passes).not.toBeNull();
      expect(passes?.id).toBe(parent2);
    });

    it("does not suppress a parent in a different company even with same reason+issueId payload shape", async () => {
      const a = await createCompany("DDF");
      const b = await createCompany("DDG");
      // Family in company A with all-done children
      const parentA = await insertIssue({
        companyId: a.companyId,
        identifier: "DDF-1",
        title: "parent A",
        status: "in_progress",
        assigneeAgentId: a.agentId,
      });
      await insertIssue({
        companyId: a.companyId,
        identifier: "DDF-2",
        title: "child A1",
        status: "done",
        parentId: parentA,
        assigneeAgentId: a.agentId,
      });
      // Insert a recent wake in company B referencing the same parentA UUID via payload
      // — the dedupe must scope on companyId, not just payload->>'issueId'.
      await insertWakeup({
        companyId: b.companyId,
        agentId: b.agentId,
        reason: "issue_children_completed",
        issueId: parentA,
        offsetMs: -1 * 60 * 1000,
      });

      const result = await svc.getWakeableParentAfterChildCompletion(parentA);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(parentA);
    });
  },
);
