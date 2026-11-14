import type { Db, mcpFileTickets } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { readIdleMcpTransferSchedule } from "./idle-transfer-schedule.js";
type Ticket = Pick<typeof mcpFileTickets.$inferSelect,"companyId"|"grantId"|"uploadId"|"attachmentId"|"workSessionId"|"expiresAt">;
const row: Ticket = {companyId:"company",grantId:"grant",uploadId:"upload",attachmentId:null,workSessionId:null,expiresAt:new Date(10_000)};
function fixture(rows:Ticket[]) {
  const select = vi.fn(()=>({from:()=>({where:()=>({orderBy:()=>({limit:async()=>rows})})})}));
  return {select,tx:{select} as unknown as Pick<Db,"select">};
}
const budget = {beforeRead:async()=>{},check:()=>{}};
describe("live MCP transfer boundary",()=>{
  it("keeps reusable live tickets blocked and reports the actual bounded expiry",async()=>{
    const value = await readIdleMcpTransferSchedule(fixture([row]).tx,{now:0,budget});
    expect(value.blocked).toBe(true);expect(value.deadlines).toEqual([10_000]);
    expect((await readIdleMcpTransferSchedule(fixture([]).tx,{now:0,budget})).blocked).toBe(false);
  });
  it("retains malformed, uncertain and overflowing authority as blockers",async()=>{
    for(const change of [{expiresAt:new Date(NaN)},{expiresAt:new Date(0)},{companyId:""},{uploadId:null},{attachmentId:"attachment"}]) {
      const value=await readIdleMcpTransferSchedule(fixture([{...row,...change}]).tx,{now:0,budget});expect(value.blocked).toBe(true);expect(value.deadlines).toEqual([]);
    }
    const overflow=await readIdleMcpTransferSchedule(fixture(Array.from({length:1001},()=>row)).tx,{now:0,budget});expect(overflow.blocked).toBe(true);expect(overflow.deadlines).toEqual([]);
    const f=fixture([]);await expect(readIdleMcpTransferSchedule(f.tx,{now:0,budget:{beforeRead:async()=>{throw new Error("budget exhausted");},check:()=>{}}})).rejects.toThrow("budget exhausted");expect(f.select).not.toHaveBeenCalled();
  });
});
