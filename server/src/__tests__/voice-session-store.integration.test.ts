import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { documentService } from "../services/documents.js";
import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments } from "../services/connector-runtime.js";
import { VOICE_RESULT_NOTIFICATION } from "@paperclipai/shared";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chatActions, environments, chatVoiceInboundCalls, chatVoicePhoneLines, chatVoiceReports, heartbeatRuns, toolProfileBindings, chatVoiceCallbacks, agentWakeupRequests, issueThreadInteractions, issueQuestionResponseDeliveries, issueComments, agents, chatConversations, chatDeliveries, chatEndpoints, chatPublications, chatVoiceReplies, chatVoiceSessions, chatVoiceToolCalls, companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, createDb, issues, toolApplications, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import { configureSpekoSessionTools } from "../services/voice/speko-tool-setup.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { chatChannelService } from "../services/chat-channels.js";
import { voiceSessionService } from "../services/voice/voice-session-service.js";
import { captureVoiceDeliveryDiagnostics } from "../services/voice/voice-delivery-diagnostics.js";
import { parseSpekoDeliveryDiagnostics } from "../services/voice/speko-delivery-diagnostics.js";
import { SpekoProviderError } from "../services/voice/speko-provider.js";
import { voiceSessionStore, serializeVoiceSession, currentVoiceCredentialFingerprint } from "../services/voice/voice-session-store.js";
import type { SpekoToolEnvelope } from "../services/voice/speko-protocol.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

