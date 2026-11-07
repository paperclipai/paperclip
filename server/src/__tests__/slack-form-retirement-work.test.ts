import { readSlackFormRetainedConsumer } from "../services/chat-channels/slack/cloud-consumer.js";
import { transferSlackFormAckReceipt } from "../services/chat-channels/slack/form-ack-work.js";
import { parseSlackFormFinalizedReceipt, slackFormFinalizedReceiptDigest } from "../services/chat-channels/slack/ack-receipt.js";
import { createPaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, applyPendingMigrations, authUsers, chatActions, chatEndpoints, companies, companyMemberships,
  toolApplications, toolConnections, createDb, closeCheckpointDb, closeFileStorageDb, closeLivenessDb } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { stageSlackFormEnrollment, stageSlackFormOwnerConfiguration, reconcileSlackFormEnrollment, reconcilePendingSlackFormWork } from "../services/chat-channels/slack/form-owner.js";
import { acceptSlackFormRetirementLocally, transferSlackFormRetirement } from "../services/chat-channels/slack/form-retirement-work.js";
import { slackFormRetirementReceipt, slackFormRetirementHistoryReceipt } from "../services/chat-channels/slack/ack-retirement-receipt.js";
import { parseSlackFormBinding } from "../services/chat-channels/slack/cloud-forms.js";
import { retrySlackFormAcknowledgement } from "../services/chat-channels/slack/form-retry.js";
import { connectionManagementService } from "../services/connection-management.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SLACK_RETIREMENT_TEST_DATABASE_URL");
if (process.env.SLACK_GATE_EXPECT_PRELOAD === "1" && !external) throw new Error("Guarded retirement SQL requires an explicit external database");
(external ? describe : describe.skip)("Slack retirement original-custody SQL handoff", () => {
  let db: ReturnType<typeof createDb>, companyId: string, endpointId: string, connectionId: string, applicationId: string, agentId: string, actorId: string, actionId: string;
  const identity = { instanceId: "retirement-sql-instance", environment: "test" as const };
  let binding: ReturnType<typeof parseSlackFormBinding>, compactJws: string;
  const row = async () => (await db.select().from(chatActions).where(and(eq(chatActions.id, actionId), eq(chatActions.companyId, companyId))))[0]!;
  const trigger = "slack_retirement_controlled_update";
  function signCurrentReceipt(kid = "retirement-sql-key") {
    const pair = generateKeyPairSync("ed25519");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", identity.instanceId);
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] }));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const receipt = slackFormRetirementReceipt(binding, identity.environment, actorId);
    const body = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: identity.instanceId, receipt });
    return body + "." + sign(null, Buffer.from(body), pair.privateKey).toString("base64url");
  }

  beforeAll(async () => {
    if (!external) throw new Error("explicit retirement database absent");
    await applyPendingMigrations(external);
    db = createDb(external, { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 60000);
  beforeEach(async () => {
    companyId = randomUUID(); endpointId = randomUUID(); connectionId = randomUUID(); applicationId = randomUUID(); agentId = randomUUID(); actorId = `retirement-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Retirement custody", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values({ id: actorId, name: "Original owner", email: `${actorId}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId, membershipRole: "operator", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Custody fixture", adapterType: "process", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: false, intervalSec: 0 } } });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack custody", type: "chat" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack custody", uid: `slack-${connectionId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true, createdByUserId: actorId, config: { provider: "slack" } });
    binding = parseSlackFormBinding({ version: 1, instanceId: identity.instanceId, companyId, endpointId, connectionId, publicId: "p".repeat(43), runtimeGeneration: 1,
      teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
    const { credentialFingerprint, eventBindingId, ...base } = binding, enrollment = { ...base, bindingId: eventBindingId };
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, assignedAgentId: agentId, provider: "slack", publicId: binding.publicId,
      sponsorUserId: actorId, status: "active", allowUnlinkedPeople: false, setup: { step: "provider_setup" } });
    await db.update(chatEndpoints).set({ setup: sql`${JSON.stringify({ step: "provider_setup", runtimeGeneration: 1, slackCloudInstanceId: identity.instanceId,
      slackCloudSubject: actorId, slackCloudEvents: { runtimeGeneration: 1, bindingId: eventBindingId, teamId: binding.teamId, appId: binding.appId } })}::jsonb` }).where(eq(chatEndpoints.id, endpointId));
    actionId = await db.transaction(tx => stageSlackFormEnrollment(tx, { enrollment, subject: actorId, environment: identity.environment }));
    await reconcileSlackFormEnrollment(db, { actionId, identity, resolveBotToken: async () => "xoxb-controlled-test-only", protocol: async input => {
      expect(input.operation.kind).toBe("enroll"); expect(input.subject).toBe(actorId); expect(input.companyId).toBe(companyId); return { binding };
    } });
    expect((await row()).result?.phase).toBe("enrolled");
    await db.transaction(async tx => {
      await tx.update(chatEndpoints).set({ status: "paused" }).where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, companyId)));
      await stageSlackFormOwnerConfiguration(tx, endpointId, false, actorId, identity);
    });
    compactJws = signCurrentReceipt();
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [
      () => db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON chat_actions`)),
      () => db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger}()`)),
      () => db.delete(chatActions).where(eq(chatActions.companyId, companyId)),
      () => db.delete(chatEndpoints).where(eq(chatEndpoints.companyId, companyId)),
      () => db.delete(toolConnections).where(eq(toolConnections.companyId, companyId)),
      () => db.delete(toolApplications).where(eq(toolApplications.companyId, companyId)),
      () => db.delete(agents).where(eq(agents.companyId, companyId)),
      () => db.delete(activityLog).where(eq(activityLog.companyId, companyId)),
      () => db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId)),
      () => db.delete(companies).where(eq(companies.id, companyId)),
      () => db.delete(authUsers).where(eq(authUsers.id, actorId)),
    ]) try { await cleanup(); } catch (error) { errors.push(error); }
    vi.unstubAllEnvs();
    if (errors.length) throw new AggregateError(errors, "retirement SQL cleanup failure");
  });
  afterAll(async () => {
    const closed = await Promise.allSettled([closeCheckpointDb(db, 1), closeFileStorageDb(db, 1), closeLivenessDb(db, 1)]);
    await db?.$client.end({ timeout: 1 });
    const errors = closed.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new AggregateError(errors, "retirement auxiliary closure failure");
  });
  it("commits original-subject acceptance before Cloud compaction and retries a lost transfer after reconstruction", async () => {
    let retireCalls = 0, cleanupCalls = 0;
    await reconcileSlackFormEnrollment(db, { actionId, identity, resolveBotToken: async () => { throw new Error("retirement must not read credentials"); }, protocol: async input => {
      expect(input.subject).toBe(actorId); expect(input.companyId).toBe(companyId);
      if (input.operation.kind === "retire") { retireCalls++; return { retired: true }; }
      cleanupCalls++; return { cleaned: true, instanceId: identity.instanceId, environment: identity.environment, binding, retirementReceiptJws: compactJws };
    } });
    const accepted = await row(); expect(accepted.result?.phase).toBe("retirement_accepted"); expect(accepted.result?.retirementReceiptJws).toBe(compactJws);
    let compacted = false, transfers = 0; const lost = new Error("lost actual transfer response");
    const protocol = async (input: { subject: string; companyId: string; operation: Record<string, unknown> }) => {
      expect(input.subject).toBe(actorId); expect(input.companyId).toBe(companyId);
      if (input.operation.refreshRetirementReceipt) return { retirementReceiptJws: compactJws };
      if (input.operation.releaseRetirementFact) return { releasedRetirementDigest: slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId };
      expect(input.operation).toEqual({ kind: "cleanup", binding, acceptedRetirementReceipt: compactJws });
      transfers++; compacted = true; if (transfers === 1) throw lost;
      return { acceptedRetirementDigest: slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId };
    };
    const reported: string[] = [], owner = { identity, protocol, resolveBotToken: async () => { throw new Error("no new use"); }, report: (code: string) => { reported.push(code); } };
    const started = Date.now(), due = await reconcilePendingSlackFormWork(db, owner);
    const pending = await row(); expect(compacted).toBe(true); expect(pending.payload).toEqual(accepted.payload);
    expect(pending.result?.phase).toBe("retirement_accepted"); expect(pending.result?.retirementReceiptJws).toBe(compactJws);
    expect(pending.result?.attempts).toBe(1); expect(reported).toEqual(["form_owner_broker_unavailable"]);
    expect(due).toBe(Date.parse(String(pending.result?.nextAttemptAt))); expect(due).toBeGreaterThanOrEqual(started + 5000);
    if (due === null) throw new Error("normal owner did not retain retry deadline");
    while (Date.now() < due) await new Promise(resolve => setTimeout(resolve, due - Date.now()));
    expect(await reconcilePendingSlackFormWork(db, owner)).not.toBeNull();
    expect((await row()).result?.phase).toBe("retirement_gc_pending");
    expect(await reconcilePendingSlackFormWork(db, owner)).toBeNull();
    const complete = await row(); expect(slackFormRetirementHistoryReceipt(complete)?.subject).toBe(actorId);
    expect(complete.result?.retirementReceiptJws).toBeUndefined(); expect(retireCalls).toBe(1); expect(cleanupCalls).toBe(1); expect(transfers).toBe(2);
  }, 15000);
  it("a lost cleanup reply before App acceptance keeps original debt and the normal owner retries it", async () => {
    const original = await row(), lost = new Error("cleanup reply lost before local acceptance");
    let cleanups = 0;
    const owner = { identity, resolveBotToken: async () => { throw new Error("no credential reads during retirement"); }, report: () => {}, protocol: async (input: { operation: Record<string, unknown> }) => {
      if (input.operation.kind === "retire") return { retired: true };
      cleanups++; if (cleanups === 1) throw lost;
      return { cleaned: true, instanceId: identity.instanceId, environment: identity.environment, binding, retirementReceiptJws: compactJws };
    } };
    const due = await reconcilePendingSlackFormWork(db, owner), pending = await row();
    expect(pending.payload).toEqual(original.payload); expect(pending.result?.phase).toBe("retired_cleanup"); expect(pending.result?.retirementReceiptJws).toBeUndefined();
    expect(due).toBe(Date.parse(String(pending.result?.nextAttemptAt))); if (due === null) throw new Error("cleanup lost its retry deadline");
    while (Date.now() < due) await new Promise(resolve => setTimeout(resolve, due - Date.now()));
    await reconcilePendingSlackFormWork(db, owner); expect((await row()).result?.phase).toBe("retirement_accepted"); expect(cleanups).toBe(2);
  }, 15000);
  it("acceptance SQL rollback preserves old proof debt and a stale snapshot cannot clear a successor", async () => {
    const before = await row(); expect(actionId).toMatch(/^[a-f0-9-]+$/);
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${actionId}' AND NEW.result->>'phase'='retirement_accepted' THEN RAISE EXCEPTION 'controlled retirement acceptance rollback'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
    await expect(acceptSlackFormRetirementLocally(db, before, identity, compactJws)).rejects.toThrow(); expect(await row()).toEqual(before);
    await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON chat_actions`)); await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
    await db.update(chatActions).set({ result: { ...before.result, preservedSuccessor: "exact" } }).where(eq(chatActions.id, actionId));
    const successor = await row(); await expect(acceptSlackFormRetirementLocally(db, before, identity, compactJws)).rejects.toMatchObject({ code: "form_retirement_acceptance_changed" });
    expect(await row()).toEqual(successor);
  });
  it("foreign company and a changed accepted digest cannot clear local responsibility", async () => {
    const before = await row(); await expect(acceptSlackFormRetirementLocally(db, { ...before, companyId: randomUUID() }, identity, compactJws)).rejects.toMatchObject({ code: "form_retirement_authority_changed" });
    expect(await row()).toEqual(before); await acceptSlackFormRetirementLocally(db, before, identity, compactJws); const accepted = await row();
    await expect(transferSlackFormRetirement(db, accepted, identity, async input => input.operation.refreshRetirementReceipt ? { retirementReceiptJws: compactJws } : { acceptedRetirementDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "form_retirement_transfer_unconfirmed" });
    expect(await row()).toEqual(accepted);
  });
  it("current company-authorized Retry rearms retained debt and revoked authority cannot", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
    await db.update(chatActions).set({ status: "attention", result: { ...(await row()).result, failureCode: "form_retirement_verifier_unavailable", nextAttemptAt: null } }).where(eq(chatActions.id, actionId));
    const management = await connectionManagementService(db).authorize({ type: "board", userId: actorId, source: "session", ignoreInstanceAdmin: true }, "connections:configure",
      { type: "connection_management", companyId, connectionId, purpose: "chat", operation: "configure", readOnly: false });
    const before = await row(); expect((await retrySlackFormAcknowledgement(db, { companyId, endpointId, actionId, identity: () => identity, management })).state).toBe("scheduled");
    const pending = await row(); expect(pending.payload).toEqual(before.payload); expect(pending.result?.retirementReceiptJws).toBe(compactJws); expect(pending.result?.nextAttemptAt).not.toBeNull();
    await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, actorId)));
    await expect(retrySlackFormAcknowledgement(db, { companyId, endpointId, actionId, identity: () => identity, management })).rejects.toThrow();
    expect(await row()).toEqual(pending);
  });
  it("current signature refresh changes only the JWS and a successor CAS cannot be overwritten", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
    const accepted = await row(), currentJws = signCurrentReceipt("B");
    const protocol = async (input: { operation: Record<string, unknown> }) => input.operation.refreshRetirementReceipt
      ? { retirementReceiptJws: currentJws } : { acceptedRetirementDigest: "0".repeat(64) };
    await expect(transferSlackFormRetirement(db, accepted, identity, protocol)).rejects.toMatchObject({ code: "form_retirement_transfer_unconfirmed" });
    const refreshed = await row(); expect(refreshed.payload).toEqual(accepted.payload); expect(refreshed.status).toBe(accepted.status);
    expect(refreshed.result).toEqual({ ...accepted.result, retirementReceiptJws: currentJws });
    const nextJws = signCurrentReceipt("C"); let transfers = 0;
    await db.update(chatActions).set({ result: { ...refreshed.result, protectedSuccessor: true } }).where(eq(chatActions.id, actionId));
    const successor = await row();
    await expect(transferSlackFormRetirement(db, refreshed, identity, async input => {
      if (input.operation.refreshRetirementReceipt) return { retirementReceiptJws: nextJws };
      transfers++; return { acceptedRetirementDigest: slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId };
    })).rejects.toMatchObject({ code: "form_signature_refresh_changed" });
    expect(transfers).toBe(0); expect(await row()).toEqual(successor);
  });
  it("durable transfer tracks GC and retries a lost release reply without the old signing key", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws); const currentJws = signCurrentReceipt("B");
    const digest = slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId;
    let releases = 0; const lost = new Error("lost canonical fact release response");
    const protocol = async (input: { operation: Record<string, unknown> }) => {
      if (input.operation.refreshRetirementReceipt) return { retirementReceiptJws: currentJws };
      if (input.operation.acceptedRetirementReceipt) return { acceptedRetirementDigest: digest };
      expect(input.operation).toEqual({ kind: "cleanup", binding, releaseRetirementFact: { receiptId: digest } });
      releases++; if (releases === 1) throw lost; return { releasedRetirementDigest: digest };
    };
    await transferSlackFormRetirement(db, await row(), identity, protocol);
    const transferred = await row(); expect(transferred.result?.phase).toBe("retirement_gc_pending"); expect(transferred.result?.nextAttemptAt).not.toBeNull(); expect(releases).toBe(0);
    const owner = { identity, protocol, resolveBotToken: async () => { throw new Error("GC has no new credential use"); }, report: () => {} };
    const due = await reconcilePendingSlackFormWork(db, owner); const pending = await row(); expect(pending.result?.phase).toBe("retirement_gc_pending");
    expect(pending.result?.attempts).toBe(1); expect(due).toBe(Date.parse(String(pending.result?.nextAttemptAt))); if (due === null) throw new Error("GC debt lost its retry deadline");
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", "");
    while (Date.now() < due) await new Promise(resolve => setTimeout(resolve, due - Date.now()));
    expect(await reconcilePendingSlackFormWork(db, owner)).toBeNull(); expect((await row()).result?.phase).toBe("transferred"); expect(releases).toBe(2);
  }, 15000);
  it("transfer rollback cannot issue GC before the actual App SQL commit", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws); const currentJws = signCurrentReceipt("B");
    expect(actionId).toMatch(/^[a-f0-9-]+$/);
    await db.execute(sql.raw(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${actionId}' AND NEW.result->>'phase'='retirement_gc_pending' THEN RAISE EXCEPTION 'controlled transfer commit rollback'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON chat_actions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`));
    let transfers = 0, releases = 0; const digest = slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId;
    const protocol = async (input: { operation: Record<string, unknown> }) => {
      if (input.operation.refreshRetirementReceipt) return { retirementReceiptJws: currentJws };
      if (input.operation.acceptedRetirementReceipt) { transfers++; return { acceptedRetirementDigest: digest }; }
      releases++; return { releasedRetirementDigest: digest };
    };
    await expect(transferSlackFormRetirement(db, await row(), identity, protocol)).rejects.toThrow();
    expect(transfers).toBe(1); expect(releases).toBe(0); expect((await row()).result?.phase).toBe("retirement_accepted");
    await db.execute(sql.raw(`DROP TRIGGER ${trigger} ON chat_actions`)); await db.execute(sql.raw(`DROP FUNCTION ${trigger}()`));
    await transferSlackFormRetirement(db, await row(), identity, protocol); expect((await row()).result?.phase).toBe("retirement_gc_pending"); expect(releases).toBe(0);
    await transferSlackFormRetirement(db, await row(), identity, protocol); expect((await row()).result?.phase).toBe("transferred"); expect(releases).toBe(1);
  });

  it("a real paused endpoint polls reconstructed GC debt but completed exact session history stops recurring empty leases", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
    const retirementDigest = slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId;
    const retirementProtocol = async (input: { operation: Record<string, unknown> }) => input.operation.refreshRetirementReceipt
      ? { retirementReceiptJws: compactJws } : input.operation.acceptedRetirementReceipt
        ? { acceptedRetirementDigest: retirementDigest } : { releasedRetirementDigest: retirementDigest };
    await transferSlackFormRetirement(db, await row(), identity, retirementProtocol);
    await transferSlackFormRetirement(db, await row(), identity, retirementProtocol);
    expect((await row()).result?.phase).toBe("transferred");
    expect((await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]?.status).toBe("paused");
    const sessionId = randomUUID(), operationId = "c".repeat(64), deliveryId = `slack_form_${operationId}`, now = new Date().toISOString();
    const receipt = parseSlackFormFinalizedReceipt({ version: 1, kind: "slack_form_finalized", environment: identity.environment, binding,
      operationId, deliveryId, appReceiptId: sessionId, grantId: "grant", publicationId: "publication", interactionId: "interaction", userId: "UTEST",
      viewDigest: null, terminalDigest: "d".repeat(64), outcome: "no_effect", finalizedAt: now });
    const pair = generateKeyPairSync("ed25519"), kid = "session-canonical-control";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: identity.instanceId, receipt });
    const receiptJws = input + "." + sign(null, Buffer.from(input), pair.privateKey).toString("base64url");
    const terminalIntent = { version: 1, binding, operationId, deliveryId, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction",
      appReceiptId: sessionId, view: null, outcome: "no_effect", submitReceiptId: null, rejectionDigest: receipt.terminalDigest, encryptedEvidence: null };
    await db.insert(chatActions).values({ id: sessionId, companyId, endpointId, kind: "slack_form_session", providerActionId: `slack-form-session:${operationId}`,
      status: "failed", payload: { binding, environment: identity.environment, operationId, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction" },
      result: { phase: "not_opened", terminalIntent,
        cloudProofAcceptance: { version: 1, binding, operationId, appReceiptId: sessionId, outcome: "no_effect", terminalDigest: receipt.terminalDigest, acceptedAt: now },
        formAck: { version: 1, phase: "gc_pending", leaseId: "exact-session-lease", deliveryId, receiptJws, receipt }, nextAttemptAt: now } });
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const signPrivateKey = signing.privateKey.export({ format: "jwk" }).d, sealPrivateKey = sealing.privateKey.export({ format: "jwk" }).d;
    if (!signPrivateKey || !sealPrivateKey) throw new Error("normal controlled connector private keys absent");
    const connector = createPaperclipCloudConnector({ config: { baseUrl: "https://broker.example.test", instanceId: identity.instanceId,
      environment: identity.environment, signPrivateKey, sealPrivateKey }, request: async () => { throw new Error("Unexpected external connector request"); } });
    const lease = vi.spyOn(connector, "leaseEvents").mockResolvedValue(null);
    expect((await readSlackFormRetainedConsumer(db, connector)).owner).toMatchObject({ companyId, requiresDelivery: false });
    const pendingWorker = githubConnectionEventService(db, { connector, env: { PAPERCLIP_GITHUB_EVENT_POLLING: "1" } });
    await pendingWorker.pollOnce(); expect(lease).toHaveBeenCalledTimes(1); expect(pendingWorker.nextPollAt()).not.toBeNull();
    let releases = 0;
    await transferSlackFormAckReceipt(db, { companyId, actionId: sessionId, instanceId: identity.instanceId, protocol: async values => {
      expect(values.subject).toBe("github-bot-events"); expect(values.companyId).toBe(companyId);
      expect(values.operation).toEqual({ kind: "receipt", binding, operationId, deliveryId,
        releaseAckFact: { leaseId: "exact-session-lease", receiptDigest: slackFormFinalizedReceiptDigest(receipt), appReceiptId: sessionId } });
      releases++; return { releasedAckDigest: slackFormFinalizedReceiptDigest(receipt) };
    } });
    const [completed] = await db.select().from(chatActions).where(and(eq(chatActions.id, sessionId), eq(chatActions.companyId, companyId)));
    expect(completed?.result?.formAck).toMatchObject({ phase: "transferred", leaseId: "exact-session-lease", receipt });
    expect(completed?.result?.nextAttemptAt).toBeNull(); expect(releases).toBe(1);
    expect(await readSlackFormRetainedConsumer(db, connector)).toEqual({ owner: null, attention: [] });
    const completedWorker = githubConnectionEventService(db, { connector, env: { PAPERCLIP_GITHUB_EVENT_POLLING: "1" } });
    await completedWorker.pollOnce(); expect(lease).toHaveBeenCalledTimes(2); expect(completedWorker.nextPollAt()).toBeNull();
    await completedWorker.pollOnce(); expect(lease).toHaveBeenCalledTimes(2);
  });
  it("bounded retained-consumer pages pass more than32 completed rows to discover an unfinished tail without dropping attention", async () => {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
    const retirementDigest = slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId;
    const retirementProtocol = async (input: { operation: Record<string, unknown> }) => input.operation.refreshRetirementReceipt
      ? { retirementReceiptJws: compactJws } : input.operation.acceptedRetirementReceipt
        ? { acceptedRetirementDigest: retirementDigest } : { releasedRetirementDigest: retirementDigest };
    await transferSlackFormRetirement(db, await row(), identity, retirementProtocol);
    await transferSlackFormRetirement(db, await row(), identity, retirementProtocol);
    expect((await row()).result?.phase).toBe("transferred");
    expect((await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)))[0]?.status).toBe("paused");
    const sessionId = randomUUID(), operationId = "c".repeat(64), deliveryId = `slack_form_${operationId}`, now = new Date().toISOString();
    const receipt = parseSlackFormFinalizedReceipt({ version: 1, kind: "slack_form_finalized", environment: identity.environment, binding,
      operationId, deliveryId, appReceiptId: sessionId, grantId: "grant", publicationId: "publication", interactionId: "interaction", userId: "UTEST",
      viewDigest: null, terminalDigest: "d".repeat(64), outcome: "no_effect", finalizedAt: now });
    const pair = generateKeyPairSync("ed25519"), kid = "session-canonical-control";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: identity.instanceId, receipt });
    const receiptJws = input + "." + sign(null, Buffer.from(input), pair.privateKey).toString("base64url");
    const terminalIntent = { version: 1, binding, operationId, deliveryId, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction",
      appReceiptId: sessionId, view: null, outcome: "no_effect", submitReceiptId: null, rejectionDigest: receipt.terminalDigest, encryptedEvidence: null };
    await db.insert(chatActions).values({ id: sessionId, companyId, endpointId, kind: "slack_form_session", providerActionId: `slack-form-session:${operationId}`,
      status: "failed", payload: { binding, environment: identity.environment, operationId, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction" },
      result: { phase: "not_opened", terminalIntent,
        cloudProofAcceptance: { version: 1, binding, operationId, appReceiptId: sessionId, outcome: "no_effect", terminalDigest: receipt.terminalDigest, acceptedAt: now },
        formAck: { version: 1, phase: "gc_pending", leaseId: "exact-session-lease", deliveryId, receiptJws, receipt }, nextAttemptAt: now } });
    await transferSlackFormAckReceipt(db, { companyId, actionId: sessionId, instanceId: identity.instanceId,
      protocol: async () => ({ releasedAckDigest: slackFormFinalizedReceiptDigest(receipt) }) });
    const [completed] = await db.select().from(chatActions).where(and(eq(chatActions.id, sessionId), eq(chatActions.companyId, companyId)));
    if (!completed) throw new Error("Actual GC transition lost its session");
    for (let n = 1; n <= 33; n++) {
      const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, op = n.toString(16).padStart(64, "0"), delivery = `slack_form_${op}`;
      const historyReceipt = { ...receipt, operationId: op, deliveryId: delivery, appReceiptId: id };
      const body = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: identity.instanceId, receipt: historyReceipt });
      const historyJws = body + "." + sign(null, Buffer.from(body), pair.privateKey).toString("base64url");
      await db.insert(chatActions).values({ ...completed, id, providerActionId: `slack-form-session:${op}`,
        payload: { ...completed.payload, operationId: op }, result: { phase: "not_opened",
          terminalIntent: { ...terminalIntent, operationId: op, deliveryId: delivery, appReceiptId: id },
          cloudProofAcceptance: { version: 1, binding, operationId: op, appReceiptId: id, outcome: "no_effect", terminalDigest: receipt.terminalDigest, acceptedAt: now },
          formAck: { version: 1, phase: "transferred", leaseId: "exact-session-lease", deliveryId: delivery, receiptJws: historyJws, receipt: historyReceipt }, nextAttemptAt: null } });
    }
    const tailId = "ffffffff-ffff-4fff-8fff-ffffffffffff", tailOp = "f".repeat(64);
    await db.insert(chatActions).values({ id: tailId, companyId, endpointId, kind: "slack_form_session", status: "processing", providerActionId: `slack-form-session:${tailOp}`,
      payload: { binding, environment: identity.environment, operationId: tailOp, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction" },
      result: { phase: "update_attempted", view: { id: "VTAIL", hash: "same-loading-hash", externalId: `pc-form-${tailOp}` } } });
    const connector = { instanceIdentity: () => identity };
    expect((await readSlackFormRetainedConsumer(db, connector)).owner).toEqual({ subject: "github-bot-events", companyId, binding, requiresDelivery: true });
    await db.insert(chatActions).values({ id: "00000000-0000-4000-8000-000000000000", companyId, endpointId, kind: "slack_form_session", status: "attention", providerActionId: "malformed-retained-page",
      payload: { binding: { instanceId: identity.instanceId }, environment: identity.environment }, result: {} });
    const withMalformed = await readSlackFormRetainedConsumer(db, connector);
    expect(withMalformed.owner).toMatchObject({ companyId, requiresDelivery: true });
    expect(withMalformed.attention).toContainEqual({ actionId: "00000000-0000-4000-8000-000000000000", code: "form_retained_owner_invalid" });
    expect(withMalformed.attention.length).toBeLessThanOrEqual(32);
  });

});
