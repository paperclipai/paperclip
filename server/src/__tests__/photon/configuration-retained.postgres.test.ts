import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, companyMemberships, agents, chatEndpointLeases, chatEndpoints, chatConversations, chatEndpointResources, chatPublications, companies, chatSdkState, companySecrets, createDb, toolConnections } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "../helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "../helpers/chat-milestone-fixtures.js";
import { chatChannelService } from "../../services/chat-channels.js";
import { createChatSdkRuntime, type CreateChatSdkEndpointRuntimeOptions } from "../../services/chat-sdk-runtime.js";
import { ChatRuntime, createChatRuntime } from "../../services/chat-runtime.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { PhotonChatAdapter } from "../../services/photon/adapter.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import { credentialFingerprint } from "../../services/chat-channels/credential-fingerprint.js";
import { createPhotonExternalRuntimeOwner } from "../../services/chat-channels/imessage-photon/external-runtime.js";
import { PHOTON_EXTERNAL_STATE, photonStateFor } from "../../services/chat-channels/imessage-photon/external-store.js";
import { photonHash, photonExternalStateSchema, readPhotonExternalState } from "../../services/chat-channels/imessage-photon/external-contract.js";

import { photonFixture } from "./fixture.js";
import * as photonExternalRuntime from "../../services/chat-channels/imessage-photon/external-runtime.js";
import * as photonStores from "../../services/chat-channels/imessage-photon/external-store.js";
import { startAgentLifecycle, createAgentLifecycle } from "../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../services/agent-lifecycle-driver.js";
import { createPluginWorkerManager } from "../../services/plugin-worker-manager.js";
import * as photonClients from "../../services/photon/owned-client.js";
import * as cloudConnectors from "../../services/paperclip-cloud-connector.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";

import { createPhotonExternalStore } from "../../services/chat-channels/imessage-photon/external-store.js";
import { createPhotonExternalOwner, PhotonLocalResources } from "../../services/chat-channels/imessage-photon/external-owner.js";
import type { ProcessProbe } from "../../services/owner-proof.js";

