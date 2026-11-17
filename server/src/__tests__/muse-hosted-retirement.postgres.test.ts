import { randomBytes, randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, applyPendingMigrations,
  activityLog, principalPermissionGrants, instanceSettings, museAgentBindings as bindings, museCredentials, museReceiverContactBuckets as buckets,
  mcpOauthClientMirrorState as mirrorState, subscribeDatabaseWork } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { museIdentity, museCredentialHash } from "../services/muse-identity.js";
import { museOAuth } from "../services/muse-oauth.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";
import { museReceiver } from "../services/muse-receiver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { authorizationService } from "../services/authorization.js";
import { initializeCloudRuntimeIdentity, applyCloudRuntimeIdentityAssertion, resetCloudRuntimeIdentityForTests } from "../services/cloud-runtime-identity.js";
import * as connectorModule from "../services/paperclip-cloud-connector.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { startMcpClientMirrorSync } from "../services/public-mcp/client-mirror-sync.js";
import { mcpClientMirrorGeneration, mcpClientMirrorReceiptSchema, type McpClientMirrorRequest } from "../services/public-mcp/client-mirror-contract.js";
import { readIdleMcpWakeProof } from "../services/public-mcp/idle-wake-proof.js";
import { museContactPageDigest, type MuseContactPage } from "../modules/external-agents/muse-hosted-contract.js";
import { importMuseContactPage } from "../modules/external-agents/muse-hosted-contact-import.js";
import { syncMuseContactCustody } from "../modules/external-agents/muse-hosted-sync.js";
import { readMuseReceiverProjection } from "../modules/external-agents/muse-hosted-projection.js";
import { readIdleMuseReceiverProof, idleMuseWorkQuery } from "../modules/external-agents/idle-muse-receiver-proof.js";

