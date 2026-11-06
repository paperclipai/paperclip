import {createHash,randomBytes,randomUUID} from "node:crypto";
import {appendFileSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Request} from "express";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {eq,sql} from "drizzle-orm";
import {applyPendingMigrations,createDb,companies,authUsers,companyMemberships,mcpOauthClients as clients,mcpOauthClientMirrorState as state,mcpOauthClientChanges as changes,mcpOauthDeviceRequests as devices,mcpOauthGrants as grants} from "@paperclipai/db";
import {resolveExternalTestDatabaseUrl} from "../../__tests__/helpers/external-test-database.js";
import {createDeliveryWorkCoordinator} from "../delivery-work-coordinator.js";
import {instanceSettingsService} from "../instance-settings.js";
import {deleteCompany} from "../company-deletion.js";
import {createPublicMcpOAuth,DEVICE_GRANT} from "./oauth.js";
import {startMcpRevocationIndexSync} from "./revocation-index-sync.js";
import {startMcpClientMirrorSync} from "./client-mirror-sync.js";
import {mcpClientMirrorGeneration,type McpClientMirrorRequest,type McpClientMirrorReceipt} from "./client-mirror-contract.js";
import {readIdleMcpClientMirror} from "./idle-client-mirror.js";
import {readIdleMcpDeviceStatus} from "./idle-device-status.js";
import {deriveLocalEncryptedInstanceSecret} from "../../secrets/local-encrypted-provider.js";
import {mcpDeviceStatusFingerprint} from "./device-status-contract.js";
import {readIdleMcpWakeProof} from "./idle-wake-proof.js";

