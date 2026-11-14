import {beforeEach,describe,expect,it,vi} from "vitest";
import type {Db} from "@paperclipai/db";
const current=vi.hoisted(()=>({identity:null as null|{stackId:string;canonicalOrigin:string},instanceId:null as string|null,enabled:true,settingsReads:0}));
vi.mock("../cloud-runtime-identity.js",()=>({getCloudRuntimeIdentity:()=>current.identity}));
vi.mock("../paperclip-cloud-connector.js",()=>({paperclipCloudConnectorConfigFromEnv:()=>current.instanceId?{instanceId:current.instanceId}:null}));
vi.mock("../instance-settings.js",()=>({instanceSettingsService:()=>({getExperimentalReadOnly:async()=>{current.settingsReads++;return{enablePublicMcp:current.enabled};}})}));
import {cloudEventAuthoritySchema,cloudEventValidationOrigin} from "./cloud-event-authority.js";
import {mcpClientMirrorGeneration} from "./client-mirror-contract.js";
const origin="https://tenant.example.test",central="https://my.example.test",config={origin,resource:origin+"/mcp/paperclip"},authority={token:"opaque-wrapper",expiresAt:Date.now()+60_000,transport:"tenant-personal-v1" as const};
function fixture(patch:Record<string,unknown>={}){
  const receipt={version:1 as const,instanceId:"instance",origin,revision:1,enabled:true,frontDoor:"tenant-personal-v1" as const,deviceStatus:{keyId:"a".repeat(64),generation:"b".repeat(64),count:0},generation:""};receipt.generation=mcpClientMirrorGeneration(receipt);
  const row={revision:1,enabled:true,remoteResponsibility:true,receipt,deviceCutoverAt:new Date(1),deviceCutoverStackId:"stack",...patch};let reads=0;
  return{db:{select:()=>{reads++;return{from:()=>({where:async()=>[row]})};}}as unknown as Db,reads:()=>reads};
}
describe("hosted event authority transport selection",()=>{
  beforeEach(()=>{current.identity={stackId:"stack",canonicalOrigin:origin};current.instanceId="instance";current.enabled=true;current.settingsReads=0;});
  it("absent marker preserves the existing fixed central origin without tenant metadata reads",async()=>{
    const f=fixture();expect(await cloudEventValidationOrigin(f.db,config,central,{token:"central-wrapper",expiresAt:authority.expiresAt})).toBe(central);expect(f.reads()).toBe(0);expect(current.settingsReads).toBe(0);
  });
  it("current complete mirror derives the exact verified tenant endpoint",async()=>{
    const f=fixture();expect(await cloudEventValidationOrigin(f.db,config,central,authority)).toBe(origin);expect(f.reads()).toBe(1);expect(current.settingsReads).toBe(1);
  });
  it("unknown marker or caller URL never selects a validation endpoint",async()=>{
    for(const value of [{...authority,transport:"unknown"},{...authority,transport:null},{...authority,url:"https://attacker.example"}])expect(cloudEventAuthoritySchema.safeParse(value).success).toBe(false);
    const f=fixture();await expect(cloudEventValidationOrigin(f.db,config,central,{...authority,transport:"unknown"}as unknown as typeof authority)).rejects.toThrow("Invalid hosted");expect(f.reads()).toBe(0);
  });
  it("missing managed authority, connector or central enrollment fails closed",async()=>{
    const f=fixture();current.identity=null;await expect(cloudEventValidationOrigin(f.db,config,central,authority)).rejects.toThrow();current.identity={stackId:"stack",canonicalOrigin:origin};current.instanceId=null;await expect(cloudEventValidationOrigin(f.db,config,central,authority)).rejects.toThrow();current.instanceId="instance";await expect(cloudEventValidationOrigin(f.db,config,undefined,authority)).rejects.toThrow();expect(f.reads()).toBe(0);
  });
  it("pending, disabled, missing cutover and replaced instance receipts cannot use the tenant transport",async()=>{
    for(const patch of [{revision:2},{enabled:false},{remoteResponsibility:false},{deviceCutoverAt:null},{receipt:null}])await expect(cloudEventValidationOrigin(fixture(patch).db,config,central,authority)).rejects.toThrow();
    current.instanceId="replacement";await expect(cloudEventValidationOrigin(fixture().db,config,central,authority)).rejects.toThrow();current.instanceId="instance";current.enabled=false;await expect(cloudEventValidationOrigin(fixture().db,config,central,authority)).rejects.toThrow();
  });
  it("foreign issuer, authorization origin and Dot resource never reuse a personal marker",async()=>{
    for(const value of [{...config,origin:"https://old.example.test"},{...config,authorizationOrigin:"https://foreign.example.test"},{...config,resource:origin+"/mcp/runner"}])await expect(cloudEventValidationOrigin(fixture().db,value,central,authority)).rejects.toThrow();
  });
});
