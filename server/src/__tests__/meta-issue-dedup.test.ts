import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueComments, issues } from "@paperclipai/db";
import { ensureUnblockBlockerCard } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import {
  RECOVERY_CARD_TERMINAL_SUPPRESSION_MS,
  UNBLOCK_CARD_TERMINAL_SUPPRESSION_MS,
} from "../services/meta-issue-dedup.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres meta-issue dedup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * TSMC-20961: duplicate platform-minted meta cards. Both mint classes
 * ("Unblock: ..." disposition cards and "Recover ..." recovery cards) must
 * reuse an identical open card (recording the occurrence as a comment) and
 * must not remint while an identical card sits freshly done/cancelled.
 */
describeEmbeddedPostgres("meta-issue dedup", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let issuesSvc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-meta-issue-dedup-");
    db = createDb(tempDb.connectionString);
    issuesSvc = issueService(db);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `MD${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Dedup Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend feature",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  function unblockSource(seed: Awaited<ReturnType<typeof seedCompany>>) {
    return {
      id: seed.sourceIssueId,
      companyId: seed.companyId,
      identifier: `${seed.prefix}-1`,
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspaceSettings: null,
      workMode: "standard",
      assigneeAgentId: seed.coderId,
      assigneeUserId: null,
    };
  }

  function mintedCardId(result: Awaited<ReturnType<typeof ensureUnblockBlockerCard>>) {
    if (result.outcome === "terminal_suppressed" || !result.issue) {
      throw new Error(`expected a card, got ${result.outcome}`);
    }
    return result.issue.id;
  }

  async function cardsTitled(companyId: string, title: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, title)));
  }

  describe("Unblock cards", () => {
    it("reuses the identical open card and records the occurrence as a comment", async () => {
      const seed = await seedCompany();
      const blocker = "Waiting on the ops API key";
      const runId = null;

      const first = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker,
        runId,
      });
      expect(first.outcome).toBe("created");

      const second = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker,
        runId,
      });
      expect(second.outcome).toBe("reused");
      expect(mintedCardId(second)).toBe(mintedCardId(first));

      const cards = await cardsTitled(seed.companyId, `Unblock: ${blocker}`);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ status: "todo", assigneeAgentId: seed.coderId });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, mintedCardId(first)));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Reusing this open card");
      expect(comments[0]?.body).toContain(`${seed.prefix}-1`);
      expect(comments[0]?.authorType).toBe("system");
    });

    it("a reworded blocker from the same source reuses the one open Unblock card", async () => {
      // 2026-08-22: this test previously asserted the pre-6e86af2c1 behavior
      // (distinct blocker wording => distinct cards). The standing policy is
      // ONE open Unblock per source issue, ever — free-prose blocker text
      // never repeats, so title-keyed minting produced 49 sibling cards in a
      // single morning once blocked dispositions were honored. A new blocker
      // statement lands as a comment on the existing card.
      const seed = await seedCompany();

      const first = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker: "Waiting on the ops API key",
      });
      const second = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker: "Waiting on the design source package",
      });

      expect(first.outcome).toBe("created");
      expect(second.outcome).toBe("reused");
      expect(mintedCardId(second)).toBe(mintedCardId(first));
    });

    it("suppresses re-creation while an identical card is freshly cancelled, then remints after the window", async () => {
      const seed = await seedCompany();
      const blocker = "Waiting on the ops API key";

      const first = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker,
      });
      const cardId = mintedCardId(first);
      await issuesSvc.update(cardId, { status: "cancelled" });

      const suppressed = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker,
      });
      expect(suppressed).toMatchObject({
        outcome: "terminal_suppressed",
        existingIssueId: cardId,
        existingStatus: "cancelled",
      });
      expect(await cardsTitled(seed.companyId, `Unblock: ${blocker}`)).toHaveLength(1);
      await expect(
        db.select().from(issueComments).where(eq(issueComments.issueId, cardId)),
      ).resolves.toHaveLength(0);

      await db
        .update(issues)
        .set({ cancelledAt: new Date(Date.now() - UNBLOCK_CARD_TERMINAL_SUPPRESSION_MS - 60_000) })
        .where(eq(issues.id, cardId));

      const reminted = await ensureUnblockBlockerCard(db, issuesSvc, {
        sourceIssue: unblockSource(seed),
        blocker,
      });
      expect(reminted.outcome).toBe("created");
      expect(mintedCardId(reminted)).not.toBe(cardId);
      expect(await cardsTitled(seed.companyId, `Unblock: ${blocker}`)).toHaveLength(2);
    });
  });

  describe("recovery cards", () => {
    function latestRunFor(coderId: string) {
      return {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      } as const;
    }

    async function recoveryCards(companyId: string, sourceIssueId: string) {
      return db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, sourceIssueId),
          ),
        );
    }

    it("second escalation reuses the open recovery card and records the occurrence as a comment", async () => {
      const seed = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = latestRunFor(seed.coderId);

      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      });
      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      });

      const cards = await recoveryCards(seed.companyId, seed.sourceIssueId);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.title).toBe(`Recover stalled issue ${seed.prefix}-1`);

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, cards[0]!.id));
      const reuseComments = comments.filter((row) =>
        row.body.includes("Reusing this open recovery card"),
      );
      expect(reuseComments).toHaveLength(1);
      expect(reuseComments[0]?.body).toContain(`${seed.prefix}-1`);
      expect(reuseComments[0]?.body).toContain("stranded_assigned_issue");
    });

    it("distinct source issues still mint distinct recovery cards", async () => {
      const seed = await seedCompany();
      const otherSourceId = randomUUID();
      await db.insert(issues).values({
        id: otherSourceId,
        companyId: seed.companyId,
        title: "Implement second feature",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: seed.coderId,
        issueNumber: 2,
        identifier: `${seed.prefix}-2`,
      });
      const [otherSource] = await db.select().from(issues).where(eq(issues.id, otherSourceId));
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun: latestRunFor(seed.coderId),
      });
      await recovery.escalateStrandedAssignedIssue({
        issue: otherSource!,
        previousStatus: "in_progress",
        latestRun: latestRunFor(seed.coderId),
      });

      await expect(recoveryCards(seed.companyId, seed.sourceIssueId)).resolves.toHaveLength(1);
      await expect(recoveryCards(seed.companyId, otherSourceId)).resolves.toHaveLength(1);
    });

    it("suppresses re-creation while an identical recovery card is freshly done, then remints after the window", async () => {
      const seed = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });

      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun: latestRunFor(seed.coderId),
      });
      const [card] = await recoveryCards(seed.companyId, seed.sourceIssueId);
      expect(card).toBeTruthy();
      await issuesSvc.update(card!.id, { status: "done" });
      const commentCountBefore = (
        await db.select().from(issueComments).where(eq(issueComments.issueId, card!.id))
      ).length;

      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun: latestRunFor(seed.coderId),
      });

      const afterSuppressed = await recoveryCards(seed.companyId, seed.sourceIssueId);
      expect(afterSuppressed).toHaveLength(1);
      expect(afterSuppressed[0]?.status).toBe("done");
      await expect(
        db.select().from(issueComments).where(eq(issueComments.issueId, card!.id)),
      ).resolves.toHaveLength(commentCountBefore);

      await db
        .update(issues)
        .set({ completedAt: new Date(Date.now() - RECOVERY_CARD_TERMINAL_SUPPRESSION_MS - 60_000) })
        .where(eq(issues.id, card!.id));

      await recovery.escalateStrandedAssignedIssue({
        issue: seed.sourceIssue,
        previousStatus: "in_progress",
        latestRun: latestRunFor(seed.coderId),
      });

      const reminted = await recoveryCards(seed.companyId, seed.sourceIssueId);
      expect(reminted).toHaveLength(2);
      expect(reminted.filter((row) => row.status === "done")).toHaveLength(1);
    });
  });
});
