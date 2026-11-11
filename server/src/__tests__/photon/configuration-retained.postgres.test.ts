import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, agents, chatEndpointLeases, chatEndpoints, companies, chatSdkState, companySecrets, createDb, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "../helpers/chat-milestone-fixtures.js";
import { chatChannelService } from "../../services/chat-channels.js";
import { createChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { PhotonChatAdapter } from "../../services/photon/adapter.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import { credentialFingerprint } from "../../services/chat-channels/credential-fingerprint.js";
import { createPhotonExternalRuntimeOwner } from "../../services/chat-channels/imessage-photon/external-runtime.js";
import { PHOTON_EXTERNAL_STATE, photonStateFor } from "../../services/chat-channels/imessage-photon/external-store.js";
import { photonHash, photonExternalStateSchema, readPhotonExternalState } from "../../services/chat-channels/imessage-photon/external-contract.js";

import { memoryPersistence, photonFixture } from "./fixture.js";
import * as photonClients from "../../services/photon/owned-client.js";
import * as cloudConnectors from "../../services/paperclip-cloud-connector.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";

import { createPhotonExternalStore } from "../../services/chat-channels/imessage-photon/external-store.js";
import { createPhotonExternalOwner, PhotonLocalResources } from "../../services/chat-channels/imessage-photon/external-owner.js";
import type { ProcessProbe } from "../../services/owner-proof.js";

import { deleteCompany } from "../../services/company-deletion.js";
import { toolAccessService } from "../../services/tool-access.js";
import { preparePhotonCompanyDeletion, assertPhotonCompanyRetired, lockPhotonCompanyMutation, registerPhotonRemovalOwner } from "../../services/chat-channels/imessage-photon/company-retirement.js";
import { chatCompanyDeletion } from "../../services/chat-channels/company-deletion.js";
import { notifyChatCompanyConfiguration } from "../../services/chat-channels/configuration-work-notifications.js";
import type { RuntimeContext } from "../../services/chat-channels/runtime-types.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PHOTON_REVIEW_TEST_DATABASE_URL");
if (process.env.PHOTON_REVIEW_EXPECT_PG === "1" && !external) throw new Error("Photon review controls require their exact external test database");
describe.skipIf(!external)("Photon normal configuration and retained receiver authority (real SQL, controlled provider ports)", () => {
  let db: ReturnType<typeof createDb>, fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<ReturnType<typeof createChatMilestoneFixtures>["create"]>>;
  let directory: string;
  const services: ReturnType<typeof chatChannelService>[] = [];
  const runtimes: ReturnType<typeof createChatSdkRuntime>[] = [];
  const heartbeats: ReturnType<typeof heartbeatService>[] = [];
  const owners: ReturnType<typeof createPhotonExternalRuntimeOwner>[] = [];
  const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
  beforeAll(async () => {
    if (!external) throw new Error("Dedicated Photon review database absent");
    await applyPendingMigrations(external); db = createDb(external, { maxConnections: 2 });
    fixtures = createChatMilestoneFixtures(db);
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
  }, 60_000);
  beforeEach(async () => {
    f = await fixtures.create(); directory = await mkdtemp(join(tmpdir(),"photon-review-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE",join(directory,"master.key"));
  });
  afterEach(async () => {
    const errors: unknown[] = [];
    for (const coordinator of coordinators.splice(0)) try { await coordinator.stop(); } catch(error) { errors.push(error); }
    for (const owner of owners.splice(0)) try { await owner.close(); } catch(error) { errors.push(error); }
    for (const service of services.splice(0)) try { await service.shutdown(); } catch(error) { errors.push(error); }
    for (const runtime of runtimes.splice(0)) try { await runtime.shutdown(); } catch(error) { errors.push(error); }
    for (const heartbeat of heartbeats.splice(0)) try { await heartbeat.drainActiveRunExecutions(); } catch(error) { errors.push(error); }
    try {
      await db.delete(chatSdkState).where(eq(chatSdkState.companyId,f.companyId));
      await db.delete(companySecrets).where(eq(companySecrets.companyId,f.companyId));
      await fixtures.cleanup();
    } catch(error) { errors.push(error); }
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    if(directory)try { await rm(directory,{recursive:true,force:true}); } catch(error) { errors.push(error); }
    if(errors.length)throw new AggregateError(errors,"Photon review fixture cleanup remains owned");
  });
  afterAll(async () => { await db?.$client.end(); });

  it("normal Photon configuration stages the actual authorized subject in its credential transaction",async()=>{
    // Preserve the real service/configuration/credential SQL owners. Only the
    // provider HTTP response and unused SDK start are controlled boundaries.
    const runtime=createChatSdkRuntime();runtimes.push(runtime);
    vi.spyOn(PhotonChatAdapter.prototype,"initialize").mockResolvedValue(undefined);
    vi.spyOn(PhotonReceiver.prototype,"start").mockImplementation(()=>undefined);
    const fetchProvider: typeof fetch=async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:String(input));
      expect(url.origin).toBe("https://spectrum.photon.codes");
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic "+Buffer.from("project:controlled-project-secret").toString("base64"));
      if(url.pathname==="/projects/project/"&&init?.method==="GET")return Response.json({succeed:true,data:{id:"project",name:"Controlled Photon"}});
      if(url.pathname==="/projects/project/imessage/tokens"&&init?.method==="POST")return Response.json({succeed:true,data:{type:"dedicated",auth:{line:"controlled-line-token"},numbers:{line:"+15555550100"},expiresIn:300}});
      throw new Error("unexpected controlled Spectrum request");
    };
    const heartbeat=heartbeatService(db);heartbeats.push(heartbeat);
    const service=chatChannelService(db,{runtime,heartbeat,fetch:fetchProvider,publicBaseUrl:"https://tenant.example"});services.push(service);
    const created=await service.create(f.companyId,{provider:"imessage-photon",assignedAgentId:f.agentId},f.userId);
    if(!created)throw new Error("normal Photon endpoint creation failed");
    const endpointId=created.id;
    await service.configure(endpointId,{action:"configure",credentials:{projectSecret:"controlled-project-secret"},photon:{allocation:"dedicated",projectId:"project",lineId:"line"}},f.userId);
    const [endpoint]=await db.select().from(chatEndpoints).where(eq(chatEndpoints.id,endpointId));
    expect(endpoint?.setup,"normal configuration must stage Photon handoff subject").toMatchObject({photonExternalSubject:f.userId});
    expect(endpoint?.status).toBe("verifying");
    const [connection]=await db.select().from(toolConnections).where(eq(toolConnections.id,endpoint!.connectionId));
    expect(connection).toMatchObject({enabled:true,status:"active",healthStatus:"healthy"});
    expect(connection!.credentialSecretRefs.length).toBeGreaterThan(0);
  });

  it("unchanged external intake stays idle but changed or revoked authority is immediately due and retires normally",async()=>{
    const [endpoint]=await db.select().from(chatEndpoints).where(eq(chatEndpoints.id,f.endpointId)); if(!endpoint)throw new Error("fixture endpoint absent");
    const [connection]=await db.select().from(toolConnections).where(eq(toolConnections.id,endpoint.connectionId)); if(!connection)throw new Error("fixture connection absent");
    let requests: Record<string,unknown>[]=[], brokerAvailable=true;
    const changedNotify=vi.fn();
    const configured={provider:"imessage-photon" as const,userName:"Agent",intakeAfter:1,credentials:{allocation:"dedicated" as const,projectId:"project",projectSecret:"controlled-secret",lineId:"line",phoneNumber:"+15555550100"}};
    const makeOwner=()=>createPhotonExternalRuntimeOwner(db,{
      broker:()=>brokerAvailable?({instanceIdentity:()=>({instanceId:"instance",environment:"test" as const}),photonReceiverOperation:async({operation})=>{
        requests.push(structuredClone(operation));
        const value=readPhotonExternalState(await photonStateFor(db,{companyId:f.companyId,endpointId:f.endpointId}).read(PHOTON_EXTERNAL_STATE));
        if(!value)throw new Error("fixture retained owner absent");
        return operation.kind==="status"?{binding:value.binding,handoffId:value.handoffId,phase:"retired"}:{binding:value.binding};
      }}):undefined,
      endpointRecord:async id=>{
        const [current]=await db.select().from(chatEndpoints).where(eq(chatEndpoints.id,id));if(!current)return null;
        const [selected]=await db.select().from(toolConnections).where(eq(toolConnections.id,current.connectionId));if(!selected)return null;
        return {endpoint:current,assignedAgentName:"Maya",connectionName:selected.name,applicationId:selected.applicationId,credentialSecretRefs:selected.credentialSecretRefs};
      },
      withReceiverLease:async()=>{throw new Error("revoked fixture cannot acquire business lease");},
      runtimeFor:async()=>{throw new Error("revoked fixture must not allocate a runtime");},context:()=>undefined,ownership:()=>undefined,
      release:async()=>{throw new Error("fixture has no local runtime lease");},currentRuntime:()=>null,removeRuntime:async()=>false,
      config:async()=>configured,admit:async()=>{throw new Error("fixture cannot admit work");},notify:changedNotify,
    }); let owner=makeOwner(); owners.push(owner);
    // Already-settled durable fixture history, NOT proof of an actual SDK join
    // or enrollment. All scheduling/retirement policy below is real production.
    for(const change of ["paused","generation","subject","missing-subject","disabled","health","credentials","broker-unavailable","physical-attention"] as const){
      requests=[];brokerAvailable=true;changedNotify.mockClear();
      await db.update(chatEndpoints).set({provider:"imessage-photon",status:"active",setup:sql`${JSON.stringify({runtimeGeneration:1,photonExternalSubject:f.userId})}::jsonb`}).where(eq(chatEndpoints.id,f.endpointId));
      await db.update(toolConnections).set({enabled:true,status:"active",healthStatus:"healthy",credentialSecretRefs:[]}).where(eq(toolConnections.id,connection.id));
      const identity={companyId:f.companyId,endpointId:f.endpointId,connectionId:connection.id,runtimeGeneration:1,credentialReferences:credentialFingerprint([]),subject:f.userId};
      const fingerprint="b".repeat(64);
      const binding={version:1,instanceId:"instance",environment:"test",companyId:f.companyId,endpointId:f.endpointId,connectionId:connection.id,runtimeGeneration:1,
        projectId:"project",lineId:"line",phoneNumber:"+15555550100",allocation:"dedicated",credentialFingerprint:fingerprint,
        bindingId:"photon-receiver:"+photonHash(["instance",f.companyId,f.endpointId,connection.id,1,fingerprint]),intakeAfter:"2099-01-01T00:00:00.000Z",maxFrameBytes:1024};
      const retained=photonExternalStateSchema.parse({version:1,identity,handoffId:randomUUID(),localResourceId:null,phase:"external",binding,acceptedRetirement:null,
        initialSequence:1,joinedSequence:1,acceptedSequence:1,pending:null,failure:null});
      if(change==="physical-attention")retained.localResourceId=randomUUID();
      const state=photonStateFor(db,identity);await state.update(PHOTON_EXTERNAL_STATE,()=>retained);
      const scope={kind:"endpoint" as const,id:f.endpointId};
      expect((await owner.retained(scope))[0]?.dueAt).toBeNull();
      if(change==="paused"||change==="broker-unavailable"||change==="physical-attention")await db.update(chatEndpoints).set({status:"paused"}).where(eq(chatEndpoints.id,f.endpointId));
      if(change==="generation")await db.update(chatEndpoints).set({setup:sql`${JSON.stringify({runtimeGeneration:2,photonExternalSubject:f.userId})}::jsonb`}).where(eq(chatEndpoints.id,f.endpointId));
      if(change==="subject")await db.update(chatEndpoints).set({setup:sql`${JSON.stringify({runtimeGeneration:1,photonExternalSubject:"other-authorized-owner"})}::jsonb`}).where(eq(chatEndpoints.id,f.endpointId));
      if(change==="missing-subject")await db.update(chatEndpoints).set({setup:sql`${JSON.stringify({runtimeGeneration:1})}::jsonb`}).where(eq(chatEndpoints.id,f.endpointId));
      if(change==="disabled")await db.update(toolConnections).set({enabled:false,status:"disabled"}).where(eq(toolConnections.id,connection.id));
      if(change==="health")await db.update(toolConnections).set({healthStatus:"failed"}).where(eq(toolConnections.id,connection.id));
      if(change==="credentials")await db.update(toolConnections).set({credentialSecretRefs:[{secretId:randomUUID(),configPath:"projectSecret"}]}).where(eq(toolConnections.id,connection.id));
      if(change==="broker-unavailable")brokerAvailable=false;
      expect((await owner.retained(scope))[0]?.dueAt,"changed Photon external owner must be due immediately").toBe(0);
      if(change==="broker-unavailable"){
        await expect(owner.reconcile(f.endpointId)).rejects.toThrow("Cloud receiver port is unavailable");
        let held=readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
        expect(held).toMatchObject({phase:"retiring",failure:{code:"authority",nextAttemptAt:null}});
        expect((await owner.retained(scope))[0]?.dueAt).toBeNull();expect(requests).toEqual([]);
        expect(changedNotify).toHaveBeenCalledWith(f.endpointId);
        // Controlled durable boundary image: first retirement phase committed,
        // then the process lost the failure write. This is not an OS crash proof.
        await state.update(PHOTON_EXTERNAL_STATE,()=>({...retained,phase:"retiring" as const,failure:null}));
        await owner.close();owner=makeOwner();owners.push(owner);
        expect((await owner.retained(scope))[0]?.dueAt).toBe(0);
        await expect(owner.reconcile(f.endpointId)).rejects.toThrow("Cloud receiver port is unavailable");
        held=readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
        expect(held).toMatchObject({phase:"retiring",failure:{code:"authority",nextAttemptAt:null}});
        expect((await owner.retained(scope))[0]?.dueAt).toBeNull();
        brokerAvailable=true;
        // Ordinary configuration/restart discovery sees the restored real port
        // and makes only its authority-held retirement immediately due.
        expect((await owner.retained(scope))[0]?.dueAt).toBe(0);
      }
      if(change==="physical-attention"){
        await expect(owner.reconcile(f.endpointId)).rejects.toThrow("closure is unknown");
        expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))).toMatchObject({phase:"retiring",failure:{code:"retirement",nextAttemptAt:null}});
        expect((await owner.retained(scope))[0]?.dueAt).toBeNull();
        expect(requests).toEqual([]);continue;
      }
      await owner.reconcile(f.endpointId);
      expect(requests.filter(value=>value.kind==="retire")).toHaveLength(1);
      expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
    }
  });

  async function managedConfiguration() {
    // The real connector object/composition is retained; only the provider RPC
    // port is controlled here. This is not managed distribution/auth proof.
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const config = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const connector = cloudConnectors.createPaperclipCloudConnector({ config });
    vi.spyOn(cloudConnectors, "paperclipCloudConnectorConfigFromEnv").mockReturnValue(config);
    vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockReturnValue(connector);
    vi.spyOn(PhotonChatAdapter.prototype, "initialize").mockResolvedValue(undefined);
    vi.spyOn(PhotonReceiver.prototype, "start").mockImplementation(() => undefined);
    const fetchProvider: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://spectrum.photon.codes");
      if (url.pathname === "/projects/project/" && init?.method === "GET") return Response.json({ succeed: true, data: { id: "project", name: "Controlled Photon" } });
      if (url.pathname === "/projects/project/imessage/tokens" && init?.method === "POST") return Response.json({ succeed: true,
        data: { type: "dedicated", auth: { line: "controlled-line-token" }, numbers: { line: "+15555550100" }, expiresIn: 300 } });
      throw new Error("unexpected controlled Spectrum request");
    };
    const runtime = createChatSdkRuntime(); runtimes.push(runtime);
    const heartbeat = heartbeatService(db); heartbeats.push(heartbeat);
    const service = chatChannelService(db, { runtime, heartbeat, fetch: fetchProvider, publicBaseUrl: "https://tenant.example" }); services.push(service);
    const endpoint = await service.create(f.companyId, { provider: "imessage-photon", assignedAgentId: f.agentId }, f.userId);
    if (!endpoint) throw new Error("normal Photon endpoint creation failed");
    await service.configure(endpoint.id, { action: "configure", credentials: { projectSecret: "controlled-project-secret" },
      photon: { allocation: "dedicated", projectId: "project", lineId: "line" } }, f.userId);
    const [configured] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
    if (!configured) throw new Error("normal configured endpoint absent");
    // Explicit controlled already-enrolled history, not an SDK enrollment/close
    // claim. The normal service, credential removal and worker remain real.
    await db.update(chatEndpoints).set({ status: "active", setup: sql`${JSON.stringify({ ...configured.setup, step: "complete", photonExternalSubject: f.userId })}::jsonb` })
      .where(eq(chatEndpoints.id, endpoint.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, configured.connectionId));
    if (!connection) throw new Error("normal configured connection absent");
    const identity = { companyId: f.companyId, endpointId: endpoint.id, connectionId: connection.id,
      runtimeGeneration: Number(Reflect.get(configured.setup, "runtimeGeneration") ?? 0), credentialReferences: credentialFingerprint(connection.credentialSecretRefs), subject: f.userId };
    const fingerprint = "b".repeat(64);
    const binding = { version: 1, instanceId: "instance", environment: "test", companyId: f.companyId, endpointId: endpoint.id, connectionId: connection.id,
      runtimeGeneration: identity.runtimeGeneration, projectId: "project", lineId: "line", phoneNumber: "+15555550100", allocation: "dedicated", credentialFingerprint: fingerprint,
      bindingId: "photon-receiver:" + photonHash(["instance", f.companyId, endpoint.id, connection.id, identity.runtimeGeneration, fingerprint]),
      intakeAfter: "2099-01-01T00:00:00.000Z", maxFrameBytes: 1024 };
    const retained = photonExternalStateSchema.parse({ version: 1, identity, binding, handoffId: randomUUID(), localResourceId: null, phase: "external",
      acceptedRetirement: null, initialSequence: 1, joinedSequence: 1, acceptedSequence: 1, pending: null, failure: null });
    const state = photonStateFor(db, identity); await state.update(PHOTON_EXTERNAL_STATE, () => retained);
    let retirement: "retiring" | "retired" = "retired";
    const requests: Record<string, unknown>[] = [];
    vi.spyOn(connector, "photonReceiverOperation").mockImplementation(async ({ operation }) => {
      requests.push(structuredClone(operation));
      return operation.kind === "status" ? { binding, handoffId: retained.handoffId, phase: retirement } : { binding };
    });
    return { service, runtime, endpoint, connection, state, retained, requests, pendingRetirement() { retirement = "retiring"; }, finishRetirement() { retirement = "retired"; } };
  }

  it("normal receiver worker settles a paused or archived Photon owner after exact retirement", async () => {
    const c = await managedConfiguration();
    await c.service.configure(c.endpoint.id, { action: "pause" }, f.userId);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } }); coordinators.push(coordinator);
    await c.service.registerReceiverWork(coordinator, () => true).ready;
    await vi.waitFor(async () => {
      expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
    expect(errors, "a retired inactive Photon receiver must settle without runtime construction retries").toEqual([]);
    expect(coordinator.nextWakeAt()).toBeNull(); expect(c.runtime.get(c.endpoint.id)).toBeNull();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); writes.mockRestore(); vi.useRealTimers(); }
  });

  it("normal remove preserves credentials until retained retirement settles and repeated remove finishes the same owner", async () => {
    const c = await managedConfiguration(); c.pendingRetirement();
    const originalRefs = structuredClone(c.connection.credentialSecretRefs);
    const error = await c.service.configure(c.endpoint.id, { action: "remove" }, f.userId).then(() => null, value => value);
    expect(error, "remove must retain credentials while the original Photon Cloud/ACK retirement remains outstanding").toBeInstanceOf(Error);
    const [archived] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id));
    const [held] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(archived.status).toBe("archived"); expect(held.credentialSecretRefs).toEqual(originalRefs);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))).toMatchObject({ phase: "retiring", handoffId: c.retained.handoffId });
    c.finishRetirement();
    await c.service.configure(c.endpoint.id, { action: "remove" }, f.userId);
    const [removed] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(removed.credentialSecretRefs).toEqual([]);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))).toMatchObject({ phase: "retired", handoffId: c.retained.handoffId });
    expect(c.requests.filter(request => request.kind === "retire")).toHaveLength(2);
    for (const request of c.requests) expect(request.binding).toEqual(c.retained.binding);
    await expect(c.service.configure(c.endpoint.id, { action: "remove" }, f.userId)).rejects.toMatchObject({ status: 409 });
  });

  it("normal receiver retries the same useful sender close without another message and replacement never treats absence as closure", async () => {
    // Actual Runtime/adapter/useful-client, service callback and retained SQL;
    // unary result/close failures and durable unknown image are controlled ports.
    const c = await managedConfiguration(), endpointRuntime = c.runtime.get(c.endpoint.id);
    if (!endpointRuntime) throw new Error("normal endpoint runtime absent");
    const adapter = endpointRuntime.getProviderAdapter();
    if (!(adapter instanceof PhotonChatAdapter)) throw new Error("normal Photon adapter absent");
    await adapter.useExternalIntake();
    const control = photonFixture(), closeFailure = new Error("controlled same-sender close debt"); let closeFails = true;
    vi.spyOn(photonClients, "createOwnedPhotonClient").mockReturnValue(control.adapter.client);
    control.client.close.mockImplementation(async () => { if (closeFails) throw closeFailure; });
    try {
      await expect(adapter.withClient(async () => "actual controlled known result")).resolves.toBe("actual controlled known result");
      expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.failure?.code).toBe("sender_close");
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } }); coordinators.push(coordinator);
      await c.service.registerReceiverWork(coordinator, () => true).ready;
      await vi.waitFor(() => { expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
      const attempts = control.client.close.mock.calls.length; expect(attempts).toBeGreaterThan(1);
      closeFails = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => {
        expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.failure).toBeNull();
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(control.client.close.mock.calls.length).toBeGreaterThan(attempts);
      expect(photonClients.createOwnedPhotonClient).toHaveBeenCalledTimes(1);
      await coordinator.stop(); vi.useRealTimers();
      // Controlled restart image contains a recorded failed close but no owned
      // runtime handle. A new normal owner cannot synthesize a close receipt.
      const current = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
      if (!current) throw new Error("retained sender owner absent");
      await c.state.update(PHOTON_EXTERNAL_STATE, () => ({ ...current, failure: { code: "sender_close" as const, attempts: 3, nextAttemptAt: new Date().toISOString() } }));
      const replacement = createPhotonExternalRuntimeOwner(db, {
        broker: () => ({ instanceIdentity: () => ({ instanceId: "instance", environment: "test" as const }), photonReceiverOperation: async () => { throw new Error("unknown sender must not invoke provider"); } }),
        endpointRecord: async id => {
          const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, id)); if (!endpoint) return null;
          const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, endpoint.connectionId)); if (!connection) return null;
          return { endpoint, assignedAgentName: "Agent", connectionName: connection.name, applicationId: connection.applicationId, credentialSecretRefs: connection.credentialSecretRefs };
        },
        withReceiverLease: async () => { throw new Error("cleanup cannot acquire new admission authority"); },
        runtimeFor: async () => { throw new Error("cleanup cannot allocate another runtime"); }, context: () => undefined, ownership: () => undefined,
        release: async () => { throw new Error("replacement has no lease"); }, currentRuntime: () => null, removeRuntime: async () => false,
        config: async () => ({ provider: "imessage-photon", userName: "Agent", intakeAfter: 1, credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550100" } }),
        admit: async () => { throw new Error("cleanup cannot admit business"); }, notify: () => {},
      }); owners.push(replacement);
      await expect(replacement.reconcile(c.endpoint.id)).rejects.toThrow("original sender physical closure is unknown");
      expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))).toMatchObject({ phase: "external", failure: { code: "sender_close", nextAttemptAt: null } });
      expect((await replacement.retained({ kind: "endpoint", id: c.endpoint.id }))[0]?.dueAt).toBeNull();
    } finally {
      closeFails = false; vi.useRealTimers();
      await control.adapter.disconnect();
    }
  });

  it("real SQL sender reservation and reconstructed birth proof preserve identity, rollback and monotonic closure", async () => {
    const c = await managedConfiguration(); await c.service.shutdown();
    // Explicit fixture lease/process probes: real normal store SQL fencing and
    // CAS, not public authorization or an actual kernel/process-exit claim.
    const token = randomUUID(), controller = { bootId: "sender-boot", hostHash: "f".repeat(32), pid: 56789, processStartedAt: "2090-02-01T00:00:00.000Z" };
    await db.insert(chatEndpointLeases).values({ companyId: f.companyId, endpointId: c.endpoint.id, leaseKey: "photon_receiver_runtime", token, expiresAt: new Date(Date.now() + 60_000) });
    const store = createPhotonExternalStore(db), resources = new PhotonLocalResources();
    const broker = { instanceIdentity: () => ({ instanceId: "instance", environment: "test" as const }),
      photonReceiverOperation: async () => { throw new Error("sender SQL control must not invoke provider"); } };
    const owner = createPhotonExternalOwner({ store, broker, resources, notify: () => {} });
    const [endpointRow] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id));
    if (!endpointRow) throw new Error("current endpoint missing");
    const leaseStopFailure = new Error("controlled finite lease stop reply lost before sender birth");
    const neverBorn = createPhotonExternalRuntimeOwner(db, {
      broker: () => broker,
      withReceiverLease: async (_record, work) => { await work({ token }); throw leaseStopFailure; },
      endpointRecord: async () => ({ endpoint: endpointRow, assignedAgentName: "Agent", connectionName: c.connection.name,
        applicationId: c.connection.applicationId, credentialSecretRefs: c.connection.credentialSecretRefs }),
      runtimeFor: async () => { throw new Error("never-born sender must not construct a runtime"); },
      context: () => undefined, ownership: () => undefined, release: async () => {}, currentRuntime: () => null, removeRuntime: async () => false,
      config: async () => ({ provider: "imessage-photon", userName: "Agent", intakeAfter: 1,
        credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550100" } }),
      admit: async () => { throw new Error("reservation is not business admission"); }, notify: () => {},
    }); owners.push(neverBorn);
    await expect(neverBorn.reserveSenderRuntime({ endpoint: endpointRow, assignedAgentName: "Agent", connectionName: c.connection.name,
      applicationId: c.connection.applicationId, credentialSecretRefs: c.connection.credentialSecretRefs },
      { generation: c.retained.identity.runtimeGeneration, credentialFingerprint: c.retained.identity.credentialReferences, localEpoch: 0, version: "controlled-allocation" }))
      .rejects.toBe(leaseStopFailure);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource?.closed).toBe(true);
    const descriptor = { id: randomUUID(), controller, leaseDigest: photonHash(token), closed: false };
    const reserved = await owner.reserveSender(c.retained.identity, { token }, descriptor);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource).toEqual(descriptor);
    // No controlled allocation exists until the preceding SQL commit returns.
    let constructed = 0; const resource = {}; constructed++; resources.attach(descriptor.id, resource, async () => {}); expect(constructed).toBe(1);
    await expect(store.retained(reserved, value => ({ ...value, senderResource: { ...descriptor, id: randomUUID() } }))).rejects.toThrow("cannot replace sender ownership");
    await expect(store.retained(reserved, value => { const next = { ...value }; delete next.senderResource; return next; })).rejects.toThrow("cannot replace sender ownership");
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))).toEqual(reserved);
    const failed = await store.retained(reserved, value => ({ ...value, failure: { code: "sender_close", attempts: 1, nextAttemptAt: null } }));
    const dead: ProcessProbe = { bootId: "new-boot", host: "current-host", processSpace: controller.hostHash,
      pidExists: () => false, processGroupExists: () => false, readStartedAt: async () => null };
    const reconstructed = createPhotonExternalOwner({ store, broker, resources: new PhotonLocalResources(), processProbe: dead, notify: () => {} });
    const confirmed = await reconstructed.repairSender(failed);
    expect(confirmed.closed).toBe(true); expect(confirmed.state.senderResource).toEqual({ ...descriptor, closed: true });
    expect(confirmed.state.failure).toBeNull(); expect(confirmed.state.acceptedSequence).toBe(failed.acceptedSequence);
    await expect(store.retained(confirmed.state, value => ({ ...value, senderResource: { ...descriptor, closed: false } }))).rejects.toThrow("cannot replace sender ownership");
    const next = await reconstructed.reserveSender(c.retained.identity, { token }, { ...descriptor, id: randomUUID() });
    await expect(reconstructed.confirmSenderClosed(confirmed.state, descriptor.id)).rejects.toThrow("owner changed");
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource).toEqual(next.senderResource);
  });

  it("normal company removal preserves retirement and permits a lost joined-sender receipt retry after deletion", async () => {
    // Real normal company-removal participant/FK cascade plus actual Runtime/SDK
    // lifecycle. Provider/auth ports remain controlled; no remote Cloud close or
    // full company-deletion/deployed socket claim is made by this local case.
    const c = await managedConfiguration();
    const registry = createChatSdkRuntime(); runtimes.push(registry);
    const token = randomUUID();
    await db.insert(chatEndpointLeases).values({ companyId: f.companyId, endpointId: c.endpoint.id,
      leaseKey: "photon_receiver_runtime", token, expiresAt: new Date(Date.now() + 60_000) });
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id));
    if (!endpoint) throw new Error("normal endpoint absent");
    const record = { endpoint, assignedAgentName: "Agent", connectionName: c.connection.name,
      applicationId: c.connection.applicationId, credentialSecretRefs: c.connection.credentialSecretRefs };
    const context: RuntimeContext = { generation: c.retained.identity.runtimeGeneration,
      credentialFingerprint: c.retained.identity.credentialReferences, localEpoch: 0, version: "controlled-original-sender" };
    const contexts = new WeakMap<object, RuntimeContext>(); let businessViewRemoved = false; let loseCloseReply = true;
    const owner = createPhotonExternalRuntimeOwner(db, {
      broker: () => ({ instanceIdentity: () => ({ instanceId: "instance", environment: "test" as const }),
        photonReceiverOperation: async () => { throw new Error("local close must not claim remote retirement"); } }),
      withReceiverLease: async () => { throw new Error("this current fixture lease was already explicitly acquired"); },
      endpointRecord: async () => { if (businessViewRemoved) throw new Error("physical cleanup must not consult removed business joins"); return record; },
      runtimeFor: async () => { throw new Error("reservation cannot construct an unowned replacement"); }, context: value => contexts.get(value),
      ownership: () => undefined, release: async () => { throw new Error("no business lease transfer in this case"); },
      currentRuntime: id => registry.get(id), removeRuntime: id => registry.removeEndpoint(id),
      config: async () => ({ provider: "imessage-photon", userName: "Agent", intakeAfter: 1,
        credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550100" } }),
      admit: async () => { throw new Error("local close cannot admit work"); }, notify: () => {},
    }); owners.push(owner);
    const allocation = await owner.reserveSenderRuntime(record, context, { token });
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource?.id).toBe(allocation.resourceId);
    const runtime = await registry.replaceEndpoint({ companyId: f.companyId, endpointId: c.endpoint.id, logger: "silent", persistence: memoryPersistence(),
      providerConfig: { provider: "imessage-photon", userName: "Agent", intakeAfter: 1,
        credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550100" } },
      callbacks: { onMessage: async () => { throw new Error("no business message in close case"); },
        onPhotonEvent: async () => { throw new Error("no incoming event in close case"); }, onPhotonAssertOwned: async () => {},
        onPhotonCheckpoint: async () => {}, onPhotonFailure: async () => {}, onPhotonUsefulClientDebt: () => owner.senderDebt(c.endpoint.id, context),
        onPhotonIntakePlacement: async () => ({ kind: "cloud", bindingId: c.retained.binding.bindingId }),
        onPhotonSenderRuntimeClosed: async () => {
          await owner.senderRuntimeClosed(allocation, context);
          if (loseCloseReply) throw new Error("controlled successful sender receipt reply lost");
        } } });
    owner.attachSenderRuntime(allocation.resourceId, runtime); context.endpointRuntime = runtime; contexts.set(runtime, context);
    await runtime.initialize();
    const disconnect = vi.spyOn(PhotonChatAdapter.prototype, "disconnect");
    await expect(db.transaction(tx => chatCompanyDeletion.deleteCompanyData(tx, f.companyId)))
      .rejects.toMatchObject({ status: 409, details: { code: "photon_retirement_pending" } });
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).not.toBeNull();
    await expect(registry.removeEndpoint(c.endpoint.id)).rejects.toThrow("controlled successful sender receipt reply lost");
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource?.closed).toBe(true);
    expect(registry.hasUnsettledLifecycle()).toBe(true);
    loseCloseReply = false;
    // Normal provider removal now observes the actual committed physical receipt,
    // settles the controlled Cloud retirement and only then clears credentials.
    await c.service.configure(c.endpoint.id, { action: "remove" }, f.userId);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
    await db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      await notifyChatCompanyConfiguration(tx, f.companyId);
      await chatCompanyDeletion.deleteCompanyData(tx, f.companyId);
    });
    businessViewRemoved = true;
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull(); // Actual FK cascade, no hand deletion of state/outcomes.
    await expect(registry.removeEndpoint(c.endpoint.id)).resolves.toBe(true);
    expect(disconnect).toHaveBeenCalled(); expect(registry.hasUnsettledLifecycle()).toBe(false);
    await expect(owner.senderRuntimeClosed({ ...allocation, resourceId: randomUUID() }, context)).rejects.toThrow("exact runtime owner");
    await expect(owner.senderRuntimeClosed({ ...allocation, identity: { ...allocation.identity, companyId: randomUUID() } }, context)).rejects.toThrow("exact runtime owner");
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
  });
  it("normal company deletion returns pending before agent termination and retries the exact Cloud retirement", async () => {
    const c = await managedConfiguration(); c.pendingRetirement();
    const [beforeAgent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await expect(deleteCompany(db, f.companyId)).rejects.toMatchObject({ status: 409,
      details: { code: "photon_retirement_pending" } });
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(company).toBeDefined(); expect(agent?.status).toBe(beforeAgent?.status);
    expect(connection?.credentialSecretRefs).toEqual(c.connection.credentialSecretRefs);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retiring");
    // Real retained consumer remains registered and the exact state remains for
    // authenticated no-effect/ACK progress; this controlled status is not queue proof.
    c.finishRetirement();
    await expect(deleteCompany(db, f.companyId)).resolves.not.toBeNull();
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toEqual([]);
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
  });

  it("normal generic connection removal retains credentials until Photon retirement settles", async () => {
    const c = await managedConfiguration(); c.pendingRetirement();
    const tools = toolAccessService(db);
    await expect(tools.archiveConnection(c.connection.id, f.companyId, { actorType: "user", actorId: f.userId }))
      .rejects.toMatchObject({ status: 409, details: { code: "photon_retirement_pending" } });
    const [held] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(held?.credentialSecretRefs).toEqual(c.connection.credentialSecretRefs);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retiring");
    c.finishRetirement();
    await tools.archiveConnection(c.connection.id, f.companyId, { actorType: "user", actorId: f.userId });
    const [removed] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(removed?.credentialSecretRefs).toEqual([]); expect(removed?.status).toBe("archived");
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
  });

  it("company destructive recheck rejects a newly created Photon endpoint after a successful preflight", async () => {
    const c = await managedConfiguration();
    await preparePhotonCompanyDeletion(db, f.companyId);
    const next = await c.service.create(f.companyId, { provider: "imessage-photon", assignedAgentId: f.agentId }, f.userId);
    expect(next).not.toBeNull();
    await expect(db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      await chatCompanyDeletion.deleteCompanyData(tx, f.companyId);
    })).rejects.toMatchObject({ status: 409, details: { code: "photon_retirement_pending" } });
    expect(await c.service.get(next!.id)).not.toBeNull();
    await preparePhotonCompanyDeletion(db, f.companyId);
    await db.transaction(tx => assertPhotonCompanyRetired(tx, f.companyId));
  });

  it("an unavailable or older stopped cleanup owner cannot authorize company deletion", async () => {
    const c = await managedConfiguration();
    const remove = vi.fn(async () => { throw new Error("latest owner intentionally unavailable"); });
    const unregisterLatest = registerPhotonRemovalOwner(db, { remove });
    await c.service.shutdown(); // Old unregister must not remove the newer owner.
    await expect(preparePhotonCompanyDeletion(db, f.companyId)).rejects.toThrow("latest owner intentionally unavailable");
    expect(remove).toHaveBeenCalledOnce(); unregisterLatest();
    await expect(preparePhotonCompanyDeletion(db, f.companyId)).rejects.toMatchObject({ status: 409 });
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("external");
  });

  it("Photon creation and destructive cleanup serialize on the same narrow transaction key", async () => {
    // Real PostgreSQL lock ownership. No provider I/O or second observer pool;
    // the second transaction uses the existing pool's other connection.
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const cleanup = db.transaction(async tx => {
      await lockPhotonCompanyMutation(tx, f.companyId);
      acquired(); await held;
    });
    const errors: unknown[] = [];
    try {
      await Promise.race([ready, cleanup.then(() => { throw new Error("lock holder exited before admission"); })]);
      await db.transaction(async tx => {
        const rows = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`photon-company:${f.companyId}`}, 0)) as acquired`);
        expect(rows[0]?.acquired).toBe(false);
        // The normal non-Photon create boundary remains untouched and unblocked.
        await lockPhotonCompanyMutation(tx, f.companyId, "discord");
      });
    } catch (error) { errors.push(error); }
    finally {
      release();
      try { await cleanup; } catch (error) { if (!errors.includes(error)) errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Photon lock control and owner cleanup failed");
    await db.transaction(async tx => {
      await lockPhotonCompanyMutation(tx, f.companyId, "imessage-photon");
    });
  });

});
