import type { EndpointRow, DbOrTransaction } from "../runtime-types.js";

import { slackSearchActionToken } from "../../connectors/slack-search-context.js";
import { slackAuthorizationRevision } from "../../connectors/slack-revision.js";

import { instanceSettingsService } from "../../instance-settings.js";
import { registerSlackTaskAuthority, slackRunOrigin } from "../../connectors/slack-authority.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatMessageLinks,
  companyMemberships,
  issueComments,
  issues,
} from "@paperclipai/db";

import {
  forbidden,
} from "../../../errors.js";

type SlackTaskAuthorityRegistrationOptions = {
  authorizeInboundWakeup: (tx: DbOrTransaction, action: typeof chatActions.$inferSelect) => Promise<{
    issue: typeof issues.$inferSelect;
    delivery: typeof chatDeliveries.$inferSelect;
    endpoint: EndpointRow;
    conversation: typeof chatConversations.$inferSelect;
  }>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
};

export function createSlackTaskAuthorityRegistration(db: Db, options: SlackTaskAuthorityRegistrationOptions) {
  const { authorizeInboundWakeup, resolveCredentials } = options;


  const unregisterSlackTaskAuthority = registerSlackTaskAuthority(db, async (binding) => {
    if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors)
      throw forbidden("Chat connectors are disabled");
    const identity = await slackRunOrigin(db, binding);
    const run = identity.run;
    if ((run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== binding.issueId || !run.responsibleUserId)
      throw forbidden("Slack tools require the bound task and an accepted linked user");
    const resolved = await db.transaction(async (tx) => {
      const [action] = await tx.select().from(chatActions).where(and(
        eq(chatActions.companyId, binding.companyId),
        eq(chatActions.kind, "inbound_wakeup"),
        sql`${chatActions.payload}->>'issueId' = ${binding.issueId}`,
        sql`${chatActions.payload}->>'agentId' = ${binding.agentId}`,
        identity.sourceMessageId
          ? sql`${chatActions.payload}->>'commentId' = ${identity.sourceMessageId}`
          : eq(chatActions.id, run.wakeupRequestId ?? "00000000-0000-0000-0000-000000000000"),
      )).limit(1);
      if (!action) {
        // Ordinary tasks and routines use their accepted responsible user, never
        // an earlier Slack sender or the connection owner's credentials.
        const [message] = identity.sourceMessageId ? await tx.select().from(issueComments)
          .where(and(eq(issueComments.companyId, binding.companyId), eq(issueComments.issueId, binding.issueId),
            eq(issueComments.id, identity.sourceMessageId), isNull(issueComments.deletedAt))) : [];
        if (identity.sourceMessageId && (!message || message.authorType !== "user" || message.authorUserId !== run.responsibleUserId))
          throw forbidden("Slack tools require the current task requester's identity");
        // An external participant may not acquire unrelated bot connections by
        // falling back to ordinary-task access after source admission fails.
        if (identity.sourceMessageId) {
          const [external] = await tx.select({ id: chatMessageLinks.id }).from(chatMessageLinks)
            .where(and(eq(chatMessageLinks.companyId, binding.companyId), eq(chatMessageLinks.commentId, identity.sourceMessageId), eq(chatMessageLinks.direction, "inbound"))).limit(1);
          if (external) throw forbidden("External messages require their originating Slack connection");
        }
        const endpoints = await tx.select().from(chatEndpoints).where(and(
          eq(chatEndpoints.companyId, binding.companyId), eq(chatEndpoints.provider, "slack"),
          eq(chatEndpoints.assignedAgentId, binding.agentId), eq(chatEndpoints.status, "active"),
          ...(binding.endpointId ? [eq(chatEndpoints.id, binding.endpointId)] : []),
        )).for("no key update");
        if (endpoints.length !== 1) throw forbidden("Select an active Slack connection assigned to this agent");
        const endpoint = endpoints[0]!;
        const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, binding.companyId), eq(issues.id, binding.issueId), eq(issues.assigneeAgentId, binding.agentId)));
        if (!issue) throw forbidden("Slack tools require a task assigned to this agent");
        const [member] = await tx.select().from(companyMemberships).where(and(
          eq(companyMemberships.companyId, binding.companyId), eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, run.responsibleUserId!), eq(companyMemberships.status, "active"), ne(companyMemberships.membershipRole, "viewer"),
        ));
        if (!member) throw forbidden("The responsible user must be an active company operator");
        const links = await tx.select({ principal: chatExternalPrincipals }).from(chatIdentityLinks)
          .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId), eq(chatExternalPrincipals.companyId, binding.companyId)))
          .where(and(eq(chatIdentityLinks.companyId, binding.companyId), eq(chatIdentityLinks.endpointId, endpoint.id),
            eq(chatIdentityLinks.paperclipUserId, run.responsibleUserId!), eq(chatIdentityLinks.status, "linked"),
            eq(chatExternalPrincipals.provider, "slack"), eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId!), eq(chatExternalPrincipals.isBot, false)));
        if (links.length !== 1) throw forbidden("Link your Slack account to this connection before using it from tasks or routines");
        // A Board message changes who is directing the work, not the privacy
        // of context already present in its linked Slack conversation.
        const conversations = await tx.select().from(chatConversations).where(and(
          eq(chatConversations.companyId, binding.companyId), eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.issueId, binding.issueId),
        )).limit(2);
        if (conversations.length > 1) throw forbidden("The task's Slack conversation boundary is ambiguous");
        return { endpoint, issue, conversation: conversations[0] ?? null, delivery: null, principalId: links[0]!.principal.id, slackUserId: links[0]!.principal.externalId };
      }
      if (action.payload.requestedByActorType !== "user" || action.payload.requestedByActorId !== run.responsibleUserId ||
          (binding.endpointId && action.endpointId !== binding.endpointId))
        throw forbidden("Slack tools require a verified linked Slack request");
      // This standalone resolver does not own the scheduler's issue lock. Use
      // the ingress lock order (endpoint, then issue) so a normal webhook or
      // endpoint update cannot turn tool setup into a NOWAIT failure. The
      // scheduler retains its nonblocking check when it owns the issue first.
      await tx.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
        eq(chatEndpoints.companyId, binding.companyId),
        eq(chatEndpoints.id, action.endpointId),
      )).for("no key update");
      const source = await authorizeInboundWakeup(tx, action);
      if (source.endpoint.provider !== "slack") throw forbidden("This is not a Slack task");
      const [principal] = await tx.select().from(chatExternalPrincipals).where(and(
        eq(chatExternalPrincipals.companyId, binding.companyId),
        eq(chatExternalPrincipals.id, action.principalId!),
        eq(chatExternalPrincipals.provider, "slack"),
        eq(chatExternalPrincipals.providerAccountId, source.endpoint.providerAccountId!),
        eq(chatExternalPrincipals.isBot, false),
      ));
      if (!principal) throw forbidden("Slack sender is no longer available");
      return { ...source, principalId: principal.id, slackUserId: principal.externalId };
    });
    const credentials = await resolveCredentials(resolved.endpoint);
    if (!credentials.botToken) throw forbidden("Slack bot credential is unavailable");
    return {
      endpoint: resolved.endpoint, issueId: binding.issueId, conversation: resolved.conversation,
      principalId: resolved.principalId, slackUserId: resolved.slackUserId,
      userId: run.responsibleUserId, deliveryId: resolved.delivery?.id ?? null,
      identityContextId: identity.context?.id ?? null,
      workMode: resolved.issue.workMode,
      revision: createHash("sha256").update(JSON.stringify([
        resolved.endpoint.status, resolved.endpoint.allowDirectMessages, resolved.conversation?.sessionGeneration ?? null,
        run.responsibleUserId, credentials.botToken,
        await slackAuthorizationRevision(db, binding.companyId, resolved.endpoint.id, resolved.endpoint.connectionId, binding.agentId, run.responsibleUserId),
      ])).digest("hex"),
      botToken: credentials.botToken,
      searchActionToken: resolved.delivery ? slackSearchActionToken(db, resolved.endpoint.id, resolved.endpoint.providerAccountId!, resolved.slackUserId, String((resolved.delivery.normalizedEvent.message as Record<string, unknown> | undefined)?.providerMessageId ?? "")) : null,
    };
  });
  return { unregisterSlackTaskAuthority };
}
