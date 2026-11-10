import { readSlackIdleIncomingProof } from "../services/chat-channels/slack/idle-incoming.js";
import { idleChatHistoryChecksForOwner } from "../services/chat-channels/idle-history-proof.js";
import { registerConnectionEventWake, hasConnectionEventWakeReceiver } from "../services/connection-event-wake.js";
import { slackConfiguredBindingsFingerprint } from "../services/chat-channels/slack/configured-coverage.js";
import { verifyCloudControlAssertion, CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_JWS_TYPE } from "../services/cloud-runtime-identity.js";
import type { VerifiedIdleCapabilities } from "../services/idle-incoming-wake-capability.js";
import { retainSlackFormOpeningProof } from "../services/chat-channels/slack/form-opening-proof.js";
import { readSlackFormRetainedConsumer } from "../services/chat-channels/slack/cloud-consumer.js";
import { parseSlackFormAckWork, transferSlackFormAckReceipt } from "../services/chat-channels/slack/form-ack-work.js";
import { parseSlackFormFinalizedReceipt, slackFormFinalizedReceiptDigest } from "../services/chat-channels/slack/ack-receipt.js";
import { createPaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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
  function signedRetainedHistoryCapabilities(): VerifiedIdleCapabilities {
    const key=generateKeyPairSync("ed25519"),kid="retained-history-current",now=Math.floor(Date.now()/1000),generation="e".repeat(64);
    const capabilities={incomingWake:{version:1,ownerId:randomUUID(),generation,routes:["slack-broker-events-v1"],
      slackBroker:{version:1,instanceId:identity.instanceId,generation,bindingsFingerprint:slackConfiguredBindingsFingerprint([]),entries:[]}}};
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
    const body=encode({alg:"EdDSA",typ:CLOUD_CONTROL_JWS_TYPE,kid})+"."+encode({v:1,iss:"paperclip-cloud",aud:CLOUD_CONTROL_AUDIENCE,
      sub:identity.instanceId,action:"task-drain:read",requestId:randomUUID(),iat:now,exp:now+60,idleCapabilities:capabilities});
    const claims=verifyCloudControlAssertion({compactJws:body+"."+sign(null,Buffer.from(body),key.privateKey).toString("base64url"),expectedAction:"task-drain:read",
      env:{PAPERCLIP_CLOUD_STACK_ID:identity.instanceId,PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS:JSON.stringify({keys:[{...key.publicKey.export({format:"jwk"}),kid,use:"sig",alg:"EdDSA"}]})}});
    if(!claims.idleCapabilities)throw new Error("Actual signed retained-history capability absent");
    return claims.idleCapabilities as VerifiedIdleCapabilities;
  }
  async function finishedHistory(ownerAlreadyTransferred=false) {
    // The original owner reaches its real normal transferred state. Additional
    // rows explicitly represent already-committed historical custody, not live
    // provider calls or a fabricated provider result in this tested journey.
    if(!ownerAlreadyTransferred)await acceptSlackFormRetirementLocally(db,await row(),identity,compactJws);
    const receipt=slackFormRetirementReceipt(binding,identity.environment,actorId);
    const protocol=async(input:{operation:Record<string,unknown>})=>input.operation.refreshRetirementReceipt?{retirementReceiptJws:compactJws}
      :input.operation.acceptedRetirementReceipt?{acceptedRetirementDigest:receipt.receiptId}:{releasedRetirementDigest:receipt.receiptId};
    if(!ownerAlreadyTransferred){await transferSlackFormRetirement(db,await row(),identity,protocol);await transferSlackFormRetirement(db,await row(),identity,protocol);}
    expect(slackFormRetirementHistoryReceipt(await row())).not.toBeNull();
    const history=Array.from({length:1005},(_,index)=>({id:`b1000000-0000-4000-8000-${String(index).padStart(12,"0")}`,companyId,endpointId,
      kind:"slack_form_grant",providerActionId:"slack-form-grant-history:"+index,status:"cancelled",
      payload:{binding,environment:identity.environment,subject:actorId},result:{phase:"transferred",nextAttemptAt:null,
        retirement:{version:1,binding,instanceId:identity.instanceId,environment:identity.environment,subject:actorId,receiptDigest:receipt.receiptId,receipt}}}));
    for(const entry of history)expect(slackFormRetirementHistoryReceipt(entry)).not.toBeNull();
    await db.insert(chatActions).values(history);
    return{history,receipt};
  }
  async function inspectHistory(abortBeforeRead?:number) {
    const capabilities=signedRetainedHistoryCapabilities(),unregister=registerConnectionEventWake(db,()=>{});
    let reads=0,selects=0;
    try {
      return await db.transaction(async tx=>{
        const select=vi.spyOn(tx,"select");
        const started=performance.now(),remaining=()=>{
          const left=2000-(performance.now()-started);if(left<=0)throw new Error("Incoming wake inspection budget exhausted");return Math.max(1,Math.floor(left));
        };
        const beforeRead=async()=>{
          reads++;if(reads===abortBeforeRead)throw new Error("Controlled existing inspection budget exhausted before next page");
          if(reads*2>64)throw new Error("Incoming wake query budget exhausted");
          await tx.execute(sql`SELECT set_config('statement_timeout', ${`${remaining()}ms`}, true)`);remaining();
        };
        try {
          const proof=await readSlackIdleIncomingProof(tx,{capabilities,identity,receiverBound:hasConnectionEventWakeReceiver(db),registeredOptions:()=>false,beforeRead,remaining});
          const check=idleChatHistoryChecksForOwner(proof?.completedActionIds).find(value=>value.reason==="chat_actions");
          if(!check)throw new Error("Actual chat action owner query absent");
          await beforeRead();const query=typeof check.query==="string"?sql.raw(check.query):check.query;
          const blockers=await tx.execute<{count:number}>(sql`SELECT count(*)::int AS count FROM (${query}) retained_history_blockers`);
          return{proof,blockers:blockers[0]!.count,reads};
        }finally{selects=select.mock.calls.length;select.mockRestore();}
      });
    }finally{unregister();if(abortBeforeRead!==undefined){expect(reads).toBe(abortBeforeRead);expect(selects).toBe(abortBeforeRead-1);}}
  }
  it("more than one page of valid finished Slack custody remains provable by the real incoming and action owners",async()=>{
    const{history}=await finishedHistory();const result=await inspectHistory();
    expect(result.proof?.completedActionIds).toEqual([actionId,...history.map(entry=>entry.id)].sort());
    expect(result.proof?.endpointIds).toEqual([]);expect(result.proof?.connectionIds).toEqual([]);
    expect(result.blockers).toBe(0);expect(result.reads).toBeGreaterThanOrEqual(5);
  },15000);
  for(const fault of ["unfinished","malformed","foreign_company"] as const)it(`a ${fault} receipt after the first completed history page still blocks the actual action owner`,async()=>{
    const{history,receipt}=await finishedHistory(),id="ffffffff-ffff-4fff-bfff-ffffffffffff",last=history.at(-1)!;
    const payload=fault==="foreign_company"?{...last.payload,binding:{...binding,companyId:randomUUID()}}:last.payload;
    const result=fault==="unfinished"?{phase:"issued",nextAttemptAt:null}:fault==="malformed"
      ?{...last.result,retirement:{...last.result.retirement,receipt:{...receipt,receiptId:"not-a-retirement-digest"}}}:last.result;
    await db.insert(chatActions).values({...last,id,providerActionId:"slack-form-grant-history:last",status:fault==="unfinished"?"issued":last.status,payload,result});
    const inspected=await inspectHistory();expect(inspected.proof?.completedActionIds).toHaveLength(1006);
    expect(inspected.proof?.completedActionIds).not.toContain(id);expect(inspected.blockers).toBe(1);
  },15000);
  it("a deadline before the next history page refuses proof without issuing that read",async()=>{
    await finishedHistory();await expect(inspectHistory(4)).rejects.toThrow("Controlled existing inspection budget exhausted before next page");
  },15000);

  it("a finished session on a later page certifies only its exact earlier open and submit actions",async()=>{
    const ack=await acceptedAckForRefresh("ffffffff-ffff-4fff-bfff-fffffffffffe");
    const readAck=async()=>(await db.select().from(chatActions).where(eq(chatActions.id,ack.id)))[0]!;
    const work=parseSlackFormAckWork((await readAck()).result?.formAck);
    if(!work.receipt)throw new Error("Normal retained ACK fixture lost its receipt");
    const digest=slackFormFinalizedReceiptDigest(work.receipt);
    const protocol=async(input:{operation:Record<string,unknown>})=>input.operation.refreshAckReceipt?{ackReceiptJws:ack.currentJws}
      :input.operation.acceptedAckReceipt?{acceptedReceiptDigest:digest,needsTerminalOriginal:false}:{releasedAckDigest:digest};
    await transferSlackFormAckReceipt(db,{companyId,actionId:ack.id,instanceId:identity.instanceId,protocol});
    await transferSlackFormAckReceipt(db,{companyId,actionId:ack.id,instanceId:identity.instanceId,protocol});
    const finished=await readAck();expect(parseSlackFormAckWork(finished.result?.formAck).phase).toBe("transferred");
    const openId="00000000-0000-4000-8000-000000000001",submitId="00000000-0000-4000-8000-000000000002";
    const payload={interactionId:finished.payload.interactionId,publicationId:finished.payload.publicationId};
    await db.insert(chatActions).values([
      {id:openId,companyId,endpointId,kind:"question_form_open",status:"processed",providerActionId:"slack-history-linked-open",payload},
      {id:submitId,companyId,endpointId,kind:"question_form_submit",status:"processed",providerActionId:"slack-history-linked-submit",payload}]);
    await db.update(chatActions).set({payload:{...finished.payload,openActionRowId:openId,submitActionRowId:submitId}}).where(eq(chatActions.id,ack.id));
    await finishedHistory(true);
    const proof=await inspectHistory();expect(proof.proof?.completedActionIds).toHaveLength(1009);expect(proof.blockers).toBe(0);
    expect(proof.proof?.completedActionIds).toEqual(expect.arrayContaining([ack.id,openId,submitId]));
    await db.update(chatActions).set({payload:{...payload,publicationId:"changed-retained-publication"}}).where(eq(chatActions.id,openId));
    const changed=await inspectHistory();expect(changed.proof?.completedActionIds).not.toContain(openId);expect(changed.blockers).toBe(1);
  },15000);

  // Seed retained accepted ACK custody, as in the existing GC controls; this is not a provider-delivery proof.
  async function acceptedAckForRefresh(appReceiptId=randomUUID()) {
    await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
    const digest = slackFormRetirementReceipt(binding, identity.environment, actorId).receiptId;
    const retire = async (input: { operation: Record<string, unknown> }) => input.operation.refreshRetirementReceipt
      ? { retirementReceiptJws: compactJws } : input.operation.acceptedRetirementReceipt
        ? { acceptedRetirementDigest: digest } : { releasedRetirementDigest: digest };
    await transferSlackFormRetirement(db, await row(), identity, retire);
    await transferSlackFormRetirement(db, await row(), identity, retire);
    const id = appReceiptId, operationId = "e".repeat(64), deliveryId = `slack_form_${operationId}`, now = new Date().toISOString();
    const originalBody = JSON.stringify({ type: "block_actions", user: { id: "UTEST" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const original = { rawBody: Buffer.from(originalBody).toString("base64"), timestamp,
      signature: `v0=${createHmac("sha256", "controlled-signing-secret").update(`v0:${timestamp}:${originalBody}`).digest("hex")}` };
    const requestDigest = createHash("sha256").update(JSON.stringify([original.rawBody, original.timestamp, original.signature])).digest("hex");
    const receipt = parseSlackFormFinalizedReceipt({ version: 1, kind: "slack_form_finalized", environment: identity.environment, binding,
      operationId, deliveryId, appReceiptId: id, grantId: "grant", publicationId: "publication", interactionId: "interaction", userId: "UTEST",
      viewDigest: null, terminalDigest: "d".repeat(64), outcome: "no_effect", finalizedAt: now });
    const signAck = (kid: string) => {
      const pair = generateKeyPairSync("ed25519"), encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] }));
      const body = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: identity.instanceId, receipt });
      return body + "." + sign(null, Buffer.from(body), pair.privateKey).toString("base64url");
    };
    const oldJws = signAck("ack-before-refresh");
    await db.insert(chatActions).values({ id, companyId, endpointId, kind: "slack_form_session", providerActionId: `slack-form-session:${operationId}`,
      status: "failed", payload: { binding, environment: identity.environment, operationId, requestDigest, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction" },
      result: { phase: "not_opened", terminalIntent: { version: 1, binding, operationId, deliveryId, userId: "UTEST", grantId: "grant", publicationId: "publication", interactionId: "interaction",
        appReceiptId: id, view: null, outcome: "no_effect", submitReceiptId: null, rejectionDigest: receipt.terminalDigest, encryptedEvidence: null },
        cloudProofAcceptance: { version: 1, binding, operationId, appReceiptId: id, outcome: "no_effect", terminalDigest: receipt.terminalDigest, acceptedAt: now },
        formAck: { version: 1, phase: "accepted", leaseId: "exact-refresh-lease", deliveryId, receiptJws: oldJws, receipt }, nextAttemptAt: now } });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "9".repeat(64));
    await db.transaction(tx => retainSlackFormOpeningProof(tx, { companyId, appReceiptId: id, original,
      operation: { version: 1, binding, grantId: "grant", id: operationId, externalId: "controlled-external-id", deliveryId, requestDigest, triggerDigest: "f".repeat(64),
        userId: "UTEST", acceptedAt: now, triggerDeadline: now, phase: "rejected", view: null, closed: null, acknowledgement: null, rejection: null } }));
    return { id, oldJws, currentJws: signAck("ack-after-refresh"), original };
  }
  for (const kind of ["retirement", "ack"] as const) for (const boundary of ["before_refresh", "after_refresh", "after_concurrent_write"] as const) {
    it(`${kind} owner failure ${boundary} retains exact custody and durable retry without overwriting another writer`, async () => {
      let id: string, oldJws: string, currentJws: string, original: { rawBody: string; timestamp: string; signature: string } | undefined;
      if (kind === "retirement") {
        await acceptSlackFormRetirementLocally(db, await row(), identity, compactJws);
        id = actionId; oldJws = compactJws; currentJws = signCurrentReceipt("retirement-after-refresh");
      } else ({ id, oldJws, currentJws, original } = await acceptedAckForRefresh());
      const read = async () => (await db.select().from(chatActions).where(and(eq(chatActions.id, id), eq(chatActions.companyId, companyId))))[0]!;
      const before = await read(), reported: string[] = [];
      let refreshes = 0, transfers = 0, concurrent: typeof before | undefined;
      const owner = { identity, resolveBotToken: async () => { throw new Error("retained work must not read credentials"); },
        report: (code: string) => { reported.push(code); }, protocol: async (input: { operation: Record<string, unknown> }) => {
          if (input.operation.refreshRetirementReceipt || input.operation.refreshAckReceipt) {
            refreshes++;
            if (boundary === "before_refresh") throw new Error("controlled failure before refresh");
            return kind === "retirement" ? { retirementReceiptJws: currentJws } : { ackReceiptJws: currentJws };
          }
          transfers++;
          expect(input.operation[kind === "retirement" ? "acceptedRetirementReceipt" : "acceptedAckReceipt"]).toBe(currentJws);
          if (kind === "ack") expect(input.operation.originalOpening).toEqual(original);
          if (boundary === "after_concurrent_write") {
            const refreshed = await read();
            await db.update(chatActions).set({ status: "attention", payload: { ...refreshed.payload, protectedConcurrentWriter: true },
              result: { ...refreshed.result, nextAttemptAt: null, protectedConcurrentWriter: true }, updatedAt: new Date() }).where(eq(chatActions.id, id));
            concurrent = await read();
          }
          throw new Error("controlled transfer failure after exact signature refresh");
        } };
      const started = Date.now(), due = await reconcilePendingSlackFormWork(db, owner), after = await read();
      expect(refreshes).toBe(1); expect(transfers).toBe(boundary === "before_refresh" ? 0 : 1);
      expect(reported).toEqual(["form_owner_broker_unavailable"]);
      if (boundary === "after_concurrent_write") {
        expect(concurrent).toBeDefined(); expect(after).toEqual(concurrent); expect(due).toBeNull();
      } else {
        expect(after.payload).toEqual(before.payload); expect(after.status).toBe(before.status);
        const result = kind === "retirement" ? { ...before.result, retirementReceiptJws: boundary === "before_refresh" ? oldJws : currentJws }
          : { ...before.result, formAck: { ...parseSlackFormAckWork(before.result?.formAck), receiptJws: boundary === "before_refresh" ? oldJws : currentJws } };
        expect(after.result).toEqual({ ...result, attempts: 1, failureCode: "form_owner_broker_unavailable", failureReason: null, nextAttemptAt: expect.any(String) });
        expect(due).toBe(Date.parse(String(after.result?.nextAttemptAt))); expect(due).toBeGreaterThanOrEqual(started + 5000);
        if (due === null) throw new Error("Normal owner lost durable backoff");
        expect(await reconcilePendingSlackFormWork(db, owner, new Date(due - 1))).toBe(due);
        expect(refreshes).toBe(1); expect(await read()).toEqual(after);
      }
    }, 15000);
  }
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