import { deleteCompany } from "../../services/company-deletion.js";
import { connectionManagementService } from "../../services/connection-management.js";
import { toolAccessService } from "../../services/tool-access.js";
import { preparePhotonCompanyDeletion, assertPhotonCompanyRetired, lockPhotonCompanyMutation, registerPhotonRemovalOwner } from "../../services/chat-channels/imessage-photon/company-retirement.js";
import { chatCompanyDeletion } from "../../services/chat-channels/company-deletion.js";
import { notifyChatCompanyConfiguration } from "../../services/chat-channels/configuration-work-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PHOTON_REVIEW_TEST_DATABASE_URL");
if (process.env.PHOTON_REVIEW_EXPECT_PG === "1" && !external) throw new Error("Photon review controls require their exact external test database");
describe.skipIf(!external)("Photon normal configuration and retained receiver authority (real SQL, controlled provider ports)", () => {
  let db: ReturnType<typeof createDb>, fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<ReturnType<typeof createChatMilestoneFixtures>["create"]>>;
  let directory: string;
  const services: ReturnType<typeof chatChannelService>[] = [];
  const runtimes: (ReturnType<typeof createChatSdkRuntime> | ReturnType<typeof createChatRuntime>)[] = [];
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
  it("positively unsupported Cloud retains normal local Photon intake across restart without staging a handoff",async()=>{
    // Preserve the real service/configuration/credential SQL owners. Only the
    // provider HTTP response and unused SDK start are controlled boundaries.
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const config = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const status = vi.fn(async () => Response.json({ active: true, status: "active", profiles: [] }));
    const connector = cloudConnectors.createPaperclipCloudConnector({ config, request: status });
    vi.spyOn(cloudConnectors, "paperclipCloudConnectorConfigFromEnv").mockReturnValue(config);
    vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockReturnValue(connector);
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
    const state = photonStateFor(db, { companyId: f.companyId, endpointId });
    expect(await state.read(PHOTON_EXTERNAL_STATE), "a positively unsupported Cloud must not persist an enrolling receiver").toBeNull();
    expect(runtime.get(endpointId)).not.toBeNull();
    await service.shutdown();
    const restarted = createChatSdkRuntime(); runtimes.push(restarted);
    const next = chatChannelService(db, { runtime: restarted, heartbeat, fetch: fetchProvider, publicBaseUrl: "https://tenant.example" }); services.push(next);
    // Restart an already-configured endpoint through its NORMAL reconstruction
    // entrypoint, not a second configuration or synthetic status transition.
    await expect(next.reconcileProviderRuntimes()).resolves.toEqual({ eligible: 1, local: 1, ownedElsewhere: 0, failed: 0 });
    expect(restarted.get(endpointId), "restart must retain actual normal local runtime creation").not.toBeNull();
    expect(await state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
    expect(status.mock.calls.length).toBeGreaterThan(0);
    const [connection]=await db.select().from(toolConnections).where(eq(toolConnections.id,endpoint!.connectionId));
    expect(connection).toMatchObject({enabled:true,status:"active",healthStatus:"healthy"});
    expect(connection!.credentialSecretRefs.length).toBeGreaterThan(0);
  });
  it("normal receiver cancellation settles only the exact never-created resource and retains its enrolled business intent",async()=>{
    // Preserve the real service/configuration/credential SQL owners. Only the
    // provider HTTP response and unused SDK start are controlled boundaries.
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const config = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const status = vi.fn(async () => Response.json({ active: true, status: "active", profiles: [], photonReceiver: { version: 1 } }));
    const connector = cloudConnectors.createPaperclipCloudConnector({ config, request: status });
    vi.spyOn(cloudConnectors, "paperclipCloudConnectorConfigFromEnv").mockReturnValue(config);
    vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockReturnValue(connector);
    const runtime=createChatSdkRuntime();runtimes.push(runtime);
    let cancelledAbort: (() => Promise<void>) | undefined;
    const replace = runtime.replaceEndpoint.bind(runtime);
    vi.spyOn(runtime, "replaceEndpoint").mockImplementation(async options => {
      const lifecycle: CreateChatSdkEndpointRuntimeOptions & { onConstructionAborted?(): Promise<void> } = options;
      cancelledAbort = lifecycle.onConstructionAborted;
      const replacing = replace(options);
      const joined = replacing.then(value => ({ value }), error => ({ error }));
      await runtime.removeEndpoint(options.endpointId);
      const result = await joined;
      if ("error" in result) throw result.error;
      return result.value;
    });
    const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient");
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
    let replaceBeforeLockedCommit = false;
    const normalStore = photonStores.createPhotonExternalStore;
    vi.spyOn(photonStores, "createPhotonExternalStore").mockImplementation(database => {
      const store = normalStore(database), retained = store.retained.bind(store);
      return { ...store, retained: async (...args: Parameters<typeof store.retained>) => {
        const [expected, update, after] = args;
        if (replaceBeforeLockedCommit) {
          replaceBeforeLockedCommit = false;
          if (!expected.localResource) throw new Error("actual receiver descriptor absent");
          const changedId = randomUUID();
          const newer = { ...expected, localResourceId: changedId,
            localResource: { ...expected.localResource, id: changedId, closed: false } };
          delete newer.localClosureConfirmed; // An unclosed replacement has no true-only close receipt.
          expect(newer.localClosureConfirmed).toBeUndefined();
          expect(newer.localResource.closed).toBe(false);
          // Controlled store-contract race: use REAL SQL but feed the update its
          // latest locked owner, rather than the earlier preliminary snapshot.
          await photonStateFor(database, expected.identity).update(PHOTON_EXTERNAL_STATE, () => newer);
          return retained(newer, update, after);
        }
        return retained(...args);
      } };
    });
    const heartbeat=heartbeatService(db);heartbeats.push(heartbeat);
    const service=chatChannelService(db,{runtime,heartbeat,fetch:fetchProvider,publicBaseUrl:"https://tenant.example"});services.push(service);
    const created=await service.create(f.companyId,{provider:"imessage-photon",assignedAgentId:f.agentId},f.userId);
    if(!created)throw new Error("normal Photon endpoint creation failed");
    const endpointId=created.id;
    await expect(service.configure(endpointId,{action:"configure",credentials:{projectSecret:"controlled-project-secret"},photon:{allocation:"dedicated",projectId:"project",lineId:"line"}},f.userId)).rejects.toMatchObject({ status: 422 });
    const [endpoint]=await db.select().from(chatEndpoints).where(eq(chatEndpoints.id,endpointId));
    expect(endpoint?.setup,"normal configuration must stage Photon handoff subject").toMatchObject({photonExternalSubject:f.userId});
    expect(endpoint?.status).toBe("attention");
    const state = photonStateFor(db, { companyId: f.companyId, endpointId });
    const retained = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    expect(allocate).not.toHaveBeenCalled();
    expect(retained?.localClosureConfirmed, "a superseded pre-constructor receiver must settle its exact never-created resource").toBe(true);
    expect(retained?.localResource?.closed).toBe(true);
    expect(retained).toMatchObject({ phase: "enrolling", initialSequence: null, joinedSequence: null, acceptedSequence: null, pending: null });
    expect(retained?.senderResource).toBeUndefined();
    expect(runtime.get(endpointId)).toBeNull();
    if (!cancelledAbort || !retained) throw new Error("normal exact receiver cancellation owner absent");
    await cancelledAbort(); // Same caller's lost cleanup reply is idempotent.
    expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))).toEqual(retained);
    replaceBeforeLockedCommit = true;
    await expect(cancelledAbort()).rejects.toThrow("receiver changed during close commit");
    const raced = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    expect(raced?.handoffId).toBe(retained.handoffId);
    expect(raced?.localResourceId).not.toBe(retained.localResourceId);
    expect(raced?.localResource?.closed).toBe(false);
    expect(raced?.localClosureConfirmed).toBeUndefined();
    if (!raced) throw new Error("controlled later receiver owner absent");
    // Controlled replacement of the durable handoff identity is a negative CAS
    // port, not fabricated Cloud acceptance or process-birth evidence.
    const newer = { ...raced, handoffId: randomUUID() };
    await state.update(PHOTON_EXTERNAL_STATE, () => newer);
    await cancelledAbort();
    expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))).toEqual(newer);
  });

  it("unchanged external intake stays idle but changed or revoked authority is immediately due and retires normally",async()=>{
    const [endpoint]=await db.select().from(chatEndpoints).where(eq(chatEndpoints.id,f.endpointId)); if(!endpoint)throw new Error("fixture endpoint absent");
    const [connection]=await db.select().from(toolConnections).where(eq(toolConnections.id,endpoint.connectionId)); if(!connection)throw new Error("fixture connection absent");
    let requests: Record<string,unknown>[]=[], brokerAvailable=true;
    const changedNotify=vi.fn();
    const configured={provider:"imessage-photon" as const,userName:"Agent",intakeAfter:1,credentials:{allocation:"dedicated" as const,projectId:"project",projectSecret:"controlled-secret",lineId:"line",phoneNumber:"+15555550100"}};
    const makeOwner=()=>createPhotonExternalRuntimeOwner(db,{
      retainConstructionCleanup: () => { throw new Error("revoked fixture cannot allocate a never-created resource"); },
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

  it("normal remove fences an unaccepted Photon enrollment before removing its credentials",async()=>{
    // Preserve the real service/configuration/credential SQL owners. Only the
    // provider HTTP response and unused SDK start are controlled boundaries.
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const config = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const connector = cloudConnectors.createPaperclipCloudConnector({ config,
      request: async () => Response.json({ active: true, status: "active", profiles: [], photonReceiver: { version: 1 } }) });
    vi.spyOn(cloudConnectors, "paperclipCloudConnectorConfigFromEnv").mockReturnValue(config);
    vi.spyOn(cloudConnectors, "createPaperclipCloudConnector").mockReturnValue(connector);
    const currentAdmin = randomUUID();
    const requests: Record<string, unknown>[] = [];
    vi.spyOn(connector, "photonReceiverOperation").mockImplementation(async ({ operation, subject }) => {
      requests.push(structuredClone(operation));
      const retained = readPhotonExternalState(await photonStateFor(db, { companyId: f.companyId, endpointId }).read(PHOTON_EXTERNAL_STATE));
      if (!retained) throw new Error("actual original enrollment intent absent");
      if (operation.kind === "cancel-enrollment") {
        expect(subject).toBe(currentAdmin);
        expect(operation).toEqual({ kind: "cancel-enrollment", binding: retained.binding, handoffId: retained.handoffId, originalSubject: retained.identity.subject });
        expect(retained).toMatchObject({ phase: "retiring", localClosureConfirmed: true, enrollmentCancellation: "requested" });
        // Controlled exact Cloud cancellation API receipt, NOT a physical claim.
        // The independent Cloud owner controls qualify its atomic floor below.
        return { binding: retained.binding, handoffId: retained.handoffId, phase: "cancelled" };
      }
      throw new Error("Photon retirement owner absent");
    });
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
    const state = photonStateFor(db, { companyId: f.companyId, endpointId });
    const original = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
    if (!endpoint || !original) throw new Error("normal original Photon intent absent");
    expect(original.phase).toBe("enrolling"); expect(runtime.get(endpointId)).not.toBeNull();
    expect(requests).toEqual([]); // Configuration never attempted a Cloud enrollment.
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: currentAdmin, status: "active", membershipRole: "owner" });
    await db.delete(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId)));
    const management = connectionManagementService(db), resource = { type: "connection_management" as const, companyId: f.companyId,
      connectionId: endpoint.connectionId, provider: "imessage-photon", purpose: "chat" as const, operation: "POST /chat-endpoints/:endpointId/configure" };
    await expect(management.authorize({ type: "board", userId: f.userId, source: "session" }, "connections:configure", resource)).rejects.toMatchObject({ status: 403 });
    await expect(management.authorize({ type: "board", userId: randomUUID(), source: "session" }, "connections:configure", resource)).rejects.toMatchObject({ status: 403 });
    const authority = await management.authorize({ type: "board", userId: currentAdmin, source: "session" }, "connections:configure", resource);
    await expect(service.configure(endpointId, { action: "remove" }, currentAdmin, authority),
      "ordinary removal must fence an unaccepted enrollment instead of stranding missing Cloud custody").resolves.toMatchObject({ status: "archived" });
    const [removed] = await db.select().from(toolConnections).where(eq(toolConnections.id, endpoint.connectionId));
    expect(removed.credentialSecretRefs).toEqual([]);
    expect(readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE))).toMatchObject({ phase: "retired", enrollmentCancellation: "fenced",
      handoffId: original.handoffId, binding: original.binding, initialSequence: original.initialSequence, acceptedSequence: original.acceptedSequence });
    expect(requests.map(value => value.kind)).toEqual(["cancel-enrollment"]);
    await expect(service.configure(endpointId, { action: "remove" }, currentAdmin, authority)).rejects.toMatchObject({ status: 409 });
  });

  async function managedConfiguration(useNormalRegistry = false) {
    const createRegistry = useNormalRegistry ? createChatRuntime : createChatSdkRuntime;
    // The real connector object/composition is retained; only the provider RPC
    // port is controlled here. This is not managed distribution/auth proof.
    const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
    const config = { baseUrl: "https://cloud.example", instanceId: "instance", environment: "test" as const,
      signPrivateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      sealPrivateKey: sealing.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const connector = cloudConnectors.createPaperclipCloudConnector({ config, request: async () => Response.json({ active: true, status: "active", profiles: [], photonReceiver: { version: 1 } }) });
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
    let runtime = createRegistry(); runtimes.push(runtime);
    const heartbeat = heartbeatService(db); heartbeats.push(heartbeat);
    let service = chatChannelService(db, { runtime, heartbeat, fetch: fetchProvider, publicBaseUrl: "https://tenant.example" }); services.push(service);
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
    return { get service() { return service; }, get runtime() { return runtime; }, endpoint, connection, state, retained, requests,
      async reconstructExternal(control: ReturnType<typeof photonFixture>, cancelFirstReplacement = false, constructorFault?: Error, expectedReservationFailure = false) {
        // Retain controlled enrolled history, but really join the original local
        // service and its receiver lease before reconstructing the normal owner.
        await service.shutdown();
        runtime = createRegistry(); runtimes.push(runtime);
        service = chatChannelService(db, { runtime, heartbeat, fetch: fetchProvider, publicBaseUrl: "https://tenant.example" }); services.push(service);
        const clients: { client: ReturnType<typeof photonFixture>["adapter"]["client"]; methods: { method: string; active?: unknown }[]; closeAttempts: number; joined: boolean }[] = [];
        const births: { runtime: NonNullable<ReturnType<typeof runtime.get>>; resourceId: string }[] = [];
        const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient");
        if (constructorFault) allocate.mockImplementation(() => { throw constructorFault; });
        else allocate.mockImplementation(() => {
          // Distinct controlled client for EVERY actual factory allocation. The
          // shared provider port owns send receipts; each client owns its close.
          const owned = photonFixture(), methods: { method: string; active?: unknown }[] = [];
          const row = { client: owned.adapter.client, methods, closeAttempts: 0, joined: false };
          const close = async () => {
            row.closeAttempts++;
            if (row.joined) return;
            await control.client.close(); // Existing shared controlled close-fault port.
            await owned.client.close();
            row.joined = true;
          };
          const channel = (name: "chats" | "messages" | "attachments" | "groups" | "polls" | "events") => new Proxy(owned.adapter.client[name], {
            get(target, key, receiver) {
              const method = Reflect.get(target, key, receiver);
              if (typeof method !== "function") return method;
              return (...args: unknown[]) => {
                if (row.joined) throw new Error("Controlled Photon client used after its own close");
                const operation = `${name}.${String(key)}`;
                methods.push({ method: operation, ...(operation === "chats.setTyping" ? { active: args[1] } : {}) });
                if (["chats.get", "messages.sendText", "chats.setTyping"].includes(operation)) expect(args[0]).toBe(control.chat.guid);
                // These are actual method invocations, not prefilled roles or
                // provider outcomes. One provider receipt map spans clients.
                const providerMethod = Reflect.get(control.adapter.client[name], key);
                if (typeof providerMethod !== "function") throw new Error("Unsupported controlled Photon method");
                return Reflect.apply(providerMethod, control.adapter.client[name], args);
              };
            },
          });
          row.client = new Proxy(owned.adapter.client, { get(target, key, receiver) {
            if (key === "close") return close;
            if (key === "chats" || key === "messages" || key === "attachments" || key === "groups" || key === "polls" || key === "events") return channel(key);
            return Reflect.get(target, key, receiver);
          } });
          clients.push(row);
          return row.client;
        });
        let observedCloudBirth = false, cancel = cancelFirstReplacement;
        let cancelledAbort: (() => Promise<void>) | undefined;
        const replace = runtime.replaceEndpoint.bind(runtime);
        vi.spyOn(runtime, "replaceEndpoint").mockImplementation(async options => {
          const selected = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
          expect(selected).toMatchObject({ phase: "external", handoffId: retained.handoffId,
            binding: retained.binding, identity: retained.identity });
          expect(selected?.senderResource?.closed).toBe(false);
          expect(typeof options.callbacks.onPhotonUsefulClientDebt).toBe("function");
          expect(typeof options.callbacks.onPhotonSenderRuntimeClosed).toBe("function");
          observedCloudBirth = true;
          if (cancel) {
            cancel = false;
            const lifecycle: CreateChatSdkEndpointRuntimeOptions & { onConstructionAborted?(): Promise<void> } = options;
            cancelledAbort = lifecycle.onConstructionAborted;
            // Actual registry queue cancellation before its constructor runs.
            const replacing = replace(options);
            const joined = replacing.then(value => ({ value }), error => ({ error }));
            const removal = runtime.removeEndpoint(endpoint.id).then(() => ({ complete: true as const }), error => ({ error }));
            const [result, removed] = await Promise.all([joined, removal]);
            if ("error" in result && "error" in removed) throw new AggregateError([result.error, removed.error], "Controlled cancellation and normal removal both retained cleanup failures");
            if ("error" in result) throw result.error;
            if ("error" in removed) throw removed.error;
            return result.value;
          }
          const constructed = await replace(options); // Actual normal Runtime/SDK; callbacks unchanged.
          if (!selected?.senderResource) throw new Error("actual prebirth sender descriptor absent");
          births.push({ runtime: constructed, resourceId: selected.senderResource.id });
          return constructed;
        });
        // Complete existing direct-message history, matching normal inbound
        // ensureResource: same company/endpoint/canonical thread, available DM.
        // This creates no publication, delivery, ACK or provider outcome.
        expect(control.chat.isArchived).toBe(false);
        const [currentEndpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
        expect(currentEndpoint?.allowDirectMessages).toBe(true); // Policy unchanged.
        const [resource] = await db.insert(chatEndpointResources).values({ companyId: f.companyId,
          endpointId: endpoint.id, type: "direct_message", providerResourceId: control.threadId,
          label: "Controlled Photon direct conversation", availability: "available", enabled: true }).returning();
        if (!resource) throw new Error("existing Photon direct-message resource fixture absent");
        const [conversation] = await db.insert(chatConversations).values({ companyId: f.companyId,
          endpointId: endpoint.id, resourceId: resource.id, issueId: f.issueId, externalConversationId: control.threadId,
          externalThreadId: control.threadId, externalLabel: "Controlled Photon direct conversation", isDirectMessage: true }).returning();
        if (!conversation) throw new Error("normal outbound conversation fixture absent");
        const published = await service.publishBoardMessage(endpoint.id, conversation.id,
          "Controlled ordinary sender bootstrap", randomUUID(), f.userId);
        if (cancelFirstReplacement || constructorFault || expectedReservationFailure) {
          expect(published?.state).not.toBe("published");
          expect(control.client.messages.sendText).not.toHaveBeenCalled();
          if (!published || published.state !== "delivery_unknown") throw new Error("actual original publication unknown receipt absent");
          const originalId = published.id;
          return { cancelledAbort: async () => { if (!cancelledAbort) throw new Error("normal never-created cleanup callback absent"); await cancelledAbort(); },
            retryOriginalPublication: async () => {
              // The normal FIFO deliberately blocks later publications behind
              // unknown delivery. Only the explicit operator Retry authorizes
              // this ORIGINAL publication; no new row or implicit resend.
              const authority = await connectionManagementService(db).authorize({ type: "board", userId: f.userId, source: "session" },
                "connections:configure", { type: "connection_management", companyId: f.companyId, connectionId: connection.id,
                  provider: "imessage-photon", purpose: "chat", operation: "POST /chat-endpoints/:endpointId/publications/:publicationId/resolve" });
              await authority.reauthorize();
              await service.resolvePublication(endpoint.id, originalId, "retry_anyway", f.userId);
              const [current] = await db.select().from(chatPublications).where(and(eq(chatPublications.companyId, f.companyId),
                eq(chatPublications.endpointId, endpoint.id), eq(chatPublications.id, originalId)));
              if (!current) throw new Error("original publication receipt missing after ordinary operator Retry");
              expect(current.id).toBe(originalId); expect(current.payload).toEqual(published.payload);
              return current;
            },
            verifyUsefulOwnership: async () => {
              expect(births).toHaveLength(1); // One actual successful Runtime constructor.
              const birth = births[0]; if (!birth) throw new Error("normal Runtime birth witness absent");
              expect(runtime.get(endpoint.id)).toBe(birth.runtime);
              const current = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
              expect(current?.senderResource).toMatchObject({ id: birth.resourceId, closed: false });
              expect(new Set(clients.map(row => row.client)).size).toBe(clients.length);
              expect(clients.filter(row => row.methods.length === 0)).toHaveLength(1); // Constructor bootstrap, drained by external handoff.
              expect(clients.flatMap(row => row.methods)).toEqual([
                { method: "chats.get" }, { method: "messages.sendText" }, { method: "chats.setTyping", active: false },
              ]);
              for (const client of clients) { expect(client.closeAttempts).toBe(1); expect(client.joined).toBe(true); }
            },
            joinCurrentSender: async () => {
              const birth = births[0]; if (!birth) throw new Error("normal Runtime birth witness absent");
              await runtime.removeEndpoint(endpoint.id); // Normal actual SDK+adapter join and captured close CAS.
              expect(runtime.get(endpoint.id)).toBeNull(); expect(runtime.hasUnsettledLifecycle()).toBe(false);
              const closed = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
              expect(closed?.senderResource).toMatchObject({ id: birth.resourceId, closed: true });
              expect(closed?.handoffId).toBe(retained.handoffId); expect(closed?.acceptedSequence).toBe(retained.acceptedSequence);
              for (const client of clients) expect(client.joined).toBe(true);
            } };

        }
        expect(published?.redactedError, "ordinary publication must not retain a redacted failure").toBeNull();
        expect(published?.state).toBe("published");
        expect(control.client.messages.sendText).toHaveBeenCalledOnce();
        expect(observedCloudBirth).toBe(true);
        const selected = readPhotonExternalState(await state.read(PHOTON_EXTERNAL_STATE));
        expect(selected).toMatchObject({ phase: "external", handoffId: retained.handoffId, binding: retained.binding });
        if (!selected?.senderResource || selected.senderResource.closed || !runtime.get(endpoint.id))
          throw new Error("normal external sender was not retained after its ordinary publication");
      },
      pendingRetirement() { retirement = "retiring"; }, finishRetirement() { retirement = "retired"; } };
  }

  it("normal publication cancellation before construction settles only its exact never-created sender and permits ordinary retry", async () => {
    const c = await managedConfiguration(), control = photonFixture();
    const retry = await c.reconstructExternal(control, true);
    if (!retry) throw new Error("cancelled publication retry control absent");
    expect(photonClients.createOwnedPhotonClient).not.toHaveBeenCalled();
    const aborted = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(aborted?.senderResource?.closed, "cancelled normal replacement must settle the exact never-constructed sender allocation").toBe(true);
    expect(aborted).toMatchObject({ phase: "external", handoffId: c.retained.handoffId, binding: c.retained.binding });
    expect(aborted?.localClosureConfirmed).toBeUndefined(); // No invented receiver close.
    const published = await retry.retryOriginalPublication();
    expect(published?.state).toBe("published");
    expect(control.client.messages.sendText).toHaveBeenCalledOnce();
    await retry.verifyUsefulOwnership();
    const current = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(current?.senderResource?.id).not.toBe(aborted?.senderResource?.id);
    expect(current?.senderResource?.closed).toBe(false);
    expect(current?.acceptedSequence).toBe(c.retained.acceptedSequence);
    await retry.cancelledAbort(); // Lost original cleanup reply after a newer slot.
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))).toEqual(current);
    await retry.joinCurrentSender();
  });

  it("ordinary authorized publication retries a failed never-created sender receipt before any new reservation", async () => {
    const failure = new Error("controlled never-created SQL receipt write failed");
    let failReceipt = false;
    const normalStore = photonStores.createPhotonExternalStore;
    vi.spyOn(photonStores, "createPhotonExternalStore").mockImplementation(database => {
      const store = normalStore(database), retained = store.retained.bind(store);
      return { ...store, retained: async (...args: Parameters<typeof store.retained>) => {
        const [expected] = args;
        if (failReceipt && expected.senderResource?.closed === false) throw failure;
        return retained(...args);
      } };
    });
    const c = await managedConfiguration(), control = photonFixture();
    failReceipt = true;
    try {
    const retry = await c.reconstructExternal(control, true);
    if (!retry) throw new Error("ordinary publication retry control absent");
    const pending = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(pending?.senderResource?.closed).toBe(false);
    expect(c.runtime.hasUnsettledLifecycle()).toBe(true);
    expect(photonClients.createOwnedPhotonClient).not.toHaveBeenCalled();
    failReceipt = false; // Repair the controlled fault only at explicit ordinary Retry.
    const published = await retry.retryOriginalPublication();
    expect(published?.state, "ordinary publication must join the original failed abort receipt before its sender preflight").toBe("published");
    expect(control.client.messages.sendText).toHaveBeenCalledOnce();
    await retry.verifyUsefulOwnership();
    expect(c.runtime.hasUnsettledLifecycle()).toBe(false);
    const current = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(current?.senderResource?.id).not.toBe(pending?.senderResource?.id);
    expect(current?.acceptedSequence).toBe(c.retained.acceptedSequence);
    await retry.joinCurrentSender();
    } finally { failReceipt = false; } // Normal service shutdown can join any retained exact receipt.
  });

  it("ordinary publication joins a lost reservation reply and failed direct never-created receipt before allocating again", async () => {
    const lost = new Error("controlled sender reservation committed reply lost");
    const cleanupFailure = new Error("controlled direct never-created receipt write failed");
    let loseReply = false, failCleanup = false, observedLostReply = false, observedCleanupFailure = false;
    const normalStore = photonStores.createPhotonExternalStore;
    vi.spyOn(photonStores, "createPhotonExternalStore").mockImplementation(database => {
      const store = normalStore(database), current = store.current.bind(store), retained = store.retained.bind(store);
      return { ...store,
        current: async <T,>(...args: Parameters<typeof store.current<T>>): Promise<T> => {
          const result = await current<T>(...args);
          const parsed = photonExternalStateSchema.safeParse(result);
          if (loseReply && parsed.success && parsed.data.senderResource?.closed === false) {
            loseReply = false; observedLostReply = true; throw lost;
          }
          return result;
        },
        retained: async (...args: Parameters<typeof store.retained>) => {
          if (failCleanup && args[0].senderResource?.closed === false) {
            failCleanup = false; observedCleanupFailure = true; throw cleanupFailure;
          }
          return retained(...args);
        },
      };
    });
    const c = await managedConfiguration(true), control = photonFixture();
    expect(c.runtime).toBeInstanceOf(ChatRuntime);
    loseReply = true; failCleanup = true;
    const retry = await c.reconstructExternal(control, false, undefined, true);
    if (!retry) throw new Error("ordinary reservation-failure retry control absent");
    expect(c.runtime).toBeInstanceOf(ChatRuntime);
    expect(observedLostReply).toBe(true); expect(observedCleanupFailure).toBe(true);
    const pending = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(pending?.senderResource?.closed).toBe(false);
    expect(c.runtime.hasUnsettledLifecycle()).toBe(true);
    expect(photonClients.createOwnedPhotonClient).not.toHaveBeenCalled();
    const published = await retry.retryOriginalPublication();
    expect(published?.state).toBe("published");
    expect(control.client.messages.sendText).toHaveBeenCalledOnce();
    await retry.verifyUsefulOwnership();
    expect(c.runtime.hasUnsettledLifecycle()).toBe(false);
    const settled = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(settled?.senderResource?.id).not.toBe(pending?.senderResource?.id);
    expect(settled?.acceptedSequence).toBe(c.retained.acceptedSequence);
    await retry.joinCurrentSender();
  });

  it("an entered normal sender constructor cannot turn its unknown allocation into never-created cleanup on publication retry", async () => {
    const c = await managedConfiguration(), control = photonFixture();
    const retry = await c.reconstructExternal(control, false, new Error("controlled constructor entry failure"));
    if (!retry) throw new Error("constructor failure retry control absent");
    const pending = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(pending?.senderResource?.closed).toBe(false);
    expect(photonClients.createOwnedPhotonClient).toHaveBeenCalledOnce();
    const next = await retry.retryOriginalPublication();
    expect(next?.state).not.toBe("published");
    expect(control.client.messages.sendText).not.toHaveBeenCalled();
    expect(photonClients.createOwnedPhotonClient).toHaveBeenCalledOnce();
    const retained = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    expect(retained?.senderResource?.id).toBe(pending?.senderResource?.id);
    expect(retained?.senderResource?.closed).toBe(false);
    expect(retained?.failure).toMatchObject({ code: "sender_close", nextAttemptAt: null });
  });

  it("normal receiver worker settles a paused or archived Photon owner after exact retirement", async () => {
    const c = await managedConfiguration();
    await c.service.configure(c.endpoint.id, { action: "pause" }, f.userId);
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } }); coordinators.push(coordinator);
    await c.service.registerReceiverWork(coordinator, () => true).ready;
    await vi.waitFor(async () => {
      expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator.nextWakeAt()).toBeNull();
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
    const c = await managedConfiguration(), control = photonFixture();
    await c.reconstructExternal(control);
    const factoryCallsBeforeFailure = vi.mocked(photonClients.createOwnedPhotonClient).mock.calls.length;
    const endpointRuntime = c.runtime.get(c.endpoint.id);
    if (!endpointRuntime) throw new Error("normal endpoint runtime absent");
    const adapter = endpointRuntime.getProviderAdapter();
    if (!(adapter instanceof PhotonChatAdapter)) throw new Error("normal Photon adapter absent");
    const closeFailure = new Error("controlled same-sender close debt"); let closeFails = true;
    control.client.close.mockImplementation(async () => { if (closeFails) throw closeFailure; });
    let primary: { error: unknown } | undefined;
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
      expect(photonClients.createOwnedPhotonClient).toHaveBeenCalledTimes(factoryCallsBeforeFailure + 1);
      await coordinator.stop(); vi.useRealTimers();
      // Controlled restart image contains a recorded failed close but no owned
      // runtime handle. A new normal owner cannot synthesize a close receipt.
      const current = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
      if (!current) throw new Error("retained sender owner absent");
      await c.state.update(PHOTON_EXTERNAL_STATE, () => ({ ...current, failure: { code: "sender_close" as const, attempts: 3, nextAttemptAt: new Date().toISOString() } }));
      const replacement = createPhotonExternalRuntimeOwner(db, {
        retainConstructionCleanup: (id, cleanup) => c.runtime.retainPendingConstructionCleanup(id, cleanup),
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
    } catch (error) { primary = { error }; }
    finally {
      closeFails = false; vi.useRealTimers();
      const failures: unknown[] = [];
      try { await c.runtime.removeEndpoint(c.endpoint.id); } catch (error) { failures.push(error); }
      try { await control.adapter.disconnect(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError([...(primary ? [primary.error] : []), ...failures], "Photon sender fixture normal cleanup remains incomplete");
    }
    if (primary) throw primary.error;
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
      retainConstructionCleanup: (id, cleanup) => c.runtime.retainPendingConstructionCleanup(id, cleanup),
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
    // The real service reserves and initializes the Cloud-placement sender. Only
    // the reply AFTER its real SQL close commit is lost; callbacks remain intact.
    const makeStore = photonStores.createPhotonExternalStore;
    let loseCloseReply = true;
    const lost = new Error("controlled successful sender receipt reply lost");
    vi.spyOn(photonStores, "createPhotonExternalStore").mockImplementation(database => {
      const store = makeStore(database);
      return { ...store, async retained(...args: Parameters<typeof store.retained>) {
        const next = await store.retained(...args);
        if (loseCloseReply && next.phase === "retiring" && next.senderResource?.closed) {
          loseCloseReply = false; throw lost;
        }
        return next;
      } };
    });
    const makeOwner = photonExternalRuntime.createPhotonExternalRuntimeOwner;
    const actualOwners: ReturnType<typeof makeOwner>[] = [];
    const closeObservers = new Map<ReturnType<typeof makeOwner>, {
      calls: Parameters<ReturnType<typeof makeOwner>["senderRuntimeClosed"]>[];
    }>();
    vi.spyOn(photonExternalRuntime, "createPhotonExternalRuntimeOwner").mockImplementation((database, options) => {
      const owner = makeOwner(database, options); actualOwners.push(owner);
      // Observe the exact normal callback arguments; spy delegates unchanged.
      closeObservers.set(owner, vi.spyOn(owner, "senderRuntimeClosed").mock);
      return owner;
    });
    const c = await managedConfiguration(), control = photonFixture();
    let primary: { error: unknown } | undefined;
    try {
    await c.reconstructExternal(control);
    const owner = actualOwners.at(-1);
    if (!owner) throw new Error("normal sender owner absent");
    const sender = c.runtime.get(c.endpoint.id);
    if (!sender) throw new Error("normal Cloud-placement sender absent");
    const retained = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    if (!retained?.senderResource) throw new Error("normal sender birth absent");
    await expect(db.transaction(tx => chatCompanyDeletion.deleteCompanyData(tx, f.companyId)))
      .rejects.toMatchObject({ status: 409, details: { code: "photon_retirement_pending" } });
    await expect(c.service.configure(c.endpoint.id, { action: "remove" }, f.userId)).rejects.toBe(lost);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.senderResource?.closed).toBe(true);
    expect(c.runtime.hasUnsettledLifecycle()).toBe(true);
    // Same normal remove joins that same retired Runtime and settles the actual
    // controlled Cloud retirement before clearing credentials or deleting rows.
    await c.service.configure(c.endpoint.id, { action: "remove" }, f.userId);
    expect(readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE))?.phase).toBe("retired");
    expect(c.runtime.hasUnsettledLifecycle()).toBe(false);
    await db.transaction(async tx => {
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      await notifyChatCompanyConfiguration(tx, f.companyId);
      await chatCompanyDeletion.deleteCompanyData(tx, f.companyId);
    });
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
    await expect(sender.shutdown()).resolves.toBeUndefined();
    const original = closeObservers.get(owner)?.calls.find(([allocation]) => allocation.resourceId === retained.senderResource?.id);
    if (!original) throw new Error("normal sender close callback was not observed");
    const [allocation, context] = original;
    // Retry that exact normal completion callback after its real SDK joins and
    // FK cascade. Missing rows permit no mutation, never an unknown close proof.
    await expect(owner.senderRuntimeClosed(allocation, context)).resolves.toBeUndefined();
    await expect(owner.senderRuntimeClosed({ ...allocation, resourceId: randomUUID() }, context)).rejects.toThrow("exact runtime owner");
    await expect(owner.senderRuntimeClosed({ ...allocation, identity: { ...allocation.identity, companyId: randomUUID() } }, context)).rejects.toThrow("exact runtime owner");
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
    } catch (error) { primary = { error }; }
    finally {
      loseCloseReply = false;
      const failures: unknown[] = [];
      try { await c.runtime.removeEndpoint(c.endpoint.id); } catch (error) { failures.push(error); }
      try { await control.adapter.disconnect(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError([...(primary ? [primary.error] : []), ...failures], "normal captured-sender cleanup remains incomplete");
    }
    if (primary) throw primary.error;
  });
  it("normal company deletion returns pending before agent termination and retries the exact Cloud retirement", async () => {
    const c = await managedConfiguration(); c.pendingRetirement();
    const manager = createPluginWorkerManager();
    const driver = createLifecycleDriver(db, manager);
    let holdHost = true;
    const lifecycleOwner = startAgentLifecycle(db, { ...driver,
      runHost: agent => holdHost ? Promise.resolve<"pending">("pending") : driver.runHost(agent),
    }, () => true);
    let primary: { error: unknown } | undefined;
    try {
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
    await expect(deleteCompany(db, f.companyId)).rejects.toThrow("Complete termination");
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]?.lifecycleState).toBe("terminating");
    holdHost = false;
    await createAgentLifecycle(db).retry(f.agentId);
    await lifecycleOwner.sweep();
    await expect(deleteCompany(db, f.companyId)).resolves.not.toBeNull();
    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toEqual([]);
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
    } catch (error) { primary = { error }; }
    finally {
      const failures: unknown[] = [];
      try { await lifecycleOwner.stop(); } catch (error) { failures.push(error); }
      try { await manager.stopAll(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError([...(primary ? [primary.error] : []), ...failures], "normal lifecycle fixture cleanup remains incomplete");
    }
    if (primary) throw primary.error;
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

  it("company destructive recheck reads encoded Photon obligations before deleting retired-looking records", async () => {
    const c = await managedConfiguration();
    await c.service.configure(c.endpoint.id, { action: "remove" }, f.userId);
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id));
    expect(endpoint?.status).toBe("archived");
    expect(connection).toMatchObject({ enabled: false, status: "archived", credentialSecretRefs: [] });
    const settled = readPhotonExternalState(await c.state.read(PHOTON_EXTERNAL_STATE));
    if (!settled || settled.phase !== "retired") throw new Error("normal Photon retirement did not settle");
    const receiverId = randomUUID();
    const senderId = randomUUID();
    const sequence = (settled.acceptedSequence ?? -1) + 1;
    const obligations = [
      photonExternalStateSchema.parse({ ...settled, pending: {
        deliveryId: "retained-company-delete", sequence,
        previousSequence: settled.acceptedSequence, frameDigest: "a".repeat(64),
      } }),
      photonExternalStateSchema.parse({ ...settled, localResourceId: receiverId,
        localResource: { id: receiverId, controller: {}, leaseDigest: "b".repeat(64), closed: false },
        localClosureConfirmed: undefined }),
      photonExternalStateSchema.parse({ ...settled,
        senderResource: { id: senderId, controller: {}, leaseDigest: "c".repeat(64), closed: false } }),
    ];
    for (const parsed of obligations) {
      const obligation = photonExternalStateSchema.parse(JSON.parse(JSON.stringify(parsed)));
      // Exercise the real encoded company/endpoint CAS owner, never insert a
      // raw external-owner key that would mask the destructive-gate defect.
      await c.state.update(PHOTON_EXTERNAL_STATE, () => obligation);
      expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toEqual(obligation);
      expect(await db.select().from(chatSdkState).where(and(
        eq(chatSdkState.companyId, f.companyId), eq(chatSdkState.endpointId, c.endpoint.id),
        eq(chatSdkState.stateKey, PHOTON_EXTERNAL_STATE)))).toEqual([]);
      await expect(db.transaction(async tx => {
        await tx.select({ id: companies.id }).from(companies)
          .where(eq(companies.id, f.companyId)).for("no key update");
        await chatCompanyDeletion.deleteCompanyData(tx, f.companyId);
        // Roll back an unsafe baseline deletion while preserving its precise
        // rejection difference from the required normal retirement conflict.
        throw new Error("destructive_gate_accepted_retained_photon_obligation");
      })).rejects.toMatchObject({ status: 409, details: { code: "photon_retirement_pending" } });
      expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(1);
      expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id))).toEqual([endpoint]);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.id, c.connection.id))).toEqual([connection]);
      expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toEqual(obligation);
    }
    // The positive final gate still accepts the SAME settled identity and ACK
    // prefix. It does not rewrite progress or require a second provider call.
    await c.state.update(PHOTON_EXTERNAL_STATE, () => settled);
    const requests = structuredClone(c.requests);
    await db.transaction(tx => chatCompanyDeletion.deleteCompanyData(tx, f.companyId));
    expect(c.requests).toEqual(requests);
    expect(await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, c.endpoint.id))).toEqual([]);
    expect(await c.state.read(PHOTON_EXTERNAL_STATE)).toBeNull();
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
