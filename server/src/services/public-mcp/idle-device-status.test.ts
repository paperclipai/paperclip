import {describe,it,expect} from "vitest";
import {createHash} from "node:crypto";
import type {Db} from "@paperclipai/db";
import {readIdleMcpDeviceStatus} from "./idle-device-status.js";
import {mcpDeviceStatusFingerprint,mcpDeviceStatusGeneration,mcpDeviceStatusKeyId} from "./device-status-contract.js";
import type {McpClientMirrorReceipt} from "./client-mirror-contract.js";

const key=Buffer.alloc(32,9).toString("base64url"),instanceId="instance",origin="https://tenant.example.test",revision=7;
const row={requestId:"00000000-0000-4000-8000-000000000001",clientId:"client",resource:origin+"/mcp/paperclip",ingressOwner:"tenant" as const,status:"pending" as const,expiresAt:new Date(1_800_000_000_000),deviceCodeHash:createHash("sha256").update("private-device").digest("hex")};
const entry={requestId:row.requestId,clientId:row.clientId,resource:row.resource,ingressOwner:row.ingressOwner,status:row.status,expiresAt:row.expiresAt.getTime(),fingerprint:mcpDeviceStatusFingerprint(key,row.deviceCodeHash,row.clientId,row.resource)};
const reference={keyId:mcpDeviceStatusKeyId(key),generation:mcpDeviceStatusGeneration({instanceId,origin,revision,keyId:mcpDeviceStatusKeyId(key)},[entry]),count:1};
const receipt:McpClientMirrorReceipt={version:1,instanceId,origin,revision,enabled:true,generation:"a".repeat(64),deviceStatus:reference};
function fixture(rows:unknown[]){let reads=0,checks=0,keyReads=0;const tx={select:()=>({from:()=>({where:()=>({orderBy:()=>({limit:async()=>rows})})})})} as unknown as Pick<Db,"select">;
  return{tx,input:{enabled:true,receipt,key:()=>{keyReads++;return key;},budget:{beforeRead:async()=>{reads++;},check:()=>{checks++;}}},counts:()=>({reads,checks,keyReads})};}
describe("bounded current device status proof",()=>{
  it("absent feature performs no reads or key access",async()=>{
    const f=fixture([row]);expect((await readIdleMcpDeviceStatus(f.tx,{...f.input,enabled:false})).blocked).toBe(false);expect(f.counts()).toEqual({reads:0,checks:0,keyReads:0});
  });
  it("exact source identities and original expiry match their acknowledged projection",async()=>{
    const f=fixture([row]);expect((await readIdleMcpDeviceStatus(f.tx,f.input)).blocked).toBe(false);expect(f.counts().reads).toBe(1);expect(f.counts().keyReads).toBe(1);
  });
  it("deletion, status change and different expiry cannot reuse an old ACK",async()=>{
    for(const rows of [[],[{...row,status:"denied"}],[{...row,expiresAt:new Date(row.expiresAt.getTime()+1)}]]){
      const f=fixture(rows);expect((await readIdleMcpDeviceStatus(f.tx,f.input)).blocked).toBe(true);
    }
  });
  it("missing reference, unavailable/rotated key and canonical overflow fail closed",async()=>{
    const f=fixture([row]);expect((await readIdleMcpDeviceStatus(f.tx,{...f.input,receipt:undefined})).blocked).toBe(true);
    expect((await readIdleMcpDeviceStatus(f.tx,{...f.input,key:()=>{throw new Error("No local key");}})).blocked).toBe(true);
    expect((await readIdleMcpDeviceStatus(f.tx,{...f.input,key:()=>Buffer.alloc(32,8).toString("base64url")})).blocked).toBe(true);
    const overflow=fixture(Array.from({length:1001},()=>row));expect((await readIdleMcpDeviceStatus(overflow.tx,overflow.input)).blocked).toBe(true);
  });
});
