import { logger } from "../../middleware/logger.js";
import { captureVoiceDeliveryDiagnostics } from "./voice-delivery-diagnostics.js";
import { pushVoiceReplies } from "./voice-reply-push.js";
import { voiceInboundService } from "./voice-inbound-service.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { chatVoiceReports, chatVoiceCallbacks, chatConversations, chatEndpointResources, chatEndpoints, chatVoiceSessions, issues, toolConnections, activityLog, type Db } from "@paperclipai/db";
import { VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION, type VoiceSession, type VoiceSessionMedia, type VoiceCallHistoryEntry, type VoiceCallReport } from "@paperclipai/shared";
import { conflict, forbidden, notFound, HttpError } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { buildChatCommunicationGuidance } from "../chat-communication-guidance.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";
import { createSpekoProvider, SpekoProviderError } from "./speko-provider.js";
import { serializeVoiceSession, voiceSessionStore, type VoiceCaller, type VoiceSessionRow } from "./voice-session-store.js";
import { syncSpekoVoiceTools, registerSpekoVoiceRuntime } from "./speko-agent-tools.js";
import { verifySpekoToolRequest } from "./speko-protocol.js";
import { VOICE_PROMPT, PHONE_VOICE_PROMPT, LOW_TRUST_PHONE_VOICE_PROMPT } from "./voice-prompts.js";

const liveStates = ["reserved", "creating", "creation_unknown", "connecting", "active", "ending"] as const;
const terminalStates = ["ended", "failed", "expired"] as const;

