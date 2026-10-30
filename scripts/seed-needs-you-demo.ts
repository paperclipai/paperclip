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
  issueRecoveryActions,
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
import { approvalService } from "../server/src/services/approvals.js";
import { decisionService } from "../server/src/services/decisions.js";
import { budgetService } from "../server/src/services/budgets.js";
import { costService } from "../server/src/services/costs.js";
import { issueRecoveryActionService } from "../server/src/services/issue-recovery-actions.js";
import { inboxDismissalService } from "../server/src/services/inbox-dismissals.js";
import { attentionService } from "../server/src/services/attention.js";
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
  card("Company", "budget hard stop (100%) incident");

  // budget warning at ~90%
  await budgetService(db).upsertPolicy(companyId, { scopeType: "agent", scopeId: warnAgent!.id, amount: 100_00, warnPercent: 80, hardStopEnabled: false, notifyEnabled: true } as never, scott);
  await costService(db).createEvent(companyId, { agentId: warnAgent!.id, provider: "anthropic", model: "claude-opus-4-8", usageKind: "agent", costCents: 90_00, occurredAt: now() } as never);
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

    const histWithdrawn = await makeIssue({ title: "History: withdrawn", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const w = await makeInteraction(histWithdrawn, "request_confirmation", { prompt: "Withdrawn in the past." }, { title: "Withdrawn" });
    await db.update(issueThreadInteractions).set({ status: "withdrawn", resolvedAt: daysAgo(2), resolvedByUserId: scott, result: { outcome: "withdrawn_by_user", reason: "No longer needed." }, updatedAt: daysAgo(2) }).where(eq(issueThreadInteractions.id, w.id));
    card("Closed history", "withdrawn interaction");

    const histExpired = await makeIssue({ title: "History: expired", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const e = await makeInteraction(histExpired, "request_confirmation", { prompt: "Expired in the past." }, { title: "Expired" });
    await db.update(issueThreadInteractions).set({ status: "expired", resolvedAt: daysAgo(1), result: { outcome: "expired" }, updatedAt: daysAgo(1) }).where(eq(issueThreadInteractions.id, e.id));
    card("Closed history", "expired interaction");

    const histClosedWithTask = await makeIssue({ title: "History: closed with its task", status: "in_progress", createdByUserId: scott, responsibleUserId: scott });
    const c = await makeInteraction(histClosedWithTask, "request_confirmation", { prompt: "Closed when its task closed." }, { title: "Closed with task" });
    await db.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: daysAgo(1), result: { outcome: "issue_closed" }, updatedAt: daysAgo(1) }).where(eq(issueThreadInteractions.id, c.id));
    await db.update(issuesTable).set({ status: "done", updatedAt: daysAgo(1) }).where(eq(issuesTable.id, histClosedWithTask.id));
    card("Closed history", "interaction closed with its task");
  }

  // =========================================================================
  // GROUP: One obligation — an approval with its in-review task, and a blocked
  //        task with the failed run that caused it.
  // =========================================================================
  {
    const obIssue = await makeIssue({ title: "Obligation: approval + in-review task", status: "todo", createdByUserId: scott, responsibleUserId: scott });
    await issuesSvc.update(obIssue.id, { status: "in_review", assigneeAgentId: null, assigneeUserId: scott, responsibleUserId: scott, executionState: reviewExecutionState(scott) } as never);
    const obApproval = await approvalSvc.create(companyId, { type: "request_board_approval", status: "pending", requestedByUserId: scott, payload: { title: "Approve the in-review task", summary: "One obligation: the approval and the in-review task are the same ask." } } as never);
    await db.insert(issueApprovals).values({ companyId, issueId: obIssue.id, approvalId: (obApproval as { id: string }).id });
    card("One obligation", "approval paired with its in-review task");
  }
  {
    const blockedIssue = await makeIssue({ title: "Obligation: blocked task + failed run", status: "blocked", createdByUserId: scott, responsibleUserId: scott, assigneeAgentId: failingAgent!.id });
    const [brun] = await db.insert(heartbeatRuns).values({
      companyId, agentId: failingAgent!.id, scopeKind: "issue", issueId: blockedIssue.id, status: "failed",
      invocationSource: "on_demand", responsibleUserId: scott, error: "Run failed and blocked the task.",
      contextSnapshot: { issueId: blockedIssue.id }, startedAt: hoursAgo(5), finishedAt: hoursAgo(4),
    }).returning();
    await db.insert(heartbeatRunEvents).values({
      companyId, runId: brun!.id, agentId: failingAgent!.id, seq: 1, eventType: "lifecycle",
      message: "Bounded retry exhausted after 3 scheduled attempts; the task is blocked.", createdAt: hoursAgo(4),
    });
    card("One obligation", "blocked task paired with its failed run");
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
  };
}

// --- small helpers ---------------------------------------------------------

async function createProject(db: Db, companyId: string, leadAgentId: string): Promise<string> {
  const [project] = await db.insert(projects).values({
    companyId, name: "Needs You Demo", description: "Holds the demo issues.", status: "in_progress", leadAgentId,
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
