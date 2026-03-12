import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDb, cleanDb, type TestDb } from "../helpers/test-db.js";
import { approvalService } from "../../services/approvals.js";
import { agents, companies } from "@paperclipai/db";
import { randomUUID } from "node:crypto";

describe("approvalService", () => {
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
      .values({ name: "Approval Co", issuePrefix: `A${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning();
    companyId = co.id;
  });

  function svc() {
    return approvalService(testDb.db);
  }

  // ── create ────────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates approval request", async () => {
      const approval = await svc().create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: { name: "New Bot" },
      });
      expect(approval).toBeDefined();
      expect(approval.status).toBe("pending");
      expect(approval.companyId).toBe(companyId);
    });
  });

  // ── list ──────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists with filtering by status", async () => {
      await svc().create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const pending = await svc().list(companyId, "pending");
      expect(pending.length).toBe(1);

      const approved = await svc().list(companyId, "approved");
      expect(approved.length).toBe(0);
    });
  });

  // ── approve ───────────────────────────────────────────────────────────

  describe("approve", () => {
    it("approves a pending request", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const userId = randomUUID();
      const result = await svc().approve(approval.id, userId, "Looks good");
      expect(result.approval.status).toBe("approved");
      expect(result.applied).toBe(true);
    });

    it("negative: approve already-approved is idempotent (not re-applied)", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const userId = randomUUID();
      await svc().approve(approval.id, userId);
      const result = await svc().approve(approval.id, userId);
      expect(result.approval.status).toBe("approved");
      expect(result.applied).toBe(false);
    });
  });

  // ── reject ────────────────────────────────────────────────────────────

  describe("reject", () => {
    it("rejects a pending request", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const userId = randomUUID();
      const result = await svc().reject(approval.id, userId, "Not suitable");
      expect(result.approval.status).toBe("rejected");
      expect(result.applied).toBe(true);
    });

    it("negative: reject already-rejected is idempotent", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const userId = randomUUID();
      await svc().reject(approval.id, userId);
      const result = await svc().reject(approval.id, userId);
      expect(result.approval.status).toBe("rejected");
      expect(result.applied).toBe(false);
    });
  });

  // ── resubmit ──────────────────────────────────────────────────────────

  describe("resubmit", () => {
    it("resubmits a revision-requested approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: { v: 1 },
      });
      const userId = randomUUID();
      await svc().requestRevision(approval.id, userId, "Fix it");
      const resubmitted = await svc().resubmit(approval.id, { v: 2 });
      expect(resubmitted.status).toBe("pending");
    });

    it("negative: cannot resubmit a pending approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await expect(svc().resubmit(approval.id)).rejects.toThrow(/revision requested/i);
    });
  });

  // ── requestRevision ──────────────────────────────────────────────────

  describe("requestRevision", () => {
    it("transitions pending approval to revision_requested", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const userId = randomUUID();
      const result = await svc().requestRevision(approval.id, userId, "Fix the name");
      expect(result.status).toBe("revision_requested");
      expect(result.decisionNote).toBe("Fix the name");
    });

    it("negative: cannot request revision on approved approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await svc().approve(approval.id, randomUUID());
      await expect(svc().requestRevision(approval.id, randomUUID())).rejects.toThrow(/pending/i);
    });
  });

  // ── approve/reject edge cases ──────────────────────────────────────

  describe("approve edge cases", () => {
    it("negative: cannot approve a rejected approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await svc().reject(approval.id, randomUUID());
      await expect(svc().approve(approval.id, randomUUID())).rejects.toThrow(/pending or revision/i);
    });

    it("can approve a revision_requested approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await svc().requestRevision(approval.id, randomUUID(), "Fix it");
      const result = await svc().approve(approval.id, randomUUID(), "Looks good now");
      expect(result.approval.status).toBe("approved");
      expect(result.applied).toBe(true);
    });

    it("can reject a revision_requested approval", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await svc().requestRevision(approval.id, randomUUID(), "Fix it");
      const result = await svc().reject(approval.id, randomUUID(), "Not fixable");
      expect(result.approval.status).toBe("rejected");
      expect(result.applied).toBe(true);
    });
  });

  // ── comments ────────────────────────────────────────────────────────

  describe("listComments & addComment", () => {
    it("adds and lists comments", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const comment = await svc().addComment(approval.id, "Hello!", { userId: "user-1" });
      expect(comment).toBeDefined();
      expect(comment.body).toBe("Hello!");

      const comments = await svc().listComments(approval.id);
      expect(comments.length).toBe(1);
      expect(comments[0].body).toBe("Hello!");
    });

    it("adds comment with agentId", async () => {
      const [ag] = await testDb.db
        .insert(agents)
        .values({ companyId, name: "Commenter", role: "general", adapterType: "process", budgetMonthlyCents: 0, spentMonthlyCents: 0, status: "idle" })
        .returning();
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const comment = await svc().addComment(approval.id, "Agent note", { agentId: ag.id });
      expect(comment.body).toBe("Agent note");
    });

    it("negative: listComments throws for nonexistent approval", async () => {
      await expect(svc().listComments(randomUUID())).rejects.toThrow(/not found/i);
    });

    it("negative: addComment throws for nonexistent approval", async () => {
      await expect(svc().addComment(randomUUID(), "test", {})).rejects.toThrow(/not found/i);
    });
  });

  // ── list (no filter) ───────────────────────────────────────────────

  describe("list without filter", () => {
    it("lists all approvals for company", async () => {
      await svc().create(companyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: {},
      });
      const all = await svc().list(companyId);
      expect(all.length).toBe(2);
    });
  });

  // ── getById ───────────────────────────────────────────────────────────

  describe("getById", () => {
    it("returns approval by id", async () => {
      const approval = await svc().create(companyId, {
        type: "general",
        requestedByAgentId: null,
        requestedByUserId: null,
        payload: { key: "value" },
      });
      const found = await svc().getById(approval.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(approval.id);
    });

    it("negative: returns null for nonexistent", async () => {
      const found = await svc().getById(randomUUID());
      expect(found).toBeNull();
    });
  });
});
