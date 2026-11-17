import {beforeEach,describe,it,expect,vi} from "vitest";
import {mcpOauthClients,type Db} from "@paperclipai/db";
import express from "express";
import {createServer} from "node:http";
import request from "supertest";
import {HttpError} from "../../errors.js";
import {createPublicMcpOAuth,DEVICE_GRANT} from "./oauth.js";
import {publicMcpIngressRoutes} from "../../routes/public-mcp.js";
const current=vi.hoisted(()=>({identity:null as null|{stackId:string;canonicalOrigin:string},connector:null as null|{instanceId:string}}));
vi.mock("../paperclip-cloud-connector.js",()=>({paperclipCloudConnectorConfigFromEnv:()=>current.connector}));
vi.mock("../cloud-runtime-identity.js",()=>({getCloudRuntimeIdentity:()=>current.identity}));
vi.mock("../delivery-work-notifications.js",async importOriginal=>({...await importOriginal<typeof import("../delivery-work-notifications.js")>(),notifyDeliveryWork:vi.fn(async()=>{})}));
import {mcpClientMirrorGeneration} from "./client-mirror-contract.js";
import {requiresMcpDeviceBroker,currentMcpDeviceCutoverStack,installMcpDeviceCutover,assertDotDeviceProfileAck} from "./device-cutover.js";

vi.mock("../instance-settings.js",async importOriginal=>({...await importOriginal<typeof import("../instance-settings.js")>(),instanceSettingsService:()=>({getExperimental:async()=>({enablePublicMcp:true,enableOpenAiDot:true})})}));
// This isolated HTTP/error-boundary control supplies a verified mint-context port;
// real signature/enrollment/SQL/ACK transport are exercised by the paired PG case.
vi.mock("./device-mint-authority.js",()=>({
  verifyMcpDeviceMintContext:()=>({resource:"https://tenant.example.test/mcp/runner",stackId:"stack",instanceId:"instance",expiresAt:Date.now()+60_000}),
  consumeMcpDeviceMintContext:(value:unknown)=>value,
  assertCurrentMcpDeviceMint:()=>{},
}));
const resource="https://tenant.example.test/mcp/paperclip";
const identity={version:1 as const,instanceId:"instance",origin:"https://tenant.example.test",revision:1};
const receipt={...identity,enabled:true,frontDoor:"tenant-personal-v1" as const,deviceStatus:{keyId:"a".repeat(64),generation:"b".repeat(64),count:0},generation:""};receipt.generation=mcpClientMirrorGeneration(receipt);
function fixture(row:unknown){let reads=0;const tx={select:()=>{reads++;return{from:()=>({where:async()=>row?[row]:[]})};}} as unknown as Pick<Db,"select">;return{tx,reads:()=>reads};}
describe("one-time managed device cutover",()=>{
  beforeEach(()=>{current.identity=null;current.connector=null;});
  it("persisted managed cutover is inert after legitimate selfhost/no-Cloud startup",async()=>{
    const f=fixture({stackId:"old-stack",at:new Date(1)});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(false);expect(f.reads()).toBe(0);
  });
  it("current verified managed identity gates raw mint and keeps original cutover after restart/re-enable",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:"https://tenant.example.test"};const at=new Date(1),f=fixture({stackId:"stack",at,receipt});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(true);expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(true);expect(at.getTime()).toBe(1);
    expect(currentMcpDeviceCutoverStack(resource)).toBe("stack");
  });
  it("same-stack cutover keeps unsigned mint fenced while re-enable has cleared its receipt",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};const at=new Date(1),f=fixture({stackId:"stack",at,receipt:null});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(true);expect(at.getTime()).toBe(1);
    expect(await requiresMcpDeviceBroker(f.tx,identity.origin+"/mcp/runner")).toBe(false);
  });
  it("a missing receipt cannot transfer the cutover fence across current stack or inspection identity",async()=>{
    current.identity={stackId:"replacement",canonicalOrigin:identity.origin};
    expect(await requiresMcpDeviceBroker(fixture({stackId:"stack",at:new Date(1),receipt:null}).tx,resource)).toBe(false);
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};
    const tx={select:()=>({from:()=>({where:async()=>{current.identity=null;return[{stackId:"stack",at:new Date(1),receipt:null}];}})})} as unknown as Pick<Db,"select">;
    expect(await requiresMcpDeviceBroker(tx,resource)).toBe(false);
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};
    expect(await requiresMcpDeviceBroker(fixture({stackId:"stack",at:new Date(1),receipt:{}}).tx,resource)).toBe(false);
  });
  it("a replacement current managed stack cannot inherit old persisted cutover authority",async()=>{
    current.identity={stackId:"replacement-stack",canonicalOrigin:"https://tenant.example.test"};
    expect(await requiresMcpDeviceBroker(fixture({stackId:"old-stack",at:new Date(1),receipt}).tx,resource)).toBe(false);
    expect(currentMcpDeviceCutoverStack(resource)).toBe("replacement-stack");
  });
  it("never-cut-over and other resource/origin paths preserve their original owner",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:"https://tenant.example.test"};const f=fixture({stackId:null,at:null});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(false);
    expect(await requiresMcpDeviceBroker(f.tx,"https://tenant.example.test/mcp/runner")).toBe(false);
    expect(await requiresMcpDeviceBroker(f.tx,"https://old.example.test/mcp/paperclip")).toBe(false);expect(f.reads()).toBe(1);
  });
  it("same-stack origin replacement and identity rotation during inspection cannot inherit cutover",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:"https://replacement.example.test"};
    expect(await requiresMcpDeviceBroker(fixture({stackId:"stack",at:new Date(1),receipt}).tx,"https://replacement.example.test/mcp/paperclip")).toBe(false);
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};
    const tx={select:()=>({from:()=>({where:async()=>{current.identity={stackId:"replacement",canonicalOrigin:identity.origin};return[{stackId:"stack",at:new Date(1),receipt}];}})})} as unknown as Pick<Db,"select">;
    expect(await requiresMcpDeviceBroker(tx,resource)).toBe(false);
  });

  it("only an acknowledged current namespace refreshes cutover owner while retaining original time",async()=>{
    current.identity={stackId:"replacement",canonicalOrigin:identity.origin};const at=new Date(1),updates:unknown[]=[];
    const tx={select:()=>({from:()=>({where:()=>({for:async()=>[{revision:1,deviceCutoverStackId:"old-stack",deviceCutoverAt:at}]})})}),update:()=>({set:(value:unknown)=>{updates.push(value);return{where:async()=>[]};}})} as unknown as Db;
    await installMcpDeviceCutover(tx,receipt);expect(updates).toEqual([{deviceCutoverStackId:"replacement",deviceCutoverAt:at}]);
    updates.length=0;await installMcpDeviceCutover(tx,{...receipt,generation:"0".repeat(64)});expect(updates).toEqual([]);
    await installMcpDeviceCutover(tx,{...receipt,origin:"https://foreign.example.test"});expect(updates).toEqual([]);
  });

});