type Endpoint = typeof chatEndpoints.$inferSelect;
export function voiceSessionService(db: Db, options: {
  allowLocalBoard: boolean;
  credentials(endpoint: Endpoint, expectedFingerprint?: string): Promise<Record<string, string>>;
  provider?: typeof createSpekoProvider;
  /** Queue the canonical response delivery after its durable receipt commits. */
  onQuestionAnswered(interactionId: string): void;
}) {
  const store = voiceSessionStore(db, options), issueSvc = issueService(db);
  const provider = options.provider ?? createSpekoProvider;

  async function endpointFor(companyId: string, endpointId: string) {
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.provider, "speko")));
    if (!endpoint) throw notFound("Voice connection not found");
    return endpoint;
  }
  async function ownedSession(companyId: string, sessionId: string, caller: VoiceCaller, content = true) {
    return db.transaction(async (tx) => {
      const [session] = await tx.select().from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.id, sessionId)));
      if (!session) throw notFound("Voice session not found");
      if (session.callerId !== caller.id) throw forbidden("This voice session belongs to another caller");
      if (content) await store.authorizeTask(tx, companyId, session.issueId, caller, false);
      return session;
    });
  }
  async function start(input: { companyId: string; endpointId: string; issueId?: string; newConversation?: boolean; caller: VoiceCaller; idempotencyKey: string; maxDurationSeconds: number; mode?: "outbound_phone" | "inbound_phone"; phoneNumber?: string; providerSessionId?: string; toolToken?: string }): Promise<{ session: VoiceSession; media?: VoiceSessionMedia }> {
    if (input.mode === "outbound_phone" && !(await instanceSettingsService(db).getExperimental()).enableChatConnectors) throw forbidden("Voice connections are disabled");
    const endpoint = await endpointFor(input.companyId, input.endpointId);
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ endpointId: input.endpointId, issueId: input.issueId ?? null, maxDurationSeconds: input.maxDurationSeconds, ...(input.mode ? { mode: input.mode, phoneNumber: input.phoneNumber, providerSessionId: input.providerSessionId } : {}), ...(input.newConversation ? { newConversation: true } : {}) })).digest("hex");
    const reserved = await store.reserve({ ...input, requestFingerprint, prepareBinding: async (tx) => {
      // One lock per task preserves the existing conversation on concurrent resumes.
      if (input.issueId) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-binding:${input.companyId}:${input.endpointId}:${input.issueId}`}, 0))`);
      // Serialize generic starts per authenticated caller/endpoint, including
      // different request keys. Session history is durable ownership evidence;
      // never infer ownership from a provider caller ID or a display name.
      let issueId = input.issueId;
      if (!issueId) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-caller:${input.companyId}:${input.endpointId}:${input.caller.id}`}, 0))`);
        if (!input.newConversation) {
          const candidates = await tx.select({ issueId: chatVoiceSessions.issueId }).from(chatVoiceSessions)
            .innerJoin(issues, and(eq(issues.id, chatVoiceSessions.issueId), eq(issues.companyId, chatVoiceSessions.companyId)))
            .innerJoin(chatConversations, eq(chatConversations.id, chatVoiceSessions.conversationId))
            .where(and(eq(chatVoiceSessions.companyId, input.companyId), eq(chatVoiceSessions.endpointId, input.endpointId),
              eq(chatVoiceSessions.callerId, input.caller.id), eq(issues.originKind, "chat_channel"), eq(issues.originId, input.endpointId),
              eq(issues.assigneeAgentId, endpoint.assignedAgentId), notInArray(issues.status, ["cancelled", "done"]),
              inArray(chatConversations.state, ["active", "waiting"])))
            .orderBy(desc(chatVoiceSessions.createdAt), desc(chatVoiceSessions.id)).limit(20);
          for (const candidate of candidates) {
            try { await store.authorizeTask(tx, input.companyId, candidate.issueId, input.caller); issueId = candidate.issueId; break; }
            catch (error) { if (!(error instanceof HttpError && [403, 404].includes(error.status))) throw error; }
          }
        }
      }
      const task = issueId
        ? await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))).then((rows) => rows[0])
        : await issueSvc.create(input.companyId, { title: "Voice conversation", status: "todo", priority: "medium", assigneeAgentId: endpoint.assignedAgentId, createdByUserId: input.caller.id, responsibleUserId: input.caller.id, originKind: "chat_channel", originId: endpoint.id, idempotencyKey: `voice:${input.caller.id}:${input.idempotencyKey}` }, tx);
      if (!task) throw notFound("Task not found");
      if (task.assigneeAgentId !== endpoint.assignedAgentId) throw conflict("Choose a voice connection for this task's assigned agent");
      const existing = await tx.select().from(chatConversations).where(and(eq(chatConversations.companyId, input.companyId), eq(chatConversations.endpointId, input.endpointId), eq(chatConversations.issueId, task.id))).limit(1).then((rows) => rows[0]);
      if (existing) {
        if (!["active", "waiting"].includes(existing.state)) throw conflict("This voice conversation is no longer available");
        return { issueId: task.id, conversationId: existing.id };
      }
      const conversationId = randomUUID(), threadId = `speko:${conversationId}`;
      const [resource] = await tx.insert(chatEndpointResources).values({ companyId: input.companyId, endpointId: input.endpointId, type: "direct_message", providerResourceId: threadId, label: "Voice conversation", enabled: true, availability: "available" }).returning();
      await tx.insert(chatConversations).values({ id: conversationId, companyId: input.companyId, endpointId: input.endpointId, resourceId: resource.id, issueId: task.id, externalConversationId: threadId, externalThreadId: threadId, externalLabel: "Voice conversation", communicationGuidance: buildChatCommunicationGuidance({ provider: "speko", isDirectMessage: true, communicationInstructions: endpoint.communicationInstructions }), isDirectMessage: true });
      return { issueId: task.id, conversationId };
    } });
    // Media credentials are intentionally not stored or reissued. An uncertain
    // browser response must inspect/end this attempt, never blindly create again.
    if (!reserved.created || input.mode === "inbound_phone") return { session: serializeVoiceSession(reserved.session) };
    const session = reserved.session;
    const [claim] = await db.update(chatVoiceSessions).set({ state: "creating", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "reserved"))).returning({ id: chatVoiceSessions.id });
    if (!claim) throw conflict("The call was ended before Speko connected");
    let client: ReturnType<typeof createSpekoProvider> | undefined;
    let created: { sessionId: string; transportToken?: string; transportUrl?: string };
    try {
      const credentials = await options.credentials(endpoint, session.credentialFingerprint);
      if (!credentials.agentId || !credentials.apiKey) throw new SpekoProviderError("credentials_rejected", false);
      await db.transaction((tx) => store.authorizeSession(tx, input.companyId, session.id, ["creating"]));
      client = provider(credentials.apiKey);
      const shared = { agentId: credentials.agentId, bindingId: session.id, toolToken: reserved.token, maxDurationSeconds: input.maxDurationSeconds };
      created = input.mode === "outbound_phone"
        ? await client.createPhoneSession({ ...shared, to: input.phoneNumber!, systemPrompt: PHONE_VOICE_PROMPT })
        : await client.createBrowserSession({ ...shared, systemPrompt: VOICE_PROMPT });
    } catch (error) {
      const known = error instanceof SpekoProviderError && !error.outcomeUnknown || error instanceof HttpError && [403, 404].includes(error.status);
      await db.update(chatVoiceSessions).set({ state: known ? "failed" : "creation_unknown", errorCode: error instanceof SpekoProviderError ? error.code : "provider_unavailable", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "creating")));
      if (error instanceof SpekoProviderError && error.code === "insufficient_credits") throw conflict("Speko needs credits before starting a call. Add credits in Speko, then try again.", {code: "voice_credits_required", sessionId: session.id});
      throw conflict(known ? "Speko could not start the call. Check connection status before trying again." : "Speko may have started this call. Inspect this attempt before starting another.", { code: known ? "voice_creation_failed" : "voice_creation_unknown", sessionId: session.id });
    }
    let bound: VoiceSessionRow | undefined;
    try {
    [bound] = await db.update(chatVoiceSessions).set({ providerSessionId: created.sessionId, state: "connecting", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), eq(chatVoiceSessions.state, "creating"))).returning();
    } catch (error) {
      // If the provider started but persistence failed, stop that exact call.
      // Never return media or retry creation on an uncertain database outcome.
      await client!.endSession(created.sessionId).catch(() => undefined);
      throw conflict("The call could not be saved. Inspect this attempt before starting another.", { code: "voice_creation_unknown", sessionId: session.id });
    }
    if (!bound) {
      // A concurrent end must still learn the provider identity for reconciliation.
      await db.update(chatVoiceSessions).set({ providerSessionId: created.sessionId, state: "ending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
      await closeProvider({ ...session, providerSessionId: created.sessionId, state: "ending" });
      throw conflict("The call was ended while Speko was connecting");
    }
    try { await db.transaction((tx) => store.authorizeSession(tx, input.companyId, session.id)); }
    catch (error) { await closeProvider(bound).catch(() => undefined); throw error; }
    return { session: serializeVoiceSession(bound), ...(created.transportToken && created.transportUrl ? { media: { sessionId: session.id, generation: session.generation, transportToken: created.transportToken, transportUrl: created.transportUrl } } : {}) };
  }
  const closingSessions = new Map<string, Promise<VoiceSessionRow>>();
  function closeProvider(session: VoiceSessionRow): Promise<VoiceSessionRow> {
    const pending = closingSessions.get(session.id);
    if (pending) return pending;
    const operation = closeProviderOnce(session).finally(() => closingSessions.delete(session.id));
    closingSessions.set(session.id, operation);
    return operation;
  }
  async function closeProviderOnce(session: VoiceSessionRow) {
    if (terminalStates.some(state => state === session.state)) return session;
    await db.transaction(async (tx) => {
      const [changed] = await tx.update(chatVoiceSessions).set({ state: "ending", updatedAt: new Date() }).where(and(eq(chatVoiceSessions.id, session.id), inArray(chatVoiceSessions.state, [...liveStates].filter((state) => state !== "ending")))).returning({ id: chatVoiceSessions.id });
      if (changed) await tx.insert(activityLog).values({ companyId: session.companyId, actorType: "system", actorId: "voice-session-service", action: "voice.session.ending", entityType: "voice_session", entityId: session.id, details: { issueId: session.issueId } });
    });
    if (session.providerSessionId) {
      const endpoint = await endpointFor(session.companyId, session.endpointId), credentials = await options.credentials(endpoint);
      const client = provider(credentials.apiKey);
      // Closing the SDK room can race the provider end request. Confirm the
      // exact existing call before presenting an ambiguous rejection as failure.
      let confirmed = false;
      try { confirmed = (await client.endSession(session.providerSessionId)).confirmed; }
      catch (error) { if (!(error instanceof SpekoProviderError)) throw error; }
      if (!confirmed) {
        try { confirmed = Boolean((await client.inspectSession(session.providerSessionId)).endedAt); }
        catch (error) { if (!(error instanceof SpekoProviderError)) throw error; }
      }
      await db.update(chatVoiceSessions).set(confirmed
        ? { state: "ended", endedAt: new Date(), errorCode: null, updatedAt: new Date() }
        : { errorCode: "cleanup_pending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
    } else if (session.state === "reserved") {
      await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
    }
    return db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, session.id)).then((rows) => rows[0]);
  }
  async function inspect(companyId: string, sessionId: string, caller: VoiceCaller) {
    let session = await ownedSession(companyId, sessionId, caller);
    if (session.providerSessionId && !terminalStates.some(state => state === session.state)) {
      const endpoint = await endpointFor(companyId, session.endpointId), credentials = await options.credentials(endpoint);
      const state = await provider(credentials.apiKey).inspectSession(session.providerSessionId);
      if (state.endedAt) {
        [session] = await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, sessionId)).returning();
      }
    }
    return serializeVoiceSession(session);
  }
  async function end(companyId: string, sessionId: string, caller: VoiceCaller) {
    const session = await ownedSession(companyId, sessionId, caller, false);
    return serializeVoiceSession(await closeProvider(session));
  }
  async function tool(publicId: string, body: Buffer, headers: Record<string, string | string[] | undefined>) {
    const endpoint = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.publicId, publicId), eq(chatEndpoints.provider, "speko"))).then((rows) => rows[0]);
    if (!endpoint) throw notFound("Voice endpoint not found");
    const credentials = await options.credentials(endpoint);
    const verified = verifySpekoToolRequest({ body, headers, keys: [{ secret: credentials.signingSecret }] });
    const authorization = headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw forbidden("Missing voice session credential");
    let session = await db.select({ id: chatVoiceSessions.id, authority: chatVoiceSessions.callerAuthority, mode: chatVoiceSessions.mode }).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.companyId, endpoint.companyId), eq(chatVoiceSessions.endpointId, endpoint.id), eq(chatVoiceSessions.providerSessionId, verified.envelope.session_id))).then((rows) => rows[0]);
    if (!session) {
      const pending = await inbound.pendingTool(endpoint, verified.envelope, authorization.slice(7));
      if (!("sessionId" in pending) || typeof pending.sessionId !== "string") return pending;
      session = await db.select({id: chatVoiceSessions.id, authority: chatVoiceSessions.callerAuthority, mode: chatVoiceSessions.mode}).from(chatVoiceSessions).where(and(eq(chatVoiceSessions.id, pending.sessionId), eq(chatVoiceSessions.companyId, endpoint.companyId), eq(chatVoiceSessions.endpointId, endpoint.id))).then(rows => rows[0]);
      if (!session) throw conflict("Incoming request could not be bound to its task");
    }
    const result = await store.runTool({ ...verified, companyId: endpoint.companyId, endpointId: endpoint.id, sessionId: session.id, token: authorization.slice(7), accept: store.stageDelivery });
    // Do not await execution within Speko's four-second webhook budget. The
    // shared delivery service deduplicates retries; its sweep repairs crashes.
    if (verified.envelope.tool === "answer_question") options.onQuestionAnswered(verified.envelope.args.interactionId);
    return session.mode === "inbound_phone" ? {...result, authorization: session.authority === "guest_intake" ? "guest_intake" : "approved"} : result;
  }
  async function reconcile(limit = 25) {
    // Provider maximum duration is the final bound even if creation response was
    // lost. Unknown attempts remain reserved until that bound plus teardown grace.
    const enabled = (await instanceSettingsService(db).getExperimental()).enableChatConnectors;
    const rows = await db.select({ session: chatVoiceSessions }).from(chatVoiceSessions)
      .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatVoiceSessions.endpointId))
      .innerJoin(toolConnections, eq(toolConnections.id, chatEndpoints.connectionId))
      .where(and(inArray(chatVoiceSessions.state, [...liveStates]), or(
        enabled ? undefined : sql`true`,
        lte(chatVoiceSessions.expiresAt, new Date()), eq(chatVoiceSessions.state, "ending"),
        notInArray(chatEndpoints.status, ["active", "verifying"]), eq(toolConnections.enabled, false),
        sql`${chatVoiceSessions.generation} <> coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0)`,
        // Recheck membership and bindings periodically even without callbacks.
        and(inArray(chatVoiceSessions.state, ["connecting", "active"]), lte(chatVoiceSessions.updatedAt, new Date(Date.now() - 30_000))),
      ))).orderBy(asc(chatVoiceSessions.updatedAt)).limit(limit);
    for (const { session } of rows) {
      try {
        let authorized = false;
        if (enabled && ["connecting", "active"].includes(session.state) && session.callerAuthority === "guest_intake" && session.expiresAt.getTime() > Date.now()) {
          authorized = await inbound.authorizeGuest(session.id);
        } else if (enabled && ["connecting", "active"].includes(session.state)) {
          try { await db.transaction((tx) => store.authorizeSession(tx, session.companyId, session.id)); authorized = true; } catch { /* revoked, changed binding, or expired */ }
        }
        if (authorized) {
          // A caller can hang up without a final browser request. Poll provider
          // state as well as permissions so a missed callback releases the task.
          const endpoint = await endpointFor(session.companyId, session.endpointId);
          const credentials = await options.credentials(endpoint);
          const state = session.providerSessionId ? await provider(credentials.apiKey).inspectSession(session.providerSessionId) : null;
          await db.update(chatVoiceSessions).set({
            ...(state?.endedAt ? { state: "ended", endedAt: new Date(), errorCode: null } : {}),
            updatedAt: new Date(),
          }).where(and(eq(chatVoiceSessions.id, session.id), inArray(chatVoiceSessions.state, ["connecting", "active"])));
          continue;
        }
        if (session.providerSessionId) await closeProvider(session);
        else if (session.expiresAt.getTime() + 120_000 < Date.now()) await db.update(chatVoiceSessions).set({ state: "expired", endedAt: new Date(), updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
      } catch {
        await db.update(chatVoiceSessions).set({ errorCode: "cleanup_pending", updatedAt: new Date() }).where(eq(chatVoiceSessions.id, session.id));
      }
    }
    await pushReplies(limit);
    await inbound.reconcile(limit);
    await reconcileReports(limit);
    return rows.length;
  }
  async function pushReplies(limit = 25, companyId?: string, endpointId?: string) {
    return pushVoiceReplies(db, {store, credentials: options.credentials, provider, limit, companyId, endpointId});
  }
  function reportProjection(row?: typeof chatVoiceReports.$inferSelect): VoiceCallReport {
    return row ? { status: row.status, transcript: row.transcript.filter(turn => turn.speaker !== "caller" || ![VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION].includes(turn.text)), costMicroUsd: row.costMicroUsd, durationSeconds: row.durationSeconds, updatedAt: row.updatedAt.toISOString() }
      : { status: "pending", transcript: [], costMicroUsd: null, durationSeconds: null, updatedAt: null };
  }
  async function history(companyId: string, endpointId: string, caller: VoiceCaller): Promise<VoiceCallHistoryEntry[]> {
    await endpointFor(companyId, endpointId);
    return db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      const rows = await tx.select({ session: chatVoiceSessions, report: chatVoiceReports }).from(chatVoiceSessions)
        .leftJoin(chatVoiceReports, and(eq(chatVoiceReports.sessionId, chatVoiceSessions.id), eq(chatVoiceReports.companyId, chatVoiceSessions.companyId)))
        .where(and(eq(chatVoiceSessions.companyId, companyId), eq(chatVoiceSessions.endpointId, endpointId), or(eq(chatVoiceSessions.callerId, caller.id), eq(chatVoiceSessions.callerAuthority, "guest_intake"))))
        .orderBy(desc(chatVoiceSessions.createdAt), desc(chatVoiceSessions.id)).limit(50);
      const result: VoiceCallHistoryEntry[] = [];
      for (const row of rows) {
        try { await store.authorizeTask(tx, companyId, row.session.issueId, caller, false); }
        catch (error) { if (error instanceof HttpError && [403,404].includes(error.status)) continue; throw error; }
        result.push({ session: serializeVoiceSession(row.session), report: reportProjection(row.report ?? undefined) });
      }
      return result;
    });
  }
  async function callDetail(companyId: string, sessionId: string, caller: VoiceCaller): Promise<VoiceCallHistoryEntry> {
    const session = await ownedSession(companyId, sessionId, caller);
    const [report] = await db.select().from(chatVoiceReports).where(and(eq(chatVoiceReports.companyId, companyId), eq(chatVoiceReports.sessionId, session.id)));
    return { session: serializeVoiceSession(session), report: reportProjection(report) };
  }
  async function reconcileReports(limit: number) {
    // Repair missed lifecycle callbacks, including later recording-ready reports.
    // GET the same call; never create a call or download provider recordings.
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db.select({ session: chatVoiceSessions, report: chatVoiceReports }).from(chatVoiceSessions)
      .leftJoin(chatVoiceReports, and(eq(chatVoiceReports.sessionId, chatVoiceSessions.id), eq(chatVoiceReports.companyId, chatVoiceSessions.companyId)))
      .where(and(inArray(chatVoiceSessions.state, terminalStates), sql`${chatVoiceSessions.providerSessionId} is not null`,
        sql`${chatVoiceSessions.endedAt} >= ${recent.toISOString()}`, or(sql`${chatVoiceReports.sessionId} is null`, lte(chatVoiceReports.nextCheckAt, new Date()))))
      .orderBy(asc(sql`coalesce(${chatVoiceReports.nextCheckAt}, ${chatVoiceSessions.endedAt})`)).limit(limit);
    for (const {session, report} of rows) {
      const attempts = (report?.attempts ?? 0) + 1;
      const retryAt = new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000);
      await db.insert(chatVoiceReports).values({ sessionId: session.id, companyId: session.companyId }).onConflictDoNothing();
      try {
        const endpoint = await endpointFor(session.companyId, session.endpointId);
        const credentials = await options.credentials(endpoint, session.credentialFingerprint);
        const client = provider(credentials.apiKey);
        const result = await client.callReport(session.providerSessionId!, [credentials.signingSecret]);
        logger.info({event: "voice.call.report_received", companyId: session.companyId, endpointId: session.endpointId,
          issueId: session.issueId, sessionId: session.id, providerSessionId: session.providerSessionId, attempts,
          complete: result.complete, transcriptTurns: result.transcript.length, providerUpdatedAt: result.providerUpdatedAt?.toISOString() ?? null}, "Speko call report received for reconciliation");
        await captureVoiceDeliveryDiagnostics(db, session, client, result.complete);
        if (!result.complete && report?.status === "available") {
          await db.update(chatVoiceReports).set({ attempts, nextCheckAt: retryAt }).where(eq(chatVoiceReports.sessionId, session.id));
          continue;
        }
        await db.update(chatVoiceReports).set({
          transcript: result.transcript, costMicroUsd: result.costMicroUsd, durationSeconds: result.durationSeconds,
          providerUpdatedAt: result.providerUpdatedAt, status: result.complete ? "available" : "pending", attempts, nextCheckAt: retryAt, updatedAt: new Date(),
        }).where(and(eq(chatVoiceReports.sessionId, session.id), eq(chatVoiceReports.companyId, session.companyId),
          // A stale report must never replace a newer completed report.
          result.providerUpdatedAt ? or(sql`${chatVoiceReports.providerUpdatedAt} is null`, lte(chatVoiceReports.providerUpdatedAt, result.providerUpdatedAt)) : sql`${chatVoiceReports.providerUpdatedAt} is null`));
        // Keep both actual spoken sides on this public call's own task. This
        // does not publish a document or grant access to any other task.
        if (session.callerAuthority === "guest_intake") await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice-transcript:${session.id}`}, 0))`);
          const [retained] = await tx.select().from(chatVoiceReports).where(and(eq(chatVoiceReports.companyId, session.companyId), eq(chatVoiceReports.sessionId, session.id)));
          if (!retained?.transcript.length) return;
          const [task] = await tx.select({sourceTrust: issues.sourceTrust}).from(issues).where(and(eq(issues.companyId, session.companyId), eq(issues.id, session.issueId)));
          if (task?.sourceTrust?.preset !== "low_trust_review" || task.sourceTrust.disposition !== "quarantined") return;
          const key = `voice-transcript-${session.id}`;
          const body = retained.transcript.map(turn => `**${turn.speaker === "caller" ? "Caller" : "Agent"}** · ${turn.startedAt}${turn.interrupted ? " · interrupted" : ""}\n\n${turn.text}`).join("\n\n---\n\n");
          const docs = documentService(tx as unknown as Db), previous = await docs.getIssueDocumentByKey(session.issueId, key);
          if (previous?.body === body) return;
          await docs.upsertIssueDocument({issueId: session.issueId, key, title: "Phone conversation transcript", format: "markdown", body, sourceTrust: task.sourceTrust, changeSummary: "Speko spoken conversation, including caller and agent turns"});
          await tx.insert(activityLog).values({companyId: session.companyId, actorType: "system", actorId: "speko-report", action: "voice.transcript.updated", entityType: "issue", entityId: session.issueId, details: {sessionId: session.id}});
        });
        // Even a stale provider reply must back off instead of spinning.
        await db.update(chatVoiceReports).set({ attempts, nextCheckAt: retryAt }).where(eq(chatVoiceReports.sessionId, session.id));
      } catch (error) {
        logger.warn({event: "voice.call.report_failed", companyId: session.companyId, endpointId: session.endpointId,
          issueId: session.issueId, sessionId: session.id, providerSessionId: session.providerSessionId, attempts,
          errorCode: error instanceof SpekoProviderError ? error.code : "report_reconciliation_failed",
          httpStatus: error instanceof SpekoProviderError ? error.httpStatus ?? null : null, retryAt: retryAt.toISOString()}, "Speko call report reconciliation deferred");
        await db.update(chatVoiceReports).set({ attempts, nextCheckAt: retryAt, ...(report?.status !== "available" && attempts >= 8 ? { status: "unavailable" as const } : {}) }).where(eq(chatVoiceReports.sessionId, session.id));
      }
    }
    return rows.length;
  }
  async function callbackPreference(companyId: string, endpointId: string, caller: VoiceCaller) {
    await endpointFor(companyId, endpointId);
    await db.transaction(tx => store.authorizeCaller(tx, companyId, caller));
    const [row] = await db.select().from(chatVoiceCallbacks).where(and(eq(chatVoiceCallbacks.companyId, companyId), eq(chatVoiceCallbacks.endpointId, endpointId), eq(chatVoiceCallbacks.userId, caller.id)));
    return row ? { phoneNumber: row.phoneNumber, enabled: row.enabled } : null;
  }
  async function saveCallbackPreference(companyId: string, endpointId: string, caller: VoiceCaller, preference: { phoneNumber: string; enabled: boolean }) {
    const endpoint = await endpointFor(companyId, endpointId);
    await db.transaction(async tx => {
      await store.authorizeCaller(tx, companyId, caller);
      await tx.insert(chatVoiceCallbacks).values({ companyId, endpointId, userId: caller.id, ...preference }).onConflictDoUpdate({ target: [chatVoiceCallbacks.companyId, chatVoiceCallbacks.endpointId, chatVoiceCallbacks.userId], set: { ...preference, updatedAt: new Date() } });
      await syncSpekoVoiceTools(tx, endpoint, caller.id);
      await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: caller.id, action: "voice.callback.preference_updated", entityType: "chat_endpoint", entityId: endpointId, details: { enabled: preference.enabled } });
    });
    return preference;
  }
  const inbound = voiceInboundService(db, { ...options, start, voicePrompt: PHONE_VOICE_PROMPT, lowTrustVoicePrompt: LOW_TRUST_PHONE_VOICE_PROMPT });
  const unregisterAgentTools = registerSpekoVoiceRuntime(db, async (binding, invocationId) => {
    const preference = await callbackPreference(binding.companyId, binding.endpointId, binding.caller);
    if (!preference?.enabled) throw forbidden("Save and enable your callback number in this Speko connection first");
    const result = await start({ ...binding, mode: "outbound_phone", phoneNumber: preference.phoneNumber, idempotencyKey: invocationId, maxDurationSeconds: 600 });
    return { session: result.session };
  });
  return { start, inspect, end, tool, reconcile, pushReplies, inbound, notification: store.notification, callbackPreference, saveCallbackPreference, history, callDetail, unregisterAgentTools };

}
export type VoiceSessionService = ReturnType<typeof voiceSessionService>;
