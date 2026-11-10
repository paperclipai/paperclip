import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { agentApiKeys, agents, companies, companyMemberships, heartbeatRuns, issueComments, issues, nativeRunResults, type Db } from "@paperclipai/db";
import { agentApiKeyScopeSchema, isUuidLike, sendChatMessageSchema, type AgentApiKeyScope } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from "../errors.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { authorizationService, canActorReadIssuePrivacy, type AuthorizationActor } from "./authorization.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { resolveActorSourceTrustForIssue } from "./source-trust.js";
import { resolveTaskWatchdogMutationScope } from "./task-watchdog-scope.js";
import { readNativeReviewAssignmentContext } from "./native-runtime/native-review-participant.js";
import { nativeRunKeyScope } from "./native-runtime/native-skill-test-scope.js";
import { crossIssueInfluenceLimitError, observeCrossIssueInfluence } from "./cross-issue-influence-limit.js";

type Actor = { companyId: string; agentId: string; runId: string; agentApiKeyId?: string | null;
  keyScope?: AgentApiKeyScope | null; onBehalfOfUserId?: string | null;
  authorizingUserId?: string | null; source?: AuthorizationActor["source"] };
export interface ChatMessageReceipt {
  commentId: string;
  conversationId: string;
  chatUrl: string;
  sourceTaskId: string;
  replayed: boolean;
}

function runTask(run: typeof heartbeatRuns.$inferSelect) {
  return run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId;
}

