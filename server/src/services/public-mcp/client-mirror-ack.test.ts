import {describe,expect,it} from "vitest";
import {sameMcpClientMirrorReceipt} from "./client-mirror-sync.js";
import type {McpClientMirrorReceipt} from "./client-mirror-contract.js";

const make=():McpClientMirrorReceipt=>({version:1,instanceId:"mirror-control",origin:"https://mirror-control.example.test",revision:4,enabled:true,frontDoor:"tenant-personal-v1",deviceStatus:{keyId:"a".repeat(64),generation:"b".repeat(64),count:0},generation:"c".repeat(64)});
describe("same-revision MCP mirror receipt identity",()=>{
  it("accepts property reordering and equivalent default issuer without mutating either receipt",()=>{
    const prior=make(),saved=structuredClone(prior),same={...prior,deviceStatus:{count:0,generation:prior.deviceStatus!.generation,keyId:prior.deviceStatus!.keyId},authorizationOrigin:prior.origin};
    expect(sameMcpClientMirrorReceipt(prior,same)).toBe(true);expect(prior).toEqual(saved);
  });
  it("rejects every conflicting immutable field even with the same opaque generation value",()=>{
    const prior=make(),saved=structuredClone(prior);
    const alternatives:McpClientMirrorReceipt[]=[{...prior,instanceId:"replacement"},{...prior,origin:"https://foreign.example.test"},{...prior,revision:5},{...prior,enabled:false},{...prior,frontDoor:undefined},{...prior,authorizationOrigin:"https://foreign.example.test"},{...prior,deviceStatus:undefined},{...prior,deviceStatus:{...prior.deviceStatus!,keyId:"d".repeat(64)}},{...prior,deviceStatus:{...prior.deviceStatus!,generation:"e".repeat(64)}},{...prior,deviceStatus:{...prior.deviceStatus!,count:1}},{...prior,generation:"f".repeat(64)}];
    for(const changed of alternatives){expect(sameMcpClientMirrorReceipt(prior,changed)).toBe(false);expect(prior).toEqual(saved);}
  });
});
