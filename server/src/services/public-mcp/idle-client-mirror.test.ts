import {describe,it,expect} from "vitest";
import type {Db} from "@paperclipai/db";
import {readIdleMcpClientMirror} from "./idle-client-mirror.js";
import {mcpClientMirrorGeneration} from "./client-mirror-contract.js";

const identity={version:1 as const,instanceId:"instance-1",origin:"https://tenant.example.test",revision:7};
const receipt={...identity,enabled:true,generation:mcpClientMirrorGeneration(identity)};
const complete={...receipt,frontDoor:"tenant-personal-v1" as const,deviceStatus:{keyId:"a".repeat(64),generation:"b".repeat(64),count:0}};
complete.generation=mcpClientMirrorGeneration(complete);
const rowFor=(value=receipt)=>({revision:7,enabled:true,remoteResponsibility:true,receipt:value,deviceCutoverAt:new Date(1),deviceCutoverStackId:"stack"});
function fixture(row:unknown){
  let queries=0,reads=0,checks=0;
  const tx={select:()=>{queries++;return{from:()=>({where:async()=>row===undefined?[]:[row]})};}} as unknown as Pick<Db,"select">;
  return{tx,context:{enabled:true,origin:identity.origin,instanceId:identity.instanceId,managedStackId:"stack",budget:{beforeRead:async()=>{reads++;},check:()=>{checks++;}}},counts:()=>({queries,reads,checks})};
}
describe("MCP client mirror inspection",()=>{
  it("unconfigured selfhost adds no old Cloud responsibility read",async()=>{
    const f=fixture(undefined);
    expect((await readIdleMcpClientMirror(f.tx,{...f.context,enabled:false,managedStackId:undefined})).blocked).toBe(false);
    expect((await readIdleMcpClientMirror(f.tx,{...f.context,managedStackId:undefined})).blocked).toBe(true);
    expect(f.counts()).toEqual({queries:0,reads:0,checks:0});
  });
  it("missing, partial, future, malformed and foreign receipts fail closed without mutations",async()=>{
    for(const row of [undefined,{...rowFor(),receipt:null},{...rowFor(),revision:8},{...rowFor(),revision:6},{...rowFor(),receipt:{...receipt,instanceId:"old-instance"}},{...rowFor(),receipt:{...receipt,generation:"0".repeat(64)}},{...rowFor(),revision:NaN}]){
      const f=fixture(row);expect((await readIdleMcpClientMirror(f.tx,f.context)).blocked).toBe(true);
      expect(f.counts()).toEqual({queries:1,reads:1,checks:1});
    }
  });
  it("old metadata-only acknowledgment cannot certify the advertised front door",async()=>{
    const f=fixture(rowFor()),result=await readIdleMcpClientMirror(f.tx,f.context);
    expect(result.blocked).toBe(true);expect(result.receipt).toEqual(receipt);expect((result.state as unknown[])[0]).toBe("incomplete-front-door");
  });
  it("only actual capability, status ref and durable cutover permit the personal profile",async()=>{
    const f=fixture(rowFor(complete)),result=await readIdleMcpClientMirror(f.tx,f.context);
    expect(result.blocked).toBe(false);expect(result.receipt).toEqual(complete);expect(result.deadlines).toEqual([]);
    for(const patch of [{deviceCutoverAt:null},{deviceCutoverStackId:null},{deviceCutoverStackId:"foreign-stack"}]){const missing=fixture({...rowFor(complete),...patch});expect((await readIdleMcpClientMirror(missing.tx,missing.context)).blocked).toBe(true);}
    expect((await readIdleMcpClientMirror(f.tx,{...f.context,unsupportedProfiles:true})).blocked).toBe(true);
    expect(f.counts()).toEqual({queries:2,reads:2,checks:2});
  });
  it("disabled flag retains published responsibility until exact durable disable ACK",async()=>{
    const pending=fixture({...rowFor(),revision:8,enabled:false,receipt:null});
    expect((await readIdleMcpClientMirror(pending.tx,{...pending.context,enabled:false})).blocked).toBe(true);
    const disabled={...receipt,enabled:false,revision:8,generation:mcpClientMirrorGeneration({...receipt,enabled:false,revision:8})};
    const acknowledged=fixture({...rowFor(),revision:8,enabled:false,remoteResponsibility:false,receipt:disabled});
    expect((await readIdleMcpClientMirror(acknowledged.tx,{...acknowledged.context,enabled:false})).blocked).toBe(false);
    const late=fixture({...rowFor(),revision:9,receipt:disabled});expect((await readIdleMcpClientMirror(late.tx,late.context)).blocked).toBe(true);
  });
  it("missing connector/origin cannot erase managed published teardown debt",async()=>{
    for(const missing of [{instanceId:undefined},{origin:undefined},{origin:undefined,instanceId:undefined}]){
      const f=fixture({...rowFor(),revision:8,enabled:false,receipt:null});expect((await readIdleMcpClientMirror(f.tx,{...f.context,...missing,enabled:false})).blocked).toBe(true);
      expect(f.counts()).toEqual({queries:1,reads:1,checks:1});
    }
    for(const row of [undefined,{revision:1,enabled:true,remoteResponsibility:false,receipt:null}]){const never=fixture(row);expect((await readIdleMcpClientMirror(never.tx,{...never.context,enabled:false,origin:undefined,instanceId:undefined})).blocked).toBe(false);}
  });
  it("relocated selfhost keeps old persisted history without acquiring old cleanup authority",async()=>{
    const f=fixture({...rowFor(),revision:8,enabled:false,receipt:null});expect((await readIdleMcpClientMirror(f.tx,{...f.context,enabled:false,managedStackId:undefined})).blocked).toBe(false);
    expect(f.counts()).toEqual({queries:0,reads:0,checks:0});
  });
  it("strict retired namespace ACK remains absent after managed instance and origin replacement",async()=>{
    const disabled={...receipt,enabled:false,revision:8,generation:mcpClientMirrorGeneration({...receipt,enabled:false,revision:8})};
    const row={...rowFor(),revision:9,enabled:false,remoteResponsibility:false,receipt:disabled};
    const f=fixture(row),next={...f.context,enabled:false,instanceId:"replacement-instance",origin:"https://replacement.example.test",managedStackId:"replacement-stack"};
    expect(await readIdleMcpClientMirror(f.tx,next)).toEqual({blocked:false,state:"absent",deadlines:[]});
    for(const patch of [{remoteResponsibility:true},{enabled:true},{revision:7},{receipt:{...disabled,generation:"0".repeat(64)}},{receipt:{...disabled,enabled:true}}]){
      const pending=fixture({...row,...patch});expect((await readIdleMcpClientMirror(pending.tx,next)).blocked).toBe(true);
      expect((await readIdleMcpClientMirror(pending.tx,{...next,origin:undefined,instanceId:undefined})).blocked).toBe(true);
    }
  });

});