import { liveVoiceExecutionGuidance } from "../services/voice/voice-execution-guidance.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { spekoToolsForSession, executeSpekoVoiceTool } from "../services/voice/speko-agent-tools.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable Speko voice sessions", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-speko-store-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), endpointId = randomUUID(), agentId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID(), issueId = randomUUID(), conversationId = randomUUID(), callerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Voice test", issuePrefix: `V${companyId.slice(0, 7).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: callerId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Existing agent", role: "operator", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Existing task", assigneeAgentId: agentId, status: "in_progress" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `chat:speko:${endpointId}`, name: "Speko", type: "chat", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Speko", uid: endpointId, connectionPurpose: "channel", transport: "voice", config: { provider: "speko" }, status: "active", enabled: true });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "speko", publicId: randomUUID(), assignedAgentId: agentId, status: "active", setup: { step: "complete", runtimeGeneration: 1 } });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: `speko:${conversationId}`, externalThreadId: `speko:${conversationId}`, externalLabel: "Voice", isDirectMessage: true });
    const store = voiceSessionStore(db, { allowLocalBoard: false });
    const prepareBinding = vi.fn(async () => ({ issueId, conversationId }));
    const request = { companyId, endpointId, caller: { id: callerId, authority: "member" as const }, idempotencyKey: randomUUID(), requestFingerprint: "request", maxDurationSeconds: 600, prepareBinding };
    const reserved = await store.reserve(request);
    if (!reserved.created) throw new Error("Expected reservation");
    const sessionId = reserved.session.id, providerSessionId = randomUUID();
    await db.update(chatVoiceSessions).set({ state: "active", providerSessionId }).where(eq(chatVoiceSessions.id, sessionId));
    const accept = vi.fn(store.stageDelivery);
    const toolInput = (tool: SpekoToolEnvelope["tool"], args: SpekoToolEnvelope["args"], toolId = randomUUID()) => {
      const envelope = { session_id: providerSessionId, tool_call_id: toolId, idempotency_key: `${providerSessionId}:${toolId}`, tool, args } as SpekoToolEnvelope;
      return { companyId, endpointId, sessionId, token: reserved.token, envelope, webhookId: `msg_${toolId}`, fingerprint: createHash("sha256").update(JSON.stringify(envelope)).digest("hex"), accept };
    };
    async function publication(state: "streaming" | "published" = "published") {
      const [row] = await db.insert(chatPublications).values({ companyId, endpointId, conversationId, issueId, idempotencyKey: randomUUID(), state, payload: { text: "Approved result" } }).returning();
      return row;
    }
    return { companyId, endpointId, agentId, connectionId, issueId, conversationId, callerId, sessionId, store, request, reserved, accept, toolInput, publication };
  }

  it("deduplicates concurrent session requests before creating a second task", async () => {
    const f = await fixture();
    const results = await Promise.all([f.store.reserve(f.request), f.store.reserve(f.request)]);
    expect(results.every((r) => !r.created && r.session.id === f.sessionId)).toBe(true);
    expect(f.request.prepareBinding).toHaveBeenCalledTimes(1);
    await expect(f.store.reserve({ ...f.request, requestFingerprint: "different" })).rejects.toMatchObject({ status: 409 });
    expect(JSON.stringify(serializeVoiceSession(f.reserved.session))).not.toContain(f.reserved.token);
    expect(serializeVoiceSession(f.reserved.session)).not.toHaveProperty("toolTokenHash");
  });

  it("accepts one durable delivery across concurrent tool retries and survives store restart", async () => {
    const f = await fixture(), request = f.toolInput("submit_request", { text: "Do the work" });
    const [a, b] = await Promise.all([f.store.runTool(request), f.store.runTool(request)]);
    expect(a).toEqual(b);
    expect(f.accept).toHaveBeenCalledTimes(1);
    const restarted = voiceSessionStore(db, { allowLocalBoard: false });
    expect(await restarted.runTool(request)).toEqual(a);
    expect(await db.select().from(chatVoiceToolCalls).where(eq(chatVoiceToolCalls.sessionId, f.sessionId))).toHaveLength(1);
    await expect(restarted.runTool({ ...request, fingerprint: "changed" })).rejects.toMatchObject({ status: 409 });
  });

  it("delivers urgent live-call guidance only after accepted work and retires it after hangup or revocation", async () => {
    const f = await fixture(), scope = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId };
    expect(await liveVoiceExecutionGuidance(db, scope)).toBeNull();
    await f.store.runTool(f.toolInput("submit_request", { text: "Inspect disk space" }));
    expect(await liveVoiceExecutionGuidance(db, scope)).toContain("Get a useful spoken response to them as quickly as possible");
    await db.update(chatEndpoints).set({status: "verifying"}).where(eq(chatEndpoints.id, f.endpointId));
    expect(await liveVoiceExecutionGuidance(db, scope)).toContain("Live voice request");
    await db.update(chatEndpoints).set({status: "active"}).where(eq(chatEndpoints.id, f.endpointId));
    expect(await liveVoiceExecutionGuidance(db, { ...scope, companyId: randomUUID() })).toBeNull();
    expect(await liveVoiceExecutionGuidance(db, { ...scope, agentId: randomUUID() })).toBeNull();
    expect(await liveVoiceExecutionGuidance(db, scope, new Date(Date.now() + 900_000))).toBeNull();
    await db.update(chatEndpoints).set({setup: {step: "complete", runtimeGeneration: 2}}).where(eq(chatEndpoints.id, f.endpointId));
    expect(await liveVoiceExecutionGuidance(db, scope)).toBeNull();
    await db.update(chatEndpoints).set({setup: {step: "complete", runtimeGeneration: 1}, status: "paused"}).where(eq(chatEndpoints.id, f.endpointId));
    expect(await liveVoiceExecutionGuidance(db, scope)).toBeNull();
    await db.update(chatEndpoints).set({status: "active"}).where(eq(chatEndpoints.id, f.endpointId));
    await db.update(chatVoiceSessions).set({state: "ended", endedAt: new Date()}).where(eq(chatVoiceSessions.id, f.sessionId));
    expect(await liveVoiceExecutionGuidance(db, scope)).toBeNull();
  });

  it("reports queueing, running follow-ups, and finished execution without inventing an answer or exposing logs", async () => {
    const f = await fixture();
    const read = () => f.store.runTool(f.toolInput("get_updates", {cursor: 0}));
    expect(await read()).toMatchObject({work: {state: "idle"}, updates: []});
    const accepted = await f.store.runTool(f.toolInput("submit_request", {text: "Check disk space"}));
    expect(await read()).toMatchObject({work: {state: "queued"}, updates: []});
    // A different task's running agent must not become this call's status.
    const [otherTask] = await db.insert(issues).values({companyId: f.companyId, title: "Private other task", assigneeAgentId: f.agentId}).returning();
    await db.insert(heartbeatRuns).values({companyId: f.companyId, agentId: f.agentId, issueId: otherTask.id, status: "running", error: "private log"});
    expect(await read()).toMatchObject({work: {state: "queued"}});
    await db.update(chatDeliveries).set({state: "processed"}).where(eq(chatDeliveries.id, accepted.requestId as string));
    const [run] = await db.insert(heartbeatRuns).values({companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "running", contextSnapshot: {issueId: f.issueId}, error: "private log"}).returning();
    await db.update(issues).set({executionRunId: run.id}).where(eq(issues.id, f.issueId));
    expect(await read()).toMatchObject({work: {state: "running", followUpQueued: false}});
    const followUp = await f.store.runTool(f.toolInput("submit_request", {text: "Please also report free space"}));
    expect(await read()).toMatchObject({work: {state: "running", followUpQueued: true}});
    await db.update(chatDeliveries).set({state: "processed"}).where(eq(chatDeliveries.id, followUp.requestId as string));
    await db.update(heartbeatRuns).set({status: "succeeded"}).where(eq(heartbeatRuns.id, run.id));
    const waiting = await read();
    expect(waiting).toMatchObject({status: "pending", work: {state: "awaiting_reply"}, updates: []});
    expect(JSON.stringify(waiting)).not.toContain("private log");
    expect(JSON.stringify(waiting)).not.toContain("Execution finished");
    const publication = await f.publication(); await f.store.enqueuePublication(f.companyId, publication.id);
    expect(await read()).toMatchObject({status: "updates", updates: [{text: "Approved result"}]});
    await db.update(heartbeatRuns).set({status: "failed", error: "secret provider credentials"}).where(eq(heartbeatRuns.id, run.id));
    const failed = await read(); expect(failed).toMatchObject({work: {state: "failed"}});
    expect(JSON.stringify(failed)).not.toContain("secret provider credentials");
  });

  it("advertises server push without restarting work or changing browser and terminal behavior", async () => {
    const f = await fixture();
    const read = () => f.store.runTool(f.toolInput("get_updates", {cursor: 0}));
    await db.update(chatVoiceSessions).set({mode: "inbound_phone"}).where(eq(chatVoiceSessions.id, f.sessionId));
    expect(await read()).not.toHaveProperty("nextAction");
    const accepted = await f.store.runTool(f.toolInput("submit_request", {text: "Check disk space"}));
    const request = f.toolInput("get_updates", {cursor: 0});
    const pending = await f.store.runTool(request);
    expect(pending).toMatchObject({status: "pending", updates: [], delivery: expect.stringContaining("pushed into this live call")});
    expect(await f.store.runTool(request)).toEqual(pending);
    expect(await f.store.runTool(f.toolInput("get_updates", {cursor: 0, repeat: true}))).not.toHaveProperty("nextAction");
    await db.update(chatVoiceSessions).set({mode: "browser"}).where(eq(chatVoiceSessions.id, f.sessionId));
    expect(await read()).not.toHaveProperty("nextAction");
    await db.insert(chatVoiceCallbacks).values({companyId: f.companyId, endpointId: f.endpointId, userId: f.callerId, phoneNumber: "+12015551234", enabled: true});
    await db.update(chatVoiceSessions).set({mode: "outbound_phone"}).where(eq(chatVoiceSessions.id, f.sessionId));
    expect(await read()).not.toHaveProperty("nextAction");
    await db.update(chatDeliveries).set({state: "failed"}).where(eq(chatDeliveries.id, accepted.requestId as string));
    expect(await read()).not.toHaveProperty("nextAction");
    const publication = await f.publication(); await f.store.enqueuePublication(f.companyId, publication.id);
    const delivered = await read();
    expect(delivered).toMatchObject({status: "updates", updates: [{text: "Approved result"}]});
    expect(delivered).not.toHaveProperty("nextAction");
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, accepted.requestId as string))).toHaveLength(1);
  });

  it("rejects a replayed webhook identity before accepting different work", async () => {
    const f = await fixture(), original = f.toolInput("submit_request", { text: "First request" });
    await f.store.runTool(original);
    await expect(f.store.runTool({ ...f.toolInput("submit_request", { text: "Different request" }), webhookId: original.webhookId })).rejects.toMatchObject({ status: 409 });
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(await db.select().from(chatVoiceToolCalls).where(eq(chatVoiceToolCalls.sessionId, f.sessionId))).toHaveLength(1);
  });

  it("repeats only an already delivered answer and retains truthful playback evidence", async () => {
    const f = await fixture(); const first = await f.publication();
    await f.store.enqueuePublication(f.companyId, first.id);
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0, repeat: true }))).toMatchObject({ status: "pending", updates: [] });
    const delivered = await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    const next = await f.publication(); await f.store.enqueuePublication(f.companyId, next.id);
    const repeated = await f.store.runTool(f.toolInput("get_updates", { cursor: 1, repeat: true }));
    expect(repeated).toMatchObject({ repeated: true, playback: "unknown", updates: delivered.updates });
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 1 }))).toMatchObject({ updates: [{ publicationId: next.id }] });
    const rows = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId));
    expect(rows).toHaveLength(2); expect(rows.every(row => row.deliveredAt && row.spokenAt === null)).toBe(true);
    expect(f.accept).not.toHaveBeenCalled();
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 2, repeat: true }))).rejects.toMatchObject({ status: 403 });
  });

  it("does not restore legacy access when a managed connection loses its final install", async () => {
    const f = await fixture();
    await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connectionId, kind: "organization", isDefault: true });
    const [install] = await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connectionId, targetType: "agent", targetId: f.agentId }).returning();
    await expect(f.store.notification(f.companyId, f.sessionId, f.callerId)).resolves.toBeNull();
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.id, install.id));
    await expect(f.store.notification(f.companyId, f.sessionId, f.callerId)).rejects.toMatchObject({ status: 403 });
    await expect(f.store.runTool(f.toolInput("submit_request", { text: "Unauthorized after uninstall" }))).rejects.toMatchObject({ status: 403 });
    expect(f.accept).not.toHaveBeenCalled();
  });

  it("does not replay an old tool receipt after its approved publication changes", async () => {
    const f = await fixture(); const publication = await f.publication();
    await f.store.enqueuePublication(f.companyId, publication.id);
    const request = f.toolInput("get_updates", { cursor: 0 });
    await f.store.runTool(request);
    await db.update(chatPublications).set({ payload: { text: "Corrected approved response" } }).where(eq(chatPublications.id, publication.id));
    await expect(f.store.runTool(request)).rejects.toMatchObject({ status: 409 });
  });

  it("repeats a missed audible answer after rejoining, without replaying it automatically or crossing callers", async () => {
    const f = await fixture(); const publication = await f.publication();
    await f.store.enqueuePublication(f.companyId, publication.id);
    await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, f.sessionId));
    async function rejoin(callerId: string) {
      const reserved = await f.store.reserve({ ...f.request, caller: { id: callerId, authority: "member" }, idempotencyKey: randomUUID() });
      if (!reserved.created) throw new Error("Expected a new media call");
      const providerSessionId = randomUUID(), toolId = randomUUID();
      await db.update(chatVoiceSessions).set({ state: "active", providerSessionId }).where(eq(chatVoiceSessions.id, reserved.session.id));
      expect(await f.store.notification(f.companyId, reserved.session.id, callerId)).toBeNull();
      const envelope = { session_id: providerSessionId, tool_call_id: toolId, idempotency_key: `${providerSessionId}:${toolId}`, tool: "get_updates" as const, args: { cursor: 0, repeat: true } };
      return f.store.runTool({ ...f.toolInput("get_updates", { cursor: 0 }), sessionId: reserved.session.id, token: reserved.token, envelope, webhookId: toolId, fingerprint: createHash("sha256").update(JSON.stringify(envelope)).digest("hex") });
    }
    expect(await rejoin(f.callerId)).toMatchObject({ updates: [{ publicationId: publication.id }], repeated: true, playback: "unknown" });
    const otherCaller = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: otherCaller, status: "active", membershipRole: "member" });
    expect(await rejoin(otherCaller)).toMatchObject({ status: "pending", updates: [] });
  });

  it("marks media active only after a valid session-scoped provider request", async () => {
    const f = await fixture();
    await db.update(chatVoiceSessions).set({ state: "connecting" }).where(eq(chatVoiceSessions.id, f.sessionId));
    const request = f.toolInput("get_updates", { cursor: 0 });
    await expect(f.store.runTool({ ...request, token: "invalid" })).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId)))[0].state).toBe("connecting");
    await f.store.runTool(request);
    expect((await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId)))[0].state).toBe("active");
  });

  it("rolls back both acceptance and receipt on failure", async () => {
    const f = await fixture();
    const request = f.toolInput("submit_request", { text: "Do the work" });
    await expect(f.store.runTool({ ...request, accept: async (...args) => { await f.accept(...args); throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId))).toHaveLength(0);
    expect(await db.select().from(chatVoiceToolCalls).where(eq(chatVoiceToolCalls.sessionId, f.sessionId))).toHaveLength(0);
    expect(await f.store.runTool(request)).toMatchObject({ status: "accepted" });
  });

  it("never substitutes company, session, or token authority", async () => {
    const a = await fixture(), b = await fixture(), request = a.toolInput("submit_request", { text: "Private work" });
    await expect(a.store.runTool({ ...request, companyId: b.companyId })).rejects.toMatchObject({ status: 404 });
    await expect(a.store.runTool({ ...request, endpointId: b.endpointId })).rejects.toMatchObject({ status: 403 });
    await expect(a.store.runTool({ ...request, token: b.reserved.token })).rejects.toMatchObject({ status: 403 });
    await expect(a.store.runTool({ ...request, envelope: { ...request.envelope, session_id: b.reserved.session.id } })).rejects.toMatchObject({ status: 403 });
    expect(a.accept).not.toHaveBeenCalled();
  });

  it.each(["paused", "revoked", "archived"] as const)("denies new tools after endpoint becomes %s", async (status) => {
    const f = await fixture();
    await db.update(chatEndpoints).set({ status }).where(eq(chatEndpoints.id, f.endpointId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
  });

  it("fences old generations and credential rotations", async () => {
    const f = await fixture();
    await db.update(chatEndpoints).set({ setup: { step: "complete", runtimeGeneration: 2 } }).where(eq(chatEndpoints.id, f.endpointId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
    await db.update(chatEndpoints).set({ setup: { step: "complete", runtimeGeneration: 1 } }).where(eq(chatEndpoints.id, f.endpointId));
    await db.update(toolConnections).set({ credentialSecretRefs: [{ configPath: "apiKey", secretId: randomUUID(), versionSelector: "latest" }] }).where(eq(toolConnections.id, f.connectionId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
  });

  it("retires active calls when a latest credential rotates without changing its reference", async () => {
    const f = await fixture();
    const [secret] = await db.insert(companySecrets).values({ companyId: f.companyId, key: "SPEKO_TEST", name: "Speko fixture" }).returning();
    const refs = [{ configPath: "apiKey", secretId: secret.id, versionSelector: "latest" as const }];
    await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, f.connectionId));
    await db.update(chatVoiceSessions).set({ credentialFingerprint: await currentVoiceCredentialFingerprint(db, f.companyId, refs) }).where(eq(chatVoiceSessions.id, f.sessionId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).resolves.toMatchObject({ status: "pending" });
    await db.update(companySecrets).set({ latestVersion: 2 }).where(eq(companySecrets.id, secret.id));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
    await expect(f.store.notification(f.companyId, f.sessionId, f.callerId)).rejects.toMatchObject({ status: 403 });
  });

  it("honors the credential's current human audience and revoked grants", async () => {
    const f = await fixture();
    const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connectionId, kind: "organization", isDefault: true }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connectionId, targetType: "agent", targetId: f.agentId });
    const [member] = await db.insert(connectionGrantMembers).values({ companyId: f.companyId, grantId: grant.id, subjectType: "user", subjectId: "another-person" }).returning();
    await expect(f.store.runTool(f.toolInput("submit_request", { text: "Denied" }))).rejects.toMatchObject({ status: 403 });
    expect(f.accept).not.toHaveBeenCalled();
    await db.update(connectionGrantMembers).set({ subjectId: f.callerId }).where(eq(connectionGrantMembers.id, member.id));
    await expect(f.store.runTool(f.toolInput("submit_request", { text: "Allowed" }))).resolves.toMatchObject({ status: "accepted" });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, grant.id));
    await expect(f.store.reserve(f.request)).rejects.toMatchObject({ status: 403 });
    await expect(f.store.notification(f.companyId, f.sessionId, f.callerId)).rejects.toMatchObject({ status: 403 });
  });

  it("rechecks membership and rejects read-only users and unapproved callers", async () => {
    const f = await fixture();
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, f.callerId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.principalId, f.callerId));
    await db.update(chatVoiceSessions).set({ callerAuthority: "pending_approval" }).where(eq(chatVoiceSessions.id, f.sessionId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
    await expect(f.store.reserve({ ...f.request, caller: { id: "local-board", authority: "local_board" } })).rejects.toMatchObject({ status: 403 });
  });

  it("preserves accepted work after hangup but still enforces revoked access", async () => {
    const f = await fixture();
    await f.store.runTool(f.toolInput("submit_request", { text: "Finish this after I hang up" }));
    await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, f.sessionId));
    expect(await db.transaction((tx) => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${f.sessionId}`))).toMatchObject({ allowed: true, userId: f.callerId });
    await expect(f.store.runTool(f.toolInput("submit_request", { text: "Late replay" }))).rejects.toMatchObject({ status: 403 });
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, f.callerId));
    await expect(db.transaction((tx) => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${f.sessionId}`))).rejects.toMatchObject({ status: 403 });
  });

  it("publishes each approved answer once, preserves retry receipts, and never assumes speech", async () => {
    const f = await fixture(), publication = await f.publication("streaming");
    await Promise.all([f.store.enqueuePublication(f.companyId, publication.id), f.store.enqueuePublication(f.companyId, publication.id)]);
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).toMatchObject({ status: "pending", updates: [] });
    await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.id, publication.id));
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toEqual({ sessionId: f.sessionId, generation: 1, publicationId: publication.id, attempt: 0 });
    const request = f.toolInput("get_updates", { cursor: 0 }), reply = await f.store.runTool(request);
    expect(reply).toMatchObject({ cursor: 1, updates: [{ text: "Approved result", publicationId: publication.id }] });
    expect(await f.store.runTool(request)).toEqual(reply);
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).toMatchObject({ status: "pending", updates: [] });
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
    const records = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId));
    expect(records).toHaveLength(1);
    expect(records[0].deliveredAt).toBeInstanceOf(Date);
    expect(records[0].spokenAt).toBeNull();
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 999 }))).rejects.toMatchObject({ status: 409 });
  });

  it("skips routine progress and retries the oldest unclaimed answer without duplicating delivery", async () => {
    const f = await fixture(), progress = await f.publication();
    await db.update(chatPublications).set({ payload: { text: "Working", progressState: "working" } }).where(eq(chatPublications.id, progress.id));
    await f.store.enqueuePublication(f.companyId, progress.id);
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
    const first = await f.publication(), second = await f.publication();
    await f.store.enqueuePublication(f.companyId, first.id);
    await f.store.enqueuePublication(f.companyId, second.id);
    await db.update(chatVoiceReplies).set({ createdAt: new Date(Date.now() - 21_000) }).where(eq(chatVoiceReplies.publicationId, first.id));
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toMatchObject({ publicationId: first.id, attempt: 2 });
    const reply = await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    expect(reply).toMatchObject({ cursor: 2, updates: [{ publicationId: first.id }, { publicationId: second.id }] });
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 2 }))).toMatchObject({ status: "pending", updates: [] });
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).toMatchObject({ status: "pending", updates: [] });
  });

  it("bounds one retrieval to eight replies and stops at a clarification", async () => {
    const f = await fixture();
    const publications = [];
    for (let index = 0; index < 10; index++) {
      const publication = await f.publication(); publications.push(publication);
      await f.store.enqueuePublication(f.companyId, publication.id);
    }
    await db.update(chatPublications).set({ payload: { text: "Please clarify", interactionId: randomUUID() } }).where(eq(chatPublications.id, publications[2]!.id));
    const first = await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    expect(first).toMatchObject({ cursor: 3, updates: publications.slice(0, 3).map(p => ({ publicationId: p.id })) });
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toMatchObject({ publicationId: publications[3]!.id });
    const next = await f.store.runTool(f.toolInput("get_updates", { cursor: 3 }));
    expect(next).toMatchObject({ cursor: 10, updates: publications.slice(3).map(p => ({ publicationId: p.id })) });
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
  });

  it("leaves excess replies pending after a bounded batch", async () => {
    const f = await fixture();
    for (let index = 0; index < 9; index++) { const p = await f.publication(); await f.store.enqueuePublication(f.companyId, p.id); }
    const first = await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    expect(first.cursor).toBe(8); expect(first.updates).toHaveLength(8);
    const next = await f.store.runTool(f.toolInput("get_updates", { cursor: 8 }));
    expect(next.cursor).toBe(9); expect(next.updates).toHaveLength(1);
  });

  it("delivers an earlier stream that completes after a newer answer without moving the cursor backwards", async () => {
    const f = await fixture(), slow = await f.publication("streaming"), ready = await f.publication();
    await f.store.enqueuePublication(f.companyId, slow.id);
    await f.store.enqueuePublication(f.companyId, ready.id);
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).toMatchObject({ cursor: 2, updates: [{ publicationId: ready.id }] });
    await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.id, slow.id));
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 2 }))).toMatchObject({ cursor: 2, updates: [{ cursor: 1, publicationId: slow.id }] });
    expect(await f.store.notification(f.companyId, f.sessionId, f.callerId)).toBeNull();
  });

  it("denies changed task assignment, expired calls, and another caller's notification feed", async () => {
    const f = await fixture();
    await expect(f.store.notification(f.companyId, f.sessionId, randomUUID())).rejects.toMatchObject({ status: 403 });
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    await expect(f.store.runTool(f.toolInput("submit_request", { text: "Wrong agent" }))).rejects.toMatchObject({ status: 403 });
    await db.update(issues).set({ assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));
    await db.update(chatVoiceSessions).set({ createdAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 1) }).where(eq(chatVoiceSessions.id, f.sessionId));
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks same-company private task access on tools, notifications, retries and queued work", async () => {
    const f = await fixture();
    await f.store.runTool(f.toolInput("submit_request", { text: "Accepted before privacy changes" }));
    await db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    await expect(f.store.reserve(f.request)).rejects.toMatchObject({ status: 403 });
    await expect(f.store.notification(f.companyId, f.sessionId, f.callerId)).rejects.toMatchObject({ status: 403 });
    await expect(f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).rejects.toMatchObject({ status: 403 });
    await expect(db.transaction(tx => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${f.sessionId}`))).rejects.toMatchObject({ status: 403 });
  });

  it("recovers results completed after hangup without replaying already delivered results", async () => {
    const f = await fixture(), delivered = await f.publication();
    await f.store.enqueuePublication(f.companyId, delivered.id);
    await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, f.sessionId));
    const missed = await f.publication();
    await f.store.enqueuePublication(f.companyId, missed.id);
    const resumed = await f.store.reserve({ ...f.request, idempotencyKey: randomUUID() });
    await db.update(chatVoiceSessions).set({ state: "active", providerSessionId: randomUUID() }).where(eq(chatVoiceSessions.id, resumed.session.id));
    expect(await f.store.notification(f.companyId, resumed.session.id, f.callerId)).toMatchObject({ publicationId: missed.id });
    const replies = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, resumed.session.id));
    expect(replies.map(r => r.publicationId)).toEqual([missed.id]);
  });

  async function questionFixture() {
    const f = await fixture(), id = randomUUID();
    await db.insert(issueThreadInteractions).values({ id, companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      createdByAgentId: f.agentId, addresseeUserId: f.callerId, effectiveResolverPolicy: "addressee_only",
      payload: { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single", required: true,
        allowOther: false, options: [{ id: "cobalt", label: "Cobalt" }] }] } });
    const publication = await f.publication();
    await db.update(chatPublications).set({ payload: { text: "Which color?", interactionId: id, progressState: "waiting_for_input" } }).where(eq(chatPublications.id, publication.id));
    await f.store.enqueuePublication(f.companyId, publication.id);
    const answer = f.toolInput("answer_question", { interactionId: id, answers: [{ questionId: "color", optionIds: ["cobalt"] }] });
    return { ...f, id, answer };
  }
  it("answers only a question presented to this session and writes one canonical continuation receipt", async () => {
    const f = await questionFixture();
    await expect(f.store.runTool(f.answer)).rejects.toMatchObject({ status: 403 });
    expect(await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }))).toMatchObject({ updates: [{ question: { interactionId: f.id, questions: [{ id: "color" }] } }] });
    const answer = await f.store.runTool(f.answer);
    expect(answer).toMatchObject({ status: "answered", interactionId: f.id });
    expect(await f.store.runTool(f.answer)).toEqual(answer);
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, f.id))).toHaveLength(1);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.id)))[0]).toMatchObject({ status: "answered", resolvedByUserId: f.callerId });
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId))).toHaveLength(0);
  });
  it("refuses voice answers when the exact question recipient changes", async () => {
    const f = await questionFixture();
    await f.store.runTool(f.toolInput("get_updates", { cursor: 0 }));
    await db.update(issueThreadInteractions).set({ addresseeUserId: randomUUID() }).where(eq(issueThreadInteractions.id, f.id));
    await expect(f.store.runTool(f.answer)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, f.id))).toHaveLength(0);
  });

  async function nativeServiceFixture() {
    const f = await fixture();
    await db.update(chatVoiceSessions).set({ state: "ended", endedAt: new Date() }).where(eq(chatVoiceSessions.id, f.sessionId));
    const hooks: {id: string; url: string; events: string[]; allAgents: boolean; agentIds: string[]; filterTags: Record<string,string>}[] = [];
    const transport = {
      listPhoneNumbers: vi.fn(async () => []), assignPhoneNumber: vi.fn(async () => {}),
      listWebhooks: vi.fn(async () => [...hooks]), configureWebhook: vi.fn(async (agentId: string, url: string, _secret: string, id?: string) => { const hook = {id: id ?? "hook_test", url, events: ["call.pre_call", "call.status", "call.report"], allAgents: false, agentIds: [agentId], filterTags: {}}; hooks.splice(0, hooks.length, hook); return {id: hook.id}; }),
      listTools: vi.fn(async () => []),
      configureTool: vi.fn(async () => ({ id: "tool_test" })),
      configureVoiceDefaults: vi.fn(async () => {}),
      verifyAgent: vi.fn(async () => ({ id: "agent_test", organizationId: "org_test", name: "Test voice" })),
      createPhoneSession: vi.fn(async (_input: { to: string; bindingId: string }) => ({ sessionId: randomUUID(), status: "dialing" as const })),
      createBrowserSession: vi.fn(async () => ({ sessionId: randomUUID(), transportToken: "short-lived-media-token", transportUrl: "wss://media.example.test" })),
      inspectSession: vi.fn(async () => ({ status: "active", endedAt: null as string | null })),
      callReport: vi.fn(async () => ({ complete: true, transcript: [{ id: "turn1", index: 0, speaker: "caller" as const, text: "A test request", startedAt: new Date().toISOString(), endedAt: null, interrupted: false }], costMicroUsd: "120000", durationSeconds: 60, providerUpdatedAt: new Date() })),
      callDeliveryDiagnostics: vi.fn(async (id: string, deliveries: readonly {messageId: string; acceptedAt: string}[]) => parseSpekoDeliveryDiagnostics(
        {id, report: {session_id: id, updated_at: new Date().toISOString(), transcript: {entries: []}}}, {events: []}, id, deliveries)),
      sendCallMessage: vi.fn(async (_id: string, _text: string, _mode?: "respond" | "context") => ({messageId: "message_test"})),
      endSession: vi.fn(async () => ({ confirmed: true })),
    };
    const credentials = vi.fn(async () => ({ apiKey: "server-only-key", agentId: "agent_test" }));
    const service = voiceSessionService(db, { allowLocalBoard: false, credentials, provider: () => transport, onQuestionAnswered: vi.fn() });
    const input = { companyId: f.companyId, endpointId: f.endpointId, issueId: f.issueId, caller: f.request.caller, idempotencyKey: randomUUID(), maxDurationSeconds: 600 };
    return { ...f, service, transport, credentials, input };
  }

  async function pushFixture() {
    await instanceSettingsService(db).updateExperimental({enableChatConnectors: true});
    const f = await nativeServiceFixture();
    const {session} = await f.service.start(f.input);
    await db.update(chatVoiceSessions).set({mode: "inbound_phone", state: "active"}).where(eq(chatVoiceSessions.id, session.id));
    const publication = await f.publication();
    await f.store.enqueuePublication(f.companyId, publication.id);
    const push = () => f.service.pushReplies(25, f.companyId, f.endpointId);
    return {...f, session, publication, push};
  }
  it("pushes a published phone answer exactly once across concurrent dispatch and restart", async () => {
    const f = await pushFixture();
    await Promise.all([f.push(), f.push()]); await f.push();
    expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    expect(f.transport.sendCallMessage).toHaveBeenCalledWith(expect.any(String), "Approved result", "respond");
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.session.id));
    expect(reply?.deliveredAt).toBeInstanceOf(Date); expect(reply?.spokenAt).toBeNull();
    const [action] = await db.select().from(chatActions).where(eq(chatActions.providerActionId, `voice_reply_push:${reply!.id}`));
    expect(action).toMatchObject({status: "completed", result: {messageId: "message_test", playback: "unknown"}});
  });
  it("retains correlated post-call diagnostics once and preserves acceptance/playback semantics", async () => {
    const f = await pushFixture(); await f.push();
    await db.update(chatVoiceSessions).set({state: "ended", endedAt: new Date()}).where(eq(chatVoiceSessions.id, f.session.id));
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.session.id));
    await Promise.all([captureVoiceDeliveryDiagnostics(db, session!, f.transport, true), captureVoiceDeliveryDiagnostics(db, session!, f.transport, true)]);
    await captureVoiceDeliveryDiagnostics(db, session!, f.transport, true);
    const [action] = await db.select().from(chatActions).where(eq(chatActions.providerActionId, `voice_reply_push:${(await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, session!.id)))[0]!.id}`));
    expect(f.transport.callDeliveryDiagnostics).toHaveBeenCalledOnce();
    expect(action).toMatchObject({status: "completed", result: {messageId: "message_test", playback: "unknown",
      deliveryDiagnostics: {state: "collected", attempts: 1, final: true, message: {messageId: "message_test", playback: "unknown"}}}});
    expect(action!.result!.deliveryDiagnostics).not.toHaveProperty("transcript");
    expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, session!.id));
    expect(reply!.deliveredAt).not.toBeNull(); expect(reply!.spokenAt).toBeNull();
  });
  it("bounds failed diagnostic reads across restarts without replaying accepted speech", async () => {
    const f = await pushFixture(); await f.push();
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.session.id));
    f.transport.callDeliveryDiagnostics.mockRejectedValue(new SpekoProviderError("provider_unavailable", false, 503));
    for (let i = 0; i < 5; i++) await captureVoiceDeliveryDiagnostics(db, session!, f.transport, true);
    expect(f.transport.callDeliveryDiagnostics).toHaveBeenCalledTimes(3);
    expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    const [action] = await db.select().from(chatActions).where(eq(chatActions.endpointId, f.endpointId));
    expect(action).toMatchObject({status: "completed", result: {playback: "unknown", deliveryDiagnostics: {attempts: 3, state: "failed", errorCode: "provider_unavailable", httpStatus: 503}}});
  });

  it("never blindly repeats a push after an ambiguous provider outcome", async () => {
    const f = await pushFixture();
    f.transport.sendCallMessage.mockRejectedValue(new SpekoProviderError("provider_unavailable", true));
    await f.push(); await f.push();
    expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.session.id));
    expect(reply?.deliveredAt).toBeNull();
    const [action] = await db.select().from(chatActions).where(eq(chatActions.providerActionId, `voice_reply_push:${reply!.id}`));
    expect(action?.status).toBe("unknown");
  });
  it("handles an ended call without claiming delivery or creating another call", async () => {
    const f = await pushFixture();
    f.transport.sendCallMessage.mockRejectedValue(new SpekoProviderError("provider_unavailable", false, 409));
    await f.push(); await f.push();
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.session.id));
    expect(session?.state).toBe("ended"); expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    expect(f.transport.createPhoneSession).not.toHaveBeenCalled();
  });
  it("pushes only published replies under current connection and caller authority", async () => {
    const f = await pushFixture();
    await db.update(chatPublications).set({state: "streaming"}).where(eq(chatPublications.id, f.publication.id));
    await f.push(); expect(f.transport.sendCallMessage).not.toHaveBeenCalled();
    await db.update(chatPublications).set({state: "published"}).where(eq(chatPublications.id, f.publication.id));
    await db.delete(companyMemberships).where(eq(companyMemberships.principalId, f.callerId));
    await f.push(); expect(f.transport.sendCallMessage).not.toHaveBeenCalled();
  });
  it("backs off a definitive rate limit and recovers a crash before publication enqueue", async () => {
    const f = await pushFixture();
    await db.delete(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.session.id));
    f.transport.sendCallMessage.mockRejectedValueOnce(new SpekoProviderError("rate_limited", false, 429));
    await f.push(); await f.push(); expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.session.id));
    await db.update(chatActions).set({result: {retryAt: 0}}).where(eq(chatActions.providerActionId, `voice_reply_push:${reply!.id}`));
    await f.push(); expect(f.transport.sendCallMessage).toHaveBeenCalledTimes(2);
  });

  it("does not push when experimental connectors are disabled", async () => {
    const f = await pushFixture();
    await instanceSettingsService(db).updateExperimental({enableChatConnectors: false});
    await f.push();
    expect(f.transport.sendCallMessage).not.toHaveBeenCalled();
    await instanceSettingsService(db).updateExperimental({enableChatConnectors: true});
  });

  it("keeps a reply out of pull delivery during push and after an uncertain outcome", async () => {
    const f = await pushFixture();
    await db.update(chatVoiceSessions).set({state: "ended"}).where(eq(chatVoiceSessions.id, f.session.id));
    await db.update(chatVoiceSessions).set({state: "active", mode: "inbound_phone"}).where(eq(chatVoiceSessions.id, f.sessionId));
    await f.store.enqueuePublication(f.companyId, f.publication.id);
    let reject!: (error: Error) => void, started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    f.transport.sendCallMessage.mockImplementation(() => {
      started();
      return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    });
    const push = f.push();
    await sending;
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.sessionId));
    // The persisted dispatch intent is visible while the network call is pending.
    const [action] = await db.select().from(chatActions).where(eq(chatActions.providerActionId, `voice_reply_push:${reply!.id}`));
    expect(action?.status).toBe("dispatching");
    expect(await f.store.runTool(f.toolInput("get_updates", {cursor: 0}))).toMatchObject({updates: []});
    expect(reply?.deliveredAt).toBeNull();
    reject(new SpekoProviderError("provider_unavailable", true));
    await push;
    expect(await f.store.runTool(f.toolInput("get_updates", {cursor: 0}))).toMatchObject({updates: []});
    await f.push();
    expect(f.transport.sendCallMessage).toHaveBeenCalledOnce();
    expect(session?.state).toBe("active");
  });

  it("preserves an ambiguous dispatch after restart instead of speaking it twice", async () => {
    const f = await pushFixture();
    const [reply] = await db.select().from(chatVoiceReplies).where(eq(chatVoiceReplies.sessionId, f.session.id));
    await db.insert(chatActions).values({companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, kind: "speko_voice_reply_push", providerActionId: `voice_reply_push:${reply!.id}`, status: "dispatching", payload: {sessionId: f.session.id, replyId: reply!.id}, updatedAt: new Date(Date.now() - 60_000)});
    await f.push();
    expect(f.transport.sendCallMessage).not.toHaveBeenCalled();
    const [action] = await db.select().from(chatActions).where(eq(chatActions.providerActionId, `voice_reply_push:${reply!.id}`));
    expect(action?.status).toBe("unknown");
  });

  async function inboundFixture(guestIntake = false, sandboxId?: string) {
    const f = await nativeServiceFixture();
    await instanceSettingsService(db).updateExperimental({enableChatConnectors: true, enableIsolatedWorkspaces: guestIntake});
    const signingSecret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    f.credentials.mockResolvedValue({apiKey: "server-only-key", agentId: "agent_test", signingSecret} as never);
    await db.update(chatEndpoints).set({providerAccountId: `org_${f.companyId}`, botExternalId: "agent_test"}).where(eq(chatEndpoints.id, f.endpointId));
    await db.insert(chatVoicePhoneLines).values({companyId: f.companyId, endpointId: f.endpointId, providerNumberId: randomUUID(), phoneNumber: "+12015550123", enabled: true, guestIntake, lowTrustEnvironmentId: sandboxId ?? null});
    const [line] = await db.select().from(chatVoicePhoneLines).where(eq(chatVoicePhoneLines.endpointId, f.endpointId));
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    const providerSessionId = randomUUID();
    const sign = (value: unknown, webhookId = `msg_${randomUUID()}`) => {
      const body = Buffer.from(JSON.stringify(value)), timestamp = String(Math.floor(Date.now()/1000));
      const signature = createHmac("sha256", Buffer.from(signingSecret.slice(6), "base64")).update(`${webhookId}.${timestamp}.`).update(body).digest("base64");
      return {body, headers: {"webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`}};
    };
    const event = {type: "call.pre_call", session_id: providerSessionId, call_id: providerSessionId, organization_id: `org_${f.companyId}`, direction: "inbound", phone_number_id: line.providerNumberId, dialed_number: line.phoneNumber, from: "+12015551234"};
    const signed = sign(event);
    const response = await f.service.inbound.lifecycle(endpoint.publicId, signed.body, signed.headers);
    const capability = (response as {toolSecrets: {paperclip_session_token: string}}).toolSecrets.paperclip_session_token;
    const [call] = await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.providerSessionId, providerSessionId));
    const tool = (name: "submit_request" | "get_updates", args: unknown, toolId = randomUUID()) => {
      const signed = sign({session_id: providerSessionId, tool_call_id: toolId, idempotency_key: `${providerSessionId}:${toolId}`, tool: name, args});
      return f.service.tool(endpoint.publicId, signed.body, {...signed.headers, authorization: `Bearer ${capability}`});
    };
    return {...f, call, event, signed, sign, response, endpoint, capability, tool};
  }
  it("pins a connection-selected sandbox only to its new public task", async () => {
    const sandboxId = randomUUID();
    await db.insert(environments).values({id: sandboxId, name: `Phone sandbox ${sandboxId}`, driver: "sandbox", config: {provider: "daytona"}});
    const f = await inboundFixture(true, sandboxId);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.call.intakeIssueId!));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(task.executionWorkspaceSettings).toMatchObject({mode: "isolated_workspace", environmentId: sandboxId, workspaceStrategy: {type: "cloud_sandbox"}});
    expect(agent.defaultEnvironmentId).not.toBe(sandboxId);
    expect((await f.tool("submit_request", {text: "Hello"})).status).toBe("accepted");
    await db.update(issues).set({executionWorkspaceSettings: {mode: "isolated_workspace", environmentId: randomUUID()}}).where(eq(issues.id, task.id));
    await expect(f.tool("get_updates", {cursor: 0})).rejects.toMatchObject({status: 403});
  });
  it("confines explicitly enabled public calls to one new low-trust conversation task", async () => {
    const f = await inboundFixture(true), toolId = randomUUID();
    expect(f.response).not.toHaveProperty("approvalCode");
    expect(f.response.firstMessage).toBe("Thanks for calling. What would you like to work on?");
    expect(f.response.systemPrompt).not.toContain(f.call.approvalCode);
    // The provider must not inherit browser notification-only waiting or a
    // protected question tool that this public session cannot use.
    expect(f.response.systemPrompt).toContain("Paperclip pushes approved task answers");
    expect(f.response.systemPrompt).toContain("Do not repeatedly poll while pending.");
    expect(f.response.systemPrompt).toContain("Do not call answer_question");
    expect(f.response.systemPrompt).toContain("Do not make the caller wait for a Paperclip turn");
    expect(f.response.systemPrompt).toContain("Submit follow-ups even while earlier work is running");
    expect(f.response.systemPrompt).toContain("inspect its actual environment");
    expect(f.response.systemPrompt).toContain("How much disk space do you have on your computer?");
    expect(f.response.systemPrompt).toContain("What is the capital of France?");
    expect(f.response.idleRePrompts).toMatchObject({enabled: true, delayMs: 5000, maxPrompts: 10, messages: ["I'm still working on it."]});
    const [task] = await db.select().from(issues).where(eq(issues.id, f.call.intakeIssueId!));
    expect(task.description).toContain("You are on a live phone call");
    expect(task.description).toContain("Immediately post a brief, caller-safe task comment");
    expect(task).toMatchObject({status: "todo", assigneeAgentId: f.agentId, responsibleUserId: null, sourceTrust: {disposition: "quarantined", preset: "low_trust_review"}, executionPolicy: {authorizationPolicy: {trustBoundary: {issueIds: [task.id], allowedAgentIds: [f.agentId], allowedToolClasses: [], allowedSecretBindingIds: []}}}});
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.issueId, task.id));
    expect(conversation.communicationGuidance).toContain("Keep your existing identity, runtime, tools");
    expect(conversation.communicationGuidance).toContain("own low-trust task");
    const first = await f.tool("submit_request", {text: "Help me draft a public inquiry"}, toolId);
    expect(first).toMatchObject({status: "accepted", authorization: "guest_intake"});
    expect(await f.tool("submit_request", {text: "Help me draft a public inquiry"}, toolId)).toEqual(first);
    await expect(f.tool("submit_request", {text: "Changed replay"}, toolId)).rejects.toMatchObject({status: 409});
    expect(await f.service.inbound.lifecycle(f.endpoint.publicId, f.signed.body, f.signed.headers)).toEqual(f.response);
    expect(await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.providerSessionId, f.event.session_id))).toHaveLength(1);
    const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.call.sessionId!));
    const authority = await db.transaction(tx => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${session.id}`));
    expect(authority).toMatchObject({allowed: true, userId: null});
    const [publication] = await db.insert(chatPublications).values({companyId: f.companyId, endpointId: f.endpointId, conversationId: session.conversationId, issueId: task.id, idempotencyKey: randomUUID(), state: "published", payload: {text: "Here is a draft for your public inquiry."}}).returning();
    await f.store.enqueuePublication(f.companyId, publication.id);
    expect(await f.tool("get_updates", {cursor: 0})).toMatchObject({updates: [{text: "Here is a draft for your public inquiry."}]});
    await db.update(chatVoiceSessions).set({issueId: f.issueId}).where(eq(chatVoiceSessions.id, session.id));
    await expect(f.tool("get_updates", {cursor: 0})).rejects.toMatchObject({status: 403});
    await db.update(chatVoiceSessions).set({issueId: task.id}).where(eq(chatVoiceSessions.id, session.id));
    await db.update(issues).set({executionPolicy: {mode: "normal", commentRequired: true, stages: []}}).where(eq(issues.id, task.id));
    await expect(f.tool("submit_request", {text: "Must never run after losing containment"})).rejects.toMatchObject({status: 403});
  });
  it("routes opted-in public speech and follow-ups through the real chat queue with low-trust wakeups", async () => {
    const f = await inboundFixture(true);
    const wakeup = vi.fn(async (agentId, opts) => {
      const request = opts.durableChatRequest;
      await db.transaction(async tx => {
        await request.authorize(tx);
        await tx.insert(agentWakeupRequests).values({id: request.id, companyId: request.companyId, agentId, source: opts.source ?? "assignment", triggerDetail: opts.triggerDetail, reason: opts.reason, payload: opts.payload, requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId, idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt, status: "queued"}).onConflictDoNothing();
      });
      return {accepted: true};
    });
    const chat = chatChannelService(db, {heartbeat: {wakeup}, deferWebhookProcessing: true});
    try {
      for (const text of ["Help draft a public inquiry", "Keep it short"] ) {
        const accepted = await f.tool("submit_request", {text});
        await expect.poll(async () => {
          await chat.processPendingDeliveries(25, accepted.requestId as string);
          const [delivery] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, accepted.requestId as string));
          return delivery?.state;
        }, {timeout: 10_000}).toBe("processed");
      }
      expect(wakeup).toHaveBeenCalledTimes(2);
      const ended = await f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: false, approvalCode: f.call.approvalCode});
      expect(ended.state).toBe("ended");
      await expect(f.tool("submit_request", {text: "Cannot submit after the call ends"})).rejects.toMatchObject({status: 403});
      expect(await db.transaction(tx => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${f.call.sessionId}`))).toMatchObject({allowed: true, userId: null});
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.call.intakeIssueId!));
      expect(comments.map(c => c.body)).toEqual(["Help draft a public inquiry", "Keep it short"]);
      expect(comments.every(c => !c.authorUserId && c.sourceTrust?.preset === "low_trust_review")).toBe(true);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.call.intakeIssueId!));
      expect(task.executionWorkspaceSettings).toMatchObject({mode: "isolated_workspace", workspaceStrategy: {type: "cloud_sandbox"}});
      expect(task.executionPolicy?.authorizationPolicy).toMatchObject({trustBoundary: {issueIds: [task.id], allowedToolClasses: [], allowedSecretBindingIds: []}});
      await db.update(chatVoicePhoneLines).set({guestIntake: false}).where(eq(chatVoicePhoneLines.endpointId, f.endpointId));
      await expect(db.transaction(tx => f.store.authorizePrincipal(tx, f.companyId, f.endpointId, `voice:${f.call.sessionId}`))).rejects.toMatchObject({status: 403});
    } finally { await chat.shutdown(); }
  });
  it("retains both spoken sides once on the public call task and preserves quarantine", async () => {
    const f = await inboundFixture(true), now = new Date().toISOString();
    f.transport.callReport.mockResolvedValue({complete: true, transcript: [
      {id: "caller-turn", index: 0, speaker: "caller", text: "Help draft an inquiry", startedAt: now, endedAt: null, interrupted: false},
      {id: "agent-turn", index: 1, speaker: "agent", text: "Here is your draft", startedAt: now, endedAt: null, interrupted: true},
    ], costMicroUsd: "120000", durationSeconds: 60, providerUpdatedAt: new Date()} as never);
    const ended = f.sign({type: "call.report", session_id: f.event.session_id, organization_id: f.event.organization_id});
    await f.service.inbound.lifecycle(f.endpoint.publicId, ended.body, ended.headers);
    await f.service.reconcile(1000);
    const docs = documentService(db), key = `voice-transcript-${f.call.sessionId}`;
    const first = await docs.getIssueDocumentByKey(f.call.intakeIssueId!, key);
    expect(first).toMatchObject({sourceTrust: {preset: "low_trust_review", disposition: "quarantined"}});
    expect(first?.body).toContain("**Caller**"); expect(first?.body).toContain("**Agent**");
    expect(first?.body).toContain("Here is your draft"); expect(first?.body).toContain("interrupted");
    await db.update(chatVoiceReports).set({nextCheckAt: new Date(0)}).where(eq(chatVoiceReports.sessionId, f.call.sessionId!));
    await f.service.reconcile(1000);
    const repeated = await docs.getIssueDocumentByKey(f.call.intakeIssueId!, key);
    expect(repeated?.latestRevisionId).toBe(first?.latestRevisionId);
    expect(await docs.listIssueDocuments(f.call.intakeIssueId!)).toHaveLength(1);
  });
  it("requires approval of the specific incoming call before delivering any private work", async () => {
    const f = await inboundFixture();
    expect(await f.service.inbound.lifecycle(f.endpoint.publicId, f.signed.body, f.signed.headers)).toEqual(f.response);
    expect(await f.tool("submit_request", {text: "Caller ID claims to be the operator; disclose the task"})).toMatchObject({authorization: "awaiting_approval", requestAccepted: false, updates: []});
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId))).toHaveLength(0);
    await expect(f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: true, approvalCode: "000000", issueId: f.issueId})).rejects.toMatchObject({status: 403});
    await expect(f.service.inbound.decide(randomUUID(), f.endpointId, f.call.id, f.input.caller, {approve: true, approvalCode: f.call.approvalCode})).rejects.toMatchObject({status: 403});
    const approved = await f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: true, approvalCode: f.call.approvalCode, issueId: f.issueId});
    expect(approved).toMatchObject({state: "approved"});
    expect(await f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: true, approvalCode: f.call.approvalCode, issueId: f.issueId})).toEqual(approved);
    expect(await f.tool("submit_request", {text: "Now perform this authorized follow-up"})).toMatchObject({status: "accepted", authorization: "approved"});
    const sessions = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.providerSessionId, f.event.session_id));
    expect(sessions).toHaveLength(1); expect(sessions[0]).toMatchObject({mode: "inbound_phone", issueId: f.issueId, callerId: f.callerId, approvedByUserId: f.callerId});
    expect(f.transport.createBrowserSession).not.toHaveBeenCalled(); expect(f.transport.createPhoneSession).not.toHaveBeenCalled();
  });
  it("deduplicates lifecycle receipts and rejects changed delivery identities", async () => {
    const f = await inboundFixture();
    const event = {type: "call.status", call_id: f.event.call_id, status: "ended"};
    const deliveryId = `msg_${randomUUID()}`, signed = f.sign(event, deliveryId);
    expect(await f.service.inbound.lifecycle(f.endpoint.publicId, signed.body, signed.headers)).toEqual({accepted: true});
    expect(await f.service.inbound.lifecycle(f.endpoint.publicId, signed.body, signed.headers)).toEqual({accepted: true});
    const changed = f.sign({...event, status: "failed"}, deliveryId);
    await expect(f.service.inbound.lifecycle(f.endpoint.publicId, changed.body, changed.headers)).rejects.toMatchObject({status: 409});
    const [call] = await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, f.call.id));
    expect(call.state).toBe("ended");
    const history = await f.service.inbound.history(f.companyId, f.endpointId, f.input.caller);
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({id: call.id, state: "ended"});
    expect(JSON.stringify(history)).not.toContain("approvalCode"); expect(JSON.stringify(history)).not.toContain("toolToken");
  });
  it("retires guest authority after an assignment or line permission change", async () => {
    const f = await inboundFixture(true);
    await f.tool("submit_request", {text: "Please record a public inquiry"});
    const [call] = await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.id, f.call.id));
    expect(await f.service.inbound.authorizeGuest(call.sessionId!)).toBe(true);
    await db.update(chatVoicePhoneLines).set({guestIntake: false}).where(eq(chatVoicePhoneLines.endpointId, f.endpointId));
    expect(await f.service.inbound.authorizeGuest(call.sessionId!)).toBe(false);
    await expect(f.tool("submit_request", {text: "Disabled guests cannot continue"})).rejects.toMatchObject({status: 403});
    await db.update(chatVoicePhoneLines).set({guestIntake: true}).where(eq(chatVoicePhoneLines.endpointId, f.endpointId));
    await db.update(issues).set({assigneeAgentId: null}).where(eq(issues.id, call.intakeIssueId!));
    expect(await f.service.inbound.authorizeGuest(call.sessionId!)).toBe(false);
  });
  it("denies expired and rejected calls and closes the existing provider leg without creating work", async () => {
    const f = await inboundFixture();
    expect(await f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: false, approvalCode: f.call.approvalCode})).toMatchObject({state: "denied"});
    expect(f.transport.endSession).toHaveBeenCalledWith(f.event.session_id);
    expect(await f.tool("submit_request", {text: "Try again"})).toMatchObject({authorization: "denied", requestAccepted: false});
    const expired = await inboundFixture();
    await db.update(chatVoiceInboundCalls).set({expiresAt: new Date(0)}).where(eq(chatVoiceInboundCalls.id, expired.call.id));
    expect(await expired.tool("get_updates", {cursor: 0})).toMatchObject({authorization: "expired", updates: []});
    await expect(expired.service.inbound.decide(expired.companyId, expired.endpointId, expired.call.id, expired.input.caller, {approve: true, approvalCode: expired.call.approvalCode})).rejects.toMatchObject({status: 409});
    await expired.service.inbound.reconcile(1000);
    expect(expired.transport.endSession).toHaveBeenCalledWith(expired.event.session_id);
    expect(await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, expired.endpointId))).toHaveLength(0);
  });
  it("rejects unsigned, cross-number, cross-workspace and stale incoming admissions", async () => {
    const f = await inboundFixture();
    await expect(f.service.inbound.lifecycle(f.endpoint.publicId, f.signed.body, {...f.signed.headers, "webhook-signature": "v1,invalid"})).rejects.toMatchObject({code: "invalid_signature"});
    for (const event of [{...f.event, phone_number_id: "other"}, {...f.event, organization_id: "other"}, {...f.event, call_id: "other"}]) {
      const signed = f.sign(event); await expect(f.service.inbound.lifecycle(f.endpoint.publicId, signed.body, signed.headers)).rejects.toMatchObject({status: 403});
    }
    await db.update(chatEndpoints).set({setup: {step: "complete", runtimeGeneration: 2}}).where(eq(chatEndpoints.id, f.endpointId));
    await expect(f.tool("get_updates", {cursor: 0})).rejects.toMatchObject({status: 403});
    await expect(f.service.inbound.decide(f.companyId, f.endpointId, f.call.id, f.input.caller, {approve: true, approvalCode: f.call.approvalCode})).rejects.toMatchObject({status: 409});
  });
  it("retains one safe report per call and rejects history after access revocation", async () => {
    const f = await nativeServiceFixture(), first = await f.service.start(f.input);
    await f.service.end(f.companyId, first.session.id, f.input.caller);
    await f.service.reconcile(1000);
    const detail = await f.service.callDetail(f.companyId, first.session.id, f.input.caller);
    expect(detail.report).toMatchObject({ status: "available", costMicroUsd: "120000", transcript: [{ id: "turn1", text: "A test request" }] });
    expect(await f.service.history(f.companyId, f.endpointId, f.input.caller)).toEqual(expect.arrayContaining([detail]));
    await db.update(chatVoiceReports).set({transcript: [...detail.report.transcript, {...detail.report.transcript[0]!, id: "legacy-control", index: 1, text: VOICE_RESULT_NOTIFICATION}]}).where(eq(chatVoiceReports.sessionId, first.session.id));
    expect((await f.service.callDetail(f.companyId, first.session.id, f.input.caller)).report.transcript).toEqual(detail.report.transcript);

    await db.update(chatVoiceReports).set({ nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, first.session.id));
    const latest = new Date(Date.now() + 10000);
    f.transport.callReport.mockResolvedValueOnce({ ...await f.transport.callReport(), costMicroUsd: "240000", providerUpdatedAt: latest });
    await f.service.reconcile(1000);
    await db.update(chatVoiceReports).set({ nextCheckAt: new Date(0) }).where(eq(chatVoiceReports.sessionId, first.session.id));
    f.transport.callReport.mockResolvedValueOnce({ ...await f.transport.callReport(), costMicroUsd: "1", providerUpdatedAt: new Date(0) });
    await f.service.reconcile(1000);
    expect((await f.service.callDetail(f.companyId, first.session.id, f.input.caller)).report.costMicroUsd).toBe("240000");
    expect(await db.select().from(chatVoiceReports).where(eq(chatVoiceReports.sessionId, first.session.id))).toHaveLength(1);
    await expect(f.service.callDetail(f.companyId, first.session.id, { id: randomUUID(), authority: "member" })).rejects.toMatchObject({ status: 403 });
    await expect(f.service.callDetail(randomUUID(), first.session.id, f.input.caller)).rejects.toMatchObject({ status: 404 });
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, f.callerId));
    await expect(f.service.history(f.companyId, f.endpointId, f.input.caller)).rejects.toMatchObject({ status: 403 });
    await expect(f.service.callDetail(f.companyId, first.session.id, f.input.caller)).rejects.toMatchObject({ status: 403 });
    expect(f.transport.createPhoneSession).not.toHaveBeenCalled();
  });
  it("does not create provider media when membership is revoked during credential resolution", async () => {
    const f = await nativeServiceFixture();
    f.credentials.mockImplementationOnce(async () => {
      await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, f.callerId));
      return { apiKey: "server-only-key", agentId: "agent_test" };
    });
    await expect(f.service.start(f.input)).rejects.toMatchObject({ status: 409, details: { code: "voice_creation_failed" } });
    expect(f.transport.createBrowserSession).not.toHaveBeenCalled();
  });

  it("returns the existing call for concurrent starts with different request keys", async () => {
    const f = await nativeServiceFixture();
    const results = await Promise.allSettled([f.service.start(f.input), f.service.start({ ...f.input, idempotencyKey: randomUUID() })]);
    const accepted = results.find(result => result.status === "fulfilled");
    const rejected = results.find(result => result.status === "rejected");
    expect(accepted?.status).toBe("fulfilled");
    expect(rejected?.status).toBe("rejected");
    if (accepted?.status !== "fulfilled" || rejected?.status !== "rejected") throw new Error("Expected one active call");
    expect(rejected.reason).toMatchObject({ status: 409, details: { code: "voice_call_already_active", sessionId: accepted.value.session.id } });
    expect(f.transport.createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("continues one caller's conversation across five calls, with explicit new conversations", async () => {
    const f = await nativeServiceFixture();
    const input = { ...f.input, issueId: undefined };
    const first = await f.service.start(input);
    await f.service.end(f.companyId, first.session.id, f.request.caller);
    for (let turn = 0; turn < 4; turn++) {
      const next = await f.service.start({ ...input, idempotencyKey: randomUUID() });
      expect(next.session.issueId).toBe(first.session.issueId);
      await f.service.end(f.companyId, next.session.id, f.request.caller);
    }
    const fresh = await f.service.start({ ...input, newConversation: true, idempotencyKey: randomUUID() });
    expect(fresh.session.issueId).not.toBe(first.session.issueId);
    const other = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: other, status: "active", membershipRole: "member" });
    const independent = await f.service.start({ ...input, caller: { id: other, authority: "member" }, idempotencyKey: randomUUID() });
    expect(independent.session.issueId).not.toBe(fresh.session.issueId);
    expect(independent.session.issueId).not.toBe(first.session.issueId);
  });

  it("allows hangup but denies private session inspection after membership revocation", async () => {
    const f = await nativeServiceFixture(), result = await f.service.start(f.input);
    await db.update(companyMemberships).set({ status: "removed" }).where(eq(companyMemberships.principalId, f.callerId));
    await expect(f.service.inspect(f.companyId, result.session.id, f.request.caller)).rejects.toMatchObject({ status: 403 });
    expect(await f.service.end(f.companyId, result.session.id, f.request.caller)).toMatchObject({ state: "ended" });
    expect(f.transport.endSession).toHaveBeenCalledOnce();
  });

  it("creates one hosted session, returns only short-lived media, and resumes the existing task", async () => {
    const f = await nativeServiceFixture();
    const first = await f.service.start(f.input), retry = await f.service.start(f.input);
    expect(first.session.issueId).toBe(f.issueId);
    expect(first.media?.transportToken).toBe("short-lived-media-token");
    expect(JSON.stringify(first)).not.toContain("server-only-key");
    expect(retry.session.id).toBe(first.session.id);
    expect(retry.media).toBeUndefined();
    expect(f.transport.createBrowserSession).toHaveBeenCalledTimes(1);
    const row = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, first.session.id));
    expect(JSON.stringify(row)).not.toContain("short-lived-media-token");
    expect((await f.service.end(f.companyId, first.session.id, f.input.caller)).state).toBe("ended");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
  });

  it("starts from an agent by creating one task through the ordinary issue service", async () => {
    const f = await nativeServiceFixture();
    const input = { ...f.input, issueId: undefined };
    const first = await f.service.start(input), retry = await f.service.start(input);
    expect(first.session.issueId).not.toBe(f.issueId);
    expect(retry.session.issueId).toBe(first.session.issueId);
    expect((await db.select().from(issues).where(eq(issues.id, first.session.issueId)))[0]).toMatchObject({ assigneeAgentId: f.agentId, originKind: "chat_channel" });
    expect(f.transport.createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("quarantines an uncertain provider creation without redialing on retry", async () => {
    const f = await nativeServiceFixture();
    f.transport.createBrowserSession.mockRejectedValueOnce(new SpekoProviderError("provider_unavailable", true));
    await expect(f.service.start(f.input)).rejects.toMatchObject({ status: 409, details: { code: "voice_creation_unknown" } });
    expect((await f.service.start(f.input)).session.state).toBe("creation_unknown");
    expect(f.transport.createBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("does not claim ended until the provider confirms teardown", async () => {
    const f = await nativeServiceFixture(), started = await f.service.start(f.input);
    f.transport.endSession.mockResolvedValue({ confirmed: false });
    expect((await f.service.end(f.companyId, started.session.id, f.input.caller)).state).toBe("ending");
    f.transport.inspectSession.mockResolvedValue({ status: "ended", endedAt: new Date().toISOString() });
    expect((await f.service.inspect(f.companyId, started.session.id, f.input.caller)).state).toBe("ended");
  });

  it("joins simultaneous hangups and confirms a room already closed by the browser", async () => {
    const f = await nativeServiceFixture(), started = await f.service.start(f.input);
    f.transport.endSession.mockRejectedValue(new SpekoProviderError("provider_unavailable", true));
    f.transport.inspectSession.mockResolvedValue({ status: "ended", endedAt: new Date().toISOString() });
    const replies = await Promise.all([f.service.end(f.companyId, started.session.id, f.input.caller), f.service.end(f.companyId, started.session.id, f.input.caller)]);
    expect(replies.every((reply) => reply.state === "ended")).toBe(true);
    expect(f.transport.endSession).toHaveBeenCalledTimes(1);
  });

  it("reconciles a provider hangup even without a browser end request", async () => {
    const f = await nativeServiceFixture(), started = await f.service.start(f.input);
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    await db.update(chatVoiceSessions).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(chatVoiceSessions.id, started.session.id));
    f.transport.inspectSession.mockResolvedValue({ status: "ended", endedAt: new Date().toISOString() });
    await f.service.reconcile(1000);
    const [row] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, started.session.id));
    expect(row.state).toBe("ended");
    expect(row.endedAt).toBeInstanceOf(Date);
    expect(f.transport.endSession).not.toHaveBeenCalledWith((await f.transport.createBrowserSession.mock.results[0]!.value).sessionId);
  });

  it("retries definitively rejected tool setup and repairs completed tools on reconnect", async () => {
    const f = await nativeServiceFixture();
    const tools: { id: string; name: string; source: { kind: string; url: string } }[] = [];
    f.transport.listTools.mockImplementation(async () => structuredClone(tools) as never[]);
    f.transport.configureTool.mockImplementation(async (_agentId: string, definition: any, _secret: string, id?: string) => {
      const tool = { id: id ?? randomUUID(), name: definition.name, source: definition.source };
      if (!id) tools.push(tool);
      return { id: tool.id };
    });
    f.transport.configureTool.mockRejectedValueOnce(new SpekoProviderError("rate_limited", false, 429));
    const input = { companyId: f.companyId, endpointId: f.endpointId, agentId: "agent_test", callbackUrl: "https://voice.example.test/tools", signingSecret: "whsec_fixture", client: f.transport, assertOwned: async () => {} };
    await expect(configureSpekoSessionTools(db, input)).rejects.toMatchObject({ outcomeUnknown: false });
    await configureSpekoSessionTools(db, input);
    expect(tools).toHaveLength(3);
    await configureSpekoSessionTools(db, input);
    expect(tools).toHaveLength(3);
    expect(f.transport.configureTool).toHaveBeenCalledTimes(7);
    expect(f.transport.configureTool.mock.calls.slice(-3).every((call) => Boolean(call[3]))).toBe(true);
  });

  it("moves only receipt-owned tools and lifecycle hooks when the callback origin changes", async () => {
    const f = await nativeServiceFixture();
    const tools: {id: string; name: string; source: {kind: string; url: string}}[] = [];
    f.transport.listTools.mockImplementation(async () => structuredClone(tools) as never[]);
    f.transport.configureTool.mockImplementation(async (_agent: string, definition: any, _secret: string, id?: string) => {
      const tool = {id: id ?? randomUUID(), name: definition.name, source: definition.source};
      const index = tools.findIndex(t => t.id === tool.id);
      if (index === -1) tools.push(tool); else tools[index] = tool;
      return {id: tool.id};
    });
    const input = {companyId: f.companyId, endpointId: f.endpointId, agentId: "agent_test", callbackUrl: "https://old-tunnel.example.test/tools", signingSecret: "whsec_fixture", client: f.transport, assertOwned: async () => {}};
    await configureSpekoSessionTools(db, input);
    const oldIds = tools.map(t => t.id);
    await configureSpekoSessionTools(db, {...input, callbackUrl: "https://new-tunnel.example.test/tools"});
    expect(tools.map(t => t.id)).toEqual(oldIds);
    expect(tools.every(t => t.source.url === "https://new-tunnel.example.test/tools")).toBe(true);
    expect(f.transport.configureWebhook.mock.calls.at(-1)?.[3]).toBe("hook_test");
    // Even the same provider ID is no longer ours if its URL was changed outside
    // Paperclip. A historical ID alone cannot authorize overwriting it.
    tools[0]!.source.url = "https://another-app.example.test/tools";
    f.transport.configureTool.mockClear();
    await expect(configureSpekoSessionTools(db, {...input, callbackUrl: "https://third-tunnel.example.test/tools"})).rejects.toMatchObject({status: 409});
    expect(f.transport.configureTool).not.toHaveBeenCalled();
  });

  it("quarantines uncertain tool creation until the matching tool can be recovered", async () => {
    const f = await nativeServiceFixture();
    const tools: { id: string; name: string; source: { kind: string; url: string } }[] = [];
    f.transport.listTools.mockImplementation(async () => structuredClone(tools) as never[]);
    f.transport.configureTool.mockRejectedValueOnce(new SpekoProviderError("provider_unavailable", true));
    const input = { companyId: f.companyId, endpointId: f.endpointId, agentId: "agent_test", callbackUrl: "https://voice.example.test/tools", signingSecret: "whsec_fixture", client: f.transport, assertOwned: async () => {} };
    await expect(configureSpekoSessionTools(db, input)).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(configureSpekoSessionTools(db, input)).rejects.toMatchObject({ status: 409 });
    expect(f.transport.configureTool).toHaveBeenCalledTimes(1);
    tools.push({ id: "recovered_tool", name: "submit_request", source: { kind: "webhook", url: input.callbackUrl } });
    f.transport.configureTool.mockImplementation(async (_agentId: string, definition: any, _secret: string, id?: string) => {
      const tool = { id: id ?? randomUUID(), name: definition.name, source: definition.source };
      if (!id) tools.push(tool);
      return { id: tool.id };
    });
    await configureSpekoSessionTools(db, input);
    expect(f.transport.configureTool.mock.calls[1]?.[3]).toBe("recovered_tool");
    expect(tools).toHaveLength(3);
  });

  it("drains real chat deliveries into one task and durable agent wakeups", async () => {
    const f = await fixture();
    const wakeup = vi.fn(async (agentId, opts) => {
      const request = opts.durableChatRequest;
      if (!request) throw new Error("Voice requires a durable wakeup");
      await db.transaction(async (tx) => {
        await request.authorize(tx);
        await tx.insert(agentWakeupRequests).values({ id: request.id, companyId: request.companyId, agentId, source: opts.source ?? "assignment", triggerDetail: opts.triggerDetail, reason: opts.reason, payload: opts.payload, requestedByActorType: opts.requestedByActorType, requestedByActorId: opts.requestedByActorId, idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt, status: "queued" }).onConflictDoNothing();
      });
      return { accepted: true };
    });
    const chat = chatChannelService(db, { heartbeat: { wakeup }, deferWebhookProcessing: true });
    try {
      const accepted = await f.store.runTool(f.toolInput("submit_request", { text: "Research the shipping options" }));
      await chat.processPendingDeliveries(25, accepted.requestId as string);
      const delivery = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, accepted.requestId as string));
      expect(delivery[0], JSON.stringify(delivery[0])).toMatchObject({ state: "processed", conversationId: f.conversationId });
      const followup = await f.store.runTool(f.toolInput("submit_request", { text: "Also compare the delivery dates" }));
      await chat.processPendingDeliveries(25, followup.requestId as string);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.map((comment) => comment.body)).toEqual(expect.arrayContaining(["Research the shipping options", "Also compare the delivery dates"]));
      expect(wakeup).toHaveBeenCalledTimes(2);
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(2);
    } finally { await chat.shutdown(); }
  });

  async function phoneToolFixture() {
    const f = await nativeServiceFixture();
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    await f.service.saveCallbackPreference(f.companyId, f.endpointId, f.request.caller, { phoneNumber: "+12015551234", enabled: true });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.issueId } });
    await initializeRunIdentity(db, { companyId: f.companyId, agentId: f.agentId, runId, issueId: f.issueId, responsibleUserId: f.callerId, cause: "queued" });
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "speko-outbound-fixture-only" });
    const gatewaySession = await gateway.createSession({ companyId: f.companyId, agentId: f.agentId, runId, issueId: f.issueId });
    return { ...f, runId, gateway, gatewaySession };
  }
  it("delivers Speko guidance to existing agents only while the connection remains assigned and enabled", async () => {
    const f = await phoneToolFixture();
    const binding = { companyId: f.companyId, agentId: f.agentId };
    const assigned = async () => (await resolveConnectorAssignments(db, binding)).filter(item => item.key === "speko");
    const assignments = await assigned();
    expect(assignments).toMatchObject([{ skillKey: "paperclipai/paperclip/speko", resources: [{ id: f.endpointId, connectionId: f.connectionId }], tools: [] }]);
    const config = await applyConnectorSkills({}, [], assignments);
    const skill = config.paperclipRuntimeSkills[0];
    const markdown = await readFile(join(skill.source, "SKILL.md"), "utf8");
    expect(markdown).toContain("one focused clarification");
    expect(markdown).toContain("durable Paperclip continuation");
    expect(markdown).toContain("never blindly redial");
    expect(markdown).not.toContain("+12015551234");
    for (const adapter of ["paperclip_runner", "claude_local", "codex_local"]) {
      expect((await prepareConnectorSkillDelivery({ ...config, engine: "cli" }, adapter)).config.paperclipRuntimeSkills).toEqual([skill]);
    }
    expect((await prepareConnectorSkillDelivery(config, "cursor_local")).instructions).toContain("name: speko");
    expect((await prepareConnectorSkillDelivery(config, "paperclip_runner")).instructions).toContain("name: speko");
    expect((await resolveConnectorAssignments(db, { ...binding, agentId: randomUUID() })).filter(item => item.key === "speko")).toEqual([]);
    expect((await resolveConnectorAssignments(db, { ...binding, companyId: randomUUID() })).filter(item => item.key === "speko")).toEqual([]);
    // Browser voice guidance remains available when phone callbacks are disabled.
    await db.update(chatVoiceCallbacks).set({ enabled: false }).where(eq(chatVoiceCallbacks.endpointId, f.endpointId));
    expect(await assigned()).toHaveLength(1);
    for (const status of ["paused", "revoked", "archived"] as const) {
      await db.update(chatEndpoints).set({ status }).where(eq(chatEndpoints.id, f.endpointId));
      expect(await assigned()).toEqual([]);
    }
    await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connectionId));
    expect(await assigned()).toEqual([]);
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, f.connectionId));
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
    expect(await assigned()).toEqual([]);
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
    expect(await assigned()).toHaveLength(1);
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.targetId, f.agentId));
    expect(await assigned()).toEqual([]);
    const removed = await applyConnectorSkills(config, config.paperclipRuntimeSkills, []);
    expect(removed.paperclipRuntimeSkills).toEqual([]);
  });

  it("makes call_my_phone discoverable through the governed gateway and reuses a durable attempt", async () => {
    const f = await phoneToolFixture();
    const tools = await f.gateway.listToolsForSession(f.gatewaySession.token);
    const tool = tools.find(tool => tool.providerType === "paperclip_speko_voice");
    expect(tool).toMatchObject({ upstreamToolName: "call_my_phone", connectionId: f.connectionId });
    const call = { sessionToken: f.gatewaySession.token, tool: tool!.name, parameters: {}, idempotencyKey: randomUUID() };
    const result = await f.gateway.executeTool(call);
    expect(result).toBeDefined();
    expect(f.transport.createPhoneSession).toHaveBeenCalledOnce();
    expect(f.transport.createPhoneSession.mock.calls[0]![0]).toMatchObject({ to: "+12015551234", bindingId: expect.any(String) });
    await f.gateway.executeTool(call);
    expect(f.transport.createPhoneSession).toHaveBeenCalledOnce();
    const sessions = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.endpointId, f.endpointId));
    expect(sessions.filter(s => s.mode === "outbound_phone")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("+12015551234");
    expect(JSON.stringify(result)).not.toContain("short-lived-media-token");
  });
  it("does not restore an agent's removed tool binding when callback settings are saved again", async () => {
    const f = await phoneToolFixture();
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.targetId, f.agentId));
    await f.service.saveCallbackPreference(f.companyId, f.endpointId, f.request.caller, { phoneNumber: "+12015551234", enabled: true });
    expect((await f.gateway.listToolsForSession(f.gatewaySession.token)).some(t => t.providerType === "paperclip_speko_voice")).toBe(false);
  });
  it("requires the current task requester, company, active endpoint, opt-in and agent assignment", async () => {
    const f = await phoneToolFixture();
    expect(await spekoToolsForSession(db, f.gatewaySession)).toHaveLength(1);
    await expect(executeSpekoVoiceTool(db, f.gatewaySession, f.endpointId, { to: "+12015559999" }, randomUUID())).rejects.toThrow();
    expect(await spekoToolsForSession(db, { ...f.gatewaySession, companyId: randomUUID() })).toHaveLength(0);
    expect(await spekoToolsForSession(db, { ...f.gatewaySession, issueId: randomUUID() })).toHaveLength(0);
    expect(await spekoToolsForSession(db, { ...f.gatewaySession, identityContextId: randomUUID() })).toHaveLength(0);
    await f.service.saveCallbackPreference(f.companyId, f.endpointId, f.request.caller, { phoneNumber: "+12015551234", enabled: false });
    expect(await spekoToolsForSession(db, f.gatewaySession)).toHaveLength(0);
    await expect(executeSpekoVoiceTool(db, f.gatewaySession, f.endpointId, {}, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect(f.transport.createPhoneSession).not.toHaveBeenCalled();
  });
  it("keeps callback numbers personal and refuses callers from another company", async () => {
    const f = await phoneToolFixture();
    const secondUser = randomUUID();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: secondUser, principalType: "user", status: "active", membershipRole: "member" });
    expect(await f.service.callbackPreference(f.companyId, f.endpointId, { id: secondUser, authority: "member" })).toBeNull();
    await expect(f.service.callbackPreference(f.companyId, f.endpointId, { id: randomUUID(), authority: "member" })).rejects.toMatchObject({ status: 403 });
    await expect(f.service.callbackPreference(randomUUID(), f.endpointId, f.request.caller)).rejects.toMatchObject({ status: 404 });
  });
  it("never redials a phone call whose creation response was lost", async () => {
    const f = await phoneToolFixture();
    f.transport.createPhoneSession.mockRejectedValueOnce(new SpekoProviderError("provider_unavailable", true));
    const invocationId = randomUUID();
    await expect(executeSpekoVoiceTool(db, f.gatewaySession, f.endpointId, {}, invocationId)).rejects.toMatchObject({ status: 409 });
    const retry = await executeSpekoVoiceTool(db, f.gatewaySession, f.endpointId, {}, invocationId);
    expect(retry).toMatchObject({ session: { state: "creation_unknown", mode: "outbound_phone" } });
    expect(f.transport.createPhoneSession).toHaveBeenCalledOnce();
  });

  it("isolates signed outbound polling from browser hints without creating an admission", async () => {
    const f = await inboundFixture();
    const event = {type: "call.pre_call", session_id: randomUUID(), organization_id: `org_${f.companyId}`, direction: "outbound"};
    const signed = f.sign(event);
    const response = await f.service.inbound.lifecycle(f.endpoint.publicId, signed.body, signed.headers);
    expect(response).toMatchObject({idleRePrompts: {enabled: true}});
    expect(response).not.toHaveProperty("toolSecrets");
    const web = f.sign({...event, direction: "web"});
    expect(await f.service.inbound.lifecycle(f.endpoint.publicId, web.body, web.headers)).toEqual({idleRePrompts: {enabled: false}});
    expect(await db.select().from(chatVoiceInboundCalls).where(eq(chatVoiceInboundCalls.companyId, f.companyId))).toHaveLength(1);
  });

  it("delivers the phone tool to the assigned agent's actual runtime MCP server", async () => {
    const f = await phoneToolFixture();
    const previousUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
    try {
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: { id: f.agentId, companyId: f.companyId, name: "Phone tool agent" }, runId: f.runId });
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({ url: expect.stringContaining("/mcp/gateways/") });
    } finally { if (previousUrl === undefined) delete process.env.PAPERCLIP_API_URL; else process.env.PAPERCLIP_API_URL = previousUrl; }
  });

});
