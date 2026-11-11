import {beforeEach,describe,it,expect,vi} from "vitest";
import type {Db} from "@paperclipai/db";
const current=vi.hoisted(()=>({identity:null as null|{stackId:string;canonicalOrigin:string}}));
vi.mock("../cloud-runtime-identity.js",()=>({getCloudRuntimeIdentity:()=>current.identity}));
vi.mock("../delivery-work-notifications.js",async importOriginal=>({...await importOriginal<typeof import("../delivery-work-notifications.js")>(),notifyDeliveryWork:vi.fn(async()=>{})}));
import {mcpClientMirrorGeneration} from "./client-mirror-contract.js";
import {requiresMcpDeviceBroker,currentMcpDeviceCutoverStack,installMcpDeviceCutover} from "./device-cutover.js";

const resource="https://tenant.example.test/mcp/paperclip";
const identity={version:1 as const,instanceId:"instance",origin:"https://tenant.example.test",revision:1};
const receipt={...identity,enabled:true,frontDoor:"tenant-personal-v1" as const,deviceStatus:{keyId:"a".repeat(64),generation:"b".repeat(64),count:0},generation:""};receipt.generation=mcpClientMirrorGeneration(receipt);
function fixture(row:unknown){let reads=0;const tx={select:()=>{reads++;return{from:()=>({where:async()=>row?[row]:[]})};}} as unknown as Pick<Db,"select">;return{tx,reads:()=>reads};}
describe("one-time managed device cutover",()=>{
  beforeEach(()=>{current.identity=null;});
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
