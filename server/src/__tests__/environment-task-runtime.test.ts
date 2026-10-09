import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { environmentTaskOperationSchema, parseEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import { executeEnvironmentTask } from "../services/environment-task-runtime.js";

const state = vi.hoisted(() => ({ plugin: {} as any }));
vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => ({ getById: vi.fn(async () => state.plugin) }) }));
const leaseId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const secondProjectId = "10000000-0000-4000-8000-000000000003";
const row = () => ({
  lease: { id: leaseId, companyId: "company", environmentId: "environment", providerLeaseId: "attempt-1", heartbeatRunId: "run", issueId: "issue", status: "active", expiresAt: null as Date | null,
    metadata: { driver: "plugin", pluginId: "original", driverKey: "tasks" } },
  environment: { id: "environment", config: { pluginKey: "test.provider", driverKey: "tasks", driverConfig: {} } } as { id: string; config: Record<string, unknown> } | null,
  run: { id: "run", agentId: "agent", status: "running" } as { id: string; agentId: string; status: string } | null,
});
function database(value: ReturnType<typeof row> | null = row(), projectRows = [{ id: projectId }]) {
  const results = [value ? [value] : [], [{ id: "issue" }]];
  const query: any = { from: () => query, leftJoin: () => query, where: vi.fn(() => query), limit: () => Promise.resolve(results.shift()), then: (resolve: (rows: typeof projectRows) => unknown) => Promise.resolve(projectRows).then(resolve) };
  return { db: { select: () => query } as unknown as Db, query };
}
function worker(result: unknown = { kind: "accepted", taskId: "attempt-1" }) {
  return { getWorker: vi.fn(() => ({ supportedMethods: ["environmentTask"] })), call: vi.fn(async () => result) };
}
const submit = { kind: "submit" as const, projectIds: [projectId], runner: { protocolMin: 1, protocolMax: 2, harness: "codex", runnerId: "runner", leaseId, runId: "run", sessionId: "session", turnId: "turn", itemId: "item" }, bootstrapTicket: "transient-test-ticket" };

