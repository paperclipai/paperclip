import { logger } from "../../middleware/logger.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { activityLog, chatVoicePhoneLines, chatVoiceInboundCalls, chatVoiceCallbacks, chatEndpoints, chatConversations, chatDeliveries, chatPublications, chatVoiceSessions, chatVoiceToolCalls, chatVoiceReplies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, toolConnectionInstalls, instanceUserRoles, issueThreadInteractions, issues, heartbeatRuns, toolConnections, type Db } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import type { ToolCredentialSecretRef, VoiceSession } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../../errors.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { evaluateIssueThreadInteractionResolverAudience } from "../issue-thread-interaction-resolution.js";
import { nativeSha256 } from "../native-runtime/canonical.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import type { SpekoToolEnvelope } from "./speko-protocol.js";

export type VoiceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type VoiceSessionRow = typeof chatVoiceSessions.$inferSelect;
export interface VoiceCaller { id: string; authority: "member" | "instance_admin" | "local_board" }
export function voiceCredentialFingerprint(refs: ToolCredentialSecretRef[]) {
  const stable = refs.map((ref) => ({ configPath: ref.configPath, secretId: ref.secretId, versionSelector: ref.versionSelector ?? "latest" }))
    .sort((a, b) => `${a.configPath}:${a.secretId}:${a.versionSelector}`.localeCompare(`${b.configPath}:${b.secretId}:${b.versionSelector}`));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
/** Include resolved versions so rotating a `latest` ref retires old calls. */
export async function currentVoiceCredentialFingerprint(db: Db | VoiceTransaction, companyId: string, refs: ToolCredentialSecretRef[]) {
  const resolved: ToolCredentialSecretRef[] = [];
  for (const ref of refs) {
    const [secret] = await db.select().from(companySecrets).where(and(eq(companySecrets.companyId, companyId),
      eq(companySecrets.id, ref.secretId), eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt)));
    if (!secret) throw forbidden("Voice credentials are no longer available");
    resolved.push({ ...ref, versionSelector: ref.versionSelector === undefined || ref.versionSelector === "latest" ? secret.latestVersion : ref.versionSelector });
  }
  return voiceCredentialFingerprint(resolved);
}
export const voiceTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function serializeVoiceSession(row: VoiceSessionRow): VoiceSession {
  return { id: row.id, companyId: row.companyId, endpointId: row.endpointId, issueId: row.issueId, assignedAgentId: row.assignedAgentId, state: row.state, mode: row.mode, generation: row.generation, callerAuthority: row.callerAuthority, replyCursor: row.replyCursor, errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), endedAt: row.endedAt?.toISOString() ?? null };
}