describe("full hosted Dot namespace mint latch", () => {
  beforeEach(() => { current.identity = { stackId: "stack", canonicalOrigin: identity.origin }; current.connector = { instanceId: identity.instanceId }; });
  const dotResource = identity.origin + "/mcp/runner";
  const latch = { version: 1 as const, profile: "hosted-dot-v1" as const, stackId: "stack", instanceId: identity.instanceId, origin: identity.origin };
  it("an enabled existing namespace without a completed Dot ACK never acquires a mint fence", async () => {
    expect(await requiresMcpDeviceBroker(fixture({ latch: null, receipt }).tx, dotResource)).toBe(false);
    expect(await requiresMcpDeviceBroker(fixture({ latch: { ...latch, profile: "code-device-v1" }, receipt }).tx, dotResource)).toBe(false);
  });
  it("same acknowledged namespace retains the fence through receipt clear and owner reconstruction", async () => {
    const f = fixture({ latch, receipt: null });
    expect(await requiresMcpDeviceBroker(f.tx, dotResource)).toBe(true);
    current.connector = { instanceId: identity.instanceId };
    expect(await requiresMcpDeviceBroker(f.tx, dotResource)).toBe(true);
    current.connector = { instanceId: "replacement-instance" };
    expect(await requiresMcpDeviceBroker(f.tx, dotResource)).toBe(false);
    current.connector = { instanceId: identity.instanceId }; current.identity = { stackId: "replacement-stack", canonicalOrigin: identity.origin };
    expect(await requiresMcpDeviceBroker(f.tx, dotResource)).toBe(false);
  });
  it("only the exact full ACK at the current revision installs the latch in its committing transaction", async () => {
    const full = { ...receipt, dotProfile: "hosted-dot-v1" as const, generation: "" }; full.generation = mcpClientMirrorGeneration(full);
    const updates: Array<Record<string, unknown>> = [];
    let revision = 1;
    const tx = { select: () => ({ from: () => ({ where: () => ({ for: async () => [{ revision, deviceCutoverStackId: "stack", deviceCutoverAt: new Date(1), dotDeviceCutover: null }] }) }) }),
      update: () => ({ set: (value: Record<string, unknown>) => { updates.push(value); return { where: async () => [] }; } }) } as unknown as Db;
    await installMcpDeviceCutover(tx, full);
    expect(updates).toEqual([{ dotDeviceCutover: latch }]);
    updates.length = 0; revision = 2; await installMcpDeviceCutover(tx, full); expect(updates).toEqual([]);
    revision = 1; await installMcpDeviceCutover(tx, { ...full, instanceId: "foreign" }); expect(updates).toEqual([]);
    await installMcpDeviceCutover(tx, receipt); expect(updates).toEqual([]);
  });
});