export async function sendAgentChatMessage(
  db: Db,
  actor: Actor,
  value: unknown,
  options: { authorizeNative?: (tx: Db) => Promise<unknown>; receiptOnly?: boolean } = {},
): Promise<ChatMessageReceipt | null> {
  const parsed = sendChatMessageSchema.safeParse(value);
  if (!parsed.success) throw badRequest("Chat messages require body and idempotencyKey only", parsed.error.issues);
  if (![actor.companyId, actor.agentId, actor.runId].every(isUuidLike)) throw forbidden("An authenticated task run is required");
  const credentialScope = agentApiKeyScopeSchema.safeParse(actor.keyScope ?? { kind: "standard" });
  if (!credentialScope.success) throw forbidden("The agent credential scope is invalid");
  if (credentialScope.data.kind !== "standard") throw forbidden("Scoped test and task bridge credentials cannot publish agent chat messages");
  const input = parsed.data;
  const contentHash = createHash("sha256").update(input.body).digest("hex");
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${actor.companyId}`}, 0))`);
    const runWhere = and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, actor.companyId), eq(heartbeatRuns.agentId, actor.agentId));
    const [initial] = await tx.select().from(heartbeatRuns).where(runWhere);
    const sourceId = initial && runTask(initial);
    if (typeof sourceId !== "string" || !isUuidLike(sourceId)) throw forbidden("Chat delivery requires a task-bound run");
    const sourceQuery = () => tx.select().from(issues).where(and(eq(issues.id, sourceId), eq(issues.companyId, actor.companyId)));
    const [initialSource] = await sourceQuery();
    if (!initialSource) throw forbidden("This run no longer owns the source task");
    let source = initialSource;
    const contextQuery = () => tx.select({ run: heartbeatRuns, agent: agents }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
      .where(runWhere);
    const validateContext = (context: { run: typeof heartbeatRuns.$inferSelect; agent: typeof agents.$inferSelect } | undefined) => {
      if (!context || context.run.status !== "running" || agentRunWritesRevoked(context.run)
        || runTask(context.run) !== sourceId || source.assigneeAgentId !== actor.agentId
        || source.executionRunId !== actor.runId || (source.checkoutRunId && source.checkoutRunId !== actor.runId)
        || ["paused", "terminated", "pending_approval", "error"].includes(context.agent.status)) {
        throw forbidden("This run no longer owns the source task");
      }
      if (source.conversationAgentId) throw forbidden("Reply normally in this conversation; send_chat_message is for execution tasks");
      if (nativeRunKeyScope({ contextSnapshot: context.run.contextSnapshot, issueId: source.id, workMode: source.workMode }).kind === "skill_test") {
        throw forbidden("Skill-test runs cannot publish agent chat messages");
      }
      if (source.workMode !== "standard" || ["done", "cancelled"].includes(source.status)
        || readNativeReviewAssignmentContext(context.run.contextSnapshot)) {
        throw forbidden("Chat delivery requires an ordinary task in standard execution mode");
      }
      return context;
    };
    const [initialContext] = await contextQuery();
    const context = validateContext(initialContext);
    if (!(await instanceSettingsService(tx).getExperimental()).enableAgentChat) throw notFound("Agent Chat is disabled");
    const userId = context.run.responsibleUserId;
    if (!userId) throw forbidden("This task has no responsible human to receive the message");
    if (actor.onBehalfOfUserId !== undefined && actor.onBehalfOfUserId !== userId) throw forbidden("The authenticated responsible human no longer matches this run");
    const assertCurrentKey = async (lock: boolean) => {
      if (!actor.agentApiKeyId) return;
      const query = tx.select().from(agentApiKeys).where(and(eq(agentApiKeys.id, actor.agentApiKeyId),
        eq(agentApiKeys.companyId, actor.companyId), eq(agentApiKeys.agentId, actor.agentId), isNull(agentApiKeys.revokedAt)));
      const [key] = lock ? await query.for("share") : await query;
      const currentScope = key && agentApiKeyScopeSchema.safeParse(key.scopeConfig ?? { kind: "standard" });
      if (!key || !currentScope?.success || JSON.stringify(currentScope.data) !== JSON.stringify(credentialScope.data)
        || (key.responsibleUserId?.trim() || null) !== (actor.onBehalfOfUserId ?? userId)) {
        throw forbidden("The agent key was revoked or its authority changed");
      }
    };
    await assertCurrentKey(false);
    const [membership] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
    )).for("share");
    if (!membership) throw forbidden("The responsible human is no longer an active company member");
    const authActor: AuthorizationActor = { type: "agent", ...actor, keyId: actor.agentApiKeyId, keyScope: credentialScope.data,
      source: actor.source ?? "agent_jwt", onBehalfOfUserId: actor.onBehalfOfUserId ?? userId };
    const authorize = async (issueId: string, action: "issue:read" | "issue:comment") => {
      const decision = await authorizationService(tx).decide({ actor: authActor, action,
        resource: { type: "issue", companyId: actor.companyId, issueId } });
      if (!decision.allowed) throw forbidden(decision.explanation);
    };
    await authorize(source.id, "issue:read");
    if (!(await canActorReadIssuePrivacy(tx, { type: "none" }, source))) {
      throw forbidden("Restricted task content cannot be sent to a company-visible chat");
    }
    const svc = issueService(tx);
    let conversation = await svc.getConversation(actor.companyId, actor.agentId, userId);
    if (!conversation && !options.receiptOnly) {
      conversation = await svc.create(actor.companyId, {
        title: `Chat with ${context.agent.name}`, assigneeAgentId: actor.agentId,
        conversationAgentId: actor.agentId, conversationUserId: userId,
        conversationState: "waiting", status: "in_review", createdByAgentId: actor.agentId,
        responsibleUserId: userId, trustExplicitResponsibleUserId: true,
      });
      const opened = await persistActivity(tx, { companyId: actor.companyId, actorType: "agent", actorId: actor.agentId,
        agentId: actor.agentId, runId: actor.runId, action: "issue.conversation_opened", entityType: "issue", entityId: conversation.id,
        details: { agentId: actor.agentId, conversationUserId: userId } });
      publications.push(opened.publication);
    }
    if (conversation) await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, conversation.id), eq(issues.companyId, actor.companyId),
    )).for("update");
    const [lockedSource] = await sourceQuery().for("update");
    if (!lockedSource) throw forbidden("This run no longer owns the source task");
    source = lockedSource;
    if (options.authorizeNative) await options.authorizeNative(tx);
    const [lockedContext] = await contextQuery().for("update");
    const current = validateContext(lockedContext);
    if (current.run.responsibleUserId !== userId) throw forbidden("The responsible human changed before this message was saved");
    await assertCurrentKey(true);
    if ((await resolveTaskWatchdogMutationScope(tx, { ...actor, type: "agent" })).kind !== "none") {
      throw forbidden("Chat delivery requires an ordinary task in standard execution mode");
    }
    await assertAgentRunWriteAllowed(tx, actor.companyId, actor);
    if (await issueTreeControlService(tx).getActivePauseHoldGate(actor.companyId, source.id)) throw forbidden("This task is paused");
    const [finished] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, actor.companyId), eq(nativeRunResults.runId, actor.runId), eq(nativeRunResults.schemaStatus, "accepted"),
    )).limit(1);
    if (finished) throw forbidden("Send the message before finishing the run");
    if (!(await instanceSettingsService(tx).getExperimental()).enableAgentChat) throw notFound("Agent Chat is disabled");
    await authorize(source.id, "issue:read");
    if (!conversation) return null;
    await authorize(conversation.id, "issue:comment");
    const recipientDecision = await authorizationService(tx).decide({ actor: { type: "board", userId, source: "session", ignoreInstanceAdmin: true },
      action: "issue:read", resource: { type: "issue", companyId: actor.companyId, issueId: conversation.id } });
    if (!recipientDecision.allowed) throw forbidden("The responsible human cannot access this chat");
    const requestId = `chat:${source.id}:${createHash("sha256").update(input.idempotencyKey).digest("hex")}`;
    const [prior] = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, actor.companyId),
      eq(issueComments.issueId, conversation.id), eq(issueComments.authorAgentId, actor.agentId), eq(issueComments.clientRequestId, requestId)));
    const [company] = await tx.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, actor.companyId));
    const receipt = (commentId: string, replayed: boolean): ChatMessageReceipt => ({ commentId, conversationId: conversation!.id,
      chatUrl: `/${company.prefix}/chats/${actor.agentId}`, sourceTaskId: source.id, replayed });
    if (prior) {
      if (prior.metadata?.chatMessage?.contentHash !== contentHash) {
        if (options.receiptOnly) return null;
        throw conflict("Chat message retry key was already used with different content");
      }
      return receipt(prior.id, true);
    }
    if (options.receiptOnly) return null;
    const influence = await observeCrossIssueInfluence(tx, { companyId: actor.companyId, agentId: actor.agentId,
      runId: actor.runId, responsibleUserId: userId, targetIssueId: conversation.id,
      targetIssueIdentifier: conversation.identifier, kind: "comment" });
    if (influence && !influence.allowed) {
      const denial = crossIssueInfluenceLimitError(influence, { actorLabel: current.agent.name,
        assigneeLabel: current.agent.name, issueIdentifier: conversation.identifier });
      throw tooManyRequests(denial.error, denial.details);
    }
    const sourceTrust = await resolveActorSourceTrustForIssue({ db: tx, issue: source,
      actor: { actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId } });
    const comment = await svc.addComment(conversation.id, input.body, { agentId: actor.agentId, runId: actor.runId }, {
      clientRequestId: requestId, sourceTrust, proactiveChatMessage: { sourceTaskId: source.id, userId },
      metadata: { version: 1, chatMessage: { sourceTaskId: source.id, sourceTaskIdentifier: source.identifier!, sourceRunId: actor.runId, contentHash },
        sections: [{ rows: [{ type: "issue_link", issueId: source.id, identifier: source.identifier, label: "Source task" }] }] },
    }, tx);
    const activity = await persistActivity(tx, { companyId: actor.companyId, actorType: "agent", actorId: actor.agentId,
      agentId: actor.agentId, runId: actor.runId, agentApiKeyId: actor.agentApiKeyId,
      action: "issue.comment_added", entityType: "issue", entityId: conversation.id,
      details: { commentId: comment.id, identifier: conversation.identifier, conversationUserId: userId,
        conversationAgentId: actor.agentId, sourceTaskId: source.id } });
    publications.push(activity.publication);
    return receipt(comment.id, false);
  });
  for (const publication of publications) publishActivity(publication);
  return result;
}