const configured=resolveExternalTestDatabaseUrl("PAPERCLIP_MUSE_HOSTED_RETIREMENT_TEST_DATABASE_URL");
const origin="https://muse-retirement.example.test",instanceId="muse-retirement-instance",stackId="muse-retirement-stack";
const namespace={stackId,instanceId,origin};
// This real-PG owner regression has an explicit external fixture gate. Normal tests do not discover a cluster or require Cloud outputs.
describe.skipIf(!configured)("hosted Muse retirement ownership",()=>{
  let db:ReturnType<typeof createDb>,home:string;
  let coordinator:ReturnType<typeof createDeliveryWorkCoordinator>|undefined;
  const seededCompanies:string[]=[],users:string[]=[];
  beforeAll(async()=>{await applyPendingMigrations(configured!);db=createDb(configured!,{maxConnections:2});},30_000);
  beforeEach(async()=>{
    home=await mkdtemp(path.join(tmpdir(),"muse-retirement-"));vi.stubEnv("PAPERCLIP_HOME",home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));
    await instanceSettingsService(db).updateExperimental({enableMuse:true,enableNativeRunner:true});
    seededCompanies.length=0;users.length=0;
  });
  afterEach(async context=>{
    try{await coordinator?.stop();coordinator=undefined;await museReceiver(db).stop();}
    finally{
      vi.restoreAllMocks();resetCloudRuntimeIdentityForTests();
      try{
        await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey,"cloud-runtime-identity/v1"));
        if(!context.task.result?.errors?.length){
          for(const id of seededCompanies)await deleteFixtureCompany(id);
          for(const id of users)await db.delete(authUsers).where(eq(authUsers.id,id));
          await rm(home,{recursive:true,force:true});
        }
      }finally{vi.unstubAllEnvs();}
    }
  });
  afterAll(async()=>{await db?.$client.end({timeout:1});});
  // Only rows created by this controlled fixture; failed cases retain their rows.
  async function deleteFixtureCompany(companyId:string){
    await db.delete(activityLog).where(eq(activityLog.companyId,companyId));
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId,companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId,companyId));
    await db.delete(agents).where(eq(agents.companyId,companyId));
    await db.delete(companies).where(eq(companies.id,companyId));
  }
  async function fixture(oauth=false){
    const operatorId=randomUUID();users.push(operatorId);
    await db.insert(authUsers).values({id:operatorId,name:"Retirement operator",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [company]=await db.insert(companies).values({name:"Muse retirement",issuePrefix:"MR"+operatorId.replaceAll("-","")}).returning();seededCompanies.push(company.id);
    const [agent]=await db.insert(agents).values({companyId:company.id,name:"Muse",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"muse",allowUnmeteredProvider:true,lifecycle:"per_turn"}}).returning();
    await db.insert(companyMemberships).values([{companyId:company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"},{companyId:company.id,principalType:"agent",principalId:agent.id,membershipRole:"member",status:"active"}]);
    const ticket=randomBytes(32).toString("base64url"),[binding]=await db.insert(bindings).values({companyId:company.id,agentId:agent.id,operatorId,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+600_000)}).returning();
    await db.update(agents).set({adapterConfig:{...agent.adapterConfig,museBindingId:binding.id}}).where(eq(agents.id,agent.id));
    const identity=museIdentity(db);
    if(oauth){
      const auth=museOAuth(db,origin),callback="https://authd.example/callback";
      const client=await auth.register({client_name:"Muse retirement authd",redirect_uris:[callback],token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"]},randomUUID());
      const verifier=randomBytes(32).toString("base64url"),location=await auth.authorize({client_id:client.client_id,redirect_uri:callback,response_type:"code",scope:"paperclip:agent offline_access",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",pairing_ticket:ticket});
      await auth.token({grant_type:"authorization_code",client_id:client.client_id,redirect_uri:callback,code:new URL(location).searchParams.get("code")!,code_verifier:verifier});
      await db.update(bindings).set({status:"ready",receiverContactAt:new Date(),verifiedReplyAt:new Date()}).where(eq(bindings.id,binding.id));
    }else await identity.pair(ticket,"2");
    const broker=museRunnerBroker(db,{publicOrigin:origin,heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun:vi.fn()}});
    return {operatorId,company,agent,binding,broker};
  }
  function pageFor(rows:Array<Awaited<ReturnType<typeof fixture>>>):MuseContactPage{
    const now=Date.now();const unsigned={version:1 as const,namespace,recipientNamespace:namespace,sourceId:randomUUID(),after:0,through:rows.length,
      entries:rows.map((f,index)=>({sequence:index+1,bucket:{id:randomUUID(),bindingId:f.binding.id,companyId:f.company.id,generation:f.binding.generation,bucketAt:Math.floor(now/30_000)*30_000,firstAt:now,lastAt:now,contacts:1,gapsAtMostSevenSeconds:0,maxGapMs:0,timestamps:[now],incomplete:false}}))};
    return {...unsigned,digest:museContactPageDigest(unsigned)};
  }
  function emptyAfter(page:MuseContactPage){const {digest:_,...previous}=page;const unsigned={...previous,after:page.through,through:page.through,entries:[]};return {...unsigned,digest:museContactPageDigest(unsigned)};}
  async function managedIdentity(){
    const signing=generateKeyPairSync("ed25519"),kid="muse-retirement-control",issued=Math.floor(Date.now()/1000);
    const env={...process.env,PAPERCLIP_CLOUD_STACK_ID:stackId,PAPERCLIP_PUBLIC_URL:origin,PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS:JSON.stringify({keys:[{...signing.publicKey.export({format:"jwk"}),kid,alg:"EdDSA",use:"sig"}]})};
    await initializeCloudRuntimeIdentity(db,env);
    const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");
    const body=encode({alg:"EdDSA",typ:"paperclip-cloud-runtime-identity+jwt",kid})+"."+encode({v:1,iss:"paperclip-cloud",aud:"paperclip-runtime-identity/v1",sub:stackId,claimId:randomUUID(),previousOrigin:origin,canonicalOrigin:origin,stackSlug:"muse-retirement",iat:issued,exp:issued+60});
    await applyCloudRuntimeIdentityAssertion({db,env,compactJws:body+"."+sign(null,Buffer.from(body),signing.privateKey).toString("base64url")});
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID",instanceId);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",generateKeyPairSync("ed25519").privateKey.export({format:"pem",type:"pkcs8"}).toString());
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",generateKeyPairSync("x25519").privateKey.export({format:"pem",type:"pkcs8"}).toString());
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT","test");vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL","https://cloud-retirement.example.test");
  }
  it("retires deleted company and agent contact custody through exact ACK loss and mirror-owner reconstruction",async()=>{
    const deletedCompany=await fixture(),deletedAgent=await fixture(),page=pageFor([deletedCompany,deletedAgent]);
    // Controlled retained state uses the real FK dependency order, not the normal UI/provider deletion lifecycle.
    await deleteFixtureCompany(deletedCompany.company.id);
    await db.delete(activityLog).where(eq(activityLog.agentId,deletedAgent.agent.id));
    await db.delete(agents).where(eq(agents.id,deletedAgent.agent.id));
    expect(await db.select().from(bindings)).toEqual([]);
    await managedIdentity();
    let remoteAckCommitted=false,ackAttempts=0,reads=0;
    const published:McpClientMirrorRequest[]=[],errors:unknown[]=[],verificationHints:string[]=[];
    const unsubscribe=subscribeDatabaseWork(db,DELIVERY_QUEUES.museMaintenance,(event,hints)=>{if(event==="intent")for(const hint of hints??[])if(hint.includes('"kind":"muse-contact-verification"'))verificationHints.push(hint);});
    onTestFailed(()=>console.error("MUSE_DELETED_OWNER_FRONTIER "+JSON.stringify({ackAttempts,remoteAckCommitted,reads,published:published.map(value=>value.operation),errors:errors.map(error=>error instanceof Error&&["Muse contact binding is unavailable","controlled reply loss AFTER exact ACK commit"].includes(error.message)?error.message:"unclassified")})));
    const realConnector=connectorModule.createPaperclipCloudConnector;
    vi.spyOn(connectorModule,"createPaperclipCloudConnector").mockImplementation(options=>({...realConnector(options),async syncMuseReceiverContacts(serialized:string){
      const input=JSON.parse(serialized);
      if(input.operation==="read"){reads++;return{page:remoteAckCommitted?emptyAfter(page):page,ownership:{state:"pending"}};}
      expect(input.operation).toBe("ack");expect(input.page).toEqual(page);ackAttempts++;
      remoteAckCommitted=true;throw new Error("controlled reply loss AFTER exact ACK commit");
    }}));
    const publish=async(value:McpClientMirrorRequest)=>{
      published.push(structuredClone(value));
      if(value.operation!=="complete")return{complete:false,nextSequence:0,receivedRecords:0,nextDeviceSequence:0,nextMuseSequence:0};
      const receipt={version:1 as const,instanceId:value.instanceId,origin:value.origin,revision:value.revision,enabled:true,
        ...(value.authorizationOrigin?{authorizationOrigin:value.authorizationOrigin}:{}),...(value.deviceStatus?{deviceStatus:value.deviceStatus}:{}),...(value.museReceivers?{museReceivers:value.museReceivers}:{}),generation:mcpClientMirrorGeneration({...value,enabled:true})};
      return{complete:true,receipt};
    };
    const start=()=>{coordinator=createDeliveryWorkCoordinator({owner:db,canRun:()=>true,onError:error=>errors.push(error)});return startMcpClientMirrorSync(db,coordinator,origin,{instanceId,publish}).worker;};
    try{
      await start().ready;
      await vi.waitFor(()=>expect(ackAttempts).toBe(1),{timeout:5000});
      expect(remoteAckCommitted).toBe(true);expect(published).toEqual([]);
      expect(errors).toHaveLength(1);expect(errors[0]).toBeInstanceOf(Error);expect(String(errors[0])).toContain("controlled reply loss AFTER exact ACK commit");
      await coordinator!.stop();coordinator=undefined;
      await start().ready;
      await vi.waitFor(async()=>{const [row]=await db.select().from(mirrorState).where(eq(mirrorState.id,"public"));const parsed=mcpClientMirrorReceiptSchema.safeParse(row?.receipt);expect(parsed.success).toBe(true);if(!parsed.success)throw new Error("current mirror receipt is not complete");expect(parsed.data.museReceivers?.count).toBe(0);expect(parsed.data.revision).toBe(row?.revision);},{timeout:5000});
      expect(published.some(value=>value.operation==="complete")).toBe(true);expect(published.filter(value=>value.operation==="append-muse-receivers")).toEqual([]);
      expect(ackAttempts).toBe(1);expect(reads).toBeGreaterThanOrEqual(2);
      expect(await db.select().from(buckets)).toEqual([]);expect(await db.select().from(bindings)).toEqual([]);expect(verificationHints).toEqual([]);
    }finally{unsubscribe();await coordinator?.stop();coordinator=undefined;}
  },30_000);
  it("refuses foreign future and malformed contacts without ACK and preserves immutable live contact evidence",async()=>{
    const f=await fixture(),other=await fixture(),page=pageFor([f]),before=(await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0];
    for(const fault of ["foreign","future","malformed"]as const){
      const changed=structuredClone(page);
      if(fault==="foreign")changed.entries[0]!.bucket.companyId=other.company.id;
      if(fault==="future")changed.entries[0]!.bucket.generation++;
      const {digest:_,...unsigned}=changed;changed.digest=fault==="malformed"?"0".repeat(64):museContactPageDigest(unsigned);
      let acks=0;
      await expect(syncMuseContactCustody(db,namespace,async serialized=>{const input=JSON.parse(serialized);if(input.operation==="ack")acks++;return{page:changed,ownership:{state:"pending"}};},new AbortController().signal)).rejects.toThrow();
      expect(acks).toBe(0);expect(await db.select().from(buckets)).toEqual([]);expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0]).toEqual(before);
    }
    await importMuseContactPage(db,namespace,page);const saved=await db.select().from(buckets);expect(saved).toHaveLength(1);
    await importMuseContactPage(db,namespace,page);expect(await db.select().from(buckets)).toEqual(saved);
    const changed=structuredClone(page);changed.entries[0]!.bucket.incomplete=true;const {digest:_,...unsigned}=changed;changed.digest=museContactPageDigest(unsigned);
    await expect(importMuseContactPage(db,namespace,changed)).rejects.toThrow("Muse contact chunk is not immutable");expect(await db.select().from(buckets)).toEqual(saved);
  },30_000);
  it("keeps a retired qualified OAuth receiver blocked until its detector removal is confirmed",async()=>{
    const f=await fixture(true);expect(await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id))).toEqual([]);
    await ensureHumanRoleDefaultGrants(db,{companyId:f.company.id,principalId:f.operatorId,membershipRole:"owner",grantedByUserId:f.operatorId});
    const qualificationId=randomUUID(),expiresAt=new Date(Date.now()+1500),[current]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));
    await f.broker.beginQualification({companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,generation:current.generation,expectedRevision:current.revision,qualificationId,expiresAt,operatorId:f.operatorId});
    await vi.waitFor(()=>expect(Date.now()).toBeGreaterThanOrEqual(expiresAt.getTime()),{timeout:5000,interval:25});
    await f.broker.endQualification({companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,qualificationId,operatorId:f.operatorId});
    const projection=await readMuseReceiverProjection(db,namespace,0,{enabled:true,contactImportWakeVersion:1});if(!projection.complete)throw new Error("retired receiver projection must be complete");
    expect(projection.records).toHaveLength(1);expect(projection.records[0]?.state).toBe("retired");
    const receipt=mcpClientMirrorReceiptSchema.parse({version:1,instanceId,origin,revision:0,enabled:true,museReceivers:projection.reference,generation:mcpClientMirrorGeneration({...namespace,revision:0,enabled:true,museReceivers:projection.reference})});
    const budget={beforeRead:async()=>{},check:()=>{}},proof=await readIdleMuseReceiverProof(db,{enabled:true,contactImportWakeVersion:1,namespace,receipt,now:Date.now(),budget});
    expect(proof.blocked).toBe(false);expect(proof.coveredBindings).toEqual([{id:f.binding.id,generation:f.binding.generation,grantId:current.grantId,retired:true}]);
    const ingress=await readIdleMcpWakeProof(db,{budget,clientMirror:receipt,stackId,ownerId:randomUUID(),capabilityGeneration:"a".repeat(64),challenge:"b".repeat(64),personalResource:origin+"/mcp/paperclip",dotResource:origin+"/mcp/runner",museResource:origin+"/api/muse/v1",personalEnabled:false,dotEnabled:false,museEnabled:true,now:Date.now()});
    const check=()=>{const query=idleMuseWorkQuery("muse_agent_bindings",proof,ingress);if(!query)throw new Error("current retired binding has no scoped idle history query");return db.execute(query);};
    expect(await check()).toHaveLength(1);
    const [revoked]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(revoked.detectorRemovedAt).toBeNull();
    const actor={type:"board" as const,userId:f.operatorId,source:"session" as const,ignoreInstanceAdmin:true};
    expect((await authorizationService(db).decide({actor,action:"agent_config:update",resource:{type:"agent",companyId:f.company.id,agentId:f.agent.id},scope:{requiresChangeGrant:true}})).allowed).toBe(true);
    await f.broker.attestDetectorCleanup(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:revoked.generation,expectedRevision:revoked.revision,qualificationId,hookScript:`~/hooks/scripts/paperclip-muse-${f.binding.id}.sh`,detectorRemoved:true,observation:{method:"hooks.list",includeDisabled:true,hookId:"paperclip-fixture-hook",outcome:"exact_hook_absent",observedAt:new Date().toISOString(),sha256:"d".repeat(64)}},actor);
    expect(await check()).toEqual([]);
    expect(await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id))).toEqual([]);
    // This proves only this binding-history obligation. Mailboxes, effects, holds, and instance-wide sleep retain their own checks.
  },30_000);
});
