import {beforeEach,describe,it,expect,vi} from "vitest";
import type {Db} from "@paperclipai/db";
const current=vi.hoisted(()=>({identity:null as null|{stackId:string;canonicalOrigin:string}}));
vi.mock("../cloud-runtime-identity.js",()=>({getCloudRuntimeIdentity:()=>current.identity}));
import {requiresMcpDeviceBroker,currentMcpDeviceCutoverStack} from "./device-cutover.js";

const resource="https://tenant.example.test/mcp/paperclip";
function fixture(row:unknown){let reads=0;const tx={select:()=>{reads++;return{from:()=>({where:async()=>row?[row]:[]})};}} as unknown as Pick<Db,"select">;return{tx,reads:()=>reads};}
describe("one-time managed device cutover",()=>{
  beforeEach(()=>{current.identity=null;});
  it("persisted managed cutover is inert after legitimate selfhost/no-Cloud startup",async()=>{
    const f=fixture({stackId:"old-stack",at:new Date(1)});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(false);expect(f.reads()).toBe(0);
  });
  it("current verified managed identity gates raw mint and keeps original cutover after restart/re-enable",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:"https://tenant.example.test"};const at=new Date(1),f=fixture({stackId:"stack",at});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(true);expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(true);expect(at.getTime()).toBe(1);
    expect(currentMcpDeviceCutoverStack(resource)).toBe("stack");
  });
  it("a replacement current managed stack cannot reopen anonymous raw mint using old persisted cutover",async()=>{
    current.identity={stackId:"replacement-stack",canonicalOrigin:"https://tenant.example.test"};
    expect(await requiresMcpDeviceBroker(fixture({stackId:"old-stack",at:new Date(1)}).tx,resource)).toBe(true);
    expect(currentMcpDeviceCutoverStack(resource)).toBe("replacement-stack");
  });
  it("never-cut-over and other resource/origin paths preserve their original owner",async()=>{
    current.identity={stackId:"stack",canonicalOrigin:"https://tenant.example.test"};const f=fixture({stackId:null,at:null});
    expect(await requiresMcpDeviceBroker(f.tx,resource)).toBe(false);
    expect(await requiresMcpDeviceBroker(f.tx,"https://tenant.example.test/mcp/runner")).toBe(false);
    expect(await requiresMcpDeviceBroker(f.tx,"https://old.example.test/mcp/paperclip")).toBe(false);expect(f.reads()).toBe(1);
  });
});
