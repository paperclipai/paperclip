/**
 * scripts/seed-needs-you-demo.ts
 *
 * Needs You demo seed for PAP-749 ("Plan fixes for Needs You"), task 0 (PAP-752),
 * plan section 7. It builds one synthetic demo company with three human board
 * members and every "Needs You" / attention card group listed in the plan's
 * section 7 table, so the multi-user authenticated preview can exercise the full
 * flow end to end.
 *
 * Design rules (from AGENTS.md + the plan):
 *  - Uses the server services (not raw SQL) wherever a service exists; a few
 *    attention sources have no public create service (failed runs, agent error,
 *    join requests, escalated recovery, closed history) and are written directly
 *    to their tables, matching how the product itself produces that state.
 *  - Re-runnable: it deletes and recreates ONLY the demo company and its three
 *    demo users. It never touches any other company.
 *  - Stale cases are backdated by updating the source rows' timestamps.
 *  - No product behavior changes here: this script lives under scripts/ and is
 *    never imported by the app.
 *
 * Run it against the preview's OWN database (never this instance's data):
 *   DATABASE_URL=postgres://... \
 *     pnpm --filter @paperclipai/server exec tsx ../scripts/seed-needs-you-demo.ts
 *
 * Logins: the three demo users share one password, the DEMO_PASSWORD constant
 * below (override with SEED_DEMO_PASSWORD). Emails are listed in DEMO_USERS.
 *
 * Current cards (PAP-749 task 2a): archived/snoozed cards store the card's
 * `changeFingerprint`, read from the live feed exactly as the UI sends it, so
 * they return only on an important change. The pending cards on the done and
 * cancelled tasks are expired by the closed-task sweep at the next server
 * start; the approval on a done task stays (approvals are never auto-closed)
 * and shows the "Task closed" stale reason.
 *
 * Default decision owner (PAP-749 task 1d-lite): set SEED_DEFAULT_DECISION_OWNER
 * to a demo user key (scott|dotta|riley) to configure the company's default
 * decision owner. When set, the Unassigned-group cards route to that user's
 * "For you" list; when unset (the default) they stay in Unassigned. Re-run the
 * seed with and without it to compare the two behaviors.
 *
 * Views and Claim (PAP-749 task 1b): one ownerless card is already claimed by
 * Dotta through the claim service, with the same `attention.claimed` activity
 * entry the claim route writes. It shows in Dotta's "For you" as "Sent to you"
 * and in nobody's Unassigned pool.
 *
 * Close API (PAP-749 task 2b): the "Closed history" group holds an interaction
 * Dotta withdrew, a decision Scott withdrew and an approval Scott withdrew, made
 * through the same services the close endpoint calls, with matching
 * `attention.closed` entries. Riley still starts with no cards, so "transfer a
 * card to Riley" is a live step in the checklist.
 *
 * Receipts (PAP-749 task 2f): Dotta's For you opens with three receipts, made
 * the way the routes make them (the card's audience is read before the action
 * and written as `handledForUserId` + `receipt` on the activity entry): Scott
 * answered a confirmation on her task, withdrew her question with a reason
 * (the task shows unread in her Mine), and approved the approval she
 * requested. Transfer stays a live step, so Riley still starts with no cards.
 *
 * Archived view and history filters (PAP-749 task 2e): Scott's Archived tab
 * holds the archived cards (one of them also stale, 40 days without a change)
 * and, in its Snoozed group, the card snoozed until tomorrow. Decision history
 * now includes approvals: Dotta's approval Scott approved, the approval Scott
 * withdrew, and a strategy approval with no task that Scott rejected. The
 * Withdrawn, Expired and Closed with task filters each match their own rows;
 * the closed-with-task card is stored as `expired` like the product stores it,
 * and the Expired filter leaves it out.
 *
 * One card for each obligation (PAP-749 task 2d): Scott's For you shows the
 * approval with its in-review task as one card, and the failed run with the
 * task it blocked (blocked by exhausted retries, board-owned next action) as
 * one card with Retry; the run moves from Company to Scott with the task. A
 * task with a configured human review stage plus an approval stays two cards,
 * because the review is an independent quality gate.
 *
 * Project and budget escalation owners (PAP-749 task 1d): the "Platform"
 * project names Dotta as its decision owner, so its ownerless card goes to
 * Dotta's "For you" ("You own this project's decisions") before the company's
 * default decision owner. Scott is the budget owner, so the budget hard stop is
 * also in Scott's "For you" ("You own budget escalation", with Raise limit /
 * Keep paused) while every person's Company view still shows it; the 90%
 * warning stays in Company only. Toggle with SEED_PROJECT_DECISION_OWNER and
 * SEED_BUDGET_OWNER (scott|dotta|riley|none). Riley still starts with no cards.
 */
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  createDb,
  authUsers,
  authAccounts,
  authSessions,
  instanceUserRoles,
  companyMemberships,
  inboxDismissals,
  heartbeatRuns,
  heartbeatRunEvents,
  invites,
  joinRequests,
  issueRecoveryActions,
  issueThreadInteractions,
  decisions,
  decisionTargetIssues,
  issueApprovals,
  agents,
  approvals as approvalsTable,
  projects,
  issues as issuesTable,
  companies as companiesTable,
} from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { companyService } from "../server/src/services/companies.js";
import { accessService } from "../server/src/services/access.js";
import { issueService } from "../server/src/services/issues.js";
import { issueThreadInteractionService } from "../server/src/services/issue-thread-interactions.js";
import { documentService } from "../server/src/services/documents.js";
import { approvalService } from "../server/src/services/approvals.js";
import { decisionService } from "../server/src/services/decisions.js";
import { budgetService, flushBudgetEvaluationWork } from "../server/src/services/budgets.js";
import { costService } from "../server/src/services/costs.js";
import { issueRecoveryActionService } from "../server/src/services/issue-recovery-actions.js";
import { inboxDismissalService } from "../server/src/services/inbox-dismissals.js";
import { attentionService } from "../server/src/services/attention.js";
import { attentionHandledDetails, attentionHandledFor } from "../server/src/services/attention-receipts.js";
import { logActivity } from "../server/src/services/activity-log.js";
import { createAgentLifecycle } from "../server/src/services/agent-lifecycle.js";

// drizzle-orm and better-auth are server-package dependencies; from a repo-root
// script they only resolve through the server package's require graph.
const serverRequire = createRequire(new URL("../server/package.json", import.meta.url));
const { eq, and, inArray, ne } = serverRequire("drizzle-orm") as typeof import("drizzle-orm");
const { hashPassword } = (await import(
  pathToFileURL(serverRequire.resolve("better-auth/crypto")).href
)) as { hashPassword: (password: string) => Promise<string> };

type Db = ReturnType<typeof createDb>;

const DEMO_COMPANY_NAME = "Needs You Demo";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "needs-you-demo-2026";

