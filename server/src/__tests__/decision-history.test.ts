import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, approvals, budgetIncidents, budgetPolicies, companies, createDb, decisions, decisionTargetIssues, heartbeatRuns, issueApprovals, issues, issueThreadInteractions, projects } from "@paperclipai/db";
import { approvalHistoryAction, decisionHistoryAction, decisionHistoryService, decodeDecisionHistoryCursor, decisionHistoryHref, decisionHistoryTarget, interactionHistoryAction, itemVerdictsHistoryLabel } from "../services/decision-history.js";
import { documentService } from "../services/documents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

describe("decision receipt navigation", () => {
  it("preserves all verdict outcomes in a mixed review summary", () => {
    expect(itemVerdictsHistoryLabel({ outcome: "resolved", items: [{ verdict: "approve" }, { verdict: "reject" }, { verdict: "defer" }] }))
      .toBe("1 approved · 1 rejected · 1 deferred");
    expect(itemVerdictsHistoryLabel({ outcome: "resolved", items: [{ verdict: "reject" }] })).toBe("1 rejected");
    expect(itemVerdictsHistoryLabel({ outcome: "cancelled", items: [{ verdict: "approve" }] })).toBeNull();
  });
  it("pins the reviewed document and interaction and ignores arbitrary custom URLs", () => {
    const target = decisionHistoryTarget({ target: { type: "issue_document", key: "launch copy", revisionId: "old-revision", href: "https://untrusted.example" } });
    expect(decisionHistoryHref("PAP", "PAP-1", "issue_thread_interaction", "interaction", target)).toBe("/PAP/issues/PAP-1#document-launch%20copy&revision=old-revision&interaction=interaction");
    expect(decisionHistoryTarget({ target: { type: "custom", href: "javascript:alert(1)" } })).toBeNull();
  });
  it("rejects malformed or incompatible pagination cursors", () => {
    expect(() => decodeDecisionHistoryCursor("nope", "newest")).toThrow("Invalid decision history cursor");
    expect(() => decodeDecisionHistoryCursor(Buffer.from(JSON.stringify({ at: "today", id: "x", sort: "oldest" })).toString("base64url"), "newest")).toThrow();
  });
  it("names each action with the receipt's verb (PAP-767)", () => {
    const by = { resolvedByUserId: "scott" };
    expect(interactionHistoryAction({ ...by, kind: "request_confirmation", status: "accepted", result: { outcome: "accepted" } })).toEqual({ outcome: "approved", detail: null });
    expect(interactionHistoryAction({ ...by, kind: "request_confirmation", status: "rejected", result: { outcome: "rejected" } })).toEqual({ outcome: "changes_requested", detail: null });
    expect(interactionHistoryAction({ ...by, kind: "ask_user_questions", status: "answered", result: {} })).toEqual({ outcome: "answered", detail: null });
    expect(interactionHistoryAction({ ...by, kind: "request_item_verdicts", status: "answered", result: { outcome: "resolved", items: [{ verdict: "approve" }] } }))
      .toEqual({ outcome: "answered", detail: "1 approved" });
    expect(interactionHistoryAction({ ...by, kind: "ask_user_questions", status: "cancelled", result: { outcome: "withdrawn" } })).toEqual({ outcome: "withdrawn", detail: null });
    // Nobody acted on an expired or task-closed card, or the agent withdrew it.
    expect(interactionHistoryAction({ ...by, kind: "request_confirmation", status: "expired", result: { outcome: "issue_closed" } })).toBeNull();
    expect(interactionHistoryAction({ resolvedByUserId: null, kind: "ask_user_questions", status: "cancelled", result: { outcome: "withdrawn" } })).toBeNull();
    expect(approvalHistoryAction({ status: "approved", decidedByUserId: "scott", type: "request_board_approval" })).toEqual({ outcome: "approved", detail: null });
    expect(approvalHistoryAction({ status: "rejected", decidedByUserId: "dotta", type: "budget_override_required" })).toEqual({ outcome: "kept_paused", detail: null });
    expect(approvalHistoryAction({ status: "approved", decidedByUserId: "dotta", type: "budget_override_required" })).toEqual({ outcome: "limit_raised", detail: null });
    expect(approvalHistoryAction({ status: "cancelled", decidedByUserId: null, type: "budget_override_required" })).toBeNull();
    expect(decisionHistoryAction({ status: "decided", resolvedByUserId: "scott", chosenLabel: "Ship it" })).toEqual({ outcome: "decided", detail: "Ship it" });
  });
  it("preserves the owning task while the receipt points to its origin interaction", () => {
    const target = decisionHistoryTarget({ target: { type: "issue_document", issueId: "task-b", key: "plan", revisionId: "b-v1" } });
    expect(target).toEqual({ kind: "issue_document", issueId: "task-b", key: "plan", revisionId: "b-v1" });
    expect(decisionHistoryHref("PAP", "PAP-A", "issue_thread_interaction", "review-a", target)).toBe("/PAP/issues/PAP-A#document-plan&revision=b-v1&interaction=review-a&documentIssue=task-b");
  });
});

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("canonical decision history database projection", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!externalUrl) temp = await startEmbeddedPostgresTestDatabase("paperclip-decision-history-");
    db = createDb(externalUrl ?? temp!.connectionString);
    if (externalUrl) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }, 30_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (externalUrl && db) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db?.$client.end({ timeout: 1 });
    await temp?.cleanup();
  });

  it("projects mixed review verdicts into history instead of generic answers", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review history", issuePrefix: "VRD" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reviewed outputs" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_item_verdicts", status: "answered",
      resolvedAt: new Date(), resolvedByUserId: "reviewer", payload: { version: 1, prompt: "Review outputs", items: [] },
      result: { version: 1, outcome: "resolved", complete: true, items: [
        { id: "copy", verdict: "approve", resolvedAt: new Date().toISOString() },
        { id: "art", verdict: "reject", resolvedAt: new Date().toISOString() },
        { id: "extra", verdict: "defer", resolvedAt: new Date().toISOString() },
      ] } });
    const page = await decisionHistoryService(db).list(companyId, { actor: { type: "board", userId: "reviewer" }, userId: "reviewer" });
    expect(page.items[0]?.label).toBe("1 approved · 1 rejected · 1 deferred");
  });

  it("returns a cross-task document receipt whose exact revision belongs to the target, not the origin", async () => {
    const companyId = randomUUID(), originId = randomUUID(), documentOwnerId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cross-task review", issuePrefix: "XDR" });
    await db.insert(issues).values([
      { id: originId, companyId, identifier: "XDR-1", title: "Review in origin task" },
      { id: documentOwnerId, companyId, identifier: "XDR-2", title: "Document owning task" },
    ]);
    const documents = documentService(db);
    const reviewed = (await documents.upsertIssueDocument({ issueId: documentOwnerId, key: "plan", title: "Reviewed plan", body: "Approved v1 body", format: "markdown", createdByUserId: "reviewer" })).document;
    await documents.upsertIssueDocument({ issueId: documentOwnerId, key: "plan", title: "Later plan", body: "Later v2 body", format: "markdown", baseRevisionId: reviewed.latestRevisionId, createdByUserId: "reviewer" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId: originId, kind: "request_confirmation", status: "accepted", resolvedByUserId: "reviewer", resolvedAt: new Date(), payload: { version: 1, prompt: "Review the other task's plan", target: { type: "issue_document", issueId: documentOwnerId, documentId: reviewed.id, key: "plan", revisionId: reviewed.latestRevisionId } } });
    const page = await decisionHistoryService(db).list(companyId, { actor: { type: "board", userId: "reviewer" }, userId: "reviewer" });
    expect(page.items).toHaveLength(1);
    const receipt = page.items[0]!;
    expect(receipt.issueId).toBe(originId);
    expect(receipt.target).toMatchObject({ kind: "issue_document", issueId: documentOwnerId, revisionId: reviewed.latestRevisionId });
    expect(receipt.href).toBe(`/XDR/issues/XDR-1#document-plan&revision=${reviewed.latestRevisionId}&interaction=${interactionId}&documentIssue=${documentOwnerId}`);
    expect(await documents.getIssueDocumentRevision(originId, "plan", reviewed.latestRevisionId!)).toBeNull();
    expect((await documents.getIssueDocumentRevision(documentOwnerId, "plan", reviewed.latestRevisionId!))?.body).toBe("Approved v1 body");
  });

  it("filters item reviews by recorded verdicts before pagination and keeps mixed reviews in both outcomes", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Verdict filters", issuePrefix: "VFL" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review outputs" });
    for (const [title, verdicts] of [
      ["Approved outputs", ["approve", "approve"]], ["Rejected outputs", ["reject"]],
      ["Mixed outputs", ["approve", "reject", "defer"]], ["Deferred outputs", ["defer"]],
    ] as const) {
      await db.insert(issueThreadInteractions).values({ companyId, issueId, title,
        kind: "request_item_verdicts", status: "answered", resolvedAt: new Date(),
        payload: { version: 1, prompt: "Review", items: [] },
        result: { version: 1, outcome: "resolved", complete: true,
          items: verdicts.map((verdict, index) => ({ id: String(index), verdict, resolvedAt: new Date().toISOString() })) } });
    }
    await db.insert(issueThreadInteractions).values([
      { companyId, issueId, title: "Question answered", kind: "ask_user_questions", status: "answered", resolvedAt: new Date(), payload: { version: 1, questions: [] } },
      { companyId, issueId, title: "Confirmation approved", kind: "request_confirmation", status: "accepted", resolvedAt: new Date(), payload: { version: 1, prompt: "Approve?" } },
      { companyId, issueId, title: "Confirmation rejected", kind: "request_confirmation", status: "rejected", resolvedAt: new Date(), payload: { version: 1, prompt: "Approve?" } },
    ]);
    const service = decisionHistoryService(db);
    const options = { actor: { type: "board" as const, userId: "reviewer" }, userId: "reviewer" };
    for (const [outcome, titles] of [
      ["accepted", ["Approved outputs", "Mixed outputs", "Confirmation approved"]],
      ["rejected", ["Rejected outputs", "Mixed outputs", "Confirmation rejected"]],
      ["answered", ["Question answered"]],
    ] as const) {
      const found = []; let cursor: string | undefined;
      do {
        const page = await service.list(companyId, { ...options, outcome, limit: 1, cursor });
        found.push(...page.items.map(item => item.title));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(found)).toEqual(new Set(titles));
      expect(found).toHaveLength(titles.length);
    }
    expect((await service.list(companyId, options)).items).toHaveLength(7);
  });

  // PAP-749 task 2e: approvals in history; Withdrawn, Expired and Closed with task filters.
  it("adds approvals and keeps Withdrawn, Expired and Closed with task apart across every source", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), privateId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Approval history", issuePrefix: "APH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Requester", role: "engineer", adapterType: "codex_local" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Launch" });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "APH-1", title: "Launch plan", projectId },
      { id: privateId, companyId, identifier: "APH-2", title: "Private plan", visibility: "private", createdByUserId: "somebody-else" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    const at = (minutes: number) => new Date(Date.parse("2026-10-29T12:00:00.000Z") + minutes * 60_000);
    const approved = randomUUID(), withdrawn = randomUUID(), cancelled = randomUUID(), rejected = randomUUID(), pending = randomUUID(), hidden = randomUUID();
    await db.insert(approvals).values([
      { id: approved, companyId, type: "request_board_approval", status: "approved", requestedByAgentId: agentId, payload: { title: "Ship the launch" }, decidedByUserId: "scott", decidedAt: at(1) },
      { id: withdrawn, companyId, type: "approve_ceo_strategy", status: "cancelled", payload: { summary: "Old strategy" }, decisionNote: "Plan changed", decidedByUserId: "scott", decidedAt: at(2) },
      { id: cancelled, companyId, type: "budget_override_required", status: "cancelled", payload: {}, decidedAt: at(3) },
      { id: rejected, companyId, type: "request_board_approval", status: "rejected", payload: { title: "Raise the price" }, decisionNote: "No", decidedByUserId: "dotta", decidedAt: at(4) },
      { id: pending, companyId, type: "request_board_approval", status: "pending", payload: { title: "Still open" } },
      { id: hidden, companyId, type: "request_board_approval", status: "approved", payload: { title: "Private approval" }, decidedAt: at(5) },
    ]);
    await db.insert(issueApprovals).values([
      { companyId, issueId, approvalId: approved },
      { companyId, issueId: privateId, approvalId: hidden },
    ]);
    const expiredQ = randomUUID(), closedQ = randomUUID(), withdrawnQ = randomUUID();
    await db.insert(issueThreadInteractions).values([
      { id: expiredQ, companyId, issueId, kind: "request_confirmation", status: "expired", title: "Timed out", resolvedAt: at(6), payload: { version: 1, prompt: "?" }, result: { version: 1, outcome: "stale_target" } },
      { id: closedQ, companyId, issueId, kind: "request_confirmation", status: "expired", title: "Closed with task", resolvedAt: at(7), payload: { version: 1, prompt: "?" }, result: { version: 1, outcome: "issue_closed" } },
      { id: withdrawnQ, companyId, issueId, kind: "ask_user_questions", status: "cancelled", title: "Withdrawn question", resolvedAt: at(8), resolvedByUserId: "scott", payload: { version: 1, questions: [] }, result: { version: 1, outcome: "withdrawn", reason: "Out of date" } },
    ]);
    const decisionExpired = randomUUID(), decisionWithdrawn = randomUUID();
    const decisionBase = { companyId, originIssueId: issueId, originAgentId: agentId, originRunId: runId, body: "Choose", options: [{ id: "yes", label: "Yes", effects: [] }], expiresAt: at(0), signedSpec: "test", targetSnapshots: {} };
    await db.insert(decisions).values([
      { ...decisionBase, id: decisionExpired, title: "Expired decision", status: "expired", decidedAt: at(9) },
      { ...decisionBase, id: decisionWithdrawn, title: "Withdrawn decision", status: "cancelled", decidedAt: at(10), decidedByUserId: "scott", metadata: { cancelReason: "Not needed" } },
    ]);
    // Dotta's approval that Scott withdrew for her shows in her "Handled for me".
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "scott", action: "approval.cancelled", entityType: "approval", entityId: withdrawn,
      details: { handledForUserId: "dotta", receipt: { outcome: "withdrawn", sourceKind: "approval", sourceId: withdrawn, issueId: null, title: "Old strategy", actorUserId: "scott" } } });

    const service = decisionHistoryService(db);
    const options = { actor: { type: "board" as const, userId: "scott", ignoreInstanceAdmin: true, authorizingUserId: "scott" }, userId: "scott" };
    const ids = async (extra: Record<string, unknown> = {}) => (await service.list(companyId, { ...options, limit: 100, ...extra })).items.map((item) => item.sourceId);

    const all = await service.list(companyId, { ...options, limit: 100 });
    // Pending and private-task approvals stay out.
    expect(new Set(all.items.filter((item) => item.sourceKind === "approval").map((item) => item.sourceId))).toEqual(new Set([approved, withdrawn, cancelled, rejected]));
    const approvedItem = all.items.find((item) => item.sourceId === approved)!;
    expect(approvedItem).toMatchObject({ id: `approval:${approved}`, title: "Ship the launch", label: "Approved", outcome: "approved", resultOutcome: null,
      issueId, issueIdentifier: "APH-1", projectId, agentId, agentName: "Requester", resolvedByUserId: "scott", href: `/APH/approvals/${approved}` });
    expect(all.items.find((item) => item.sourceId === withdrawn)).toMatchObject({ title: "Old strategy", label: "Withdrawn by user", resultOutcome: "withdrawn",
      reason: "Plan changed", issueId: null, issueTitle: null });
    expect(all.items.find((item) => item.sourceId === cancelled)).toMatchObject({ title: "budget override required", label: "Cancelled", resultOutcome: null, reason: null });
    expect(all.items.find((item) => item.sourceId === rejected)).toMatchObject({ label: "Rejected", reason: null });
    expect(all.items.find((item) => item.sourceId === withdrawnQ)).toMatchObject({ resultOutcome: "withdrawn", reason: "Out of date" });
    expect(all.items.find((item) => item.sourceId === closedQ)).toMatchObject({ label: "Closed with task", resultOutcome: "issue_closed" });
    expect(all.items.find((item) => item.sourceId === decisionWithdrawn)).toMatchObject({ resultOutcome: "withdrawn", reason: "Not needed" });

    expect(new Set(await ids({ outcome: "withdrawn" }))).toEqual(new Set([withdrawn, withdrawnQ, decisionWithdrawn]));
    expect(new Set(await ids({ outcome: "expired" }))).toEqual(new Set([expiredQ, decisionExpired]));
    expect(await ids({ outcome: "issue_closed" })).toEqual([closedQ]);
    expect(new Set(await ids({ outcome: "accepted" }))).toEqual(new Set([approved]));
    expect(new Set(await ids({ outcome: "rejected" }))).toEqual(new Set([rejected]));
    expect(new Set(await ids({ outcome: "cancelled" }))).toEqual(new Set([withdrawn, cancelled, withdrawnQ, decisionWithdrawn]));
    expect(await ids({ outcome: "answered" })).toEqual([]);
    expect(await ids({ search: "launch" })).toEqual(expect.arrayContaining([approved]));
    expect(await ids({ search: "Old strategy" })).toEqual([withdrawn]);
    expect(new Set(await ids({ agentId }))).toEqual(new Set([approved, decisionExpired, decisionWithdrawn]));
    expect(await ids({ projectId })).toEqual(expect.arrayContaining([approved]));
    expect(await ids({ projectId })).not.toContain(withdrawn);
    expect(await ids({ issueIds: [issueId] })).toContain(approved);
    expect(await ids({ issueIds: [issueId] })).not.toContain(withdrawn);
    expect(await service.list(companyId, { ...options, userId: "dotta", limit: 100, handledForMe: true }).then((page) => page.items.map((item) => item.sourceId))).toEqual([withdrawn]);
    expect((await service.list(companyId, { ...options, limit: 100 })).items.find((item) => item.sourceId === withdrawn)?.handledForUserId).toBe("dotta");

    // One keyset cursor pages through all three sources without gaps.
    const paged: string[] = []; let cursor: string | undefined;
    do {
      const page = await service.list(companyId, { ...options, limit: 2, cursor });
      paged.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.items.map((item) => item.id));
  });

  it("shows Keep paused on a budget hard stop as kept paused by the actor, for the budget owner (PAP-767)", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), policyId = randomUUID(), incidentId = randomUUID(), approvalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget history", issuePrefix: "BDH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Spendy Agent", role: "engineer", adapterType: "codex_local" });
    await db.insert(budgetPolicies).values({ id: policyId, companyId, scopeType: "agent", scopeId: agentId, windowKind: "calendar_month_utc", amount: 10_000 });
    // `budgets.resolveIncident` rejects the approval as the person who kept it paused.
    await db.insert(approvals).values({ id: approvalId, companyId, type: "budget_override_required", status: "rejected",
      payload: { scopeName: "Spendy Agent" }, decidedByUserId: "dotta", decidedAt: new Date() });
    await db.insert(budgetIncidents).values({ id: incidentId, companyId, policyId, scopeType: "agent", scopeId: agentId, metric: "billed_cents",
      windowKind: "calendar_month_utc", windowStart: new Date("2026-11-01T00:00:00.000Z"), windowEnd: new Date("2026-12-01T00:00:00.000Z"),
      thresholdType: "hard", amountLimit: 10_000, amountObserved: 10_000, status: "dismissed", approvalId });
    // The receipt names the budget card (the incident), not its approval.
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "dotta", action: "budget.incident_resolved", entityType: "budget_incident", entityId: incidentId,
      details: { action: "keep_paused", handledForUserId: "scott", receipt: { outcome: "kept_paused", sourceKind: "budget_alert", sourceId: incidentId, issueId: null, title: "Spendy Agent budget hard stop", actorUserId: "dotta" } } });

    const service = decisionHistoryService(db);
    const scott = { actor: { type: "board" as const, userId: "scott", ignoreInstanceAdmin: true, authorizingUserId: "scott" }, userId: "scott", limit: 100 };
    const handled = await service.list(companyId, { ...scott, handledForMe: true });
    expect(handled.items).toEqual([expect.objectContaining({ sourceKind: "approval", sourceId: approvalId, label: "Kept paused",
      action: { outcome: "kept_paused", detail: null }, resolvedByUserId: "dotta", handledForUserId: "scott" })]);
    // Dotta acted for Scott, so it is not in her own "Handled for me".
    expect((await service.list(companyId, { ...scott, userId: "dotta", handledForMe: true })).items).toEqual([]);
    expect((await service.list(companyId, scott)).items.find((item) => item.sourceId === approvalId)?.handledForUserId).toBe("scott");
  });

  // PAP-768: "Handled by me or for me" is the default history; Everyone is a scope.
  it("scopes history to what I handled, what was handled for me and cards whose audience is me", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Personal history", issuePrefix: "PHS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    const [scottTask, childTask, dottaTask, assignedTask, agentTask] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values([
      { id: scottTask, companyId, identifier: "PHS-1", title: "Scott: task you created", createdByUserId: "scott", originKind: "manual" },
      // Agent work under Scott's task is still his (the instigator walk).
      { id: childTask, companyId, identifier: "PHS-2", title: "Agent child", parentId: scottTask, createdByAgentId: agentId, originKind: "manual" },
      { id: dottaTask, companyId, identifier: "PHS-3", title: "Dotta's task", createdByUserId: "dotta", originKind: "manual" },
      // A human assignee comes before the instigator.
      { id: assignedTask, companyId, identifier: "PHS-4", title: "Dotta's task for Scott", createdByUserId: "dotta", assigneeUserId: "scott", originKind: "manual" },
      { id: agentTask, companyId, identifier: "PHS-5", title: "Routine work", createdByAgentId: agentId, originKind: "routine_execution" },
    ]);
    const at = (minutes: number) => new Date(Date.parse("2026-11-02T12:00:00.000Z") + minutes * 60_000);
    const payload = { version: 1 as const, prompt: "?" };
    const [answeredOwn, expiredOwn, expiredChild, answeredForDotta, forRiley, expiredAssigned, transferred, ownerless] =
      Array.from({ length: 8 }, () => randomUUID());
    await db.insert(issueThreadInteractions).values([
      { id: answeredOwn, companyId, issueId: scottTask, kind: "request_confirmation", status: "accepted", resolvedAt: at(1), resolvedByUserId: "scott", payload },
      { id: expiredOwn, companyId, issueId: scottTask, kind: "request_confirmation", status: "expired", resolvedAt: at(2), payload },
      { id: expiredChild, companyId, issueId: childTask, kind: "request_confirmation", status: "expired", resolvedAt: at(3), payload },
      { id: answeredForDotta, companyId, issueId: dottaTask, kind: "request_confirmation", status: "accepted", resolvedAt: at(4), resolvedByUserId: "scott", payload },
      // An explicit addressee wins over the task's person.
      { id: forRiley, companyId, issueId: scottTask, addresseeUserId: "riley", kind: "request_confirmation", status: "expired", resolvedAt: at(5), payload },
      { id: expiredAssigned, companyId, issueId: assignedTask, kind: "request_confirmation", status: "expired", resolvedAt: at(6), payload },
      { id: transferred, companyId, issueId: agentTask, addresseeUserId: "riley", kind: "request_confirmation", status: "accepted", resolvedAt: at(7), resolvedByUserId: "riley", payload },
      { id: ownerless, companyId, issueId: agentTask, kind: "request_confirmation", status: "expired", resolvedAt: at(8), payload },
    ]);
    // Scott moved Dotta's card to Riley; the receipt names him and her.
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "scott", action: "attention.transferred", entityType: "issue", entityId: agentTask,
      details: { handledForUserId: "dotta", receipt: { outcome: "transferred", sourceKind: "issue_thread_interaction", sourceId: transferred, issueId: agentTask, title: "Moved", actorUserId: "scott", transferredToUserId: "riley" } } });
    const [requestedByDotta, onScottTask, systemApproval] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(approvals).values([
      { id: requestedByDotta, companyId, type: "request_board_approval", status: "rejected", requestedByUserId: "dotta", payload: { title: "Dotta asks" }, decidedByUserId: "scott", decidedAt: at(9) },
      { id: onScottTask, companyId, type: "request_board_approval", status: "approved", requestedByAgentId: agentId, payload: { title: "On Scott's task" }, decidedByUserId: "riley", decidedAt: at(10) },
      { id: systemApproval, companyId, type: "approve_ceo_strategy", status: "approved", payload: { title: "Nobody's" }, decidedAt: at(11) },
    ]);
    await db.insert(issueApprovals).values({ companyId, issueId: scottTask, approvalId: onScottTask });
    const [decisionOnScottTask, decisionWithdrawnByDotta] = [randomUUID(), randomUUID()];
    const decisionBase = { companyId, originAgentId: agentId, originRunId: runId, body: "Choose", options: [{ id: "yes", label: "Yes", effects: [] }], expiresAt: at(0), signedSpec: "test", targetSnapshots: {} };
    await db.insert(decisions).values([
      { ...decisionBase, id: decisionOnScottTask, originIssueId: scottTask, title: "Scott's decision", status: "expired", decidedAt: at(12) },
      { ...decisionBase, id: decisionWithdrawnByDotta, originIssueId: agentTask, title: "Withdrawn by Dotta", status: "cancelled", decidedAt: at(13), decidedByUserId: "dotta" },
    ]);

    const service = decisionHistoryService(db);
    const ids = async (userId: string, extra: Record<string, unknown> = {}) => new Set((await service.list(companyId, {
      actor: { type: "board", userId, ignoreInstanceAdmin: true, authorizingUserId: userId }, userId, limit: 100, ...extra,
    })).items.map((item) => item.sourceId));
    expect(await ids("scott", { scope: "mine" })).toEqual(new Set([answeredOwn, expiredOwn, expiredChild, answeredForDotta, expiredAssigned, transferred,
      requestedByDotta, onScottTask, decisionOnScottTask]));
    // Dotta no longer sees "PHS-1 · Scott: task you created", which Scott answered on his own task.
    expect(await ids("dotta", { scope: "mine" })).toEqual(new Set([answeredForDotta, transferred, requestedByDotta, decisionWithdrawnByDotta]));
    expect(await ids("riley", { scope: "mine" })).toEqual(new Set([forRiley, transferred, onScottTask]));
    // Everyone (and no scope, the API default) is every person's history.
    const everyone = await ids("dotta", { scope: "all" });
    expect(everyone).toEqual(await ids("dotta"));
    expect(everyone.size).toBe(13);
    expect(everyone.has(answeredOwn)).toBe(true);
    // Outcome filters and Handled for me keep working inside each scope.
    expect(await ids("scott", { scope: "mine", outcome: "expired" })).toEqual(new Set([expiredOwn, expiredChild, expiredAssigned, decisionOnScottTask]));
    expect(await ids("dotta", { scope: "mine", outcome: "expired" })).toEqual(new Set());
    expect(await ids("dotta", { scope: "all", outcome: "expired" })).toEqual(new Set([expiredOwn, expiredChild, forRiley, expiredAssigned, ownerless, decisionOnScottTask]));
    expect(await ids("dotta", { scope: "mine", handledForMe: true })).toEqual(new Set([transferred]));
    expect(await ids("dotta", { scope: "mine", outcome: "accepted" })).toEqual(new Set([answeredForDotta, transferred]));
    // One keyset cursor still pages through the scoped sources without gaps.
    const paged: string[] = []; let cursor: string | undefined;
    do {
      const page = await service.list(companyId, { actor: { type: "board", userId: "scott", ignoreInstanceAdmin: true, authorizingUserId: "scott" },
        userId: "scott", scope: "mine", limit: 2, cursor });
      paged.push(...page.items.map((item) => item.sourceId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(paged)).toEqual(await ids("scott", { scope: "mine" }));
    expect(paged).toHaveLength(9);
  });

  it("paginates both sources without losing answered questions; filters before limiting; isolates companies and private tasks", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), hiddenId = randomUUID(), otherIssueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "History", issuePrefix: "HIS" }, { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "HIS-1", title: "Launch copy" },
      { id: hiddenId, companyId, identifier: "HIS-2", title: "Private launch", visibility: "private", createdByUserId: "somebody-else" },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTH-1", title: "Other company" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    const at = new Date("2026-10-26T12:00:00.000Z");
    const copy = randomUUID(), visual = randomUUID(), question = randomUUID();
    await db.insert(issueThreadInteractions).values([
      { id: copy, companyId, issueId, kind: "request_confirmation", status: "accepted", title: "Copy approved", createdByAgentId: agentId, resolvedByUserId: "reviewer", resolvedAt: at, payload: { version: 1, prompt: "Approve?", target: { type: "issue_document", key: "copy", revisionId: randomUUID() } }, result: { version: 1, outcome: "accepted" } },
      { id: question, companyId, issueId, kind: "ask_user_questions", status: "answered", title: "Which channels?", resolvedAt: at, payload: { version: 1, questions: [] }, result: { version: 1, answers: [] } },
      { companyId, issueId: hiddenId, kind: "ask_user_questions", status: "answered", title: "Secret", resolvedAt: at, payload: { version: 1, questions: [] } },
      { companyId: otherCompanyId, issueId: otherIssueId, kind: "ask_user_questions", status: "answered", title: "Other secret", resolvedAt: at, payload: { version: 1, questions: [] } },
    ]);
    await db.insert(decisions).values({ id: visual, companyId, originIssueId: issueId, originAgentId: agentId, originRunId: runId, title: "Visual review", body: "Choose", options: [{ id: "yes", label: "Visual approved", effects: [] }], chosenOptionId: "yes", status: "decided", decidedAt: at, expiresAt: at, decidedByUserId: "reviewer", signedSpec: "test", targetSnapshots: {} });
    // PostgreSQL now() can have more precision than the JSON Date cursor.
    await db.execute(sql`update ${issueThreadInteractions} set resolved_at = '2026-10-26T12:00:00.123456Z'::timestamptz where id = ${copy}`);
    await db.execute(sql`update ${issueThreadInteractions} set resolved_at = '2026-10-26T12:00:00.123789Z'::timestamptz where id = ${question}`);
    const service = decisionHistoryService(db);
    const options = { actor: { type: "board" as const, userId: "reviewer", ignoreInstanceAdmin: true, authorizingUserId: "reviewer" }, userId: "reviewer", limit: 1 };
    const result = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(companyId, { ...options, cursor });
      result.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(result.map((item) => item.sourceId))).toEqual(new Set([copy, visual, question]));
    expect(result).toHaveLength(3);
    expect(result.find((item) => item.sourceId === question)?.label).toBe("Answers recorded");
    const filtered = await service.list(companyId, { ...options, search: "channels", sort: "oldest" });
    expect(filtered.items.map((item) => item.sourceId)).toEqual([question]);
    expect((await service.list(companyId, { ...options, limit: 100, since: "2026-10-26T12:00:00.100Z" })).items).toHaveLength(2);
    expect((await service.list(companyId, { ...options, issueIds: [] })).items).toEqual([]);
    // A visible origin does not grant access to a private Decision-v1 target.
    await db.insert(decisionTargetIssues).values({ companyId, decisionId: visual, issueId: hiddenId });
    const secured = await service.list(companyId, { ...options, limit: 100 });
    expect(secured.items.map((item) => item.sourceId)).not.toContain(visual);
  });
});
