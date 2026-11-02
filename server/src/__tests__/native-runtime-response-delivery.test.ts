import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, instanceUserRoles, issues, heartbeatRuns, heartbeatRunEvents,
  nativeRunFinalizations, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { deploymentNotifications } from "../services/deployment-notifications.js";
import { enqueueNativeRuntimeResponse, registerNativeRuntimeResponseDelivery } from "../services/native-runtime/native-runtime-response-delivery.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { setNativeExecutionActive } from "../services/native-runtime/native-active-runs.js";
import type { PendingNativeRuntimeRequest } from "../services/native-runtime/runtime-request-resolution-authority.js";
const provider = vi.hoisted(() => ({ resolve: vi.fn(), accepted: vi.fn() }));
vi.mock("../services/native-runtime/native-session-executor.js", () => ({
  resolveNativeRuntimeRequest: (...args: unknown[]) => provider.resolve(...args),
  NativeRuntimeRequestResolutionError: class extends Error { constructor(readonly code: string) { super(code); } },
}));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let a: ReturnType<typeof createDb>, b: ReturnType<typeof createDb>;
let companyId: string, runId: string, agentId: string, userId: string;
let bridgeA: ReturnType<typeof deploymentNotifications>, bridgeB: ReturnType<typeof deploymentNotifications>;
let coordinatorA: ReturnType<typeof createDeliveryWorkCoordinator>, coordinatorB: ReturnType<typeof createDeliveryWorkCoordinator>;
let worker: ReturnType<typeof registerNativeRuntimeResponseDelivery>;
const errors: unknown[] = [];
let seq = 0;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("runtime-response-delivery-");
  a = createDb(database.connectionString); b = createDb(database.connectionString);
  companyId = randomUUID(); runId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
  const issueId = randomUUID(), identity = await currentNativeControllerIdentity();
  await a.insert(companies).values({ id: companyId, name: "Response fixture", issuePrefix: "RESP" });
  await a.insert(agents).values({ id: agentId, companyId, name: "Remote fixture" });
  await a.insert(issues).values({ id: issueId, companyId, title: "Response fixture", status: "in_progress" });
  await a.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running", nativeIssueId: issueId });
  await a.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "executing", controllerBootId: identity.bootId,
    leaseOwner: "fixture-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
  await a.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
  await a.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  coordinatorA = createDeliveryWorkCoordinator({ owner: a, canRun: () => true, onError: error => errors.push(error) });
  coordinatorB = createDeliveryWorkCoordinator({ owner: b, canRun: () => true, onError: error => errors.push(error) });
  bridgeA = deploymentNotifications(a, coordinatorA, { directDatabaseUrl: database.connectionString });
  bridgeB = deploymentNotifications(b, coordinatorB, { directDatabaseUrl: database.connectionString });
  await Promise.all([bridgeA.ready(), bridgeB.ready()]);
  provider.resolve.mockImplementation(async (input: { authorizeBeforeDispatch: () => Promise<void>; commandId: string }) => {
    await input.authorizeBeforeDispatch();
    provider.accepted(input.commandId);
    return { commandId: input.commandId };
  });
  worker = registerNativeRuntimeResponseDelivery(a, coordinatorA); await worker.ready;
}, 90_000);
afterAll(async () => {
  setNativeExecutionActive(runId, false); await worker?.stop();
  await Promise.all([bridgeA?.stop(), bridgeB?.stop()]);
  await Promise.all([coordinatorA?.stop(), coordinatorB?.stop()]);
  await Promise.all([a?.$client.end({ timeout: 1 }), b?.$client.end({ timeout: 1 })]); await database?.cleanup();
});
async function pending(): Promise<PendingNativeRuntimeRequest> {
  const request = { companyId, runId, requestId: randomUUID(), requestKind: "command_approval" as const,
    turnId: "turn-fixture", resolverPolicy: "instance_admin" as const };
  await a.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: ++seq, eventType: "runtime_request.created",
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", eventType: "runtime_request.created", sourceKind: "runner", runId,
      payload: { request: { ...request, status: "pending" } } } } });
  return request;
}
const enqueue = (request: PendingNativeRuntimeRequest) => enqueueNativeRuntimeResponse(b, { request,
  actor: { type: "user", userId, isInstanceAdmin: true }, localImplicit: false, resolution: { action: "decline" } });
async function state(requestId: string) {
  const [run] = await b.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const entries = run.result?.nativeRuntimeResponses as Record<string, { state: string }>;
  return entries?.[createHash("sha256").update(requestId).digest("hex")]?.state;
}
it("persists B's response before an owner is attached, then dispatches once through A", async () => {
  const request = await pending();
  const saved = await enqueue(request);
  expect(await enqueue(request)).toEqual(saved);
  expect(await state(request.requestId)).toBe("pending");
  expect(provider.resolve).not.toHaveBeenCalled();
  setNativeExecutionActive(runId, true);
  await expect.poll(() => state(request.requestId)).toBe("queued");
  expect(provider.resolve).toHaveBeenCalledTimes(1);
  expect(provider.resolve.mock.calls[0]?.[0].commandId).toBe(saved.commandId);
  await enqueue(request);
  expect(provider.resolve).toHaveBeenCalledTimes(1);
  await expect(enqueueNativeRuntimeResponse(b, { request, actor: { type: "user", userId, isInstanceAdmin: true },
    localImplicit: false, resolution: { action: "cancel" } })).rejects.toThrow("different response");
  expect(errors).toEqual([]);
});
it("rechecks company access even for an administrator before dispatch", async () => {
  setNativeExecutionActive(runId, false);
  const request = await pending(); await enqueue(request);
  await a.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, userId));
  setNativeExecutionActive(runId, true);
  await expect.poll(() => state(request.requestId)).toBe("denied");
  expect(provider.accepted).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
});
it("does not dispatch an answer after its request has become terminal", async () => {
  setNativeExecutionActive(runId, false);
  const request = await pending(); await enqueue(request);
  await a.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: ++seq, eventType: "runtime_request.resolved",
    payload: { prpEvent: { payload: { requestId: request.requestId } } } });
  setNativeExecutionActive(runId, true);
  await expect.poll(() => state(request.requestId)).toBe("obsolete");
  expect(provider.accepted).not.toHaveBeenCalled();
  expect(errors).toEqual([]);
});

it("retires a stale provider turn and still delivers the next pending answer", async () => {
  setNativeExecutionActive(runId, false);
  await a.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.principalId, userId));
  const stale = await pending(), current = await pending();
  await enqueue(stale);
  await enqueue(current);
  const { NativeRuntimeRequestResolutionError } = await import("../services/native-runtime/native-session-executor.js");
  provider.resolve.mockImplementation(async (input: { requestId: string; authorizeBeforeDispatch: () => Promise<void>; commandId: string }) => {
    if (input.requestId === stale.requestId) throw new NativeRuntimeRequestResolutionError("runtime_request_stale_turn", "fixture stale turn");
    await input.authorizeBeforeDispatch();
    provider.accepted(input.commandId);
    return { commandId: input.commandId };
  });
  setNativeExecutionActive(runId, true);
  await expect.poll(() => state(stale.requestId)).toBe("obsolete");
  await expect.poll(() => state(current.requestId)).toBe("queued");
  expect(provider.accepted).toHaveBeenCalledTimes(1);
  expect(errors).toEqual([]);
});