beforeEach(() => {
  state.plugin = { id: "original", pluginKey: "test.provider", status: "ready", manifestJson: { capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } };
});
describe("plugin-provided Runner execution", () => {
  it("dispatches with host-derived scope and a persisted attempt identity", async () => {
    const { db, query } = database(); const workers = worker();
    await expect(executeEnvironmentTask(db, workers as never, { companyId: "company", leaseId, operation: submit })).resolves.toEqual({ kind: "accepted", taskId: "attempt-1" });
    const scope = new PgDialect().sqlToQuery(query.where.mock.calls[0][0]);
    expect(scope.sql).toContain('"environment_leases"."company_id" =');
    expect(scope.sql).toContain('"environment_leases"."id" =');
    expect(scope.params).toEqual([leaseId, "company"]);
    expect(workers.call).toHaveBeenCalledWith("original", "environmentTask", expect.objectContaining({
      taskId: "attempt-1", companyId: "company", agentId: "agent", projectIds: [projectId], runId: "run", operation: submit,
    }), 15_000);
  });
  it("validates every requested project in the task company before dispatch", async () => {
    const operation = { ...submit, projectIds: [projectId, secondProjectId] };
    const { db, query } = database(row(), [{ id: projectId }, { id: secondProjectId }]);
    const workers = worker();
    await executeEnvironmentTask(db, workers as never, { companyId: "company", leaseId, operation });
    expect(workers.call).toHaveBeenCalledWith("original", "environmentTask", expect.objectContaining({ projectIds: operation.projectIds }), 15_000);
    const scope = new PgDialect().sqlToQuery(query.where.mock.calls[2][0]);
    expect(scope.sql).toContain('"projects"."company_id" =');
    expect(scope.params).toEqual(["company", projectId, secondProjectId]);
    const rejected = worker();
    await expect(executeEnvironmentTask(database(row(), [{ id: projectId }]).db, rejected as never, { companyId: "company", leaseId, operation })).rejects.toThrow("project unavailable");
    expect(rejected.call).not.toHaveBeenCalled();
  });
  it("validates unique project IDs and allows tasks with no project mounts", async () => {
    for (const projectIds of [[projectId, projectId], ["invalid"], Array(65).fill(projectId)]) {
      expect(environmentTaskOperationSchema.safeParse({ ...submit, projectIds }).success).toBe(false);
    }
    const workers = worker();
    await executeEnvironmentTask(database().db, workers as never, { companyId: "company", leaseId, operation: { ...submit, projectIds: [] } });
    expect(workers.call).toHaveBeenCalledWith("original", "environmentTask", expect.objectContaining({ projectIds: [] }), 15_000);
  });
  it("rejects an absent or cross-company lease before calling a worker", async () => {
    const workers = worker();
    await expect(executeEnvironmentTask(database(null).db, workers as never, { companyId: "other", leaseId, operation: submit })).rejects.toThrow("lease unavailable");
    expect(workers.call).not.toHaveBeenCalled();
  });
  it("rejects mismatched Runner binding and inactive submission", async () => {
    const workers = worker();
    await expect(executeEnvironmentTask(database().db, workers as never, { companyId: "company", leaseId, operation: { ...submit, runner: { ...submit.runner, runId: "other" } } })).rejects.toThrow("identity mismatch");
    const value = row(); value.lease.status = "released";
    await expect(executeEnvironmentTask(database(value).db, workers as never, { companyId: "company", leaseId, operation: submit })).rejects.toThrow("not active");
    expect(workers.call).not.toHaveBeenCalled();
  });
  it("uses the pinned provider for cleanup after environment edits", async () => {
    const value = row(); value.lease.status = "released"; value.environment!.config.pluginKey = "replacement";
    const workers = worker();
    await executeEnvironmentTask(database(value).db, workers as never, { companyId: "company", leaseId, operation: { kind: "stop" } });
    expect(workers.call).toHaveBeenCalledWith("original", "environmentTask", expect.objectContaining({ config: {}, operation: { kind: "stop" } }), 15_000);
  });
  it("keeps cleanup available after environment, run, and issue deletion", async () => {
    const value = row(); value.environment = null; value.run = null;
    for (const kind of ["stop", "complete", "status"] as const) {
      const workers = worker(kind === "status" ? { kind: "status", taskId: "attempt-1", phase: "cancelled" } : undefined);
      await executeEnvironmentTask(database(value).db, workers as never, { companyId: "company", leaseId, operation: { kind } });
      expect(workers.call).toHaveBeenCalledWith("original", "environmentTask", expect.objectContaining({
        config: {}, environmentId: null, runId: null, agentId: null, projectIds: [],
      }), 15_000);
    }
    await expect(executeEnvironmentTask(database(value).db, worker() as never, { companyId: "company", leaseId, operation: submit })).rejects.toThrow("not active");
  });
  it("preserves opaque provider IDs in requests and receipts", async () => {
    const value = row(); value.lease.providerLeaseId = `provider:attempt.${"x".repeat(120)}`;
    const workers = worker({ kind: "accepted", taskId: value.lease.providerLeaseId });
    await expect(executeEnvironmentTask(database(value).db, workers as never, { companyId: "company", leaseId, operation: { kind: "stop" } })).resolves.toMatchObject({ taskId: value.lease.providerLeaseId });
  });
  it("returns a validated connection only while the lease and run are active", async () => {
    const connection = { kind: "connection", taskId: "attempt-1", endpoint: {
      kind: "authenticated_websocket", websocketUrl: "wss://runner.example.test/connect", generation: "attempt-1",
      secretHeaders: [{ name: "Authorization", value: "Bearer fixture" }],
    } };
    const input = { companyId: "company", leaseId, operation: { kind: "connection" as const } };
    await expect(executeEnvironmentTask(database().db, worker(connection) as never, input)).resolves.toEqual(connection);
    for (const state of ["expired", "finished", "deleted"] as const) {
      const value = row();
      if (state === "expired") value.lease.expiresAt = new Date(0);
      if (state === "finished") value.run!.status = "succeeded";
      if (state === "deleted") value.environment = null;
      const workers = worker(connection);
      await expect(executeEnvironmentTask(database(value).db, workers as never, input)).rejects.toThrow("not active");
      expect(workers.call).not.toHaveBeenCalled();
    }
    for (const endpoint of [
      { ...connection.endpoint, websocketUrl: "ws://runner.example.test/connect" },
      { ...connection.endpoint, websocketUrl: "wss://runner.example.test/connect?token=fixture" },
      { ...connection.endpoint, secretHeaders: [{ name: "Authorization", value: "fixture\r\nInjected: true" }] },
      { ...connection.endpoint, secretHeaders: [{ name: "Invalid Header", value: "fixture" }] },
    ]) {
      await expect(executeEnvironmentTask(database().db, worker({ ...connection, endpoint }) as never, input)).rejects.toThrow("reconcile the same task");
    }
  });
  it.each(["manifest", "worker"])("requires live %s support", async kind => {
    const workers = worker();
    if (kind === "manifest") state.plugin.manifestJson.environmentDrivers[0].supportsTasks = false;
    else workers.getWorker.mockReturnValue({ supportedMethods: [] });
    await expect(executeEnvironmentTask(database().db, workers as never, { companyId: "company", leaseId, operation: submit })).rejects.toThrow("provider unavailable");
    expect(workers.call).not.toHaveBeenCalled();
  });
  it("rejects wrong task receipts and sanitizes worker errors", async () => {
    await expect(executeEnvironmentTask(database().db, worker({ kind: "accepted", taskId: "other" }) as never, { companyId: "company", leaseId, operation: submit })).rejects.toThrow("reconcile the same task");
    const workers = worker(); workers.call.mockRejectedValue(new Error("private-credential"));
    await expect(executeEnvironmentTask(database().db, workers as never, { companyId: "company", leaseId, operation: submit })).rejects.toThrow(/^Plugin-provided Runner execution operation unavailable; reconcile the same task before retrying$/);
  });
  it("accepts PRP identity characters and length limits", () => {
    for (const field of ["runnerId", "leaseId", "runId", "sessionId", "turnId", "itemId"]) {
      for (const value of ["session:part.1", "a".repeat(160)]) {
        expect(environmentTaskOperationSchema.safeParse({ ...submit, runner: { ...submit.runner, [field]: value } }).success).toBe(true);
      }
      for (const value of ["a".repeat(161), "../escape", "a/b", ""]) {
        expect(environmentTaskOperationSchema.safeParse({ ...submit, runner: { ...submit.runner, [field]: value } }).success).toBe(false);
      }
    }
  });
  it("validates the client's inclusive PRP version range", () => {
    for (const range of [{ protocolMin: 1, protocolMax: 1 }, { protocolMin: 1, protocolMax: 2 }, { protocolMin: 3, protocolMax: 5 }]) {
      expect(environmentTaskOperationSchema.safeParse({ ...submit, runner: { ...submit.runner, ...range } }).success).toBe(true);
    }
    for (const range of [
      { protocolMin: 0, protocolMax: 2 }, { protocolMin: 2, protocolMax: 1 },
      { protocolMin: 1.5, protocolMax: 2 }, { protocolMin: 1, protocolMax: 2.5 },
      { protocolMin: 1, protocolMax: Number.MAX_SAFE_INTEGER + 1 },
      { protocolMin: undefined, protocolMax: 2 }, { protocolMin: 1, protocolMax: undefined },
    ]) {
      expect(environmentTaskOperationSchema.safeParse({ ...submit, runner: { ...submit.runner, ...range } }).success).toBe(false);
    }
  });
  it("validates operation and result shape without making acceptance mean readiness", () => {
    expect(environmentTaskOperationSchema.safeParse({ ...submit, surprise: true }).success).toBe(false);
    expect(environmentTaskOperationSchema.safeParse({ ...submit, runner: { ...submit.runner, unknownField: true } }).success).toBe(false);
    expect(() => parseEnvironmentTaskResult({ kind: "status" }, "attempt-1", { kind: "accepted", taskId: "attempt-1" })).toThrow();
    expect(parseEnvironmentTaskResult(submit, "attempt-1", { kind: "accepted", taskId: "attempt-1" }).kind).toBe("accepted");
  });
});