const managed=vi.hoisted(()=>({identity:null as null|{stackId:string;canonicalOrigin:string}}));
vi.mock("../cloud-runtime-identity.js",async importOriginal=>({...await importOriginal<typeof import("../cloud-runtime-identity.js")>(),getCloudRuntimeIdentity:()=>managed.identity}));
const configured=resolveExternalTestDatabaseUrl("PAPERCLIP_MCP_SLEEP_TEST_DATABASE_URL"),origin="https://mirror.example.test",instanceId="mirror-instance",stackId="mirror-stack";
const budget={beforeRead:async()=>{},check:()=>{}};
describe.skipIf(!configured)("MCP mirror actual transaction lifecycle",()=>{
  let db:ReturnType<typeof createDb>,coordinator:ReturnType<typeof createDeliveryWorkCoordinator>|undefined;
  let home:string,companyId:string,userId:string,remoteAvailable:boolean,failures:number,ack:McpClientMirrorReceipt|undefined;
  const sent:McpClientMirrorRequest[]=[];
  const errors:unknown[]=[];
  let onAppend:(()=>Promise<void>)|undefined;
  beforeAll(async()=>{await applyPendingMigrations(configured!);db=createDb(configured!,{maxConnections:2});},90_000);
  beforeEach(async()=>{
    await db.execute(sql`TRUNCATE TABLE companies,mcp_oauth_clients,mcp_oauth_client_mirror_state,mcp_oauth_client_changes CASCADE`);
    companyId=randomUUID();userId=randomUUID();remoteAvailable=false;failures=0;ack=undefined;sent.length=0;errors.length=0;onAppend=undefined;
    home=await mkdtemp(path.join(tmpdir(),"mcp-mirror-lifecycle-"));vi.stubEnv("PAPERCLIP_HOME",home);
    managed.identity={stackId,canonicalOrigin:origin};vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));
    await db.insert(companies).values({id:companyId,name:"Mirror lifecycle",issuePrefix:"MIRROR"});
    await db.insert(authUsers).values({id:userId,name:"Mirror operator",email:`${userId}@example.test`,createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companyMemberships).values({companyId,principalId:userId,principalType:"user",membershipRole:"owner",status:"active"});
    await instanceSettingsService(db).updateExperimental({enablePublicMcp:true,enableOpenAiDot:false});
  });
  afterEach(async()=>{await coordinator?.stop();coordinator=undefined;managed.identity=null;await db.execute(sql`TRUNCATE TABLE companies,mcp_oauth_clients,mcp_oauth_client_mirror_state,mcp_oauth_client_changes CASCADE`);await db.delete(authUsers).where(eq(authUsers.id,userId));await rm(home,{recursive:true,force:true});vi.unstubAllEnvs();});
  afterAll(async()=>{await db?.$client.end({timeout:1});});
  async function publish(value:McpClientMirrorRequest){
    sent.push(structuredClone(value));if(value.operation==="append"&&onAppend){const append=onAppend;onAppend=undefined;await append();}if(failures>0){failures--;throw new Error("controlled mirror outage");}
    if(value.operation==="disable"||value.operation==="complete"){
      const enabled=value.operation!=="disable",frontDoor=enabled&&remoteAvailable&&value.deviceStatus&&(!value.authorizationOrigin||value.authorizationOrigin===value.origin)?"tenant-personal-v1" as const:undefined;
      ack={version:1,instanceId:value.instanceId,origin:value.origin,revision:value.revision,enabled,...(enabled&&value.deviceStatus?{deviceStatus:value.deviceStatus}:{}),...(enabled&&value.authorizationOrigin?{authorizationOrigin:value.authorizationOrigin}:{}),...(frontDoor?{frontDoor}:{}),generation:mcpClientMirrorGeneration({...value,enabled,frontDoor})};
      return{complete:true,receipt:ack};
    }
    return{complete:false,nextSequence:0,receivedRecords:0,nextDeviceSequence:0};
  }
  async function start(mirrorInstance=instanceId){
    await coordinator?.stop();coordinator=createDeliveryWorkCoordinator({owner:db,canRun:()=>true,onError:error=>errors.push(error)});
    const handle=startMcpClientMirrorSync(db,coordinator,origin,{instanceId:mirrorInstance,publish});await handle.worker.ready;return handle.worker;
  }
  const current=async()=>(await db.select().from(state).where(eq(state.id,"public")))[0];
  async function acknowledged(){await vi.waitFor(async()=>{const row=await current();expect(row).toBeDefined();expect(row?.receipt).toBeTruthy();expect(row?.receipt?.revision).toBe(row?.revision);},{timeout:10_000});return(await current())!;}
  const inspect=()=>readIdleMcpClientMirror(db,{budget,enabled:true,origin,instanceId,managedStackId:stackId});
  async function device(){
    const oauth=createPublicMcpOAuth(db,{origin,resource:origin+"/mcp/paperclip"});
    const client=await oauth.register({client_name:"Legacy device",redirect_uris:["https://client.example.test/callback"],grant_types:["authorization_code","refresh_token",DEVICE_GRANT],response_types:["code"],token_endpoint_auth_method:"none"});
    const authorization=await oauth.deviceAuthorize({client_id:client.client_id,resource:oauth.config.resource,scope:"paperclip:read offline_access"});
    return{oauth,client,authorization};
  }
  it("indexes a normally approved abandoned authorization code after an empty index startup",async()=>{
    const oauth=createPublicMcpOAuth(db,{origin,resource:origin+"/mcp/paperclip"});
    const client=await oauth.register({client_name:"Abandoned approved client",redirect_uris:["https://client.example.test/callback"],grant_types:["authorization_code"]});
    await start();
    const published:string[]=[];
    const index=startMcpRevocationIndexSync(db,coordinator!,{key:Buffer.alloc(32,9).toString("base64url"),client:{publish:async value=>{
      if(value.operation==="complete"){published.push(value.authorityId);return{complete:true,receipt:{version:1,authorityId:value.authorityId,keyId:value.keyId,revision:value.revision,generation:createHash("sha256").update(value.authorityId).digest("hex")}};}
      return{complete:false,baseRevision:-1};
    }}});await index.ready;expect(published).toEqual([]);
    const verifier="v".repeat(43),location=await oauth.authorize({response_type:"code",client_id:client.client_id,redirect_uri:"https://client.example.test/callback",resource:oauth.config.resource,scope:"paperclip:read",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
    const actor:Request["actor"]={type:"board",source:"session",userId,companyIds:[companyId]};
    const approved=await oauth.consent(new URL(location).pathname.split("/").at(-1)!,actor,{decision:"approve",companyId,allowWrites:false});
    expect(new URL(approved.redirectUrl).searchParams.get("code")).toBeTruthy();
    await vi.waitFor(async()=>{const [grant]=await db.select().from(grants);expect(grant.revocationIndexReceipt?.revision).toBe(0);},{timeout:10_000});
    expect(published).toHaveLength(1);expect(await db.select().from(grants)).toHaveLength(1);
  });
  it("refreshes old partial capability exactly once at owner startup and waits for the current ACK after an outage",async()=>{
    await device();const [originalClient]=await db.select().from(clients),[originalDevice]=await db.select().from(devices);
    await start();const old=await acknowledged();expect(old.receipt?.frontDoor).toBeUndefined();expect((await inspect()).blocked).toBe(true);
    const outageStart=sent.length;
    remoteAvailable=true;failures=100;const worker=await start();const pending=(await current())!;
    expect(pending.revision).toBe(old.revision+1);expect(pending.receipt?.revision).toBe(old.revision);expect(pending.deviceCutoverAt).toBeNull();expect((await inspect()).blocked).toBe(true);
    expect(sent.slice(outageStart).map(value=>({operation:value.operation,revision:value.revision}))).toEqual([{operation:"begin",revision:pending.revision}]);
    const recoveryStart=sent.length;
    failures=0;worker.wake();const next=await acknowledged();expect(next.revision).toBe(pending.revision+1);expect(next.receipt?.revision).toBe(next.revision);expect(next.receipt?.frontDoor).toBe("tenant-personal-v1");expect(next.deviceCutoverAt).toBeInstanceOf(Date);expect((await inspect()).blocked).toBe(false);
    const recovery=sent.slice(recoveryStart);
    expect(recovery.map(value=>value.operation)).toEqual(["begin","append","append-device-status","complete"]);
    for(const value of recovery){expect(value.revision).toBe(pending.revision+1);expect(value.baseRevision).toBeNull();expect(value.expectedRecords).toBe(1);expect(value.instanceId).toBe(instanceId);expect(value.origin).toBe(origin);}
    const clientPage=recovery.find(value=>value.operation==="append"),devicePage=recovery.find(value=>value.operation==="append-device-status");
    expect(clientPage).toMatchObject({operation:"append",sequence:0,changes:[{operation:"upsert",client:{id:originalClient.id,name:originalClient.name,redirectUris:originalClient.redirectUris,grantTypes:originalClient.grantTypes}}]});
    if(clientPage?.operation!=="append"||devicePage?.operation!=="append-device-status")throw new Error("Missing full mirror recovery pages");
    expect(clientPage.changes).toEqual([{operation:"upsert",client:{id:originalClient.id,name:originalClient.name,redirectUris:originalClient.redirectUris,grantTypes:originalClient.grantTypes}}]);
    const key=deriveLocalEncryptedInstanceSecret(`mcp-device-status:v1:${instanceId}`);
    expect(devicePage.sequence).toBe(0);expect(devicePage.entries).toEqual([{requestId:originalDevice.id,clientId:originalDevice.clientId,resource:originalDevice.resource,ingressOwner:originalDevice.ingressOwner,status:originalDevice.status,expiresAt:originalDevice.expiresAt.getTime(),fingerprint:mcpDeviceStatusFingerprint(key,originalDevice.deviceCodeHash,originalDevice.clientId,originalDevice.resource)}]);
    expect((await db.select().from(devices))[0].expiresAt).toEqual(originalDevice.expiresAt);expect(await db.select().from(changes)).toEqual([]);expect(errors.length).toBeGreaterThanOrEqual(1);
  });
  it("a normal client mutation supersedes an in-flight page without acknowledging or logging the old revision",async()=>{
    const oauth=createPublicMcpOAuth(db,{origin,resource:origin+"/mcp/paperclip"});
    const register=(name:string)=>oauth.register({client_name:name,redirect_uris:["https://client.example.test/callback"],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"});
    await register("First client");remoteAvailable=true;let superseded:number|undefined;
    onAppend=async()=>{superseded=(await current())!.revision;await register("Concurrent client");};
    await start();expect(superseded).toBeDefined();expect((await inspect()).blocked).toBe(true);
    expect((await current())?.receipt).toBeNull();expect((await current())?.deviceCutoverAt).toBeNull();
    expect(sent.some(value=>value.operation==="complete"&&value.revision===superseded)).toBe(false);expect(errors).toEqual([]);
    const ready=await acknowledged();expect(ready.revision).toBeGreaterThan(superseded!);expect(ready.receipt?.revision).toBe(ready.revision);expect(ready.deviceCutoverAt).toBeTruthy();
    expect((await inspect()).blocked).toBe(false);expect(errors).toEqual([]);expect(await db.select().from(changes)).toEqual([]);
  });
  it("factory loss, disable and re-enable preserve cutover and demand a new source ACK without resetting legacy expiry",async()=>{
    await device();remoteAvailable=true;await start();const ready=await acknowledged(),expiry=(await db.select().from(devices))[0].expiresAt;
    remoteAvailable=false;await start();const unavailable=await acknowledged();expect(unavailable.revision).toBe(ready.revision+1);expect(unavailable.receipt?.frontDoor).toBeUndefined();expect((await inspect()).blocked).toBe(true);
    expect(unavailable.deviceCutoverAt).toEqual(ready.deviceCutoverAt);expect((await db.select().from(devices))[0].expiresAt).toEqual(expiry);
    await instanceSettingsService(db).updateExperimental({enablePublicMcp:false});await vi.waitFor(async()=>expect((await current())?.remoteResponsibility).toBe(false));
    const disabled=await current();expect(disabled?.receipt?.enabled).toBe(false);
    remoteAvailable=true;await instanceSettingsService(db).updateExperimental({enablePublicMcp:true});const enabled=await acknowledged();
    expect(enabled.revision).toBeGreaterThan(disabled!.revision);expect(enabled.receipt?.enabled).toBe(true);expect(enabled.receipt?.frontDoor).toBe("tenant-personal-v1");expect(enabled.deviceCutoverAt).toEqual(ready.deviceCutoverAt);
    failures=100;const replacement=await start("replacement-instance");
    expect((await readIdleMcpClientMirror(db,{budget,enabled:true,origin,instanceId:"replacement-instance",managedStackId:stackId})).blocked).toBe(true);
    expect((await current())!.receipt?.instanceId).toBe(instanceId);failures=0;replacement.wake();const replaced=await acknowledged();expect(replaced.receipt?.instanceId).toBe("replacement-instance");expect(replaced.deviceCutoverAt).toEqual(ready.deviceCutoverAt);
    const before=sent.length;managed.identity=null;await start();expect(sent).toHaveLength(before);
  });
  it("actual company deletion rolls back mirror intent and invalidates source status and token proof on commit",async()=>{
    const f=await device();const actor:Request["actor"]={type:"board",source:"session",userId,companyIds:[companyId]};
    await f.oauth.consentDevice(f.authorization.user_code,actor,{decision:"approve",companyId,allowWrites:false});
    const approved=(await db.select().from(devices))[0];expect(approved.grantId).toBeTruthy();
    await new Promise(resolve=>setTimeout(resolve,5001));
    const tokens=await f.oauth.token({grant_type:DEVICE_GRANT,client_id:f.client.client_id,resource:f.oauth.config.resource,device_code:f.authorization.device_code});expect(tokens.access_token).toMatch(/^pcmcp_at_/);
    remoteAvailable=true;await start();
    await startMcpRevocationIndexSync(db,coordinator!,{key:Buffer.alloc(32,9).toString("base64url"),client:{publish:async value=>value.operation==="complete"?{complete:true,receipt:{version:1,authorityId:value.authorityId,keyId:value.keyId,revision:value.revision,generation:createHash("sha256").update(`${value.authorityId}:${value.revision}`).digest("hex")}}:{complete:false,baseRevision:-1}}}).ready;
    const before=await acknowledged(),receipt=before.receipt!;
    await coordinator!.stop();coordinator=undefined;
    const proofOwnerId=randomUUID(),proofNow=Date.now();
    const inspectTokens=()=>readIdleMcpWakeProof(db,{stackId,ownerId:proofOwnerId,capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),personalResource:origin+"/mcp/paperclip",dotResource:origin+"/mcp/runner",personalEnabled:true,dotEnabled:false,clientMirror:receipt,now:proofNow,budget});
    const existing=await inspectTokens();expect(existing.grantIds).toContain(approved.grantId);expect(existing.admission.revocationAuthorities).toHaveLength(1);expect(existing.admission.lanes.length).toBeGreaterThan(0);
    expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(false);
    const retained={company:await db.select().from(companies).where(eq(companies.id,companyId)),clients:await db.select().from(clients),devices:await db.select().from(devices),grants:await db.select().from(grants),changes:await db.select().from(changes),state:await current(),status:await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})};
    const suffix=randomUUID().replaceAll("-",""),barrier=`mcp_delete_barrier_${suffix}`,constraint=`mcp_delete_fk_${suffix}`;
    await db.execute(sql`CREATE TABLE ${sql.identifier(barrier)} (company_id uuid NOT NULL, CONSTRAINT ${sql.identifier(constraint)} FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT)`);
    try{
      await db.execute(sql`INSERT INTO ${sql.identifier(barrier)} (company_id) VALUES (${companyId})`);
      await expect(deleteCompany(db,companyId)).rejects.toMatchObject({cause:{code:"23503",constraint_name:constraint}});
      expect(await db.select().from(companies).where(eq(companies.id,companyId))).toEqual(retained.company);expect(await db.select().from(clients)).toEqual(retained.clients);expect(await db.select().from(devices)).toEqual(retained.devices);expect(await db.select().from(grants)).toEqual(retained.grants);expect(await db.select().from(changes)).toEqual(retained.changes);expect(await current()).toEqual(retained.state);
      expect(await inspectTokens()).toEqual(existing);expect(await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).toEqual(retained.status);
      expect((await current())?.revision).toBe(before.revision);expect((await db.select().from(devices))[0].id).toBe(approved.id);expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(false);
    }finally{await db.execute(sql`DROP TABLE ${sql.identifier(barrier)}`);}
    await deleteCompany(db,companyId);
    expect(await db.select().from(devices)).toEqual([]);expect(await db.select().from(grants)).toEqual([]);expect((await current())!.revision).toBeGreaterThan(before.revision);
    expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(true);
    await start();const after=await acknowledged();expect(after.receipt?.deviceStatus?.count).toBe(0);expect(after.receipt?.deviceStatus?.generation).not.toBe(receipt.deviceStatus?.generation);
    const proof=await readIdleMcpWakeProof(db,{stackId,ownerId:randomUUID(),capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),personalResource:origin+"/mcp/paperclip",dotResource:origin+"/mcp/runner",personalEnabled:true,dotEnabled:false,clientMirror:after.receipt!,now:Date.now(),budget});
    expect(proof.grantIds).toEqual([]);expect(proof.admission.revocationAuthorities).toEqual([]);expect(await db.select().from(changes)).toEqual([]);
  },30_000);
  it("rotated local key invalidates old status and only the current bounded source publication restores it",async()=>{
    const packetStart=sent.length;
    let beforeRevision:number|undefined,afterRevision:number|undefined;
    try{
      await device();remoteAvailable=true;await start();const before=await acknowledged();beforeRevision=before.revision;
      // Replace the key context only after the previous publication owner has joined.
      await coordinator!.stop();coordinator=undefined;
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt:before.receipt!,budget})).blocked).toBe(true);
      await start();const after=await acknowledged();afterRevision=after.revision;expect(after.revision).toBe(before.revision+1);expect(after.receipt?.deviceStatus?.keyId).not.toBe(before.receipt?.deviceStatus?.keyId);expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt:after.receipt!,budget})).blocked).toBe(false);
    }finally{
      const category=(error:unknown)=>{
        if(!(error instanceof Error))return "non-error";
        if(error.message==="MCP client mirror changed during publication")return "publication-changed";
        if(error.message==="MCP client mirror was not acknowledged")return "ack-invalid";
        if(error.message==="MCP client mirror ACK generation changed")return "ack-generation-changed";
        if(error.message==="MCP client mirror ACK revision regressed")return "ack-revision-regressed";
        if(error.message==="MCP client mirror ACK base changed")return "ack-base-changed";
        if(error.message==="MCP client mirror ACK issuer changed")return "ack-issuer-changed";
        if(error.message==="MCP client mirror current authority changed")return "authority-changed";
        return error.name==="ZodError"?"schema-invalid":"other-error";
      };
      const diagnosticPath=process.env.PAPERCLIP_MCP_KEY_DIAGNOSTIC_PATH;
      if(diagnosticPath){
        try{
          const cache=process.env.XDG_CACHE_HOME;
          if(!cache||!path.isAbsolute(cache)||!path.isAbsolute(diagnosticPath)||diagnosticPath!==path.join(path.dirname(cache),"key-rotation-diagnostic.jsonl"))throw new Error("Invalid owned key diagnostic path");
          appendFileSync(diagnosticPath,JSON.stringify({event:"mcp-key-rotation-ram-diagnostic",beforeRevision:beforeRevision??null,afterRevision:afterRevision??null,packets:sent.slice(packetStart).map(value=>({operation:value.operation,revision:value.revision,baseRevision:value.baseRevision,expectedRecords:value.expectedRecords,recordCount:value.operation==="append"?value.changes.length:value.operation==="append-device-status"?value.entries.length:null})),errorCategories:errors.map(category)})+"\n",{encoding:"utf8",mode:0o600});
        }catch{process.stderr.write("MCP key diagnostic artifact write failed\n");}
      }
    }
  });
});