describe("normal signed Dot mint admission", () => {
  it("requires current full receipt plus latch and rejects receipt-clear or revision/instance replacement", async () => {
    current.identity = { stackId: "stack", canonicalOrigin: identity.origin }; current.connector = { instanceId: identity.instanceId };
    const full = { ...receipt, dotProfile: "hosted-dot-v1" as const, generation: "" }; full.generation = mcpClientMirrorGeneration(full);
    const row = { revision: 1, enabled: true, remoteResponsibility: true, receipt: full,
      dotDeviceCutover: { version: 1, profile: "hosted-dot-v1", stackId: "stack", instanceId: identity.instanceId, origin: identity.origin } };
    await expect(assertDotDeviceProfileAck(fixture(row).tx, identity.origin + "/mcp/runner", identity.instanceId)).resolves.toBeUndefined();
    for (const change of [{ receipt: null }, { revision: 2 }, { dotDeviceCutover: null }, { enabled: false }, { remoteResponsibility: false }]) {
      await expect(assertDotDeviceProfileAck(fixture({ ...row, ...change }).tx, identity.origin + "/mcp/runner", identity.instanceId)).rejects.toMatchObject({ status: 503 });
    }
    await expect(assertDotDeviceProfileAck(fixture(row).tx, identity.origin + "/mcp/runner", "replacement")).rejects.toMatchObject({ status: 503 });
  });
});


describe("normal OAuth HTTP classification of Dot ACK admission",()=>{
  async function mintOverOwnedLoopback(oauth:ReturnType<typeof createPublicMcpOAuth>){
    const app=express();app.use(express.json());app.use(publicMcpIngressRoutes(oauth,vi.fn()));
    const server=createServer(app);
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
    try{return await request(server).post("/mcp/runner/oauth/device_authorization").send({client_id:"pcmcp_client_known",resource:oauth.config.resource,scope:"paperclip:agent"});}
    finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  }

  it("returns standard temporarily_unavailable for actual stale-ACK denial before any mint write",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};current.connector={instanceId:identity.instanceId};
    const full={...receipt,dotProfile:"hosted-dot-v1" as const,generation:""};full.generation=mcpClientMirrorGeneration(full);
    const row={revision:2,enabled:true,remoteResponsibility:true,receipt:full,
      dotDeviceCutover:{version:1,profile:"hosted-dot-v1",stackId:"stack",instanceId:identity.instanceId,origin:identity.origin}};
    let ackReads=0,writes=0;
    const tx={execute:async()=>{},select:()=>({from:()=>({where:async()=>{ackReads++;return[row];}})}),
      insert:()=>{writes++;throw new Error("Unexpected mint insert");},update:()=>{writes++;throw new Error("Unexpected mint update");},delete:()=>{writes++;throw new Error("Unexpected mint delete");}};
    const db={select:()=>({from:(table:unknown)=>({where:async()=>{if(table!==mcpOauthClients)throw new Error("Unexpected OAuth lookup");return[{id:"pcmcp_client_known",grantTypes:[DEVICE_GRANT],redirectUris:[],name:"Known device client"}];}})}),
      transaction:async(work:(value:typeof tx)=>Promise<unknown>)=>work(tx)} as unknown as Db;
    const oauth=createPublicMcpOAuth(db,{origin:identity.origin,resource:identity.origin+"/mcp/runner"});
    const response=await mintOverOwnedLoopback(oauth);
    expect(ackReads).toBe(1);expect(writes).toBe(0);
    expect(response.status).toBe(503);expect(response.body).toEqual({error:"temporarily_unavailable",error_description:"The hosted Dot connection is being reconciled."});
  });
  it.each([new Error("private storage failure"),new HttpError(403,"private unrelated denial")])("keeps unexpected gate errors generic500 without reflecting their message (%#)",async failure=>{
    current.identity={stackId:"stack",canonicalOrigin:identity.origin};current.connector={instanceId:identity.instanceId};
    let ackReads=0,writes=0;
    const tx={execute:async()=>{},select:()=>({from:()=>({where:async()=>{ackReads++;throw failure;}})}),
      insert:()=>{writes++;throw new Error("Unexpected mint insert");}};
    const db={select:()=>({from:()=>({where:async()=>[{id:"pcmcp_client_known",grantTypes:[DEVICE_GRANT],redirectUris:[],name:"Known device client"}]})}),
      transaction:async(work:(value:typeof tx)=>Promise<unknown>)=>work(tx)} as unknown as Db;
    const oauth=createPublicMcpOAuth(db,{origin:identity.origin,resource:identity.origin+"/mcp/runner"});
    const response=await mintOverOwnedLoopback(oauth);
    expect(ackReads).toBe(1);expect(writes).toBe(0);
    expect(response.status).toBe(500);expect(response.body).toEqual({error:"server_error",error_description:"Paperclip could not complete the connection request."});
    expect(JSON.stringify(response.body)).not.toContain(failure.message);expect(writes).toBe(0);
  });
});
