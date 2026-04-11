import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { sanitizeHeartbeatContextSnapshotForTenant } from "../services/heartbeat.js";

/** Minimal drizzle-shaped mock: each `.where()` resolves to the next row batch. */
function mockDbForSelectRows(rowsPerWhere: unknown[][]) {
  let i = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve((rowsPerWhere[i++] ?? []) as { id: string }[]),
  };
  return chain as unknown as Db;
}

describe("sanitizeHeartbeatContextSnapshotForTenant (PAY-114)", () => {
  it("removes cross-tenant taskId so it cannot become PAPERCLIP_TASK_ID in adapter env", async () => {
    const foreignTask = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ctx: Record<string, unknown> = { taskId: foreignTask };
    const db = mockDbForSelectRows([[], []]);
    await sanitizeHeartbeatContextSnapshotForTenant(db, "company-pay3", ctx, { agentId: "agent-1" });
    expect(ctx.taskId).toBeUndefined();
  });

  it("removes cross-tenant issueId and aligned taskId/taskKey", async () => {
    const foreignIssue = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const ctx: Record<string, unknown> = {
      issueId: foreignIssue,
      taskId: foreignIssue,
      taskKey: foreignIssue,
    };
    const db = mockDbForSelectRows([[]]);
    await sanitizeHeartbeatContextSnapshotForTenant(db, "company-pay3", ctx, { runId: "run-1" });
    expect(ctx.issueId).toBeUndefined();
    expect(ctx.taskId).toBeUndefined();
    expect(ctx.taskKey).toBeUndefined();
  });

  it("keeps taskId when the issue row exists in the same company", async () => {
    const good = "cccccccc-dddd-eeee-ffff-000000000001";
    const ctx: Record<string, unknown> = { taskId: good };
    const db = mockDbForSelectRows([[{ id: good }]]);
    await sanitizeHeartbeatContextSnapshotForTenant(db, "company-pay3", ctx, {});
    expect(ctx.taskId).toBe(good);
  });

  it("filters cross-tenant entries from issueIds (linked issues env)", async () => {
    const foreign = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const good = "dddddddd-eeee-ffff-0000-111111111111";
    const ctx: Record<string, unknown> = { issueIds: [foreign, good] };
    const db = mockDbForSelectRows([[{ id: good }]]);
    await sanitizeHeartbeatContextSnapshotForTenant(db, "company-pay3", ctx, {});
    expect(ctx.issueIds).toEqual([good]);
  });
});
