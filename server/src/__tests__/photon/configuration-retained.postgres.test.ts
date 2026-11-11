import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingMigrations, chatEndpoints, chatSdkState, companySecrets, createDb, toolConnections } from "@paperclipai/db";
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
    for (const owner of owners.splice(0)) try { await owner.close(); } catch(error) { errors.push(error); }
    for (const service of services.splice(0)) try { await service.shutdown(); } catch(error) { errors.push(error); }
    for (const runtime of runtimes.splice(0)) try { await runtime.shutdown(); } catch(error) { errors.push(error); }
    for (const heartbeat of heartbeats.splice(0)) try { await heartbeat.drainActiveRunExecutions(); } catch(error) { errors.push(error); }
    try {
      await db.delete(chatSdkState).where(eq(chatSdkState.companyId,f.companyId));
      await db.delete(companySecrets).where(eq(companySecrets.companyId,f.companyId));
      await fixtures.cleanup();
    } catch(error) { errors.push(error); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
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
});
