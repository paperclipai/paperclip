import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, companies, companyOnboardingSeeds, goals, heartbeatRuns, issueComments, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { ONBOARDING_CHAT_ORIGIN_KIND } from "@paperclipai/shared";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";
import { ONBOARDING_CHAT_GREETING_REASON } from "./onboarding-chat-prompt.js";

/** Called by Finish, before navigation. Opening a conversation never starts work. */
export async function ensureOnboardingChat(db: Db, input: {
  companyId: string; agentId: string; agentName: string; userId: string;
}) {
  const svc = issueService(db);
  const existing = await svc.getConversation(input.companyId, input.agentId, input.userId);
  if (existing) return existing;
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId));
  const [seed] = await db.select().from(companyOnboardingSeeds).where(eq(companyOnboardingSeeds.companyId, input.companyId));
  const companyGoals = await db.select({ title: goals.title, description: goals.description }).from(goals)
    .where(and(eq(goals.companyId, input.companyId), eq(goals.level, "company")));
  const issue = await svc.create(input.companyId, {
    title: `Chat with ${input.agentName}`,
    description: JSON.stringify({ organization: company?.name, goals: companyGoals,
      initialIdea: seed?.firstTaskTitle, initialDetails: seed?.firstTaskDetails }),
    originKind: ONBOARDING_CHAT_ORIGIN_KIND,
    conversationAgentId: input.agentId, conversationUserId: input.userId,
    assigneeAgentId: input.agentId, createdByUserId: input.userId,
    conversationState: "waiting", status: "in_review",
  });
  await logActivity(db, { companyId: input.companyId, actorType: "user", actorId: input.userId,
    action: "issue.conversation_opened", entityType: "issue", entityId: issue.id,
    details: { agentId: input.agentId, onboarding: true } });
  return issue;
}

/** A typed reply or /new supersedes a welcome that has not started yet. */
export async function onboardingGreetingNeeded(db: Db, issue: {
  id: string; companyId: string; originKind?: string; conversationSessionGeneration: number;
}) {
  if (issue.originKind !== ONBOARDING_CHAT_ORIGIN_KIND || issue.conversationSessionGeneration !== 0) return false;
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id), isNull(issueComments.deletedAt),
  )).limit(1);
  return !comment;
}

export async function startOnboardingGreeting(db: Db, issue: Parameters<typeof onboardingGreetingNeeded>[1] & {
  conversationAgentId: string | null;
}, userId: string, wakeup: ReturnType<typeof heartbeatService>["wakeup"]) {
  return withDedicatedDbConnection(db, lockDb => lockDb.transaction(async lock => {
    await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-greeting:${issue.id}`}, 0))`);
    if (!issue.conversationAgentId || !(await onboardingGreetingNeeded(db, issue))) return false;
    const key = `onboarding-chat-greeting:${issue.id}`;
    const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
      .where(and(eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, issue.conversationAgentId),
        eq(agentWakeupRequests.idempotencyKey, key), ne(agentWakeupRequests.status, "skipped"), ne(agentWakeupRequests.status, "failed"),
        ne(agentWakeupRequests.status, "timed_out"),
        sql`(${heartbeatRuns.status} is null or ${heartbeatRuns.status} not in ('failed', 'cancelled', 'timed_out'))`)).limit(1);
    if (receipt) return true;
    const run = await wakeup(issue.conversationAgentId, {
      source: "on_demand", triggerDetail: "manual", reason: ONBOARDING_CHAT_GREETING_REASON,
      idempotencyKey: key, requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      allowRunCoalescing: false, payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: ONBOARDING_CHAT_GREETING_REASON },
    });
    if (!run) throw new Error("The welcome could not start. Please try again.");
    await logActivity(db, { companyId: issue.companyId, actorType: "user", actorId: userId,
      action: "issue.onboarding_welcome_started", entityType: "issue", entityId: issue.id,
      details: { agentId: issue.conversationAgentId, runId: run.id } });
    return true;
  }));
}
