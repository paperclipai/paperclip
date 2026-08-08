/**
 * RBR-852 AC5 — the acceptance gate for the interaction-supersession effort.
 *
 * Kept in its own file deliberately. The gate must not be weakened to make an unrelated suite
 * pass (explicit CEO direction on RBR-823/RBR-852), and isolating it means churn in the large
 * shared interaction suite can never quietly erode it.
 *
 * Five cases, from the approved plan:
 *  1. 3 pending interactions + 1 user comment => the current (newest) one survives.
 *  2. cross-issue explicit link => the linked row expires with a pointer back to its replacement.
 *  3. cross-company supersede attempt => 422, nothing mutated.
 *  4. superseding another agent's interaction => 422, nothing mutated.
 *  5. cross-issue withdraw by the author on the company-scoped path => withdrawn; foreign company
 *     scope => 404. (The non-author 403 is an HTTP concern and lives in the route suite.)
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  instanceSettings,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  issueThreadInteractionService,
  selectContradictoryPendingConfirmations,
} from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("RBR-852 interaction supersession (AC5 gate)", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rbr852-supersession-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: name,
      level: "task",
      status: "active",
    });
    return { companyId, goalId };
  }

  async function seedIssue(companyId: string, goalId: string, title: string, assigneeAgentId?: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title,
      status: "in_progress",
      priority: "medium",
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
    });
    return issueId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  function confirmationPayload(
    title: string,
    supersedesInteractionIds?: string[],
    overrides?: { supersedeOnUserComment?: boolean },
  ) {
    return {
      version: 1 as const,
      prompt: `Confirm: ${title}`,
      acceptLabel: "Confirm",
      ...(supersedesInteractionIds ? { supersedesInteractionIds } : {}),
      ...(overrides?.supersedeOnUserComment === undefined
        ? {}
        : { supersedeOnUserComment: overrides.supersedeOnUserComment }),
    };
  }

  async function statusOf(interactionId: string) {
    const [row] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));
    return row;
  }

  /**
   * Case 1 — the gate itself, stated strictly and not weakened.
   *
   * This is the RBR-823 defect in miniature: several irreversible asks pending at once, and the
   * board member types one comment. Before the fix, that single comment expired all of them,
   * including the current, correct ask. Three distinct agents author the three asks, which is
   * exactly how the live RBR-730 / RBR-660 / RBR-398 pileups arose.
   */
  it("case 1: a single user comment does not expire the current ask when three are pending", async () => {
    const { companyId, goalId } = await seedCompany("Gate co");
    const issueId = await seedIssue(companyId, goalId, "Contradictory asks");
    const agentA = await seedAgent(companyId, "Agent A");
    const agentB = await seedAgent(companyId, "Agent B");
    const agentC = await seedAgent(companyId, "Agent C");

    const stale188 = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 188 devices"),
    }, { agentId: agentA });
    const stale190 = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 190 devices"),
    }, { agentId: agentB });
    const current193 = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 193 devices"),
    }, { agentId: agentC });

    for (const created of [stale188, stale190, current193]) {
      expect(created.status).toBe("pending");
    }

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment(
      { id: issueId, companyId },
      {
        id: randomUUID(),
        createdAt: new Date(new Date(current193.createdAt).getTime() + 1_000),
        authorUserId: "local-board",
      },
      { userId: "local-board" },
    );

    // The gate: the current ask must survive the comment.
    expect((await statusOf(current193.id))?.status).toBe("pending");
    expect(expired.map((row) => row.id)).not.toContain(current193.id);

    // And per the AC1 ruling we expire nothing rather than guess a winner among unlinked asks:
    // a comment must never silently retire a live irreversible request.
    expect(expired).toHaveLength(0);
    expect((await statusOf(stale188.id))?.status).toBe("pending");
    expect((await statusOf(stale190.id))?.status).toBe("pending");
  });

  /**
   * Case 1b — the single-candidate branch still works when expiry-by-comment is opted into.
   *
   * This case opts in explicitly (`supersedeOnUserComment: true`) rather than relying on the
   * create-time default. RBR-875 flipped `SUPERSEDE_ON_USER_COMMENT_DEFAULT` to `false`, making
   * expiry-by-comment strictly opt-in; what this case guards is the *selection rule* in
   * `selectCommentSupersededRows` (one candidate => expire it), which is RBR-852's contract and is
   * independent of whatever the default happens to be. Case 1c below pins the default itself, so
   * a future flip in either direction fails there loudly instead of silently rewriting this gate.
   */
  it("case 1b: a single opted-in pending ask still expires on a user comment", async () => {
    const { companyId, goalId } = await seedCompany("Single ask co");
    const issueId = await seedIssue(companyId, goalId, "One ask");
    const agentA = await seedAgent(companyId, "Agent A");

    const only = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 193 devices", undefined, { supersedeOnUserComment: true }),
    }, { agentId: agentA });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment(
      { id: issueId, companyId },
      {
        id: randomUUID(),
        createdAt: new Date(new Date(only.createdAt).getTime() + 1_000),
        authorUserId: "local-board",
      },
      { userId: "local-board" },
    );

    expect(expired).toHaveLength(1);
    expect(expired[0]?.id).toBe(only.id);
    expect((await statusOf(only.id))?.status).toBe("expired");
  });

  /**
   * Case 1c — expiry-by-comment is opt-in at create time (RBR-875).
   *
   * An ask created without an opinion must not be retired by a passing board comment. This is the
   * companion half of the RBR-823 defect: RBR-852 stopped a comment from expiring *several* asks,
   * RBR-875 stopped it from expiring an unconsenting *single* ask. Asserted here so the default is
   * covered by the acceptance gate and cannot drift back unnoticed.
   */
  it("case 1c: an ask that never opted in is not expired by a user comment", async () => {
    const { companyId, goalId } = await seedCompany("Default opt-out co");
    const issueId = await seedIssue(companyId, goalId, "One unconsenting ask");
    const agentA = await seedAgent(companyId, "Agent A");

    const only = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 193 devices"),
    }, { agentId: agentA });

    const expired = await interactionsSvc.expireRequestConfirmationsSupersededByComment(
      { id: issueId, companyId },
      {
        id: randomUUID(),
        createdAt: new Date(new Date(only.createdAt).getTime() + 1_000),
        authorUserId: "local-board",
      },
      { userId: "local-board" },
    );

    expect(expired).toHaveLength(0);
    expect((await statusOf(only.id))?.status).toBe("pending");
  });

  /**
   * Case 2 — the cross-issue link (finding 3). The 188-device ask lives on a different issue from
   * the one its author is working; every same-issue mechanism is structurally blind to it.
   */
  it("case 2: an explicit cross-issue link expires the target with a pointer to its replacement", async () => {
    const { companyId, goalId } = await seedCompany("Cross issue co");
    const issueA = await seedIssue(companyId, goalId, "Issue A (working here)");
    const issueB = await seedIssue(companyId, goalId, "Issue B (stale ask lives here)");
    const author = await seedAgent(companyId, "Author");

    const staleOnB = await interactionsSvc.create({ id: issueB, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 188 devices"),
    }, { agentId: author });

    const replacementOnA = await interactionsSvc.create({ id: issueA, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 193 devices", [staleOnB.id]),
    }, { agentId: author });

    expect(replacementOnA.status).toBe("pending");

    const target = await statusOf(staleOnB.id);
    expect(target?.status).toBe("expired");
    expect(target?.result).toMatchObject({
      version: 1,
      outcome: "superseded_by_interaction",
      supersededByInteractionId: replacementOnA.id,
    });
    expect(target?.resolvedByAgentId).toBe(author);
  });

  /**
   * Case 3 — company isolation. Supersession resolves ids within the actor's company only; a
   * foreign id must fail the create outright and mutate nothing on either side.
   */
  it("case 3: a cross-company supersede attempt is rejected with 422 and mutates nothing", async () => {
    const home = await seedCompany("Home co");
    const foreign = await seedCompany("Foreign co");
    const homeIssue = await seedIssue(home.companyId, home.goalId, "Home issue");
    const foreignIssue = await seedIssue(foreign.companyId, foreign.goalId, "Foreign issue");
    const homeAgent = await seedAgent(home.companyId, "Home agent");
    const foreignAgent = await seedAgent(foreign.companyId, "Foreign agent");

    const foreignAsk = await interactionsSvc.create({ id: foreignIssue, companyId: foreign.companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Foreign company ask"),
    }, { agentId: foreignAgent });

    await expect(interactionsSvc.create({ id: homeIssue, companyId: home.companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Home ask", [foreignAsk.id]),
    }, { agentId: homeAgent })).rejects.toMatchObject({ status: 422 });

    expect((await statusOf(foreignAsk.id))?.status).toBe("pending");
    const homeRows = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, homeIssue));
    expect(homeRows).toHaveLength(0);
  });

  /**
   * Case 4 — ownership, not a role grant. Supersession may never be used to silently retire the
   * board's question or a peer agent's ask.
   */
  it("case 4: superseding another agent's interaction is rejected with 422 and mutates nothing", async () => {
    const { companyId, goalId } = await seedCompany("Ownership co");
    const issueId = await seedIssue(companyId, goalId, "Ownership issue");
    const owner = await seedAgent(companyId, "Owner");
    const intruder = await seedAgent(companyId, "Intruder");

    const ownersAsk = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Owner's ask"),
    }, { agentId: owner });

    await expect(interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Intruder's ask", [ownersAsk.id]),
    }, { agentId: intruder })).rejects.toMatchObject({ status: 422 });

    expect((await statusOf(ownersAsk.id))?.status).toBe("pending");
    const rows = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ownersAsk.id);
  });

  /**
   * Case 5 — company-scoped withdraw. The author must be able to retire its own stale ask on an
   * issue it is not assigned to and is not currently addressing, without asking a human in prose.
   */
  it("case 5: the author can withdraw its own ask on another issue via the company-scoped path", async () => {
    const { companyId, goalId } = await seedCompany("Withdraw co");
    const otherAgent = await seedAgent(companyId, "Other agent");
    const author = await seedAgent(companyId, "Author");
    // The author is not the assignee of the issue the stale ask lives on: authorization here is
    // ownership, never issue membership.
    const issueB = await seedIssue(companyId, goalId, "Issue B", otherAgent);

    const staleOnB = await interactionsSvc.create({ id: issueB, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Delete 188 devices"),
    }, { agentId: author });

    const withdrawn = await interactionsSvc.withdrawCompanyInteraction(
      { companyId },
      staleOnB.id,
      { reason: "Superseded by the 193-device plan" },
      { agentId: author },
    );

    expect(withdrawn).toMatchObject({
      id: staleOnB.id,
      status: "cancelled",
      result: {
        version: 1,
        outcome: "withdrawn",
        reason: "Superseded by the 193-device plan",
      },
    });
    expect((await statusOf(staleOnB.id))?.status).toBe("cancelled");
  });

  it("case 5b: the company-scoped withdraw never reaches another company's interaction", async () => {
    const home = await seedCompany("Withdraw home co");
    const foreign = await seedCompany("Withdraw foreign co");
    const foreignIssue = await seedIssue(foreign.companyId, foreign.goalId, "Foreign issue");
    const foreignAgent = await seedAgent(foreign.companyId, "Foreign agent");

    const foreignAsk = await interactionsSvc.create({ id: foreignIssue, companyId: foreign.companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Foreign ask"),
    }, { agentId: foreignAgent });

    await expect(interactionsSvc.withdrawCompanyInteraction(
      { companyId: home.companyId },
      foreignAsk.id,
      {},
      { agentId: foreignAgent },
    )).rejects.toMatchObject({ status: 404 });

    expect((await statusOf(foreignAsk.id))?.status).toBe("pending");
  });

  it("case 5c: a resolved interaction cannot be withdrawn twice", async () => {
    const { companyId, goalId } = await seedCompany("Withdraw idempotence co");
    const issueId = await seedIssue(companyId, goalId, "Issue");
    const author = await seedAgent(companyId, "Author");

    const ask = await interactionsSvc.create({ id: issueId, companyId }, {
      kind: "request_confirmation",
      payload: confirmationPayload("Ask"),
    }, { agentId: author });

    await interactionsSvc.withdrawCompanyInteraction({ companyId }, ask.id, {}, { agentId: author });
    await expect(interactionsSvc.withdrawCompanyInteraction(
      { companyId },
      ask.id,
      {},
      { agentId: author },
    )).rejects.toMatchObject({ status: 409 });
  });

  /**
   * Case 6 — RBR-893 AC3, loud contradiction detection.
   *
   * The create-time sweep is scoped to same-issue + same-kind + same-agent, so a peer agent's
   * confirmation survives a new one (correctly — no agent may destroy another's ask). AC3 is about
   * that survivor no longer being *silent*: RBR-730 accumulated three pending confirmations for
   * the same irreversible mass deletion with nothing anywhere flagging the contradiction.
   *
   * These cases pin the two halves separately: selection (pure, exact) and the create integration
   * (warns, and critically expires nothing).
   */
  describe("case 6: RBR-893 AC3 loud contradiction detection", () => {
    it("warns and expires nothing when a peer agent's confirmation is already pending", async () => {
      const { companyId, goalId } = await seedCompany("Contradiction co");
      const issueId = await seedIssue(companyId, goalId, "Mass deletion");
      const ciso = await seedAgent(companyId, "CISO");
      const cto = await seedAgent(companyId, "CTO");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const peerAsk = await interactionsSvc.create({ id: issueId, companyId }, {
          kind: "request_confirmation",
          payload: confirmationPayload("Delete 188 devices"),
        }, { agentId: ciso });

        const newAsk = await interactionsSvc.create({ id: issueId, companyId }, {
          kind: "request_confirmation",
          payload: confirmationPayload("Delete 193 devices"),
        }, { agentId: cto });

        // The safety property: detection is an alarm, never a deletion primitive over a peer.
        expect((await statusOf(peerAsk.id))?.status).toBe("pending");
        expect((await statusOf(newAsk.id))?.status).toBe("pending");

        const contradictionWarning = warn.mock.calls
          .map((call) => String(call[0]))
          .find((message) => message.includes("RBR-893"));
        expect(contradictionWarning).toBeDefined();
        expect(contradictionWarning).toContain(peerAsk.id);
        expect(contradictionWarning).toContain(newAsk.id);
      } finally {
        warn.mockRestore();
      }
    });

    it("stays quiet when the new confirmation explicitly supersedes the only pending one", async () => {
      const { companyId, goalId } = await seedCompany("Clean supersede co");
      const issueId = await seedIssue(companyId, goalId, "Mass deletion");
      const author = await seedAgent(companyId, "Author");

      const stale = await interactionsSvc.create({ id: issueId, companyId }, {
        kind: "request_confirmation",
        payload: confirmationPayload("Delete 188 devices"),
      }, { agentId: author });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const replacement = await interactionsSvc.create({ id: issueId, companyId }, {
          kind: "request_confirmation",
          payload: confirmationPayload("Delete 193 devices", [stale.id]),
        }, { agentId: author });

        // The declared link retired the predecessor, so nothing coexists and nothing is flagged.
        expect((await statusOf(stale.id))?.status).toBe("expired");
        expect((await statusOf(replacement.id))?.status).toBe("pending");
        expect(
          warn.mock.calls.map((call) => String(call[0])).filter((message) => message.includes("RBR-893")),
        ).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it("selects only pending confirmation-like peers, never itself, answered rows, or questions", () => {
      const issueId = randomUUID();
      const row = (over: Record<string, unknown>) => ({
        id: randomUUID(),
        issueId,
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: randomUUID(),
        ...over,
      } as never);

      const created = row({ kind: "request_confirmation" });
      const peerConfirmation = row({});
      const peerCheckbox = row({ kind: "request_checkbox_confirmation" });
      const question = row({ kind: "ask_user_questions" });
      const answered = row({ status: "accepted" });

      const selected = selectContradictoryPendingConfirmations(
        created,
        [created, peerConfirmation, peerCheckbox, question, answered],
      );

      expect(selected.map((entry) => entry.id).sort()).toEqual(
        [peerConfirmation.id, peerCheckbox.id].sort(),
      );
    });

    it("returns nothing for a non-confirmation kind, so questions never trip the alarm", () => {
      const issueId = randomUUID();
      const created = { id: randomUUID(), issueId, kind: "ask_user_questions" } as never;
      const pendingConfirmation = {
        id: randomUUID(),
        issueId,
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: randomUUID(),
      } as never;

      expect(selectContradictoryPendingConfirmations(created, [pendingConfirmation])).toEqual([]);
    });
  });
});
