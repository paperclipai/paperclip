import type { Db } from "@paperclipai/db";
import { activityLog, approvals, heartbeatRuns } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { terminateLocalService } from "../local-service-supervisor.js";
import { describe, expect, it, vi } from "vitest";
import { approvalService } from "../approvals.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks, runControlPostgresSupport, setupRunControlDatabase } from "./__tests__/run-control-fixtures.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../local-service-supervisor.js", async (original) => ({
  ...await original<typeof import("../local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(async () => undefined),
}));

describe.skipIf(!runControlPostgresSupport.supported)("run approval cancellation", () => {
  let db: Db;
  const { fixture, liveRun } = setupRunControlDatabase("paperclip-run-approval-cancellation", value => { db = value; });
  it("stops an owned legacy process and releases waiters when the stop fence fails", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    await db.execute(sql`create function gateway_stop_fence_failure() returns trigger language plpgsql as $$
      begin
        if new.result_json->'executionCancellation'->>'state' = 'requested' then
          raise exception 'synthetic stop fence failure';
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger gateway_stop_fence_failure before update on heartbeat_runs
      for each row execute function gateway_stop_fence_failure()`);
    const deps = callbacks(db);
    try {
      await expect(createHeartbeatRunControl(db, deps).cancelRunInternal(run.id, "Stop")).rejects.toThrow();
      expect(terminateLocalService).toHaveBeenCalledTimes(1);
      expect(deps.processRunCancellationSettlements.size).toBe(0);
      expect(await deps.getRun(run.id)).toMatchObject({ status: "running" });
    } finally {
      await db.execute(sql`drop trigger gateway_stop_fence_failure on heartbeat_runs`);
      await db.execute(sql`drop function gateway_stop_fence_failure()`);
    }
  });

  it("rejects new run-scoped approvals after stop intent commits but before final status", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, run.id));
    await expect(approvalService(db).create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id,
      originRunId: run.id, payload: { summary: "Fictitious" } })).rejects.toThrow("running execution");
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("cancels only open approvals belonging to the stopped run", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const other = await liveRun(company.id, agent.id);
    const svc = approvalService(db);
    const create = (originRunId: string) => svc.create(company.id, {
      type: "request_board_approval", requestedByAgentId: agent.id, originRunId, payload: { summary: "Fictitious" },
    });
    const pending = await create(run.id);
    const revision = await create(run.id);
    const decided = await create(run.id);
    const unrelated = await create(other.id);
    await svc.requestRevision(revision.id, "board", "Clarify");
    await svc.approve(decided.id, "board");
    const stopped = await createHeartbeatRunControl(db, callbacks(db)).cancelRunInternal(run.id, "Stop");
    expect(stopped?.status).toBe("cancelled");
    expect((await svc.getById(pending.id))?.status).toBe("cancelled");
    expect((await svc.getById(revision.id))?.status).toBe("cancelled");
    expect((await svc.getById(decided.id))?.status).toBe("approved");
    expect((await svc.getById(unrelated.id))?.status).toBe("pending");
    await expect(create(run.id)).rejects.toThrow("running execution");
  });

  it("does not leave an open approval when creation races cancellation", async () => {
    const { company, agent } = await fixture();
    const svc = approvalService(db);
    for (let i = 0; i < 5; i++) {
      const run = await liveRun(company.id, agent.id);
      const create = svc.create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id,
        originRunId: run.id, payload: { summary: "Fictitious race" } });
      const cancel = createHeartbeatRunControl(db, callbacks(db)).cancelRunInternal(run.id, "Stop");
      const [created, stopped] = await Promise.allSettled([create, cancel]);
      expect(stopped.status).toBe("fulfilled");
      if (created.status === "fulfilled") expect((await svc.getById(created.value.id))?.status).toBe("cancelled");
      else expect(String(created.reason)).toContain("running execution");
      expect(await db.select().from(approvals).where(and(eq(approvals.originRunId, run.id), eq(approvals.status, "pending")))).toHaveLength(0);
    }
  });

  it("serializes a held approval creation before cancellation", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const created = new Promise<void>(resolve => { admitted = resolve; });
    const creation = db.transaction(async tx => {
      const approval = await approvalService(tx as unknown as Db).create(company.id, {
        type: "request_board_approval", requestedByAgentId: agent.id, originRunId: run.id, payload: {},
      });
      admitted();
      await held;
      return approval;
    });
    await created;
    const stopping = createHeartbeatRunControl(db, callbacks(db)).cancelRunInternal(run.id, "Stop");
    try {
      const early = await Promise.race([stopping.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
      expect(early).toBe(false);
    } finally { release(); }
    const [approval, stopped] = await Promise.all([creation, stopping]);
    expect(stopped?.status).toBe("cancelled");
    expect((await approvalService(db).getById(approval.id))?.status).toBe("cancelled");
  });

  it("rejects approval creation waiting behind a committed cancellation", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { admitted = resolve; });
    const cancellation = db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
      admitted();
      await held;
    });
    await locked;
    const creation = approvalService(db).create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id,
      originRunId: run.id, payload: {} });
    const observation = creation.then(() => "created", () => "rejected");
    try {
      const early = await Promise.race([observation, new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 100))]);
      expect(early).toBe("waiting");
    } finally { release(); }
    await cancellation;
    expect(await observation).toBe("rejected");
  });

  it("preserves the winning decision when approval races cancellation", async () => {
    const { company, agent } = await fixture();
    const svc = approvalService(db);
    for (let i = 0; i < 5; i++) {
      const run = await liveRun(company.id, agent.id);
      const approval = await svc.create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id,
        originRunId: run.id, payload: {} });
      const [decision, stopped] = await Promise.allSettled([
        svc.approve(approval.id, "board"),
        createHeartbeatRunControl(db, callbacks(db)).cancelRunInternal(run.id, "Stop"),
      ]);
      expect(stopped.status).toBe("fulfilled");
      const final = await svc.getById(approval.id);
      expect(final?.status).toBe(decision.status === "fulfilled" ? "approved" : "cancelled");
    }
  });

  it.each(["revision", "resubmit"] as const)("cannot reopen a cancelled approval through a racing %s", async action => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const svc = approvalService(db);
    const approval = await svc.create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id,
      originRunId: run.id, payload: {} });
    if (action === "resubmit") await svc.requestRevision(approval.id, "board", "Clarify");
    let release!: () => void;
    let admitted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { admitted = resolve; });
    const cancellation = db.transaction(async tx => {
      await tx.select().from(approvals).where(eq(approvals.id, approval.id)).for("update");
      admitted();
      await held;
      await tx.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, approval.id));
    });
    await locked;
    const update = action === "revision" ? svc.requestRevision(approval.id, "board", "Clarify") : svc.resubmit(approval.id);
    const observed = update.then(() => "updated", () => "rejected");
    try {
      const early = await Promise.race([observed, new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 100))]);
      expect(early).toBe("waiting");
    } finally { release(); }
    await cancellation;
    expect(await observed).toBe("rejected");
    expect((await svc.getById(approval.id))?.status).toBe("cancelled");
  });

  it("reconciles an already-cancelled run and records only the approval that changed", async () => {
    const { company, agent } = await fixture();
    const run = await liveRun(company.id, agent.id);
    const svc = approvalService(db);
    const pending = await svc.create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id, originRunId: run.id, payload: {} });
    const decided = await svc.create(company.id, { type: "request_board_approval", requestedByAgentId: agent.id, originRunId: run.id, payload: {} });
    await svc.approve(decided.id, "board");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    const control = createHeartbeatRunControl(db, callbacks(db));
    await control.cancelRunInternal(run.id, "Stop");
    await control.cancelRunInternal(run.id, "Stop again");
    expect((await svc.getById(pending.id))?.status).toBe("cancelled");
    expect((await svc.getById(decided.id))?.status).toBe("approved");
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.entityId, pending.id), eq(activityLog.action, "approval.cancelled")));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.runId).toBe(run.id);
  });

});