/** Server-owned bindings, not model-selected company/task IDs. */
export function voiceSessionStore(db: Db, options: { allowLocalBoard: boolean; nonblockingAuthority?: boolean }) {
  async function authorizeCaller(tx: VoiceTransaction, companyId: string, caller: VoiceCaller) {
    if (caller.authority === "local_board") {
      if (options.allowLocalBoard && caller.id === "local-board") return;
      throw forbidden("Local voice authority is unavailable");
    }
    const permitted = caller.authority === "instance_admin"
      ? await tx.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(eq(instanceUserRoles.userId, caller.id), eq(instanceUserRoles.role, "instance_admin"))).for("share", options.nonblockingAuthority ? { noWait: true } : undefined)
      : await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, caller.id), eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"), sql`${companyMemberships.membershipRole} is distinct from 'viewer'`)).for("share", options.nonblockingAuthority ? { noWait: true } : undefined);
    if (!permitted.length) throw forbidden("Voice access is no longer available");
  }
  async function authorizeTask(tx: VoiceTransaction, companyId: string, issueId: string, caller: VoiceCaller, work = true) {
    await authorizeCaller(tx, companyId, caller);
    const [task] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("share", options.nonblockingAuthority ? { noWait: true } : undefined);
    if (!task) throw notFound("Voice task not found");
    const actor: AuthorizationActor = { type: "board", userId: caller.id,
      source: caller.authority === "local_board" ? "local_implicit" : "session",
      isInstanceAdmin: caller.authority === "instance_admin" };
    const authorization = authorizationService(tx);
    // issue:comment does not itself apply the issue:read privacy projection.
    // Check both explicitly before accepting instructions or exposing replies.
    for (const action of work ? ["issue:read", "issue:comment"] as const : ["issue:read"] as const) {
      const decision = await authorization.decide({ actor, action, resource: { type: "issue", companyId, issueId, status: task.status, assigneeAgentId: task.assigneeAgentId, assigneeUserId: task.assigneeUserId, projectId: task.projectId, originKind: task.originKind, originId: task.originId } });
      if (!decision.allowed) throw forbidden("You no longer have access to this voice task");
    }
    if (work && (task.status === "cancelled" || task.hiddenAt)) throw forbidden("This voice task is no longer available for work");
    return task;
  }
  async function endpointContext(tx: VoiceTransaction, companyId: string, endpointId: string) {
    const endpoint = await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId))).for("share", options.nonblockingAuthority ? { noWait: true } : undefined).then((rows) => rows[0]);
    if (!endpoint || endpoint.provider !== "speko") throw notFound("Voice connection not found");
    const connection = await tx.select().from(toolConnections).where(and(eq(toolConnections.id, endpoint.connectionId), eq(toolConnections.companyId, companyId))).for("share", options.nonblockingAuthority ? { noWait: true } : undefined).then((rows) => rows[0]);
    if (!["active", "verifying"].includes(endpoint.status) || !connection?.enabled || connection.status !== "active" || connection.transport !== "voice") throw forbidden("Voice connection is not active");
    const generation = Number((endpoint.setup as { runtimeGeneration?: number }).runtimeGeneration ?? 0);
    return { endpoint, connection, generation, fingerprint: await currentVoiceCredentialFingerprint(tx, companyId, connection.credentialSecretRefs), runtimeFingerprint: voiceCredentialFingerprint(connection.credentialSecretRefs) };
  }
  async function authorizeConnection(tx: VoiceTransaction, context: Awaited<ReturnType<typeof endpointContext>>, caller: VoiceCaller) {
    const { endpoint, connection } = context;
    if (!endpoint.allowDirectMessages) throw forbidden("Voice conversations are disabled for this connection");
    // Dedicated channel credentials predate connection grants; their agent is
    // the endpoint assignment. Once grants/installs exist, honor those current
    // restrictions, including revoked grants. Managed grants require a current
    // install even after the final install is removed. Grant revocation keeps
    // its durable row; only the dedicated legacy channel has neither.
    const grants = await tx.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, endpoint.companyId), eq(connectionGrants.connectionId, connection.id)));
    const members = grants.length ? await tx.select().from(connectionGrantMembers).where(and(eq(connectionGrantMembers.companyId, endpoint.companyId), inArray(connectionGrantMembers.grantId, grants.map(g => g.id)))) : [];
    if (grants.length && !grants.some(grant => {
      if (grant.status !== "active") return false;
      // The channel runtime uses connection refs; an unrelated identity's
      // grant cannot authorize that credential.
      if (voiceCredentialFingerprint(grant.credentialSecretRefs) !== voiceCredentialFingerprint(connection.credentialSecretRefs)) return false;
      if (grant.kind === "user") return grant.subjectUserId === caller.id;
      if (grant.kind !== "organization" || ["per_user", "per_agent"].includes(connection.credentialPolicy)) return false;
      const audience = members.filter(member => member.grantId === grant.id);
      return !audience.length || audience.some(member => member.subjectId === caller.id);
    })) throw forbidden("You no longer have access to this voice connection's credential");
    const installs = await tx.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, endpoint.companyId), eq(toolConnectionInstalls.connectionId, connection.id)));
    if ((grants.length || installs.length) && !installs.some(install => install.targetType === "company" && install.targetId === endpoint.companyId || install.targetType === "agent" && install.targetId === endpoint.assignedAgentId)) {
      throw forbidden("The selected agent no longer has access to this voice connection");
    }
  }
  /** Public phone authority is confined to the task created for this exact call. */
  async function authorizeGuestTask(tx: VoiceTransaction, context: Awaited<ReturnType<typeof endpointContext>>, session: VoiceSessionRow) {
    const { endpoint } = context;
    const [call] = await tx.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, endpoint.companyId), eq(chatVoiceInboundCalls.endpointId, endpoint.id), eq(chatVoiceInboundCalls.sessionId, session.id), eq(chatVoiceInboundCalls.intakeIssueId, session.issueId)));
    const [line] = await tx.select().from(chatVoicePhoneLines).where(and(eq(chatVoicePhoneLines.companyId, endpoint.companyId), eq(chatVoicePhoneLines.endpointId, endpoint.id), eq(chatVoicePhoneLines.enabled, true), eq(chatVoicePhoneLines.guestIntake, true))).for("share");
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, endpoint.companyId), eq(issues.id, session.issueId))).for("share");
    const policy = task?.executionPolicy?.authorizationPolicy as {trustPreset?: string; trustBoundary?: {mode?: string; companyId?: string; rootIssueId?: string; issueIds?: string[]; allowedAgentIds?: string[]; allowedToolClasses?: string[]; allowedSecretBindingIds?: string[]}} | undefined;
    const boundary = policy?.trustBoundary;
    if (!call || !line || !endpoint.allowDirectMessages || session.mode !== "inbound_phone" || session.callerId !== `guest:${call.id}` || call.providerSessionId !== session.providerSessionId || call.generation !== context.generation || call.credentialFingerprint !== context.fingerprint || call.toolTokenHash !== session.toolTokenHash || !["guest_intake", "ended"].includes(call.state)
      || !task || (line.lowTrustEnvironmentId ?? null) !== (task.executionWorkspaceSettings?.environmentId ?? null) || task.hiddenAt || task.status === "cancelled" || task.originKind !== "chat_channel" || task.originId !== endpoint.id || task.assigneeAgentId !== session.assignedAgentId || session.assignedAgentId !== endpoint.assignedAgentId
      || task.sourceTrust?.preset !== LOW_TRUST_REVIEW_PRESET || task.sourceTrust.disposition !== "quarantined" || policy?.trustPreset !== LOW_TRUST_REVIEW_PRESET || boundary?.mode !== LOW_TRUST_REVIEW_PRESET || boundary.companyId !== endpoint.companyId || boundary.rootIssueId !== task.id
      || boundary.issueIds?.length !== 1 || boundary.issueIds[0] !== task.id || boundary.allowedAgentIds?.length !== 1 || boundary.allowedAgentIds[0] !== session.assignedAgentId || boundary.allowedToolClasses?.length !== 0 || boundary.allowedSecretBindingIds?.length !== 0) throw forbidden("The low-trust phone task boundary is no longer available");
    // Honor managed credential/install revocation without impersonating a user.
    const grants = await tx.select().from(connectionGrants).where(and(eq(connectionGrants.companyId, endpoint.companyId), eq(connectionGrants.connectionId, context.connection.id)));
    if (grants.length && !grants.some(g => g.status === "active" && g.kind === "organization" && voiceCredentialFingerprint(g.credentialSecretRefs) === voiceCredentialFingerprint(context.connection.credentialSecretRefs))) throw forbidden("The company phone credential grant is unavailable");
    const installs = await tx.select().from(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, endpoint.companyId), eq(toolConnectionInstalls.connectionId, context.connection.id)));
    if ((grants.length || installs.length) && !installs.some(i => i.targetType === "company" && i.targetId === endpoint.companyId || i.targetType === "agent" && i.targetId === endpoint.assignedAgentId)) throw forbidden("The phone agent connection was removed");
    return task;
  }
  async function authorizeSession(tx: VoiceTransaction, companyId: string, sessionId: string, allowedStates: readonly string[] = ["connecting", "active"]) {
    // Follow the existing endpoint → connection → session lock order.
    const candidate = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, sessionId), eq(chatVoiceSessions.companyId, companyId))).then((rows) => rows[0]);
    if (!candidate) throw notFound("Voice session not found");
    const context = await endpointContext(tx, companyId, candidate.endpointId);
    const session = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, sessionId), eq(chatVoiceSessions.companyId, companyId))).for("update").then((rows) => rows[0]);
    if (!session || !allowedStates.includes(session.state) || session.expiresAt.getTime() <= Date.now()
      || session.generation !== context.generation || session.credentialFingerprint !== context.fingerprint) throw forbidden("Voice session is no longer current");
    if (!["member", "instance_admin", "local_board", "guest_intake"].includes(session.callerAuthority)) throw forbidden("This call has not been approved for private work");
    if (session.mode === "outbound_phone") {
      const [optIn] = await tx.select({ id: chatVoiceCallbacks.id }).from(chatVoiceCallbacks).where(and(eq(chatVoiceCallbacks.companyId, companyId), eq(chatVoiceCallbacks.endpointId, session.endpointId), eq(chatVoiceCallbacks.userId, session.callerId), eq(chatVoiceCallbacks.enabled, true))).for("share");
      if (!optIn) throw forbidden("Phone callbacks are no longer enabled");
    }
    const guest = session.callerAuthority === "guest_intake";
    if (!guest) {
      await authorizeCaller(tx, companyId, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
      await authorizeConnection(tx, context, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
    }
    const task = guest ? await authorizeGuestTask(tx, context, session) : await authorizeTask(tx, companyId, session.issueId, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
    const conversation = await tx.select().from(chatConversations).where(and(eq(chatConversations.id, session.conversationId), eq(chatConversations.companyId, companyId), eq(chatConversations.endpointId, session.endpointId), eq(chatConversations.issueId, session.issueId))).for("share", options.nonblockingAuthority ? { noWait: true } : undefined).then((rows) => rows[0]);
    if (!task || !conversation || !["active", "waiting"].includes(conversation.state) || task.assigneeAgentId !== session.assignedAgentId || context.endpoint.assignedAgentId !== session.assignedAgentId) throw forbidden("The voice task binding changed");
    return { ...context, session, conversation, task };
  }
  async function reserve(input: {
    companyId: string; endpointId: string; caller: VoiceCaller; idempotencyKey: string; requestFingerprint: string; maxDurationSeconds: number; mode?: "browser" | "outbound_phone" | "inbound_phone"; providerSessionId?: string; toolToken?: string;
    /** Runs only for a NEW request and in the same transaction as the session. */
    prepareBinding(tx: VoiceTransaction): Promise<{ issueId: string; conversationId: string }>;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${input.companyId}:${input.caller.id}:${input.idempotencyKey}`}, 0))`);
      await authorizeCaller(tx, input.companyId, input.caller);
      const previous = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.callerId, input.caller.id), eq(chatVoiceSessions.idempotencyKey, input.idempotencyKey))).then((rows) => rows[0]);
      if (previous) {
        if (previous.requestFingerprint !== input.requestFingerprint || previous.endpointId !== input.endpointId) throw conflict("Voice request key was already used for different work");
        await authorizeConnection(tx, await endpointContext(tx, input.companyId, input.endpointId), input.caller);
        await authorizeTask(tx, input.companyId, previous.issueId, input.caller);
        return { session: previous, created: false as const };
      }
      const context = await endpointContext(tx, input.companyId, input.endpointId);
      await authorizeConnection(tx, context, input.caller);
      if (context.generation < 1 || input.maxDurationSeconds < 30 || input.maxDurationSeconds > 1800 || !Number.isInteger(input.maxDurationSeconds)) throw conflict("Voice setup or duration is invalid");
      if (input.mode === "inbound_phone") {
        const [admission] = await tx.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, input.companyId), eq(chatVoiceInboundCalls.endpointId, input.endpointId), eq(chatVoiceInboundCalls.providerSessionId, input.providerSessionId ?? ""))).for("update");
        if (!admission || admission.state !== "approving" || admission.approvedByUserId !== input.caller.id || admission.callerAuthority !== input.caller.authority || admission.expiresAt.getTime() <= Date.now() || admission.generation !== context.generation || admission.credentialFingerprint !== context.fingerprint || admission.toolTokenHash !== voiceTokenHash(input.toolToken ?? "") || input.idempotencyKey !== `inbound:${admission.id}`) throw forbidden("This live call has not been approved for private work");
      }
      const binding = await input.prepareBinding(tx);
      const task = await authorizeTask(tx, input.companyId, binding.issueId, input.caller);
      const conversation = await tx.select().from(chatConversations).where(and(eq(chatConversations.id, binding.conversationId), eq(chatConversations.companyId, input.companyId), eq(chatConversations.endpointId, input.endpointId), eq(chatConversations.issueId, binding.issueId))).then((rows) => rows[0]);
      if (!task || !conversation || task.assigneeAgentId !== context.endpoint.assignedAgentId) throw conflict("The selected voice agent must be assigned to this task");
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-live:${input.companyId}:${input.caller.id}:${binding.issueId}`}, 0))`);
      const [live] = await tx.select({ id: chatVoiceSessions.id }).from(chatVoiceSessions).where(and(
        eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.callerId, input.caller.id), eq(chatVoiceSessions.issueId, binding.issueId),
        sql`${chatVoiceSessions.state} not in ('ended', 'failed', 'expired')`)).limit(1);
      if (live) throw conflict("End the existing call before starting another", { code: "voice_call_already_active", sessionId: live.id });
      if (input.mode === "inbound_phone") {
        const [guest] = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.endpointId, input.endpointId), eq(chatVoiceSessions.providerSessionId, input.providerSessionId ?? ""), eq(chatVoiceSessions.callerAuthority, "guest_intake"))).for("update");
        if (guest) {
          if (!["connecting", "active"].includes(guest.state) || guest.expiresAt.getTime() <= Date.now() || guest.generation !== context.generation || guest.toolTokenHash !== voiceTokenHash(input.toolToken ?? "")) throw forbidden("Guest call is no longer available for approval");
          const task = await authorizeTask(tx, input.companyId, binding.issueId, input.caller);
          if (task.assigneeAgentId !== context.endpoint.assignedAgentId) throw conflict("The selected agent must be assigned to this task");
          const [promoted] = await tx.update(chatVoiceSessions).set({...binding, callerId: input.caller.id, callerAuthority: input.caller.authority, approvedByUserId: input.caller.id, idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint, updatedAt: new Date()}).where(eq(chatVoiceSessions.id, guest.id)).returning();
          await tx.insert(activityLog).values({companyId: input.companyId, actorType: "user", actorId: input.caller.id, action: "voice.guest.private_call_approved", entityType: "voice_session", entityId: guest.id, details: {issueId: binding.issueId}});
          return {session: promoted, created: false as const};
        }
      }
      const token = input.toolToken ?? randomBytes(32).toString("base64url"), createdAt = new Date();
      const [session] = await tx.insert(chatVoiceSessions).values({ id: randomUUID(), companyId: input.companyId, endpointId: input.endpointId, ...binding, assignedAgentId: context.endpoint.assignedAgentId,
        callerId: input.caller.id, callerAuthority: input.caller.authority, mode: input.mode ?? "browser", state: input.providerSessionId ? "connecting" : "reserved", providerSessionId: input.providerSessionId ?? null, approvedByUserId: input.mode === "inbound_phone" ? input.caller.id : null, generation: context.generation, credentialFingerprint: context.fingerprint,
        toolTokenHash: voiceTokenHash(token), idempotencyKey: input.idempotencyKey, requestFingerprint: input.requestFingerprint, createdAt, expiresAt: new Date(createdAt.getTime() + input.maxDurationSeconds * 1000) }).returning();
      await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "user", actorId: input.caller.id, action: "voice.session.requested", entityType: "voice_session", entityId: session.id, details: { endpointId: input.endpointId, issueId: session.issueId, mode: input.mode ?? "browser" } });
      return { session, created: true as const, token };
    });
  }
  async function stageDelivery(tx: VoiceTransaction, context: Awaited<ReturnType<typeof authorizeSession>>, text: string, toolId: string) {
    const { session, conversation } = context;
    const prior = await tx.select({ id: chatVoiceToolCalls.id }).from(chatVoiceToolCalls).where(and(eq(chatVoiceToolCalls.sessionId, session.id), eq(chatVoiceToolCalls.tool, "submit_request"))).limit(1);
    const threadId = conversation.externalThreadId;
    const providerEventId = `${threadId}:${session.id}:${toolId}`;
    const trigger = prior.length ? "subscribed_message" : "direct_message";
    const [delivery] = await tx.insert(chatDeliveries).values({
      companyId: session.companyId, endpointId: session.endpointId, conversationId: session.conversationId,
      providerEventId, deduplicationKey: createHash("sha256").update(providerEventId).digest("hex"),
      eventKind: prior.length ? "message" : "direct_message",
      normalizedEvent: {
        providerEventId, kind: prior.length ? "message" : "direct_message", trigger,
        runtimeContext: { generation: session.generation, credentialFingerprint: context.runtimeFingerprint },
        acknowledgement: { receiptReactionSupported: false },
        principal: { externalId: `voice:${session.id}`, displayName: "Voice caller", handle: "voice-caller" },
        resource: { type: "direct_message", providerResourceId: conversation.externalConversationId, label: "Voice conversation" },
        conversation: { externalConversationId: conversation.externalConversationId, externalThreadId: threadId, label: "Voice conversation", isDirectMessage: true, providerUrl: null },
        message: { providerMessageId: `${session.id}:${toolId}`, text, mentionedBot: false, attachments: [], providerSentAt: new Date().toISOString() },
      },
    }).returning({ id: chatDeliveries.id });
    return delivery.id;
  }
  function priorCallDeliveryBarrier(session: VoiceSessionRow, publicationId: string | SQL) {
    return sql<boolean>`exists (select 1 from chat_voice_replies r join chat_voice_sessions s
      on s.id = r.session_id and s.company_id = r.company_id
      where r.company_id = ${session.companyId} and r.publication_id = ${publicationId}
        and s.id <> ${session.id} and s.caller_id = ${session.callerId}
        and s.endpoint_id = ${session.endpointId} and s.conversation_id = ${session.conversationId}
        and s.issue_id = ${session.issueId}
        and (r.delivered_at is not null or exists (
          select 1 from chat_actions a where a.company_id = r.company_id
            and a.endpoint_id = s.endpoint_id and a.kind = 'speko_voice_reply_push'
            and a.payload->>'replyId' = r.id::text
            and (a.status in ('dispatching', 'unknown') or
              (a.status = 'completed' and coalesce(a.payload->>'questionNotification', 'false') = 'false'))
        )))`;
  }
  async function collectMissedReplies(tx: VoiceTransaction, session: VoiceSessionRow) {
    // Only publications since this caller joined this exact conversation are
    // eligible. Transport acceptance in any prior call suppresses automatic
    // replay; uncertain playback requires an explicit repeat, not an assumption.
    const [first] = await tx.select({ createdAt: chatVoiceSessions.createdAt }).from(chatVoiceSessions)
      .where(and(eq(chatVoiceSessions.companyId, session.companyId), eq(chatVoiceSessions.endpointId, session.endpointId),
        eq(chatVoiceSessions.conversationId, session.conversationId), eq(chatVoiceSessions.callerId, session.callerId)))
      .orderBy(asc(chatVoiceSessions.createdAt)).limit(1);
    const missing = await tx.select({ id: chatPublications.id }).from(chatPublications).where(and(
      eq(chatPublications.companyId, session.companyId), eq(chatPublications.endpointId, session.endpointId),
      eq(chatPublications.conversationId, session.conversationId), eq(chatPublications.issueId, session.issueId),
      eq(chatPublications.state, "published"), gte(chatPublications.createdAt, first?.createdAt ?? session.createdAt),
      sql`(coalesce(${chatPublications.payload}->>'progressState', '') = '' or ${chatPublications.payload}->>'interactionId' is not null)`,
      sql`not exists (select 1 from chat_voice_replies r where r.company_id = ${session.companyId}
        and r.publication_id = ${chatPublications.id} and r.session_id = ${session.id})`,
      sql`not (${priorCallDeliveryBarrier(session, sql`${chatPublications.id}`)})`,
    )).orderBy(asc(chatPublications.createdAt), asc(chatPublications.id)).limit(100);
    let cursor = session.replyCursor;
    for (const publication of missing) {
      await tx.insert(chatVoiceReplies).values({ companyId: session.companyId, sessionId: session.id, publicationId: publication.id, cursor: ++cursor });
    }
    if (cursor !== session.replyCursor) {
      await tx.update(chatVoiceSessions).set({ replyCursor: cursor, updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
      session.replyCursor = cursor;
    }
  }
  async function collectRepeatReply(tx: VoiceTransaction, session: VoiceSessionRow) {
    // A caller may rejoin after an answer was retrieved but never heard. Only
    // their own exact conversation's previously delivered publication qualifies.
    const [previous] = await tx.select({ publicationId: chatVoiceReplies.publicationId }).from(chatVoiceReplies)
      .innerJoin(chatVoiceSessions, and(eq(chatVoiceSessions.id, chatVoiceReplies.sessionId), eq(chatVoiceSessions.companyId, chatVoiceReplies.companyId)))
      .innerJoin(chatPublications, and(eq(chatPublications.id, chatVoiceReplies.publicationId), eq(chatPublications.companyId, session.companyId)))
      .where(and(eq(chatVoiceReplies.companyId, session.companyId), eq(chatVoiceSessions.callerId, session.callerId),
        eq(chatVoiceSessions.endpointId, session.endpointId), eq(chatVoiceSessions.conversationId, session.conversationId),
        eq(chatVoiceSessions.issueId, session.issueId), eq(chatPublications.endpointId, session.endpointId),
        eq(chatPublications.conversationId, session.conversationId), eq(chatPublications.issueId, session.issueId),
        eq(chatPublications.state, "published"), sql`${chatVoiceReplies.deliveredAt} is not null`))
      .orderBy(desc(chatVoiceReplies.deliveredAt), desc(chatVoiceReplies.cursor)).limit(1);
    if (!previous) return;
    const [existing] = await tx.select().from(chatVoiceReplies).where(and(eq(chatVoiceReplies.sessionId, session.id), eq(chatVoiceReplies.publicationId, previous.publicationId)));
    if (existing) return;
    const cursor = session.replyCursor + 1;
    await tx.insert(chatVoiceReplies).values({ companyId: session.companyId, sessionId: session.id, publicationId: previous.publicationId, cursor, deliveredAt: new Date() });
    await tx.update(chatVoiceSessions).set({ replyCursor: cursor, updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
    session.replyCursor = cursor;
  }
  /** Neutral task-scoped status only; execution logs and private errors never reach the voice model. */
  async function workStatus(tx: VoiceTransaction, context: Awaited<ReturnType<typeof authorizeSession>>) {
    const { session, task } = context;
    const [request] = await tx.select({ createdAt: chatVoiceToolCalls.createdAt, deliveryState: chatDeliveries.state })
      .from(chatVoiceToolCalls).innerJoin(chatDeliveries, and(eq(chatDeliveries.id, chatVoiceToolCalls.deliveryId),
        eq(chatDeliveries.companyId, session.companyId), eq(chatDeliveries.endpointId, session.endpointId),
        eq(chatDeliveries.conversationId, session.conversationId)))
      .where(and(eq(chatVoiceToolCalls.companyId, session.companyId), eq(chatVoiceToolCalls.sessionId, session.id),
        eq(chatVoiceToolCalls.tool, "submit_request"))).orderBy(desc(chatVoiceToolCalls.createdAt)).limit(1);
    if (!request) return { state: "idle", message: "No work request has been submitted in this call." };
    if (task.status === "cancelled") return { state: "cancelled", message: "Work on this task was cancelled." };
    if (["failed", "filtered"].includes(request.deliveryState)) return { state: "blocked", message: "The latest request could not be dispatched. Check the task in Paperclip." };
    const awaitingDispatch = ["received", "processing", "retry"].includes(request.deliveryState);
    const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, session.companyId), eq(heartbeatRuns.agentId, session.assignedAgentId),
      or(eq(heartbeatRuns.issueId, session.issueId), and(isNull(heartbeatRuns.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${session.issueId}`)),
      or(task.executionRunId ? eq(heartbeatRuns.id, task.executionRunId) : sql`false`, gte(heartbeatRuns.createdAt, request.createdAt)),
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    if (run?.status === "running") return { state: "running", followUpQueued: awaitingDispatch, message: "The Paperclip agent is working on this task." };
    if (awaitingDispatch || run?.status === "queued") return { state: "queued", message: "The request is saved and waiting for execution." };
    if (run && ["failed", "timed_out"].includes(run.status)) return { state: "failed", message: "The latest execution failed. Check the task in Paperclip." };
    if (run?.status === "cancelled") return { state: "cancelled", message: "The latest execution was cancelled." };
    if (run?.status === "succeeded") return { state: "awaiting_reply", message: "No agent run is currently active. Use only approved updates for the answer. This does not prove the requested work or any background command completed." };
    return { state: "pending", message: "The request is saved; execution status is not yet available." };
  }
  async function runTool(input: {
    companyId: string; endpointId: string; sessionId: string; token: string; envelope: SpekoToolEnvelope; webhookId: string; fingerprint: string;
    /** Stage the existing chat delivery. Execution drains after this transaction commits. */
    accept(tx: VoiceTransaction, context: Awaited<ReturnType<typeof authorizeSession>>, text: string, providerToolCallId: string): Promise<string>;
  }) {
    return db.transaction(async (tx) => {
      const context = await authorizeSession(tx, input.companyId, input.sessionId), { session } = context;
      if (session.endpointId !== input.endpointId || session.providerSessionId !== input.envelope.session_id || !timingSafeEqual(Buffer.from(session.toolTokenHash, "hex"), Buffer.from(voiceTokenHash(input.token), "hex"))) throw forbidden("Voice tool scope does not match this session");
      if (session.state === "connecting") {
        await tx.update(chatVoiceSessions).set({ state: "active", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
        await tx.insert(activityLog).values({ companyId: session.companyId, actorType: "system", actorId: "voice-session-service", action: "voice.session.connected", entityType: "voice_session", entityId: session.id, details: { endpointId: session.endpointId, issueId: session.issueId } });
      }
      const prior = await tx.select().from(chatVoiceToolCalls).where(and(eq(chatVoiceToolCalls.sessionId, session.id), eq(chatVoiceToolCalls.providerToolCallId, input.envelope.tool_call_id))).then((rows) => rows[0]);
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) throw conflict("Voice tool retry changed its arguments");
        if (prior.tool === "get_updates") {
          const updates = Array.isArray(prior.response.updates) ? prior.response.updates : [];
          for (const update of updates) {
            if (!update || typeof update !== "object" || typeof update.publicationId !== "string") throw conflict("Invalid saved voice reply");
            const [publication] = await tx.select().from(chatPublications).where(and(
              eq(chatPublications.id, update.publicationId), eq(chatPublications.companyId, session.companyId),
              eq(chatPublications.endpointId, session.endpointId), eq(chatPublications.conversationId, session.conversationId),
              eq(chatPublications.issueId, session.issueId), eq(chatPublications.state, "published"))).for("share");
            if (!publication || publication.payload.text !== update.text) throw conflict("This voice reply changed; retrieve current updates");
          }
        }
        return prior.response;
      }
      const replay = await tx.select({ id: chatVoiceToolCalls.id }).from(chatVoiceToolCalls)
        .where(and(eq(chatVoiceToolCalls.companyId, session.companyId), eq(chatVoiceToolCalls.webhookId, input.webhookId))).then((rows) => rows[0]);
      if (replay) throw conflict("Voice webhook id was already used for a different tool call");
      let deliveryId: string | null = null, response: Record<string, unknown>;
      if (input.envelope.tool === "submit_request") {
        if (context.task.status === "backlog") throw conflict("Move this task to Todo in Paperclip before requesting voice work.");
        if (session.callerAuthority === "guest_intake") {
          const requests = await tx.select({id: chatVoiceToolCalls.id}).from(chatVoiceToolCalls).where(and(eq(chatVoiceToolCalls.sessionId, session.id), eq(chatVoiceToolCalls.tool, "submit_request"))).limit(20);
          if (requests.length >= 20) throw conflict("This call has reached its message limit. Continue in Paperclip.");
        }
        deliveryId = await input.accept(tx, context, input.envelope.args.text, input.envelope.tool_call_id);
        const delivery = await tx.select({ id: chatDeliveries.id }).from(chatDeliveries).where(and(eq(chatDeliveries.id, deliveryId), eq(chatDeliveries.companyId, session.companyId), eq(chatDeliveries.endpointId, session.endpointId))).then((rows) => rows[0]);
        if (!delivery) throw conflict("Voice request was not durably accepted");
        response = { status: "accepted", requestId: deliveryId, message: "Your request is saved. Work continues on the same task." };
      } else if (input.envelope.tool === "answer_question") {
        if (session.callerAuthority === "guest_intake") throw forbidden("Public callers can clarify in conversation, but cannot resolve protected task questions or approvals");
        const { interactionId, answers } = input.envelope.args;
        const [published] = await tx.select({ id: chatVoiceReplies.id }).from(chatVoiceReplies)
          .innerJoin(chatPublications, eq(chatPublications.id, chatVoiceReplies.publicationId))
          .where(and(eq(chatVoiceReplies.companyId, session.companyId), eq(chatVoiceReplies.sessionId, session.id),
            eq(chatPublications.companyId, session.companyId), eq(chatPublications.conversationId, session.conversationId),
            eq(chatPublications.issueId, session.issueId), eq(chatPublications.state, "published"),
            sql`${chatVoiceReplies.deliveredAt} is not null`, sql`${chatPublications.payload}->>'interactionId' = ${interactionId}`)).limit(1);
        if (!published) throw forbidden("This question was not presented to this voice session");
        const answered = await issueThreadInteractionService(tx as unknown as Db).answerQuestions(context.task, interactionId,
          { answers }, { userId: session.callerId });
        response = { status: "answered", interactionId, resultSha256: nativeSha256(answered.result), message: "Your answer was saved." };
      } else {
        await collectMissedReplies(tx, session);
        const cursor = input.envelope.args.cursor;
        const repeat = input.envelope.args.repeat === true;
        if (cursor > session.replyCursor) throw conflict("Voice reply cursor is ahead of this session");
        if (repeat) await collectRepeatReply(tx, session);
        // The durable delivered marker is authoritative. A later publication
        // can finish before an earlier stream; a caller cursor must not hide
        // that older, still-unclaimed answer when it eventually publishes.
        const available = await tx.select({ reply: chatVoiceReplies, payload: chatPublications.payload, pushBlocked: sql<boolean>`exists (select 1 from chat_actions a where a.company_id = ${session.companyId} and a.endpoint_id = ${session.endpointId} and a.kind = 'speko_voice_reply_push' and a.payload->>'replyId' = ${chatVoiceReplies.id}::text and (a.status in ('dispatching', 'unknown') or (a.status = 'completed' and a.payload->>'questionNotification' = 'false')))` }).from(chatVoiceReplies).innerJoin(chatPublications, and(eq(chatPublications.id, chatVoiceReplies.publicationId), eq(chatPublications.companyId, session.companyId)))
          .where(and(eq(chatVoiceReplies.sessionId, session.id), eq(chatVoiceReplies.companyId, session.companyId), repeat ? sql`${chatVoiceReplies.deliveredAt} is not null` : isNull(chatVoiceReplies.deliveredAt), eq(chatPublications.endpointId, session.endpointId), eq(chatPublications.conversationId, session.conversationId), eq(chatPublications.issueId, session.issueId), eq(chatPublications.state, "published")))
          .orderBy(repeat ? desc(chatVoiceReplies.deliveredAt) : asc(chatVoiceReplies.cursor), desc(chatVoiceReplies.cursor)).limit(repeat ? 1 : 8);
        // Never skip a partly pushed answer to retrieve later replies. The
        // accepted prefix cannot be replayed, and its suffix remains ordered.
        const pushBoundary = available.findIndex(row => row.pushBlocked);
        if (!repeat && pushBoundary >= 0) available.splice(pushBoundary);
        // Deliver a bounded burst in one voice turn. Separate typed hints would
        // interrupt the preceding answer. Stop at a question so later answers
        // cannot displace the clarification the caller must respond to.
        const boundary = available.findIndex(({ payload }) => typeof payload.interactionId === "string");
        if (boundary >= 0) available.splice(boundary + 1);
        if (available.length && !repeat) await tx.update(chatVoiceReplies).set({ deliveredAt: new Date() }).where(and(inArray(chatVoiceReplies.id, available.map((row) => row.reply.id)), isNull(chatVoiceReplies.deliveredAt)));
        const updates = [];
        for (const { reply, payload } of available) {
          let question: Record<string, unknown> | undefined;
          const interactionId = typeof payload.interactionId === "string" ? payload.interactionId : null;
          if (interactionId) {
            const [interaction] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, session.companyId),
              eq(issueThreadInteractions.issueId, session.issueId), eq(issueThreadInteractions.id, interactionId),
              eq(issueThreadInteractions.kind, "ask_user_questions"), eq(issueThreadInteractions.status, "pending")));
            if (interaction && evaluateIssueThreadInteractionResolverAudience({ actor: { type: "user", userId: session.callerId }, interaction }).allowed) {
              question = { interactionId, questions: (interaction.payload as { questions?: unknown }).questions };
            }
          }
          updates.push({ cursor: reply.cursor, publicationId: reply.publicationId, text: payload.text, ...(question ? { question } : {}) });
        }
        const work = updates.some(update => update.question)
          ? { state: "waiting_for_input", message: "The agent has a question for you in the approved updates." }
          : await workStatus(tx, context);
        const nextCursor = Math.max(cursor, available.at(-1)?.reply.cursor ?? 0);
        response = { status: available.length ? "updates" : "pending", work, playback: "unknown", ...(repeat ? { repeated: true } : {}), cursor: nextCursor, updates,
          ...(session.mode !== "browser" ? {delivery: "Approved task answers are pushed into this live call. Keep conversing; no completion polling is required."} : {}),
        };
      }
      await tx.insert(chatVoiceToolCalls).values({ companyId: session.companyId, sessionId: session.id, providerToolCallId: input.envelope.tool_call_id, webhookId: input.webhookId, fingerprint: input.fingerprint, tool: input.envelope.tool, deliveryId, response });
      return response;
    });
  }
  async function authorizePrincipal(tx: VoiceTransaction, companyId: string, endpointId: string, externalId: string) {
    const id = /^voice:([0-9a-f-]{36})$/.exec(externalId)?.[1];
    if (!id) throw forbidden("Invalid voice principal");
    const context = await endpointContext(tx, companyId, endpointId);
    const session = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, id), eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.endpointId, endpointId))).then((rows) => rows[0]);
    if (!session || !session.providerSessionId || session.generation !== context.generation || session.credentialFingerprint !== context.fingerprint || session.assignedAgentId !== context.endpoint.assignedAgentId
      || !["member", "instance_admin", "local_board", "guest_intake"].includes(session.callerAuthority)) throw forbidden("Voice work authority is no longer current");
    const accepted = await tx.select({ id: chatVoiceToolCalls.id }).from(chatVoiceToolCalls).where(and(eq(chatVoiceToolCalls.sessionId, id), eq(chatVoiceToolCalls.companyId, companyId), inArray(chatVoiceToolCalls.tool, ["submit_request", "answer_question"]))).limit(1);
    if (!accepted.length) throw forbidden("No request was accepted for this voice principal");
    // Accepted work survives hangup. Endpoint/identity revocation still takes
    // effect at the ordinary work-queue authorization boundary.
    const guest = session.callerAuthority === "guest_intake";
    if (!guest) {
      await authorizeCaller(tx, companyId, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
      await authorizeConnection(tx, context, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
    }
    const task = guest ? await authorizeGuestTask(tx, context, session) : await authorizeTask(tx, companyId, session.issueId, { id: session.callerId, authority: session.callerAuthority as VoiceCaller["authority"] });
    if (task.assigneeAgentId !== session.assignedAgentId) throw forbidden("The voice task assignment changed");
    return { allowed: true, linkedDenied: false, userId: guest ? null : session.callerId };
  }
  async function enqueuePublication(companyId: string, publicationId: string) {
    const publication = await db.select().from(chatPublications).where(and(eq(chatPublications.companyId, companyId), eq(chatPublications.id, publicationId), inArray(chatPublications.state, ["streaming", "published"]))).then((rows) => rows[0]);
    if (!publication) throw conflict("Voice publication is not dispatchable");
    // The voice persona already acknowledges accepted work. Synthetic chat
    // progress must not interrupt that acknowledgment or delay the real answer.
    if (publication.payload.progressState && !publication.payload.interactionId) {
      logger.debug({event: "voice.reply.publication.skipped_progress", companyId, endpointId: publication.endpointId,
        issueId: publication.issueId, publicationId}, "Synthetic working progress does not enqueue voice speech");
      return { id: `voice:${publicationId}` };
    }
    const candidates = await db.select({ id: chatVoiceSessions.id }).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.endpointId, publication.endpointId), eq(chatVoiceSessions.conversationId, publication.conversationId), inArray(chatVoiceSessions.state, ["connecting", "active"]))).orderBy(asc(chatVoiceSessions.id));
    for (const candidate of candidates) {
      try {
        await db.transaction(async (tx) => {
          const { session } = await authorizeSession(tx, companyId, candidate.id);
          const prior = await tx.select({ id: chatVoiceReplies.id }).from(chatVoiceReplies).where(and(eq(chatVoiceReplies.sessionId, session.id), eq(chatVoiceReplies.publicationId, publication.id))).then((rows) => rows[0]);
          if (prior) return;
          const [priorCall] = await tx.select({blocked: priorCallDeliveryBarrier(session, publication.id)})
            .from(chatPublications).where(eq(chatPublications.id, publication.id)).limit(1);
          if (priorCall?.blocked) return;
          const cursor = session.replyCursor + 1;
          await tx.insert(chatVoiceReplies).values({ companyId, sessionId: session.id, publicationId: publication.id, cursor });
          await tx.update(chatVoiceSessions).set({ replyCursor: cursor, updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
          return {sessionId: session.id, providerSessionId: session.providerSessionId, replyCursor: cursor, mode: session.mode};
        }).then(queued => {
          if (queued) logger.info({...queued, event: "voice.reply.publication.enqueued", companyId, endpointId: publication.endpointId,
            issueId: publication.issueId, publicationId}, "Approved publication queued for voice delivery");
        });
      } catch (error) { if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error; }
    }
    return { id: `voice:${publicationId}` };
  }
  async function notification(companyId: string, sessionId: string, callerId: string) {
    return db.transaction(async (tx) => {
      const { session } = await authorizeSession(tx, companyId, sessionId);
      if (session.callerId !== callerId) throw forbidden("This voice session belongs to another caller");
      await collectMissedReplies(tx, session);
      const [next] = await tx.select({ publicationId: chatVoiceReplies.publicationId, createdAt: chatVoiceReplies.createdAt }).from(chatVoiceReplies).innerJoin(chatPublications, eq(chatPublications.id, chatVoiceReplies.publicationId))
        .where(and(eq(chatVoiceReplies.companyId, companyId), eq(chatVoiceReplies.sessionId, sessionId), isNull(chatVoiceReplies.deliveredAt), eq(chatPublications.state, "published")))
        .orderBy(asc(chatVoiceReplies.cursor)).limit(1);
      return next ? { sessionId, generation: session.generation, publicationId: next.publicationId, attempt: Math.max(0, Math.floor((Date.now() - next.createdAt.getTime()) / 10_000)) } : null;
    });
  }
  return { endpointContext, authorizeConnection, reserve, stageDelivery, runTool, authorizeSession, authorizeCaller, authorizeTask, authorizePrincipal, enqueuePublication, notification, collectMissedReplies };
}
