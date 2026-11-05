import {createHash,randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Request} from "express";
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from "vitest";
import {eq,sql} from "drizzle-orm";
import {applyPendingMigrations,createDb,companies,authUsers,companyMemberships,mcpOauthClientMirrorState as state,mcpOauthClientChanges as changes,mcpOauthDeviceRequests as devices,mcpOauthGrants as grants} from "@paperclipai/db";
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
  it("refreshes old partial capability exactly once at owner startup and waits for the current ACK after an outage",async()=>{
    await device();await start();const old=await acknowledged();expect(old.receipt?.frontDoor).toBeUndefined();expect((await inspect()).blocked).toBe(true);
    remoteAvailable=true;failures=100;const worker=await start();const pending=(await current())!;
    expect(pending.revision).toBe(old.revision+1);expect(pending.receipt?.revision).toBe(old.revision);expect(pending.deviceCutoverAt).toBeNull();expect((await inspect()).blocked).toBe(true);
    failures=0;worker.wake();const next=await acknowledged();expect(next.revision).toBe(pending.revision);expect(next.receipt?.frontDoor).toBe("tenant-personal-v1");expect(next.deviceCutoverAt).toBeInstanceOf(Date);expect((await inspect()).blocked).toBe(false);
    expect(sent.filter(row=>row.operation==="append"&&row.revision===next.revision)).toEqual([]);expect(errors.length).toBeGreaterThanOrEqual(1);
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
    const inspectTokens=()=>readIdleMcpWakeProof(db,{stackId,ownerId:randomUUID(),capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),personalResource:origin+"/mcp/paperclip",dotResource:origin+"/mcp/runner",personalEnabled:true,dotEnabled:false,clientMirror:receipt,now:Date.now(),budget});
    const existing=await inspectTokens();expect(existing.grantIds).toContain(approved.grantId);expect(existing.admission.revocationAuthorities).toHaveLength(1);expect(existing.admission.lanes.length).toBeGreaterThan(0);
    expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(false);
    await expect(db.transaction(async tx=>{await deleteCompany(tx as unknown as typeof db,companyId);throw new Error("rollback company delete");})).rejects.toThrow("rollback company delete");
    expect((await current())?.revision).toBe(before.revision);expect((await db.select().from(devices))[0].id).toBe(approved.id);expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(false);
    await coordinator!.stop();coordinator=undefined;await deleteCompany(db,companyId);
    expect(await db.select().from(devices)).toEqual([]);expect(await db.select().from(grants)).toEqual([]);expect((await current())!.revision).toBeGreaterThan(before.revision);
    expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt,budget})).blocked).toBe(true);
    await start();const after=await acknowledged();expect(after.receipt?.deviceStatus?.count).toBe(0);expect(after.receipt?.deviceStatus?.generation).not.toBe(receipt.deviceStatus?.generation);
    const proof=await readIdleMcpWakeProof(db,{stackId,ownerId:randomUUID(),capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),personalResource:origin+"/mcp/paperclip",dotResource:origin+"/mcp/runner",personalEnabled:true,dotEnabled:false,clientMirror:after.receipt!,now:Date.now(),budget});
    expect(proof.grantIds).toEqual([]);expect(proof.admission.revocationAuthorities).toEqual([]);expect(await db.select().from(changes)).toEqual([]);
  },30_000);
  it("rotated local key invalidates old status and only the current bounded source publication restores it",async()=>{
    await device();remoteAvailable=true;await start();const before=await acknowledged();
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY",randomBytes(32).toString("base64"));expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt:before.receipt!,budget})).blocked).toBe(true);
    await start();const after=await acknowledged();expect(after.revision).toBe(before.revision+1);expect(after.receipt?.deviceStatus?.keyId).not.toBe(before.receipt?.deviceStatus?.keyId);expect((await readIdleMcpDeviceStatus(db,{enabled:true,receipt:after.receipt!,budget})).blocked).toBe(false);
  });
});
