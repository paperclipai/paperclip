import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, afterEach, expect, it, vi } from "vitest";
import { agents, companies, issues, heartbeatRuns, nativeRunFinalizations, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { deploymentNotifications } from "../services/deployment-notifications.js";
import { nativeCancellationHasRemoteOwner, notifyNativeCancellation, registerNativeCancellationDelivery, waitForNativeCancellation } from "../services/native-runtime/native-cancellation-delivery.js";
import { currentNativeControllerIdentity } from "../services/native-runtime/native-restart-recovery.js";
import { setNativeExecutionActive } from "../services/native-runtime/native-active-runs.js";
const provider = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock("../services/native-runtime/native-session-executor.js", () => ({ cancelNativeSession: (...args: unknown[]) => provider.stop(...args) }));
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let a: ReturnType<typeof createDb>, b: ReturnType<typeof createDb>;
let companyId: string, runId: string, intentId: string;
let bridgeA: ReturnType<typeof deploymentNotifications>, bridgeB: ReturnType<typeof deploymentNotifications>;
let coordinatorA: ReturnType<typeof createDeliveryWorkCoordinator>, coordinatorB: ReturnType<typeof createDeliveryWorkCoordinator>;
let worker: ReturnType<typeof registerNativeCancellationDelivery>;
const errors: unknown[] = [];
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("cancellation-delivery-");
  a = createDb(database.connectionString); b = createDb(database.connectionString);
  companyId = randomUUID(); runId = randomUUID(); intentId = `native-cancellation:${randomUUID()}`;
  const agentId = randomUUID(), issueId = randomUUID(), identity = await currentNativeControllerIdentity();
  await a.insert(companies).values({ id: companyId, name: "Cancellation fixture", issuePrefix: "STOP" });
  await a.insert(agents).values({ id: agentId, companyId, name: "Remote fixture" });
  await a.insert(issues).values({ id: issueId, companyId, title: "Stop fixture", status: "in_progress" });
  await a.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running", nativeIssueId: issueId });
  await a.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "executing", controllerBootId: identity.bootId,
    leaseOwner: "fixture-owner", leaseExpiresAt: new Date(Date.now() + 60_000) });
  coordinatorA = createDeliveryWorkCoordinator({ owner: a, canRun: () => true, onError: error => errors.push(error) });
  coordinatorB = createDeliveryWorkCoordinator({ owner: b, canRun: () => true, onError: error => errors.push(error) });
  bridgeA = deploymentNotifications(a, coordinatorA, { directDatabaseUrl: database.connectionString });
  bridgeB = deploymentNotifications(b, coordinatorB, { directDatabaseUrl: database.connectionString });
  await Promise.all([bridgeA.ready(), bridgeB.ready()]);
  setNativeExecutionActive(runId, true);
  provider.stop.mockImplementation(async (id: string, _reason: string, options: { db: typeof a }) => {
    expect(id).toBe(runId); expect(options.db).toBe(a);
    // Simulated provider edge; the production consumer, PG transport, owner
    // selection, intent and accepting-server ACK wait are exercised for real.
    await a.transaction(async tx => {
      await notifyNativeCancellation(tx);
      await tx.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { intentId, dispatchState: "acknowledged", dispatched: true,
        acknowledgementAuditId: "fixture-audit" } } }).where(eq(heartbeatRuns.id, runId));
    });
  });
  worker = registerNativeCancellationDelivery(a, coordinatorA); await worker.ready;
}, 90_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  setNativeExecutionActive(runId, false); await worker?.stop();
  await Promise.all([bridgeA?.stop(), bridgeB?.stop()]);
  await Promise.all([coordinatorA?.stop(), coordinatorB?.stop()]);
  await Promise.all([a?.$client.end({ timeout: 1 }), b?.$client.end({ timeout: 1 })]); await database?.cleanup();
});
it("routes a committed Stop from B to its live owner A and returns only A's acknowledgement", async () => {
  await b.transaction(async tx => {
    await notifyNativeCancellation(tx);
    await tx.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", intentId,
      scope: "run", dispatchState: "pending" } } }).where(eq(heartbeatRuns.id, runId));
  });
  await expect(waitForNativeCancellation(b, { companyId, runId, intentId })).resolves.toEqual({ dispatched: true, decisionId: null, auditId: "fixture-audit" });
  expect(provider.stop).toHaveBeenCalledTimes(1); expect(errors).toEqual([]);
});
it("fails closed on a different intent and never accepts a no-op acknowledgement", async () => {
  await expect(waitForNativeCancellation(b, { companyId, runId, intentId: "wrong-intent" })).rejects.toThrow("intent_conflict");
  await b.update(heartbeatRuns).set({ resultJson: { nativeCancellation: { intentId, dispatchState: "acknowledged", dispatched: false,
    acknowledgementAuditId: "not-dispatched" } } }).where(eq(heartbeatRuns.id, runId));
  await expect(waitForNativeCancellation(b, { companyId, runId, intentId }, 50)).rejects.toThrow("pending_recovery");
});
it("distinguishes the current controller, a live replacement owner, and an expired owner", async () => {
  vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
  expect(await nativeCancellationHasRemoteOwner(b, runId)).toBe(false);
  await b.update(nativeRunFinalizations).set({ controllerBootId: "another-controller" }).where(eq(nativeRunFinalizations.runId, runId));
  expect(await nativeCancellationHasRemoteOwner(b, runId)).toBe(true);
  await b.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, runId));
  expect(await nativeCancellationHasRemoteOwner(b, runId)).toBe(false);
});
