import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { issueApprovalService } from "../../services/issue-approvals.js";
import { issueService } from "../../services/issues.js";
import { approvalService } from "../../services/approvals.js";
import { agents, companies } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("issueApprovalService", () => {
  let testDb: TestDb;
  let companyId: string;

  beforeAll(() => {
    testDb = getTestDb();
  });
  afterAll(() => testDb.close());
  beforeEach(async () => {
    await cleanDb();
    const [co] = await testDb.db
      .insert(companies)
      .values({ name: "IssueApproval Co", issuePrefix: `IA${randomUUID().slice(0, 3).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return issueApprovalService(testDb.db);
  }

  async function createIssue() {
    const issueSvc = issueService(testDb.db);
    return issueSvc.create(companyId, { title: "Test Issue", status: "todo" });
  }

  async function createApproval() {
    const approvalSvc = approvalService(testDb.db);
    return approvalSvc.create(companyId, {
      type: "general",
      requestedByAgentId: null,
      requestedByUserId: null,
      payload: {},
    });
  }

  // ── link ──────────────────────────────────────────────────────────────

  describe("link", () => {
    it("links an issue to an approval", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      const link = await svc().link(issue.id, approval.id);
      expect(link).not.toBeNull();
      expect(link!.issueId).toBe(issue.id);
      expect(link!.approvalId).toBe(approval.id);
    });

    it("link is idempotent (no error on duplicate)", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().link(issue.id, approval.id);
      const duplicate = await svc().link(issue.id, approval.id);
      expect(duplicate).not.toBeNull();
    });
  });

  // ── listApprovalsForIssue ─────────────────────────────────────────────

  describe("listApprovalsForIssue", () => {
    it("returns linked approvals", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().link(issue.id, approval.id);
      const list = await svc().listApprovalsForIssue(issue.id);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(approval.id);
    });
  });

  // ── listIssuesForApproval ─────────────────────────────────────────────

  describe("listIssuesForApproval", () => {
    it("returns linked issues", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().link(issue.id, approval.id);
      const list = await svc().listIssuesForApproval(approval.id);
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(issue.id);
    });
  });

  // ── unlink ────────────────────────────────────────────────────────────

  describe("unlink", () => {
    it("removes the link", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().link(issue.id, approval.id);
      await svc().unlink(issue.id, approval.id);
      const list = await svc().listApprovalsForIssue(issue.id);
      expect(list.length).toBe(0);
    });
  });

  // ── linkManyForApproval ──────────────────────────────────────────────

  describe("linkManyForApproval", () => {
    it("links multiple issues to one approval", async () => {
      const issue1 = await createIssue();
      const issue2 = await createIssue();
      const approval = await createApproval();
      await svc().linkManyForApproval(approval.id, [issue1.id, issue2.id]);
      const list = await svc().listIssuesForApproval(approval.id);
      expect(list.length).toBe(2);
    });

    it("deduplicates issue ids", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().linkManyForApproval(approval.id, [issue.id, issue.id]);
      const list = await svc().listIssuesForApproval(approval.id);
      expect(list.length).toBe(1);
    });

    it("no-ops for empty issueIds", async () => {
      const approval = await createApproval();
      await svc().linkManyForApproval(approval.id, []);
      const list = await svc().listIssuesForApproval(approval.id);
      expect(list.length).toBe(0);
    });

    it("throws when approval not found", async () => {
      const issue = await createIssue();
      await expect(svc().linkManyForApproval(randomUUID(), [issue.id])).rejects.toThrow(/not found/i);
    });

    it("throws when one or more issues not found", async () => {
      const issue = await createIssue();
      const approval = await createApproval();
      await expect(
        svc().linkManyForApproval(approval.id, [issue.id, randomUUID()]),
      ).rejects.toThrow(/not found/i);
    });

    it("throws when issue belongs to different company", async () => {
      const [otherCo] = await testDb.db
        .insert(companies)
        .values({ name: "Other Co", issuePrefix: `OT${randomUUID().slice(0, 3).toUpperCase()}` })
        .returning();
      const otherIssueSvc = issueService(testDb.db);
      const otherIssue = await otherIssueSvc.create(otherCo.id, { title: "Other", status: "todo" });
      const approval = await createApproval();
      await expect(
        svc().linkManyForApproval(approval.id, [otherIssue.id]),
      ).rejects.toThrow(/same company/i);
    });

    it("passes actor info for linked records", async () => {
      const [ag] = await testDb.db
        .insert(agents)
        .values({ companyId, name: "Linker", role: "general", adapterType: "process", budgetMonthlyCents: 0, spentMonthlyCents: 0, status: "idle" })
        .returning();
      const issue = await createIssue();
      const approval = await createApproval();
      await svc().linkManyForApproval(approval.id, [issue.id], {
        agentId: ag.id,
        userId: null,
      });
      const list = await svc().listIssuesForApproval(approval.id);
      expect(list.length).toBe(1);
    });
  });

  // ── cross-company assertion ─────────────────────────────────────────

  describe("cross-company", () => {
    it("throws when issue and approval belong to different companies", async () => {
      const [otherCo] = await testDb.db
        .insert(companies)
        .values({ name: "Other Co", issuePrefix: `X${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning();
      const otherIssueSvc = issueService(testDb.db);
      const otherIssue = await otherIssueSvc.create(otherCo.id, { title: "Cross", status: "todo" });
      const approval = await createApproval();
      await expect(svc().link(otherIssue.id, approval.id)).rejects.toThrow(/same company/i);
    });

    it("throws on unlink when issue and approval are from different companies", async () => {
      const [otherCo] = await testDb.db
        .insert(companies)
        .values({ name: "Other Co 2", issuePrefix: `Y${randomUUID().slice(0, 4).toUpperCase()}` })
        .returning();
      const otherIssueSvc = issueService(testDb.db);
      const otherIssue = await otherIssueSvc.create(otherCo.id, { title: "Unlink cross", status: "todo" });
      const approval = await createApproval();
      await expect(svc().unlink(otherIssue.id, approval.id)).rejects.toThrow(/same company/i);
    });
  });

  // ── negative ──────────────────────────────────────────────────────────

  describe("negative", () => {
    it("negative: throws for nonexistent issue", async () => {
      const approval = await createApproval();
      await expect(svc().link(randomUUID(), approval.id)).rejects.toThrow(/not found/i);
    });

    it("negative: throws for nonexistent approval", async () => {
      const issue = await createIssue();
      await expect(svc().link(issue.id, randomUUID())).rejects.toThrow(/not found/i);
    });

    it("negative: listApprovalsForIssue throws for nonexistent issue", async () => {
      await expect(svc().listApprovalsForIssue(randomUUID())).rejects.toThrow(/not found/i);
    });

    it("negative: listIssuesForApproval throws for nonexistent approval", async () => {
      await expect(svc().listIssuesForApproval(randomUUID())).rejects.toThrow(/not found/i);
    });
  });
});