const DEMO_USERS = [
  { key: "scott", name: "Scott", email: "scott@needs-you-demo.test", role: "owner" },
  { key: "dotta", name: "Dotta", email: "dotta@needs-you-demo.test", role: "admin" },
  { key: "riley", name: "Riley", email: "riley@needs-you-demo.test", role: "admin" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => new Date();
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const config = loadConfig();
  if (config.databaseUrl) return config.databaseUrl;
  return `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
}

async function main() {
  const url = resolveDatabaseUrl();
  const db: Db = createDb(url);
  console.log(`[seed] database: ${url.replace(/:[^:@/]*@/, ":***@")}`);

  await teardown(db);
  const summary = await seed(db);

  console.log("\n[seed] done. Demo company is ready.");
  console.log(`[seed] company: ${summary.companyName} (${summary.companyId}) prefix ${summary.prefix}`);
  console.log("[seed] users (shared password in DEMO_PASSWORD / SEED_DEMO_PASSWORD):");
  for (const u of summary.users) console.log(`         - ${u.name} <${u.email}> [${u.role}]`);
  console.log(`[seed] cards created: ${summary.cardCount} (see group breakdown above)`);
  console.log(
    `[seed] default decision owner: ${summary.defaultDecisionOwner ?? "cleared (Unassigned)"} — toggle with SEED_DEFAULT_DECISION_OWNER`,
  );
  console.log(
    `[seed] budget owner: ${summary.budgetOwner ?? "cleared (Company only)"} — toggle with SEED_BUDGET_OWNER`,
  );
  console.log(
    `[seed] Platform project decision owner: ${summary.projectDecisionOwner ?? "cleared"} — toggle with SEED_PROJECT_DECISION_OWNER`,
  );
  await (db as unknown as { $client: { end: (o?: { timeout?: number }) => Promise<void> } }).$client.end({ timeout: 5 });
  process.exit(0);
}

async function teardown(db: Db) {
  console.log("[seed] teardown: removing any existing demo company + users...");
  const existing = await db
    .select({ id: companiesTable.id })
    .from(companiesTable)
    .where(eq(companiesTable.name, DEMO_COMPANY_NAME));
  for (const company of existing) {
    // company-deletion.ts does not delete these tables, and decisions.origin_run_id
    // keeps a FK onto heartbeat_runs that blocks the standard delete. Remove the
    // demo rows first (interactions/approvals/recovery also cascade from issues,
    // but deleting them here keeps teardown independent of that ordering).
    await db.delete(decisionTargetIssues).where(eq(decisionTargetIssues.companyId, company.id));
    await db.delete(decisions).where(eq(decisions.companyId, company.id));
    await db.delete(inboxDismissals).where(eq(inboxDismissals.companyId, company.id));
    await db.delete(issueApprovals).where(eq(issueApprovals.companyId, company.id));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, company.id));
    await db.delete(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, company.id));
    // company-deletion refuses to purge agents that are not terminated/rejected.
    await db.update(agents).set({ lifecycleState: "terminated", updatedAt: now() }).where(eq(agents.companyId, company.id));
    await companyService(db).remove(company.id);
    console.log(`[seed]   removed company ${company.id}`);
  }

  const emails = DEMO_USERS.map((u) => u.email);
  const demoUserRows = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(inArray(authUsers.email, emails));
  const demoUserIds = demoUserRows.map((r) => r.id);
  if (demoUserIds.length > 0) {
    await db.delete(companyMemberships).where(inArray(companyMemberships.principalId, demoUserIds));
    await db.delete(instanceUserRoles).where(inArray(instanceUserRoles.userId, demoUserIds));
    await db.delete(inboxDismissals).where(inArray(inboxDismissals.userId, demoUserIds));
    await db.delete(authSessions).where(inArray(authSessions.userId, demoUserIds));
    await db.delete(authAccounts).where(inArray(authAccounts.userId, demoUserIds));
    await db.delete(authUsers).where(inArray(authUsers.id, demoUserIds));
    console.log(`[seed]   removed ${demoUserIds.length} demo user(s)`);
  }
}

async function seed(db: Db) {
  const access = accessService(db);
  const interactions = issueThreadInteractionService(db);
  const approvalSvc = approvalService(db);
  const decisionsSvc = decisionService(db, { wakeOriginAgent: async () => {} });
  const issuesSvc = issueService(db);
  const recoverySvc = issueRecoveryActionService(db);
  const dismissals = inboxDismissalService(db);

  let cardCount = 0;
  const card = (group: string, note: string) => {
    cardCount += 1;
    console.log(`[seed]   + [${group}] ${note}`);
  };

  // --- company -------------------------------------------------------------
  const company = await companyService(db).create({
    name: DEMO_COMPANY_NAME,
    description: "Synthetic demo for the Needs You multiplayer + stale-card plan (PAP-749).",
    status: "active",
    budgetMonthlyCents: 500_00,
  });
  const companyId = company.id;
  console.log(`[seed] created company ${companyId} (prefix ${company.issuePrefix})`);

  // --- users ---------------------------------------------------------------
  const userIds: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const id = randomUUID();
    const ts = now();
    await db.insert(authUsers).values({
      id,
      name: u.name,
      email: u.email,
      emailVerified: true,
      image: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await db.insert(authAccounts).values({
      id: randomUUID(),
      issuer: "local:credential",
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await hashPassword(DEMO_PASSWORD),
      createdAt: ts,
      updatedAt: ts,
    });
    if (u.role === "owner") {
      await db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" }).onConflictDoNothing();
    }
    await access.ensureMembership(companyId, "user", id, u.role, "active");
    await access.ensureRoleDefaultGrants(companyId, id, u.role, id);
    userIds[u.key] = id;
    console.log(`[seed] created user ${u.name} <${u.email}> [${u.role}] ${id}`);
  }
  const scott = userIds.scott!;
  const dotta = userIds.dotta!;
  const riley = userIds.riley!;

  // --- default decision owner (PAP-749 task 1d-lite) -----------------------
  // Toggle for the reviewer: SEED_DEFAULT_DECISION_OWNER accepts a demo user key
  // (scott|dotta|riley) to route ownerless cards to that person's "For you"
  // list; anything else (or unset / "none") leaves it cleared, so ownerless
  // cards stay in the claimable Unassigned pool. Re-run the seed with and
  // without it to compare set vs cleared.
  const defaultDecisionOwnerKey = (process.env.SEED_DEFAULT_DECISION_OWNER ?? "").trim().toLowerCase();
  const defaultDecisionOwnerId =
    defaultDecisionOwnerKey && defaultDecisionOwnerKey !== "none" ? userIds[defaultDecisionOwnerKey] ?? null : null;
  if (defaultDecisionOwnerId) {
    await companyService(db).update(companyId, { defaultDecisionOwnerUserId: defaultDecisionOwnerId });
    console.log(`[seed] default decision owner: ${defaultDecisionOwnerKey} (${defaultDecisionOwnerId}) — ownerless cards route to this user's For you`);
  } else {
    console.log('[seed] default decision owner: cleared — ownerless cards go to Unassigned. Set SEED_DEFAULT_DECISION_OWNER=dotta to compare.');
  }

  // --- budget owner and project decision owner (PAP-749 task 1d) -----------
  // Defaults: Scott owns budget escalation and Dotta owns the Platform
  // project's decisions. "none" clears either one, so the hard stop stays in
  // Company only and the Platform card falls back to the default decision
  // owner or Unassigned.
  const ownerFromEnv = (name: string, fallback: string) => {
    const key = (process.env[name] ?? fallback).trim().toLowerCase();
    return { key, id: key && key !== "none" ? userIds[key] ?? null : null };
  };
  const budgetOwner = ownerFromEnv("SEED_BUDGET_OWNER", "scott");
  const projectDecisionOwner = ownerFromEnv("SEED_PROJECT_DECISION_OWNER", "dotta");
  if (budgetOwner.id) {
    await companyService(db).update(companyId, { budgetOwnerUserId: budgetOwner.id });
    console.log(`[seed] budget owner: ${budgetOwner.key} (${budgetOwner.id}) — the budget hard stop is also in this user's For you`);
  } else {
    console.log("[seed] budget owner: cleared — the budget hard stop is in Company only");
  }

  // --- agents --------------------------------------------------------------
  const hire = (name: string, role: string, extra: Record<string, unknown> = {}) =>
    createAgentLifecycle(db).requestHire(companyId, {
      name,
      role,
      title: name,
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo", args: [name] },
      budgetMonthlyCents: 100_00,
      ...extra,
    });

  const worker = await hire("Dottabot", "engineer");
  const pausedAgent = await hire("Napping Agent", "engineer");
  const failingAgent = await hire("Flaky Runner", "engineer");
  const erroredAgent = await hire("Broken Agent", "engineer");
  const hardStopAgent = await hire("Spendy Agent", "engineer");
  const warnAgent = await hire("Thrifty Agent", "engineer");

  // project for the demo issues
  const projectId = await createProject(db, companyId, worker!.id);

  // Helper: create an issue via the service. in_progress / in_review issues
  // require an assignee; default to the worker agent when none is specified.
  const makeIssue = async (input: Record<string, unknown>) => {
    const needsAssignee = input.status === "in_progress" || input.status === "in_review";
    const hasAssignee = Boolean(input.assigneeAgentId || input.assigneeUserId);
    const assigneeDefault = needsAssignee && !hasAssignee ? { assigneeAgentId: worker!.id } : {};
    const issue = await issuesSvc.create(companyId, { priority: "medium", projectId, ...assigneeDefault, ...input } as never);
    return issue as { id: string; title: string };
  };

  // Helper: create an interaction. Returns the created row (with id).
  const makeInteraction = async (
    issue: { id: string },
    kind: string,
    payload: Record<string, unknown>,
    opts: { title?: string; summary?: string; addresseeUserId?: string | null; actorUserId?: string; actorAgentId?: string } = {},
  ) => {
    const actor = opts.actorAgentId ? { agentId: opts.actorAgentId } : { userId: opts.actorUserId ?? scott };
    const created = await interactions.create(
      { id: issue.id, companyId },
      {
        kind,
        payload: { version: 1, ...payload },
        title: opts.title,
        summary: opts.summary,
        addresseeUserId: opts.addresseeUserId ?? null,
        idempotencyKey: `seed:${issue.id}:${kind}:${randomUUID()}`,
      } as never,
      actor as never,
    );
    return created as { id: string };
  };

  const reviewExecutionState = (userId: string) => ({
    status: "pending" as const,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: "review" as const,
    currentParticipant: { type: "user" as const, userId },
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  });

  // =========================================================================
  // GROUP: For you (Scott) — a question, a confirmation on a Scott task,
  //        a review where Scott is reviewer, an approval Scott requested.
  // =========================================================================
  for (const [who, userId] of [["Scott", scott], ["Dotta", dotta]] as const) {
    const qIssue = await makeIssue({ title: `${who}: question needing an answer`, status: "todo", createdByUserId: userId, responsibleUserId: userId });
    await makeInteraction(qIssue, "ask_user_questions", {
      questions: [{ id: "pick", prompt: `${who}, which option should we ship?`, selectionMode: "single", required: true, options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }] }],
    }, { title: `A question for ${who}`, addresseeUserId: userId });
    card(`For you / ${who}`, "ask_user_questions sent to the user");

    const cIssue = await makeIssue({ title: `${who}: task you created`, status: "in_progress", createdByUserId: userId, responsibleUserId: userId, assigneeAgentId: worker!.id });
    await makeInteraction(cIssue, "request_confirmation", { prompt: `${who}, confirm the plan for a task you created.` }, { title: `Confirm: ${who}'s task` });
    card(`For you / ${who}`, "request_confirmation on a task the user created (instigator)");

    const rIssue = await makeIssue({ title: `${who}: review the launch checklist`, status: "todo", createdByUserId: userId });
    await issuesSvc.update(rIssue.id, { status: "in_review", assigneeUserId: userId, responsibleUserId: userId, executionState: reviewExecutionState(userId) } as never);
    card(`For you / ${who}`, "review with the user as the execution participant");

    const aIssue = await makeIssue({ title: `${who}: spend approval`, status: "in_progress", createdByUserId: userId, responsibleUserId: userId });
    const approval = await approvalSvc.create(companyId, {
      type: "request_board_approval",
      status: "pending",
      requestedByUserId: userId,
      payload: { title: `Approve ${who}'s request`, summary: `Release demo budget for ${who}.` },
    } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: aIssue.id, approvalId: (approval as { id: string }).id });
    card(`For you / ${who}`, "request_board_approval requested by the user");
  }

  // A plan approval whose ask mentions a second document (PAP-775): the plan
  // and the mentioned design notes each open as a side-panel tab.
  {
    const docs = documentService(db);
    const planIssue = await makeIssue({ title: "Scott: approve the onboarding plan", status: "in_progress", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: worker!.id }) as { id: string; identifier?: string };
    const plan = await docs.upsertIssueDocument({ issueId: planIssue.id, key: "plan", title: "Onboarding plan", format: "markdown",
      body: "# Onboarding plan\n\n1. Send the welcome email on day one.\n2. Pair each new member with a buddy.\n3. Review progress after two weeks.", createdByAgentId: worker!.id });
    await docs.upsertIssueDocument({ issueId: planIssue.id, key: "design", title: "Design notes", format: "markdown",
      body: "# Design notes\n\nThe welcome email reuses the existing template. The buddy list comes from the team directory.", createdByAgentId: worker!.id });
    await makeInteraction(planIssue, "request_confirmation", {
      prompt: `Approve the onboarding plan? It follows the [design notes](/NEE/issues/${planIssue.identifier}#document-design).`,
      acceptLabel: "Approve plan", rejectLabel: "Request changes", rejectRequiresReason: true,
      target: { type: "issue_document", issueId: planIssue.id, key: "plan", revisionId: plan.document.latestRevisionId },
    }, { title: "Approve the onboarding plan", actorAgentId: worker!.id, addresseeUserId: scott });
    card("For you / Scott", "plan approval that mentions a second document");
  }

  // =========================================================================
  // GROUP: Card designs (PAP-775, Paper "A · Compact cards") — one card for
  //        each design the groups above don't already cover. Demo only:
  //        approving the tool or connection card runs nothing real.
  // =========================================================================
  {
    const docs = documentService(db);
    const emailIssue = await makeIssue({ title: "Welcome email", status: "in_review", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: worker!.id });
    const draft = await docs.upsertIssueDocument({ issueId: emailIssue.id, key: "email-draft", title: "Welcome to the team", format: "markdown",
      body: "# Welcome to the team\n\nHi {first name}, we're glad you're here. Your first step: say hello to your buddy.", createdByAgentId: worker!.id });
    await makeInteraction(emailIssue, "request_confirmation", {
      prompt: "A shorter intro and a clear first step, ready for the pilot. Approval marks the draft ready; sending is a separate decision.",
      acceptLabel: "Approve draft", rejectLabel: "Request changes",
      target: { type: "issue_document", issueId: emailIssue.id, key: "email-draft", revisionId: draft.document.latestRevisionId },
    }, { title: "Review the welcome email draft", actorAgentId: worker!.id, addresseeUserId: scott });
    card("Card designs / Scott", "deliverable review (a document that is not the plan)");

    const followUps = await makeIssue({ title: "Pilot follow-ups", status: "in_progress", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: worker!.id });
    await makeInteraction(followUps, "suggest_tasks", {
      tasks: [
        { clientKey: "email", title: "Write the welcome email", description: "Communications" },
        { clientKey: "buddy", title: "Create the buddy matching checklist", description: "Operations" },
        { clientKey: "survey", title: "Draft the two-week survey", description: "Research" },
      ],
    }, { title: "Choose tasks to create", summary: "Choose which follow-ups to create in the Onboarding project.", actorAgentId: worker!.id, addresseeUserId: scott });
    card("Card designs / Scott", "suggested tasks for Scott");

    const releaseIssue = await makeIssue({ title: "Publish pilot assets", status: "in_progress", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: worker!.id });
    await makeInteraction(releaseIssue, "request_confirmation", {
      prompt: "The agent needs the protected GitHub release tool and its saved credential.",
      toolAction: { version: 1, actionRequestId: randomUUID(), invocationId: randomUUID(), toolName: "github.create_release", toolDisplayName: "Create a release",
        connectionId: null, applicationId: null, appDisplayName: "GitHub", risk: "write", previewMarkdown: "acme/onboarding · Tag: pilot-v1",
        argumentsSummaryJson: JSON.stringify({ repo: "acme/onboarding", tag: "pilot-v1" }), argumentsHash: randomUUID(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    }, { title: "Allow the worker to publish the pilot release?", actorAgentId: worker!.id, addresseeUserId: scott });
    card("Card designs / Scott", "tool access approval");

    const sessionsIssue = await makeIssue({ title: "Schedule pilot sessions", status: "blocked", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: worker!.id });
    const connect = await makeInteraction(sessionsIssue, "request_confirmation", { prompt: "Connect Google Calendar" }, { title: "Connect Google Calendar", actorAgentId: worker!.id, addresseeUserId: scott });
    // Only the server authors a connection request, so write it as the server would.
    await db.update(issueThreadInteractions).set({ kind: "connection_intent",
      summary: "Connect an account to schedule the onboarding sessions. You'll sign in with Google and review the requested permissions.",
      payload: { version: 1, serviceSlug: "google-calendar", serviceName: "Google Calendar", requestingAgentId: worker!.id, requestingAgentName: "Dottabot", phase: "requested" } })
      .where(eq(issueThreadInteractions.id, connect.id));
    card("Card designs / Scott", "connect a service");

    await approvalSvc.create(companyId, {
      type: "hire_agent", status: "pending", requestedByAgentId: worker!.id,
      payload: { name: "Researcher", role: "researcher", title: "Research role", capabilities: "Prepare and summarize the onboarding interviews.", adapterType: "claude_local", budgetMonthlyCents: 5000 },
    } as never);
    card("Card designs / Company", "agent hire approval");
  }

  // =========================================================================
  // GROUP: Child-task lineage — a child of a Scott task, created by an agent,
  //        with a review for Scott.
  // =========================================================================
  const parentIssue = await makeIssue({ title: "Scott: parent initiative", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const childIssue = await makeIssue({ title: "Agent-built child task (review for Scott)", status: "todo", parentId: parentIssue.id, createdByAgentId: worker!.id });
  await issuesSvc.update(childIssue.id, { status: "in_review", assigneeUserId: scott, responsibleUserId: scott, executionState: reviewExecutionState(scott) } as never);
  card("Child-task lineage", "agent-created child of a Scott task, review routed to Scott");

  // =========================================================================
  // GROUP: Unassigned — routine/agent-created work with no addressee, plus a
  //        card for an agent that cannot run (paused).
  // =========================================================================
  const routineIssue = await makeIssue({ title: "Routine-created work (no human owner)", status: "todo", createdByAgentId: worker!.id, originKind: "routine" });
  await makeInteraction(routineIssue, "request_confirmation", { prompt: "Confirm the routine output. No explicit human owner." }, { title: "Ownerless: routine output", actorAgentId: worker!.id });
  card("Unassigned", "agent/routine-created confirmation with no addressee");

  const agentIssue = await makeIssue({ title: "Agent-created work (no addressee)", status: "todo", createdByAgentId: worker!.id });
  await makeInteraction(agentIssue, "suggest_tasks", { tasks: [{ clientKey: "s1", title: "Follow-up task suggested by an agent" }] }, { title: "Ownerless: suggested tasks", actorAgentId: worker!.id });
  card("Unassigned", "agent-created suggest_tasks with no addressee");

  const cannotRunIssue = await makeIssue({ title: "Request to an agent that cannot run", status: "in_progress", assigneeAgentId: worker!.id, createdByAgentId: worker!.id });
  const cannotRun = await makeInteraction(cannotRunIssue, "request_confirmation", { prompt: "Agent cannot run; a human must pick this up." }, { title: "Agent paused — needs a human", actorAgentId: worker!.id });
  // The create path refuses a non-invokable addressee, and the feed re-evaluates
  // invokability at read time, so set the (paused) agent addressee directly.
  await db.update(agents).set({ status: "paused", updatedAt: now() }).where(eq(agents.id, pausedAgent!.id));
  await db.update(issueThreadInteractions).set({ addresseeAgentId: pausedAgent!.id }).where(eq(issueThreadInteractions.id, cannotRun.id));
  card("Unassigned", "request addressed to a paused (non-invokable) agent");

  // Claimed (task 1b): an ownerless card Dotta took from Unassigned. The claim
  // makes Dotta the addressee, so it leaves every other person's pool.
  const claimedIssue = await makeIssue({ title: "Agent-created work Dotta claimed", status: "todo", createdByAgentId: worker!.id });
  const claimedCard = await makeInteraction(claimedIssue, "request_confirmation", { prompt: "Dotta claimed this from Unassigned." }, { title: "Claimed by Dotta", actorAgentId: worker!.id });
  const claim = await attentionService(db).claim(companyId, {
    sourceKind: "issue_thread_interaction", sourceId: claimedCard.id, userId: dotta, actor: await boardActorFor(db, companyId, dotta),
  });
  await logActivity(db, {
    companyId, actorType: "user", actorId: dotta, action: "attention.claimed", entityType: "issue", entityId: claim.issueId, issueId: claim.issueId,
    details: { sourceKind: claim.sourceKind, sourceId: claim.sourceId, interactionId: claim.sourceId, claimedByUserId: dotta, previousAddresseeAgentId: null },
  });
  card("Claimed", "ownerless card Dotta claimed (in Dotta's For you, not in Unassigned)");

  // =========================================================================
  // GROUP: Project owner (task 1d) — agent-created work with no human signal
  //        in a project that names a decision owner.
  // =========================================================================
  const platformProjectId = await createProject(db, companyId, worker!.id, {
    name: "Platform",
    description: "Its decision owner gets the project's ownerless cards.",
    decisionOwnerUserId: projectDecisionOwner.id,
  });
  const platformIssue = await issuesSvc.create(companyId, {
    title: "Agent-created Platform work (no addressee)", status: "todo", priority: "medium",
    projectId: platformProjectId, createdByAgentId: worker!.id,
  } as never) as { id: string };
  await makeInteraction(platformIssue, "request_confirmation", { prompt: "Confirm the Platform migration plan. No explicit human owner." }, {
    title: "Platform: confirm the migration plan", actorAgentId: worker!.id,
  });
  card(
    "Project owner",
    projectDecisionOwner.id
      ? `ownerless Platform card in ${projectDecisionOwner.key}'s For you ("You own this project's decisions")`
      : "ownerless Platform card (no project decision owner: default owner or Unassigned)",
  );

  // =========================================================================
  // GROUP: Company — failed run after retries, agent error, budget hard stop,
  //        budget warning at 90%, join request, recovery that stopped.
  // =========================================================================
  // failed run (after bounded-retry exhaustion)
  {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: failingAgent!.id, scopeKind: "company", status: "failed",
      invocationSource: "on_demand", error: "Task failed after all retries.", startedAt: hoursAgo(3), finishedAt: hoursAgo(2),
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: run!.id, agentId: failingAgent!.id, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after 3 scheduled attempts; no further retries will run.", createdAt: hoursAgo(2),
    });
    card("Company", "failed run after bounded-retry exhaustion");
  }
  // agent error
  await db.update(agents).set({ status: "error", errorReason: "Adapter crashed during startup.", updatedAt: now() }).where(eq(agents.id, erroredAgent!.id));
  card("Company", "agent in error state");

  // budget hard stop (agent-scoped so it does not pause the whole demo company)
  await budgetService(db).upsertPolicy(companyId, { scopeType: "agent", scopeId: hardStopAgent!.id, amount: 100_00, warnPercent: 80, hardStopEnabled: true, notifyEnabled: true } as never, scott);
  await costService(db).createEvent(companyId, { agentId: hardStopAgent!.id, provider: "anthropic", model: "claude-opus-4-8", usageKind: "agent", costCents: 100_00, occurredAt: now() } as never);
  card("Company", budgetOwner.id
    ? `budget hard stop (100%) incident — also in ${budgetOwner.key}'s For you as the budget owner`
    : "budget hard stop (100%) incident");

  // budget warning at ~90%
  await budgetService(db).upsertPolicy(companyId, { scopeType: "agent", scopeId: warnAgent!.id, amount: 100_00, warnPercent: 80, hardStopEnabled: false, notifyEnabled: true } as never, scott);
  await costService(db).createEvent(companyId, { agentId: warnAgent!.id, provider: "anthropic", model: "claude-opus-4-8", usageKind: "agent", costCents: 90_00, occurredAt: now() } as never);
  // This independent seed process must finish both hard-stop and warning work
  // before handing the demo to a server whose notifier did not write the costs.
  await flushBudgetEvaluationWork(db, { companyId });
  card("Company", "budget warning (~90%) incident");

  // join request (pending approval)
  {
    const [invite] = await db.insert(invites).values({
      companyId, inviteType: "company_join", tokenHash: createHash("sha256").update(`seed-invite-${randomUUID()}`).digest("hex"),
      allowedJoinTypes: "both", expiresAt: daysFromNow(7), acceptedAt: now(),
    }).returning();
    await db.insert(joinRequests).values({
      inviteId: invite!.id, companyId, requestType: "human", status: "pending_approval", requestIp: "127.0.0.1",
      requestEmailSnapshot: "newcomer@needs-you-demo.test",
    });
    card("Company", "pending join request");
  }

  // recovery that stopped (escalated to a human owner)
  {
    const recoveryIssue = await makeIssue({ title: "Run recovery escalated to the board", status: "blocked", createdByAgentId: worker!.id });
    await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: recoveryIssue.id, kind: "stalled_run", status: "escalated", ownerType: "board",
      cause: "run_stalled", fingerprint: `seed-${randomUUID()}`, evidence: { note: "Recovery stopped; a human must decide next steps." },
      nextAction: "A human must decide how to recover this stalled run.",
    });
    card("Company", "recovery action escalated to the board");
  }

  // =========================================================================
  // GROUP: Stale — 31 & 60 days, done task, cancelled task, decision at ~85%
  //        of its TTL, and a stale approval that must escalate.
  // =========================================================================
  for (const age of [31, 60]) {
    const staleIssue = await makeIssue({ title: `Stale ${age}-day confirmation`, status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const stale = await makeInteraction(staleIssue, "request_confirmation", { prompt: `This has waited ${age} days.` }, { title: `Stale (${age}d)` });
    await backdateInteraction(db, stale.id, daysAgo(age));
    card("Stale", `${age}-day-old pending confirmation`);
  }
  {
    const doneIssue = await makeIssue({ title: "Confirmation on a done task", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const onDone = await makeInteraction(doneIssue, "request_confirmation", { prompt: "The task is done but this card lingers." }, { title: "Lingering on a done task" });
    await db.update(issuesTable).set({ status: "done", updatedAt: daysAgo(5) }).where(eq(issuesTable.id, doneIssue.id));
    await backdateInteraction(db, onDone.id, daysAgo(5));
    card("Stale", "pending card on a done task (expired by the sweep at the next server start)");
  }
  {
    const cancelledIssue = await makeIssue({ title: "Confirmation on a cancelled task", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const onCancelled = await makeInteraction(cancelledIssue, "request_confirmation", { prompt: "The task is cancelled but this card lingers." }, { title: "Lingering on a cancelled task" });
    await db.update(issuesTable).set({ status: "cancelled", updatedAt: daysAgo(5) }).where(eq(issuesTable.id, cancelledIssue.id));
    await backdateInteraction(db, onCancelled.id, daysAgo(5));
    card("Stale", "pending card on a cancelled task (expired by the sweep at the next server start)");
  }
  {
    // The sweep never closes approvals, so this one keeps the "Task closed" reason.
    const doneApprovalIssue = await makeIssue({ title: "Approval left on a done task", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const doneApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: scott, payload: { title: "Approval on a finished task", summary: "The task is done; the approval still waits for a person." } } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: doneApprovalIssue.id, approvalId: (doneApproval as { id: string }).id });
    await db.update(issuesTable).set({ status: "done", updatedAt: daysAgo(3) }).where(eq(issuesTable.id, doneApprovalIssue.id));
    card("Stale", "approval on a done task (stale: Task closed; never auto-withdrawn)");
  }
  {
    // Unassigned for 8 days: moves to Company with "No owner for 7+ days".
    const unownedIssue = await makeIssue({ title: "Agent work with no owner for 8 days", status: "todo", createdByAgentId: worker!.id });
    const unowned = await makeInteraction(unownedIssue, "request_confirmation", { prompt: "Nobody claimed this for over a week." }, { title: "Ownerless for 8 days", actorAgentId: worker!.id });
    await backdateInteraction(db, unowned.id, daysAgo(8));
    card("Stale", "Unassigned card older than 7 days (moves to Company: No owner for 7+ days)");
  }
  // decision at ~85% of a 7-day TTL (created 6 days ago, expires ~1 day out)
  const decisionIssue = await makeIssue({ title: "Decision nearing its deadline", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const boardActor = await boardActorFor(db, companyId, scott);
  const decisionRun = await makeOriginRun(db, companyId, worker!.id, decisionIssue.id, scott);
  const nearDeadline = await decisionsSvc.create({
    companyId, actor: boardActor, agentId: worker!.id, runId: decisionRun,
    title: "Choose the rollout plan (deadline soon)", body: "This decision is ~85% through its time limit.",
    options: [{ id: "staged", label: "Staged rollout", effects: [] }, { id: "bigbang", label: "All at once", style: "destructive", effects: [] }],
    expiresAt: daysFromNow(1),
  } as never);
  await db.update(decisions).set({ createdAt: daysAgo(6), updatedAt: daysAgo(6) }).where(eq(decisions.id, (nearDeadline as { id: string }).id));
  card("Stale", "open decision at ~85% of its TTL");
  // stale approval that must escalate (35 days old)
  {
    const staleApprovalIssue = await makeIssue({ title: "Approval waiting 35+ days", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const staleApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: scott, payload: { title: "Stale approval (35 days)", summary: "This approval has waited over 30 days and must escalate." } } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: staleApprovalIssue.id, approvalId: (staleApproval as { id: string }).id });
    await db.update(approvalsTable).set({ createdAt: daysAgo(35), updatedAt: daysAgo(35) }).where(eq(approvalsTable.id, (staleApproval as { id: string }).id));
    card("Stale", "approval older than 30 days (must escalate, never auto-withdrawn)");
  }

  // =========================================================================
  // GROUP: Archived & snoozed (Scott) — two archived, one snoozed until
  //        tomorrow, one archived card with a newer change that must come back.
  // =========================================================================
  // Hide each card with the fingerprint Scott's feed shows for it, exactly as
  // the UI sends it (PAP-749 Rule 9).
  const hiddenCards: Array<{ id: string; mode: "archive" | "snooze" }> = [];
  for (const i of [1, 2]) {
    const archIssue = await makeIssue({ title: `Archived by Scott #${i}`, status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const arch = await makeInteraction(archIssue, "request_confirmation", { prompt: `Scott archived this card (#${i}).` }, { title: `Archived #${i}`, addresseeUserId: scott });
    hiddenCards.push({ id: arch.id, mode: "archive" });
    card("Archived/Snoozed", `card archived by Scott (#${i})`);
  }
  const snoozeIssue = await makeIssue({ title: "Snoozed by Scott until tomorrow", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const snoozed = await makeInteraction(snoozeIssue, "request_confirmation", { prompt: "Scott snoozed this until tomorrow." }, { title: "Snoozed", addresseeUserId: scott });
  hiddenCards.push({ id: snoozed.id, mode: "snooze" });
  card("Archived/Snoozed", "card snoozed by Scott until tomorrow");
  const comebackIssue = await makeIssue({ title: "Archived, then changed — must come back", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const comeback = await makeInteraction(comebackIssue, "request_confirmation", { prompt: "Archived earlier, then the agent changed the proposal." }, { title: "Archived with a new change", addresseeUserId: scott });
  hiddenCards.push({ id: comeback.id, mode: "archive" });
  card("Archived/Snoozed", "archived card whose proposal changed (comes back)");
  const logOnlyIssue = await makeIssue({ title: "Archived, then only log activity — stays hidden", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const logOnly = await makeInteraction(logOnlyIssue, "request_confirmation", { prompt: "Archived; later activity is only log noise." }, { title: "Archived with log-only activity", addresseeUserId: scott });
  hiddenCards.push({ id: logOnly.id, mode: "archive" });
  card("Archived/Snoozed", "archived card with only log activity (stays hidden)");
  // Task 2e: the Archived view shows the archive date and whether the card is also stale.
  const archivedStaleIssue = await makeIssue({ title: "Archived and stale (40 days)", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
  const archivedStale = await makeInteraction(archivedStaleIssue, "request_confirmation", { prompt: "Archived a while ago; nothing changed for 40 days." }, { title: "Archived and stale", addresseeUserId: scott });
  await backdateInteraction(db, archivedStale.id, daysAgo(40));
  hiddenCards.push({ id: archivedStale.id, mode: "archive" });
  card("Archived/Snoozed", "archived card that is also stale (Archived view: archive date + Stale chip)");

  const scottFeed = await attentionService(db).list(companyId, { userId: scott, all: true, allowUnscopedAll: true });
  const feedBySourceId = new Map(scottFeed.items.map((item) => [item.subject.id, item]));
  for (const hidden of hiddenCards) {
    const item = feedBySourceId.get(hidden.id);
    if (!item) throw new Error(`[seed] card ${hidden.id} missing from Scott's feed; cannot archive it`);
    if (hidden.mode === "snooze") {
      await dismissals.snooze(companyId, scott, item.dismissalKey, daysFromNow(1), hoursAgo(2), item.changeFingerprint);
    } else {
      await dismissals.dismiss(companyId, scott, item.dismissalKey, hoursAgo(2), item.changeFingerprint);
    }
  }
  // After archiving: a new proposal is an important change, so the card returns.
  await db.update(issueThreadInteractions)
    .set({ payload: { version: 1, prompt: "Revised proposal: ship behind a flag first?" }, updatedAt: now() })
    .where(eq(issueThreadInteractions.id, comeback.id));
  // Activity alone (log entries, retries, comments) is not, so this card stays hidden.
  await db.update(issueThreadInteractions).set({ updatedAt: now() }).where(eq(issueThreadInteractions.id, logOnly.id));

  // =========================================================================
  // GROUP: Closed (history) — answered, withdrawn, expired, closed-with-task.
  // =========================================================================
  {
    const histAnswered = await makeIssue({ title: "History: answered", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const a = await makeInteraction(histAnswered, "request_confirmation", { prompt: "Answered in the past." }, { title: "Answered" });
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: daysAgo(3), resolvedByUserId: scott, result: { outcome: "resolved", decision: "accept" }, updatedAt: daysAgo(3) }).where(eq(issueThreadInteractions.id, a.id));
    card("Closed history", "answered interaction");

    // Withdrawn through the same services the close endpoint calls (task 2b),
    // each with the `attention.closed` entry the route writes. History shows
    // "Withdrawn by user" and the reason.
    const closedEntry = async (userId: string, sourceKind: string, sourceId: string, issueId: string, reason: string) =>
      logActivity(db, {
        companyId, actorType: "user", actorId: userId, action: "attention.closed", entityType: "issue", entityId: issueId, issueId,
        details: { sourceKind, sourceId, mode: "withdraw", reason, until: null, closedByUserId: userId },
      });
    const histWithdrawn = await makeIssue({ title: "History: withdrawn by Dotta", status: "todo", createdByUserId: scott, responsibleUserId: scott });
    const w = await makeInteraction(histWithdrawn, "request_confirmation", { prompt: "Withdrawn in the past." }, { title: "Withdrawn" });
    await interactions.withdrawInteraction({ id: histWithdrawn.id, companyId }, w.id, { reason: "No longer needed." }, { userId: dotta });
    await db.update(issueThreadInteractions).set({ resolvedAt: daysAgo(2), updatedAt: daysAgo(2) }).where(eq(issueThreadInteractions.id, w.id));
    await closedEntry(dotta, "issue_thread_interaction", w.id, histWithdrawn.id, "No longer needed.");
    card("Closed history", "interaction Dotta withdrew (Withdrawn by user)");

    const histDecisionIssue = await makeIssue({ title: "History: decision withdrawn by Scott", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const histDecisionRun = await makeOriginRun(db, companyId, worker!.id, histDecisionIssue.id, scott);
    const histDecision = await decisionsSvc.create({
      companyId, actor: await boardActorFor(db, companyId, scott), agentId: worker!.id, runId: histDecisionRun,
      title: "Pick a launch date (withdrawn)", body: "Scott withdrew this because the launch moved.",
      options: [{ id: "monday", label: "Monday", effects: [] }, { id: "friday", label: "Friday", effects: [] }],
    } as never) as { id: string };
    await decisionsSvc.cancel(histDecision.id, { actorType: "user", actorId: scott }, { reason: "The launch moved; this is out of date." });
    await closedEntry(scott, "decision", histDecision.id, histDecisionIssue.id, "The launch moved; this is out of date.");
    card("Closed history", "decision Scott withdrew (Withdrawn by user)");

    const histApprovalIssue = await makeIssue({ title: "History: approval withdrawn by Scott", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const histApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: dotta, payload: { title: "Approve the old vendor (withdrawn)", summary: "Withdrawn as out of date; never approved." } } as never) as { id: string };
    await db.insert(issueApprovals).values({ companyId, issueId: histApprovalIssue.id, approvalId: histApproval.id });
    await approvalSvc.cancel(histApproval.id, "We picked a different vendor.", { cancelledByUserId: scott });
    await closedEntry(scott, "approval", histApproval.id, histApprovalIssue.id, "We picked a different vendor.");
    card("Closed history", "approval Scott withdrew (history: \"Withdrawn by @Scott\" with the reason)");

    // Task 2e: approvals are in history. One with no task, rejected by Scott.
    const histRejected = await approvalSvc.create(companyId, { type: "approve_ceo_strategy", status: "pending", requestedByUserId: dotta, payload: { title: "Adopt the 2027 pricing strategy", summary: "Rejected; the board kept current pricing." } } as never) as { id: string };
    await approvalSvc.reject(histRejected.id, scott, "Keep current pricing for now.");
    await db.update(approvalsTable).set({ decidedAt: daysAgo(4), updatedAt: daysAgo(4) }).where(eq(approvalsTable.id, histRejected.id));
    card("Closed history", "approval with no task that Scott rejected (history: \"Approval · …\")");

    const histExpired = await makeIssue({ title: "History: expired", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const e = await makeInteraction(histExpired, "request_confirmation", { prompt: "Expired in the past." }, { title: "Expired" });
    await db.update(issueThreadInteractions).set({ status: "expired", resolvedAt: daysAgo(1), result: { outcome: "expired" }, updatedAt: daysAgo(1) }).where(eq(issueThreadInteractions.id, e.id));
    card("Closed history", "expired interaction");

    const histClosedWithTask = await makeIssue({ title: "History: closed with its task", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const c = await makeInteraction(histClosedWithTask, "request_confirmation", { prompt: "Closed when its task closed." }, { title: "Closed with task" });
    // Stored as `expired` with outcome `issue_closed`, the shape the product
    // writes when a task closes; the Expired filter leaves it out (task 2e).
    await db.update(issueThreadInteractions).set({ status: "expired", resolvedAt: daysAgo(1), result: { version: 1, outcome: "issue_closed" }, updatedAt: daysAgo(1) }).where(eq(issueThreadInteractions.id, c.id));
    await db.update(issuesTable).set({ status: "done", updatedAt: daysAgo(1) }).where(eq(issuesTable.id, histClosedWithTask.id));
    card("Closed history", "interaction closed with its task");
  }

  // =========================================================================
  // GROUP: Receipts for Dotta (task 2f) — what Scott did with Dotta's cards.
  // =========================================================================
  {
    const handledFor = (sourceKind: "issue_thread_interaction" | "approval", sourceId: string) =>
      attentionHandledFor(db, companyId, { sourceKind, sourceId }, scott);

    const answeredIssue = await makeIssue({ title: "Dotta: launch checklist", status: "todo", createdByUserId: dotta, responsibleUserId: dotta });
    const answered = await makeInteraction(answeredIssue, "request_confirmation", { prompt: "Is the launch checklist complete?" }, { title: "Confirm the launch checklist" });
    const answeredFor = await handledFor("issue_thread_interaction", answered.id);
    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: now(), resolvedByUserId: scott, result: { outcome: "accepted" }, updatedAt: now() }).where(eq(issueThreadInteractions.id, answered.id));
    await logActivity(db, {
      companyId, actorType: "user", actorId: scott, action: "issue.thread_interaction_accepted", entityType: "issue", entityId: answeredIssue.id,
      details: { interactionId: answered.id, interactionKind: "request_confirmation", interactionStatus: "accepted", ...attentionHandledDetails(answeredFor, "approved") },
    });
    card("Receipts", "Dotta: \"Approved by @Scott\" (confirmation on her task)");

    const withdrawnIssue = await makeIssue({ title: "Dotta: vendor shortlist", status: "todo", createdByUserId: dotta, responsibleUserId: dotta });
    const withdrawn = await makeInteraction(withdrawnIssue, "ask_user_questions", {
      questions: [{ id: "vendor", prompt: "Which vendor should we shortlist?", selectionMode: "single", options: [{ id: "a", label: "Acme" }, { id: "b", label: "Globex" }] }],
    }, { title: "Pick a vendor to shortlist" });
    // Dotta read the task first, so the withdraw makes it unread in her Mine.
    await issuesSvc.markRead(companyId, withdrawnIssue.id, dotta, now());
    const withdrawnFor = await handledFor("issue_thread_interaction", withdrawn.id);
    const reason = "We already signed with Acme.";
    await interactions.withdrawInteraction({ id: withdrawnIssue.id, companyId }, withdrawn.id, { reason }, { userId: scott });
    for (const action of ["issue.thread_interaction_withdrawn", "attention.closed"]) {
      await logActivity(db, {
        companyId, actorType: "user", actorId: scott, action, entityType: "issue", entityId: withdrawnIssue.id, issueId: withdrawnIssue.id,
        details: action === "attention.closed"
          ? { sourceKind: "issue_thread_interaction", sourceId: withdrawn.id, mode: "withdraw", reason, until: null, closedByUserId: scott, ...attentionHandledDetails(withdrawnFor, "withdrawn", { reason }) }
          : { interactionId: withdrawn.id, interactionKind: "ask_user_questions", interactionStatus: "cancelled", reason, ...attentionHandledDetails(withdrawnFor, "withdrawn", { reason }) },
      });
    }
    card("Receipts", "Dotta: \"Withdrawn by @Scott\" with the reason; task unread in her Mine");

    const approvedRequest = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: dotta, payload: { title: "Approve the Q4 hiring plan", summary: "Dotta asked; Scott approved." } } as never) as { id: string };
    const approvedFor = await handledFor("approval", approvedRequest.id);
    await approvalSvc.approve(approvedRequest.id, scott, null);
    await logActivity(db, {
      companyId, actorType: "user", actorId: scott, action: "approval.approved", entityType: "approval", entityId: approvedRequest.id,
      details: { type: "request_board_approval", requestedByAgentId: null, linkedIssueIds: [], ...attentionHandledDetails(approvedFor, "approved") },
    });
    card("Receipts", "Dotta: \"Approved by @Scott\" (approval she requested)");
  }

  // =========================================================================
  // GROUP: One obligation (task 2d, Rule 11) — an approval with its in-review
  //        task, and a blocked task with the failed run that caused it, each
  //        shown as one card. A configured human review stage is an
  //        independent quality gate, so that pair stays two cards.
  // =========================================================================
  {
    // The task is in review only because it waits on the approval: one card.
    const obIssue = await makeIssue({ title: "Obligation: approval + in-review task", status: "in_review", createdByUserId: scott, responsibleUserId: scott });
    const obApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: scott, payload: { title: "Approve the in-review task", summary: "One obligation: the approval and the in-review task are the same ask." } } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: obIssue.id, approvalId: (obApproval as { id: string }).id });
    card("One obligation", "approval paired with its in-review task (one card: the approval, with the task as evidence)");
  }
  {
    // Scott is also the configured reviewer: the review verdict and the
    // approval are separate gates, so they stay two cards.
    const gateIssue = await makeIssue({ title: "Independent gate: human review + approval", status: "todo", createdByUserId: scott, responsibleUserId: scott });
    await issuesSvc.update(gateIssue.id, { status: "in_review", assigneeAgentId: null, assigneeUserId: scott, responsibleUserId: scott, executionState: reviewExecutionState(scott) } as never);
    const gateApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: scott, payload: { title: "Approve the reviewed task", summary: "A separate gate from the human review stage on the same task." } } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: gateIssue.id, approvalId: (gateApproval as { id: string }).id });
    card("One obligation", "independent quality gate: a human review stage and an approval stay two cards");
  }
  {
    const blockedIssue = await makeIssue({ title: "Obligation: blocked task + failed run", status: "blocked", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: failingAgent!.id });
    // What exhausted retries leave on the task: blocked, with a board-owned next action.
    await db.update(issuesTable).set({
      unblockDescriptor: { owner: "board", action: "Automatic retries exhausted. Retry the run or reassign the task." },
      blockedTransitionAt: hoursAgo(4),
    }).where(eq(issuesTable.id, blockedIssue.id));
    const [brun] = await db.insert(heartbeatRuns).values({
      companyId, agentId: failingAgent!.id, scopeKind: "issue", issueId: blockedIssue.id, status: "failed",
      invocationSource: "on_demand", responsibleUserId: scott, error: "Run failed and blocked the task.",
      contextSnapshot: { issueId: blockedIssue.id }, startedAt: hoursAgo(5), finishedAt: hoursAgo(4),
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: brun!.id, agentId: failingAgent!.id, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after 3 scheduled attempts; the task is blocked.", createdAt: hoursAgo(4),
    });
    card("One obligation", "blocked task paired with its failed run (one card: the run with Retry, with the blocked task as evidence)");
  }

  // Keep the demo deterministic (plan section 7: "Agents in the demo company do
  // not run. The seed makes their state directly."). Pausing every non-errored
  // agent stops the heartbeat scheduler from starting a new run that would, for
  // example, supersede the seeded failed_run card.
  await db.update(agents).set({ status: "paused", updatedAt: now() })
    .where(and(eq(agents.companyId, companyId), ne(agents.status, "error")));

  return {
    companyId,
    companyName: company.name,
    prefix: company.issuePrefix,
    users: DEMO_USERS.map((u) => ({ name: u.name, email: u.email, role: u.role })),
    cardCount,
    defaultDecisionOwner: defaultDecisionOwnerId ? defaultDecisionOwnerKey : null,
    budgetOwner: budgetOwner.id ? budgetOwner.key : null,
    projectDecisionOwner: projectDecisionOwner.id ? projectDecisionOwner.key : null,
  };
}

// --- small helpers ---------------------------------------------------------

async function createProject(
  db: Db,
  companyId: string,
  leadAgentId: string,
  overrides: { name?: string; description?: string; decisionOwnerUserId?: string | null } = {},
): Promise<string> {
  const [project] = await db.insert(projects).values({
    companyId, name: "Needs You Demo", description: "Holds the demo issues.", status: "in_progress", leadAgentId, ...overrides,
  }).returning();
  return (project as { id: string }).id;
}

async function backdateInteraction(db: Db, interactionId: string, when: Date) {
  await db.update(issueThreadInteractions).set({ createdAt: when, updatedAt: when }).where(eq(issueThreadInteractions.id, interactionId));
}

async function makeOriginRun(db: Db, companyId: string, agentId: string, issueId: string, responsibleUserId: string): Promise<string> {
  const [run] = await db.insert(heartbeatRuns).values({
    companyId, agentId, scopeKind: "issue", issueId, status: "succeeded", invocationSource: "on_demand",
    responsibleUserId, contextSnapshot: { issueId }, startedAt: hoursAgo(1), finishedAt: hoursAgo(1),
  }).returning();
  return (run as { id: string }).id;
}

async function boardActorFor(db: Db, companyId: string, userId: string) {
  const membership = await db
    .select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")))
    .then((rows) => rows[0] ?? null);
  return { type: "board", userId, companyIds: [companyId], memberships: membership ? [membership] : [], source: "session" } as never;
}

await main();
