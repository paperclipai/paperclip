import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readIdleMcpAuthorizationHandoffs } from "./idle-authorization-handoffs.js";
function fixture(results:unknown[][]) {
  const select=vi.fn(()=>({from:()=>({where:()=>({orderBy:()=>({limit:async()=>results.shift()??[]})})})}));
  return {select,tx:{select} as unknown as Pick<Db,"select">};
}
const code={id:"request",grantId:"grant",decidedAt:new Date(0),expiresAt:new Date(10_000),codeValid:true};
const device={id:"device",grantId:"grant",status:"approved",expiresAt:new Date(20_000)};
describe("approved MCP precredential handoff proof",()=>{
  it("retains both exact finite expiries and charges every actual read",async()=>{
    const beforeRead=vi.fn(async()=>{}),f=fixture([[code],[device]]);
    const value=await readIdleMcpAuthorizationHandoffs(f.tx,{now:1,budget:{beforeRead,check:()=>{}}});
    expect(value.blocked).toBe(true);expect(value.deadlines).toEqual([10_000,20_000]);expect(beforeRead).toHaveBeenCalledTimes(f.select.mock.calls.length);
  });
  it("fails closed for malformed/uncertain authority and incomplete coverage",async()=>{
    for(const results of [[[{...code,codeValid:false}],[]],[[{...code,grantId:null}],[]],[[{...code,decidedAt:null}],[]],[[{...code,expiresAt:new Date(NaN)}],[]],[[],[{...device,status:"unknown"}]], [Array.from({length:1001},()=>code),[]]]) {
      const value=await readIdleMcpAuthorizationHandoffs(fixture(results).tx,{now:1,budget:{beforeRead:async()=>{},check:()=>{}}});
      expect(value.blocked).toBe(true);expect(value.deadlines).toEqual([]);
    }
    const empty=await readIdleMcpAuthorizationHandoffs(fixture([[],[]]).tx,{now:1,budget:{beforeRead:async()=>{},check:()=>{}}});expect(empty).toMatchObject({blocked:false,deadlines:[]});
  });
});
