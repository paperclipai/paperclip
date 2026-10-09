import { logger } from "../../middleware/logger.js";
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { chatEndpointResources, chatConversations, chatActions, chatEndpoints, chatVoiceInboundCalls, chatVoicePhoneLines, chatVoiceReports, chatVoiceSessions, activityLog, type Db } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, LOW_TRUST_REVIEW_PRESET_VERSION, LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } from "@paperclipai/shared";
import { buildChatCommunicationGuidance } from "../chat-communication-guidance.js";
import { environmentService } from "../environments.js";
import { assertEnvironmentSelectionForCompany } from "../../routes/environment-selection.js";
import { issueService } from "../issues.js";
import type { VoiceInboundCall, VoicePhoneConfiguration, VoiceSession } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import { authorizationService } from "../authorization.js";
import { instanceSettingsService } from "../instance-settings.js";
import { voiceSessionStore, voiceTokenHash, type VoiceCaller, type VoiceTransaction } from "./voice-session-store.js";
import { createSpekoProvider } from "./speko-provider.js";
import { verifySpekoSignature, type SpekoToolEnvelope } from "./speko-protocol.js";

type Endpoint = typeof chatEndpoints.$inferSelect;
type Admission = typeof chatVoiceInboundCalls.$inferSelect;
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
const eventSchema = z.object({ type: z.enum(["call.pre_call", "call.status", "call.report"]), call_id: id.optional(), session_id: id.optional(), organization_id: id.optional(), agent_id: id.optional(), direction: z.enum(["inbound", "outbound", "web"]).optional(), phone_number_id: id.nullable().optional(), dialed_number: z.string().nullable().optional(), status: z.string().optional() });
const projection = (row: Admission): VoiceInboundCall => ({ id: row.id, state: row.state, approvalCode: row.approvalCode, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), sessionId: row.sessionId, intakeIssueId: row.intakeIssueId });
/** No phone number or caller-ID lookup can impersonate an authenticated user. */
export function voiceInboundService(db: Db, options: {
  allowLocalBoard: boolean;
  credentials(endpoint: Endpoint, expectedFingerprint?: string): Promise<Record<string, string>>;
  provider?: typeof createSpekoProvider;
  start(input: { companyId: string; endpointId: string; issueId?: string; caller: VoiceCaller; idempotencyKey: string; maxDurationSeconds: number; mode: "inbound_phone"; providerSessionId: string; toolToken: string }): Promise<{session: VoiceSession}>;
  voicePrompt: string;
  lowTrustVoicePrompt: string;
}) {
  const store = voiceSessionStore(db, {...options, nonblockingAuthority: true}), provider = options.provider ?? createSpekoProvider;
  const issueSvc = issueService(db), environments = environmentService(db);
  async function sandboxChoices(companyId: string) {
    const choices = await environments.list({driver: "sandbox", status: "active"});
    const allowed = await Promise.all(choices.filter(e => e.config?.provider !== "fake").map(async e => {
      const owners = await environments.listBoundCompanyIds(e.id);
      return !owners.length || owners.includes(companyId) ? {id: e.id, name: e.name} : null;
    }));
    return allowed.filter((e): e is {id: string; name: string} => e !== null);
  }
  async function endpoint(companyId: string, endpointId: string) {
    const [row] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "speko")));
    if (!row) throw notFound("Voice connection not found"); return row;
  }
  async function enabled() { if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) throw forbidden("Voice connections are disabled"); }
  async function manager(companyId: string, caller: VoiceCaller, transaction?: VoiceTransaction) {
    const check = async (tx: VoiceTransaction) => {
      await store.authorizeCaller(tx, companyId, caller);
      if (caller.authority === "local_board" || caller.authority === "instance_admin" || (await authorizationService(tx).decidePrincipalGrant({companyId, principalType: "user", principalId: caller.id, permissionKey: "tools:manage_connections", action: "tools:manage_connections"})).allowed) return;
      throw forbidden("Missing permission: tools:manage_connections");
    };
    return transaction ? check(transaction) : db.transaction(check);
  }
  async function configuration(companyId: string, endpointId: string, caller: VoiceCaller): Promise<VoicePhoneConfiguration> {
    await enabled(); await manager(companyId, caller);
    const row = await endpoint(companyId, endpointId), credentials = await options.credentials(row);
    const numbers = await provider(credentials.apiKey).listPhoneNumbers();
    const [line] = await db.select().from(chatVoicePhoneLines).where(and(eq(chatVoicePhoneLines.companyId, companyId), eq(chatVoicePhoneLines.endpointId, endpointId)));
    return { number: line ? { id: line.providerNumberId, phoneNumber: line.phoneNumber, enabled: line.enabled, guestIntake: line.guestIntake, lowTrustEnvironmentId: line.lowTrustEnvironmentId } : null, sandboxEnvironments: await sandboxChoices(companyId), inventory: numbers.filter(n => n.organizationId === row.providerAccountId).map(n => ({ id: n.id, phoneNumber: n.e164, label: n.label, available: (!n.agentId || n.agentId === credentials.agentId) && !n.routeToBrokerId && !n.suspendedAt && n.direction !== "outbound", inboundReady: n.setupStatus.inboundReady, outboundReady: n.setupStatus.outboundReady, issues: n.setupStatus.issues })) };
  }
  async function saveConfiguration(companyId: string, endpointId: string, caller: VoiceCaller, input: { numberId: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null }) {
    await enabled(); await manager(companyId, caller);
    const row = await endpoint(companyId, endpointId);
    if (input.lowTrustEnvironmentId) {
      await assertEnvironmentSelectionForCompany(environments, companyId, input.lowTrustEnvironmentId, {allowedDrivers: ["sandbox"]});
      if (!(await sandboxChoices(companyId)).some(e => e.id === input.lowTrustEnvironmentId)) throw forbidden("Choose a sandbox available to this company");
    }
    const context = await db.transaction(tx => store.endpointContext(tx, companyId, endpointId));
    const credentials = await options.credentials(row, context.fingerprint), client = provider(credentials.apiKey);
    let numbers = await client.listPhoneNumbers(), number = numbers.find(n => n.id === input.numberId && n.organizationId === row.providerAccountId);
    if (!number || number.agentId && number.agentId !== credentials.agentId || number.routeToBrokerId || number.suspendedAt || number.direction === "outbound") throw conflict("Choose an available incoming number in this Speko workspace");
    // Only a verified connection can change routing. Do not remove another persona.
    if (input.enabled && !number.agentId) {
      await client.assignPhoneNumber(number.id, credentials.agentId);
      numbers = await client.listPhoneNumbers(); number = numbers.find(n => n.id === input.numberId);
    }
    if (input.enabled && (!number || number.agentId !== credentials.agentId || !number.setupStatus.inboundReady)) throw conflict("This number is not ready. Complete verification, credits or SIP setup in Speko, then refresh.");
    if (!number) throw conflict("Speko could not confirm this phone number");
    await db.transaction(async tx => {
      await manager(companyId, caller, tx);
      const current = await store.endpointContext(tx, companyId, endpointId);
      if (current.fingerprint !== context.fingerprint || current.generation !== context.generation) throw conflict("Voice configuration changed. Refresh before saving.");
      await tx.insert(chatVoicePhoneLines).values({companyId, endpointId, providerNumberId: number!.id, phoneNumber: number!.e164, enabled: input.enabled, guestIntake: input.guestIntake ?? false, lowTrustEnvironmentId: input.lowTrustEnvironmentId ?? null}).onConflictDoUpdate({target: chatVoicePhoneLines.endpointId, set: {providerNumberId: number!.id, phoneNumber: number!.e164, enabled: input.enabled, guestIntake: input.guestIntake ?? false, ...(input.lowTrustEnvironmentId !== undefined ? {lowTrustEnvironmentId: input.lowTrustEnvironmentId} : {}), updatedAt: new Date()}});
      await tx.insert(activityLog).values({companyId, actorType: "user", actorId: caller.id, action: "voice.phone_line.configured", entityType: "chat_endpoint", entityId: endpointId, details: {enabled: input.enabled, guestIntake: input.guestIntake ?? false}});
    });
    return configuration(companyId, endpointId, caller);
  }
  function token(row: Endpoint, providerSessionId: string, generation: number, secret: string) {
    return createHmac("sha256", secret).update(JSON.stringify(["paperclip-inbound-v1", row.companyId, row.id, providerSessionId, generation])).digest("base64url");
  }
  async function lifecycle(publicId: string, body: Buffer, headers: Record<string, string | string[] | undefined>) {
    await enabled();
    const [row] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.publicId, publicId), eq(chatEndpoints.provider, "speko")));
    if (!row) throw notFound("Voice connection not found");
    const credentials = await options.credentials(row);
    const { webhookId } = verifySpekoSignature({body, headers, keys: [{secret: credentials.signingSecret}]});
    const event = eventSchema.parse(JSON.parse(body.toString("utf8")));
    const providerSessionId = event.session_id ?? event.call_id;
    if (!providerSessionId || event.call_id && event.call_id !== providerSessionId || event.organization_id && event.organization_id !== row.providerAccountId || event.agent_id && event.agent_id !== credentials.agentId) throw forbidden("Invalid voice call identity");
    if (event.type === "call.pre_call") {
      if (event.direction === "outbound") return {idleRePrompts: {enabled: true, delayMs: 10_000, maxPrompts: 10, messages: ["I'm still working on it."]}};
      // Browser sessions use Paperclip result hints. The session-create API
      // rejects idleRePrompts; pre-call pipeline overrides support this setting.
      if (event.direction === "web") return {idleRePrompts: {enabled: false}};
      if (event.direction !== "inbound" || event.organization_id !== row.providerAccountId) throw forbidden("Invalid incoming call");
      const context = await db.transaction(tx => store.endpointContext(tx, row.companyId, row.id));
      const [line] = await db.select().from(chatVoicePhoneLines).where(and(eq(chatVoicePhoneLines.companyId, row.companyId), eq(chatVoicePhoneLines.endpointId, row.id), eq(chatVoicePhoneLines.enabled, true)));
      if (!line || line.providerNumberId !== event.phone_number_id || line.phoneNumber !== event.dialed_number) throw forbidden("Incoming calls are not enabled for this number");
      const capability = token(row, providerSessionId, context.generation, credentials.signingSecret);
      const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
      const existing = await db.transaction(async tx => {
        // Serialize admission per endpoint so concurrent rings cannot bypass quotas.
        await tx.execute(sql`set local lock_timeout = '500ms'`);
        await tx.execute(sql`set local statement_timeout = '2000ms'`);
        await tx.select({id: chatEndpoints.id}).from(chatEndpoints).where(eq(chatEndpoints.id, row.id)).for("update");
        const [prior] = await tx.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, row.companyId), eq(chatVoiceInboundCalls.endpointId, row.id), eq(chatVoiceInboundCalls.providerSessionId, providerSessionId)));
        if (prior) return prior;
        const recent = await tx.select({state: chatVoiceInboundCalls.state, expiresAt: chatVoiceInboundCalls.expiresAt}).from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, row.companyId), eq(chatVoiceInboundCalls.endpointId, row.id), gte(chatVoiceInboundCalls.createdAt, new Date(Date.now() - 3_600_000)))).limit(60);
        if (recent.length >= 60 || recent.filter(call => ["guest_intake", "awaiting_approval", "approving"].includes(call.state) && call.expiresAt.getTime() > Date.now()).length >= 10) throw conflict("This phone line has reached its incoming call limit. Try again later.");
        const [admission] = await tx.insert(chatVoiceInboundCalls).values({companyId: row.companyId, endpointId: row.id, providerSessionId, state: line.guestIntake ? "guest_intake" : "awaiting_approval", approvalCode: String(randomInt(100000, 1000000)), generation: context.generation, credentialFingerprint: context.fingerprint, toolTokenHash: voiceTokenHash(capability), requestFingerprint: fingerprint, callerAuthority: line.guestIntake ? "guest_intake" : null, expiresAt: new Date(Date.now() + (line.guestIntake ? 600_000 : 120_000))}).onConflictDoNothing().returning();
        return admission;
      });
      if (!existing || existing.requestFingerprint !== fingerprint || existing.toolTokenHash !== voiceTokenHash(capability) || !["awaiting_approval", "guest_intake"].includes(existing.state) || existing.expiresAt.getTime() <= Date.now()) throw forbidden("Incoming call is no longer pending");
      if (existing.state === "guest_intake") {
        return {
          toolSecrets: {paperclip_session_token: capability}, firstMessage: "Thanks for calling. What would you like to work on?",
          systemPrompt: `This call is a new, task-scoped conversation with the assigned Paperclip agent. Submit each caller request and follow-up using submit_request and speak approved replies pushed into this live call. Use get_updates for status, permitted questions, or an explicit repeat; no completion polling is required. Speak the actual replies; never invent a result. Ask normal clarifications as part of conversation and submit the caller's answers as follow-ups. Do not ask the caller to sign in or read an approval code. This caller is unverified: you cannot look up existing private tasks or approve governed actions. ${options.lowTrustVoicePrompt}`,
          idleRePrompts: {enabled: true, delayMs: 5000, maxPrompts: 10, messages: ["I'm still working on it."]},
        };
      }
      return { toolSecrets: {paperclip_session_token: capability}, firstMessage: `This is Paperclip. To continue, open this Speko connection in Paperclip and approve the live call with code ${existing.approvalCode.split("").join(" ")}.`, systemPrompt: `Before accepting any instructions, use get_updates to check approval. Until authorization is approved, do not submit work, answer task questions, infer identity from caller ID, or disclose any company information. Read the approval code ${existing.approvalCode} if asked. Keep checking get_updates while waiting. Once authorization is approved, ask the caller to repeat their request; instructions before approval were discarded. ${options.voicePrompt}`, idleRePrompts: {enabled: true, delayMs: 5000, maxPrompts: 10, messages: ["I'm waiting for you to approve this call in Paperclip."]} };
    }
    const [session] = await db.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, row.companyId), eq(chatVoiceSessions.endpointId, row.id), eq(chatVoiceSessions.providerSessionId, providerSessionId)));
    const [admission] = await db.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, row.companyId), eq(chatVoiceInboundCalls.endpointId, row.id), eq(chatVoiceInboundCalls.providerSessionId, providerSessionId)));
    if (!session && !admission) throw forbidden("Unknown voice call");
    // Store a digest for replay checks, never arbitrary provider payloads.
    const eventFingerprint = createHash("sha256").update(body).digest("hex");
    const acceptedEvent = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '500ms'`);
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      // Approval and guest tools lock admission before session; keep that order.
      if (admission) await tx.select({id: chatVoiceInboundCalls.id}).from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, admission.id)).for("update");
      const [receipt] = await tx.insert(chatActions).values({companyId: row.companyId, endpointId: row.id, kind: "speko_lifecycle_receipt", providerActionId: `speko_event:${webhookId}`, status: "completed", payload: {type: event.type, sessionId: session?.id ?? null, fingerprint: eventFingerprint}, result: {accepted: true}}).onConflictDoNothing().returning({id: chatActions.id});
      if (!receipt) {
        const [prior] = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.id), eq(chatActions.providerActionId, `speko_event:${webhookId}`)));
        if (prior?.payload.fingerprint !== eventFingerprint) throw conflict("Voice callback identity was reused for different content");
        return false;
      }
      if (event.type === "call.report" || event.status && ["ended", "failed"].includes(event.status)) {
        if (session) {
          await tx.update(chatVoiceSessions).set({state: event.status === "failed" ? "failed" : "ended", endedAt: session.endedAt ?? new Date(), updatedAt: new Date()}).where(eq(chatVoiceSessions.id, session.id));
          await tx.insert(chatVoiceReports).values({companyId: row.companyId, sessionId: session.id}).onConflictDoUpdate({target: chatVoiceReports.sessionId, set: {nextCheckAt: new Date()}});
        }
        if (admission) await tx.update(chatVoiceInboundCalls).set({state: "ended", updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, admission.id));
        await tx.insert(activityLog).values({companyId: row.companyId, actorType: "system", actorId: "speko-lifecycle", action: "voice.call.ended", entityType: session ? "voice_session" : "voice_inbound_call", entityId: session?.id ?? admission!.id, details: {endpointId: row.id}});
      }
      return true;
    });
    logger.info({event: "voice.call.lifecycle", companyId: row.companyId, endpointId: row.id,
      sessionId: session?.id ?? null, issueId: session?.issueId ?? null, providerSessionId,
      callbackType: event.type, terminal: event.type === "call.report" || ["ended", "failed"].includes(event.status ?? ""),
      duplicate: !acceptedEvent, previousSessionState: session?.state ?? null}, "Verified Speko lifecycle callback committed");
    return {accepted: true};
  }
  async function pendingTool(row: Endpoint, envelope: SpekoToolEnvelope, capability: string) {
    return db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '500ms'`);
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      const context = await store.endpointContext(tx, row.companyId, row.id);
      const [call] = await tx.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, row.companyId), eq(chatVoiceInboundCalls.endpointId, row.id), eq(chatVoiceInboundCalls.providerSessionId, envelope.session_id))).for("update");
      const hash = voiceTokenHash(capability);
      if (!call || !timingSafeEqual(Buffer.from(hash), Buffer.from(call.toolTokenHash)) || context.generation !== call.generation || context.fingerprint !== call.credentialFingerprint) throw forbidden("Invalid incoming call credential");
      if (call.expiresAt.getTime() <= Date.now() && ["guest_intake", "awaiting_approval", "approving"].includes(call.state)) { await tx.update(chatVoiceInboundCalls).set({state: "expired", updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, call.id)); return {authorization: "expired", status: "unavailable", updates: [], cursor: 0}; }
      if (call.state === "guest_intake") {
        const [line] = await tx.select().from(chatVoicePhoneLines).where(and(eq(chatVoicePhoneLines.companyId, row.companyId), eq(chatVoicePhoneLines.endpointId, row.id), eq(chatVoicePhoneLines.enabled, true), eq(chatVoicePhoneLines.guestIntake, true))).for("share");
        if (!line) throw forbidden("Guest intake is no longer enabled");
        if (envelope.tool === "get_updates") return {authorization: "guest_intake", status: call.intakeIssueId ? "intake_received" : "ready_for_intake", updates: [], cursor: 0};
        if (envelope.tool !== "submit_request") throw forbidden("Guest callers cannot answer private questions or approve actions");
        if (!call.sessionId) {
          const taskId = randomUUID(), conversationId = randomUUID(), threadId = `speko:${conversationId}`;
          const reviewPreset = {id: LOW_TRUST_REVIEW_PRESET, version: LOW_TRUST_REVIEW_PRESET_VERSION, rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION};
          const task = await issueSvc.create(row.companyId, {id: taskId, title: "Incoming phone conversation", description: "Conversation with an unverified phone caller. The agent runs under a task-scoped low-trust policy. You are on a live phone call and must attempt to answer as quickly as possible. Immediately post a brief, caller-safe task comment explaining what you are doing, then find the answer and post the result on this task so it can be spoken to the caller. Continue working after the initial update; do not treat it as the final answer. Preserve the task-scoped low-trust policy and ordinary permissions.", status: "todo", priority: "medium", assigneeAgentId: row.assignedAgentId, executionWorkspaceSettings: {mode: "isolated_workspace", workspaceStrategy: {type: "cloud_sandbox"}, ...(line.lowTrustEnvironmentId ? {environmentId: line.lowTrustEnvironmentId} : {})}, originKind: "chat_channel", originId: row.id, idempotencyKey: `guest-intake:${call.id}`, sourceTrust: {preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: taskId}, executionPolicy: {mode: "normal", commentRequired: true, stages: [], reviewPreset, authorizationPolicy: {trustPreset: LOW_TRUST_REVIEW_PRESET, reviewPreset, trustBoundary: {mode: LOW_TRUST_REVIEW_PRESET, companyId: row.companyId, rootIssueId: taskId, issueIds: [taskId], allowedAgentIds: [row.assignedAgentId], allowedToolClasses: [], allowedSecretBindingIds: []}}}}, tx);
          const [resource] = await tx.insert(chatEndpointResources).values({companyId: row.companyId, endpointId: row.id, type: "direct_message", providerResourceId: threadId, label: "Incoming phone conversation", enabled: true, availability: "available"}).returning();
          await tx.insert(chatConversations).values({id: conversationId, companyId: row.companyId, endpointId: row.id, resourceId: resource.id, issueId: task.id, externalConversationId: threadId, externalThreadId: threadId, externalLabel: "Incoming phone conversation", isDirectMessage: true, communicationGuidance: [buildChatCommunicationGuidance({ provider: "speko", isDirectMessage: true, communicationInstructions: row.communicationInstructions }), "This conversation is its own low-trust task. Use only context supplied in this conversation; do not browse other company tasks, secrets or private tools. Spoken consent does not grant governed authority."].join("\n\n")});
          const [session] = await tx.insert(chatVoiceSessions).values({companyId: row.companyId, endpointId: row.id, conversationId, issueId: task.id, assignedAgentId: row.assignedAgentId, callerId: `guest:${call.id}`, callerAuthority: "guest_intake", mode: "inbound_phone", state: "active", generation: call.generation, credentialFingerprint: call.credentialFingerprint, providerSessionId: call.providerSessionId, toolTokenHash: call.toolTokenHash, idempotencyKey: `guest:${call.id}`, requestFingerprint: call.requestFingerprint, createdAt: call.createdAt, expiresAt: call.expiresAt}).returning({id: chatVoiceSessions.id});
          await tx.update(chatVoiceInboundCalls).set({intakeIssueId: task.id, sessionId: session.id, updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, call.id));
          await tx.insert(activityLog).values({companyId: row.companyId, actorType: "system", actorId: "speko-inbound", action: "voice.low_trust_call.started", entityType: "issue", entityId: task.id, details: {callId: call.id, sessionId: session.id}});
        }
        const [bound] = await tx.select({sessionId: chatVoiceInboundCalls.sessionId}).from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, call.id));
        if (!bound?.sessionId) throw conflict("Incoming request could not be bound to its task");
        return {sessionId: bound.sessionId};
      }
      // No instructions, question answers, tasks or comments are accepted here.
      return {authorization: call.state, status: "unavailable", updates: [], cursor: 0, requestAccepted: false};
    });
  }
  async function list(companyId: string, endpointId: string, caller: VoiceCaller) {
    await enabled();
    await db.transaction(async tx => { await store.authorizeCaller(tx, companyId, caller); const context = await store.endpointContext(tx, companyId, endpointId); await store.authorizeConnection(tx, context, caller); });
    const rows = await db.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, companyId), eq(chatVoiceInboundCalls.endpointId, endpointId), inArray(chatVoiceInboundCalls.state, ["guest_intake", "awaiting_approval", "approving"]))).orderBy(desc(chatVoiceInboundCalls.createdAt)).limit(20);
    return rows.filter(row => !row.approvedByUserId || row.approvedByUserId === caller.id).map(projection);
  }
  async function history(companyId: string, endpointId: string, caller: VoiceCaller) {
    await enabled();
    return db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      const context = await store.endpointContext(tx, companyId, endpointId);
      await store.authorizeConnection(tx, context, caller);
      const rows = await tx.select({id: chatVoiceInboundCalls.id, state: chatVoiceInboundCalls.state, createdAt: chatVoiceInboundCalls.createdAt, updatedAt: chatVoiceInboundCalls.updatedAt}).from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.companyId, companyId), eq(chatVoiceInboundCalls.endpointId, endpointId), isNull(chatVoiceInboundCalls.sessionId), inArray(chatVoiceInboundCalls.state, ["denied", "expired", "ended"]))).orderBy(desc(chatVoiceInboundCalls.createdAt)).limit(20);
      return rows.map(row => ({...row, state: row.state as "denied" | "expired" | "ended", createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()}));
    });
  }
  async function decide(companyId: string, endpointId: string, callId: string, caller: VoiceCaller, input: {approve: boolean; approvalCode: string; issueId?: string}) {
    await enabled();
    let admission = await db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      const context = await store.endpointContext(tx, companyId, endpointId); await store.authorizeConnection(tx, context, caller);
      const [row] = await tx.select().from(chatVoiceInboundCalls).where(and(eq(chatVoiceInboundCalls.id, callId), eq(chatVoiceInboundCalls.companyId, companyId), eq(chatVoiceInboundCalls.endpointId, endpointId))).for("update");
      if (!row) throw notFound("Incoming call not found");
      if (row.approvalCode !== input.approvalCode) throw forbidden("Confirm the approval code spoken on this live call");
      if (row.expiresAt.getTime() <= Date.now() || row.generation !== context.generation || row.credentialFingerprint !== context.fingerprint) throw conflict("This incoming call expired. Start a new call.");
      if (row.approvedByUserId && row.approvedByUserId !== caller.id) throw forbidden("This call was claimed by another user");
      if (row.state === "approved") { if (row.requestedIssueId !== (input.issueId ?? row.intakeIssueId ?? null)) throw conflict("This call is already bound to another task"); return row; }
      if (!["guest_intake", "awaiting_approval", "approving"].includes(row.state)) throw conflict("This incoming call is no longer waiting for approval");
      if (row.state === "approving" && (!input.approve || row.requestedIssueId !== (input.issueId ?? row.intakeIssueId ?? null))) throw conflict("This call is already being approved");
      if (input.issueId) await store.authorizeTask(tx, companyId, input.issueId, caller);
      const [changed] = await tx.update(chatVoiceInboundCalls).set({state: input.approve ? "approving" : row.state === "guest_intake" ? "ended" : "denied", approvedByUserId: caller.id, callerAuthority: caller.authority, requestedIssueId: input.issueId ?? row.intakeIssueId ?? null, updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, row.id)).returning();
      await tx.insert(activityLog).values({companyId, actorType: "user", actorId: caller.id, action: input.approve ? "voice.inbound.approval_started" : row.state === "guest_intake" ? "voice.low_trust_call.ended" : "voice.inbound.denied", entityType: "voice_inbound_call", entityId: row.id});
      if (!input.approve && row.state === "guest_intake" && row.sessionId) await tx.update(chatVoiceSessions).set({state: "ending", updatedAt: new Date()}).where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.id, row.sessionId)));
      return changed;
    });
    if (admission.state === "approved") return projection(admission);
    const row = await endpoint(companyId, endpointId), credentials = await options.credentials(row, admission.credentialFingerprint);
    const client = provider(credentials.apiKey);
    if (!input.approve) { await client.endSession(admission.providerSessionId).catch(() => undefined); return projection(admission); }
    if ((await client.inspectSession(admission.providerSessionId)).endedAt) { await db.update(chatVoiceInboundCalls).set({state: "ended", updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, callId)); throw conflict("The caller already hung up"); }
    const result = await options.start({companyId, endpointId, issueId: admission.requestedIssueId ?? undefined, caller, idempotencyKey: `inbound:${admission.id}`, maxDurationSeconds: 600, mode: "inbound_phone", providerSessionId: admission.providerSessionId, toolToken: token(row, admission.providerSessionId, admission.generation, credentials.signingSecret)});
    [admission] = await db.update(chatVoiceInboundCalls).set({state: "approved", sessionId: result.session.id, updatedAt: new Date()}).where(and(eq(chatVoiceInboundCalls.id, callId), eq(chatVoiceInboundCalls.state, "approving"))).returning();
    if (!admission) throw conflict("This call ended during approval");
    return projection(admission);
  }
  async function authorizeGuest(sessionId: string) {
    const [session] = await db.select({companyId: chatVoiceSessions.companyId}).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, sessionId), eq(chatVoiceSessions.callerAuthority, "guest_intake")));
    if (!session) return false;
    try { await db.transaction(tx => store.authorizeSession(tx, session.companyId, sessionId)); return true; }
    catch (error) { if (error instanceof Error && "status" in error && [403, 404].includes(Number(error.status))) return false; throw error; }
  }
  async function reconcile(limit: number) {
    await db.delete(chatVoiceInboundCalls).where(and(isNull(chatVoiceInboundCalls.sessionId), isNull(chatVoiceInboundCalls.intakeIssueId), inArray(chatVoiceInboundCalls.state, ["denied", "expired", "ended"]), lte(chatVoiceInboundCalls.expiresAt, new Date(Date.now() - 7 * 86_400_000))));
    const rows = await db.select().from(chatVoiceInboundCalls).where(and(inArray(chatVoiceInboundCalls.state, ["guest_intake", "awaiting_approval", "approving", "denied", "expired"]), lte(chatVoiceInboundCalls.expiresAt, new Date()))).orderBy(asc(chatVoiceInboundCalls.updatedAt)).limit(limit);
    for (const call of rows) {
      try {
        const row = await endpoint(call.companyId, call.endpointId), credentials = await options.credentials(row);
        const client = provider(credentials.apiKey), state = await client.inspectSession(call.providerSessionId);
        if (state.endedAt) await db.update(chatVoiceInboundCalls).set({state: "ended", updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, call.id));
        else { await db.update(chatVoiceInboundCalls).set({state: "expired", updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, call.id)); await client.endSession(call.providerSessionId); }
      } catch { await db.update(chatVoiceInboundCalls).set({updatedAt: new Date()}).where(eq(chatVoiceInboundCalls.id, call.id)); }
    }
  }
  return {configuration, saveConfiguration, lifecycle, pendingTool, list, decide, reconcile, authorizeGuest, history};
}
