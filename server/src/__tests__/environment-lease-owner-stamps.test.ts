import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { currentControllerProcessStamp, currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { ENVIRONMENT_LEASE_CONTROLLER_KEY } from "../services/environment-lease-controller.js";
import { environmentService } from "../services/environments.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import {
  createOwnershipReportState,
  recheckSettlingKinds,
  runOwnershipReconciliationPass,
} from "../services/recovery/ownership-invariant-report.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  return pid;
}

suite("environment lease owner stamps (login/probe lease, teardown claim)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let environmentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-environment-lease-owner-stamps-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "ELS",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Fake Sandbox", driver: "sandbox",
      status: "active", config: { provider: "fake", image: "ubuntu:24.04" } });
  }, 30_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function report(kind: string) {
    const result = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: false });
    return { kind: result.kinds.find(entry => entry.kind === kind)!, violations: result.violations.filter(entry => entry.kind === kind) };
  }

  async function lease(id: string) {
    const [found] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, id));
    return found!;
  }

  async function claim(metadata: Record<string, unknown>) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, environmentId, status: "pending_cleanup",
      provider: "fake", providerLeaseId: `sandbox://fake/${id}`, metadata: { pendingCleanupInFlight: true, ...metadata } });
    return id;
  }

  describe("login/probe lease", () => {
    it("is owned by the process whose write made it active", async () => {
      await environmentService(db).acquireLease({ companyId, environmentId, provider: "fake",
        providerLeaseId: "sandbox://fake/login" });
      const { kind, violations } = await report("environment_login_probe_lease");
      expect(kind).toMatchObject({ inProgress: 1, verdicts: { alive: 1 }, reasons: { current_process: 1 } });
      expect(violations).toEqual([]);
    });

    it("is proven gone when that process has exited", async () => {
      await db.insert(environmentLeases).values({ companyId, environmentId, status: "active", metadata: {
        [ENVIRONMENT_LEASE_CONTROLLER_KEY]: { bootId: "earlier-boot", pid: await exitedPid(),
          hostHash: currentProcessSpaceHash(), processStartedAt: null } } });
      const { kind } = await report("environment_login_probe_lease");
      expect(kind).toMatchObject({ verdicts: { gone: 1 }, reasons: { pid_dead: 1 } });
    });

    it("names no owner when the previous release saved it without a stamp", async () => {
      await db.insert(environmentLeases).values({ companyId, environmentId, status: "active", metadata: {} });
      const { kind, violations } = await report("environment_login_probe_lease");
      expect(kind).toMatchObject({ verdicts: { unprovable: 1 }, reasons: { no_owner_stamp: 1 } });
      expect(violations.map(violation => violation.rule)).toEqual(["I1_owned"]);
    });
  });

  describe("teardown claim", () => {
    it("is owned by the claimant process stamped for this exact attempt", async () => {
      const attemptId = randomUUID();
      await claim({ pendingCleanupAttemptId: attemptId, pendingCleanupLeaseExpiresAtMs: Date.now() + 60_000,
        pendingCleanupController: { bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
          processStartedAt: null, attemptId } });
      const { kind } = await report("environment_teardown_claim");
      expect(kind).toMatchObject({ verdicts: { gone: 1 }, reasons: { pid_dead: 1 } });
    });

    it("never reads a controller stamped for an earlier attempt: the claim is a fence held by its token", async () => {
      const attemptId = randomUUID();
      await claim({ pendingCleanupAttemptId: attemptId, pendingCleanupLeaseExpiresAtMs: Date.now() + 60_000,
        pendingCleanupController: { ...currentControllerProcessStamp(), bootId: "earlier-boot", attemptId: randomUUID() } });
      const { kind, violations } = await report("environment_teardown_claim");
      expect(kind).toMatchObject({ verdicts: { alive: 1 }, reasons: { fence_held: 1 } });
      expect(violations).toEqual([]);
    });

    it("keeps an unstamped claim whose fence expired unprovable, never gone", async () => {
      await claim({ pendingCleanupAttemptId: randomUUID(), pendingCleanupLeaseExpiresAtMs: Date.now() - 1 });
      const { kind } = await report("environment_teardown_claim");
      expect(kind).toMatchObject({ verdicts: { unprovable: 1 }, reasons: { fence_expired_without_provider_proof: 1 } });
    });

    it("ends a dead claimant's fence on the next reconciler pass, refunding its counted attempt", async () => {
      const attemptId = randomUUID();
      const leaseId = await claim({ pendingCleanupAttemptId: attemptId, pendingCleanupLeaseExpiresAtMs: Date.now() + 14 * 60_000,
        pendingCleanupRetryAttempts: 3, pendingCleanupController: { bootId: "earlier-boot", pid: await exitedPid(),
          hostHash: currentProcessSpaceHash(), processStartedAt: null, attemptId, countedAttempt: true } });
      // A read-only pass never settles.
      await report("environment_teardown_claim");
      expect((await lease(leaseId)).metadata?.pendingCleanupLeaseExpiresAtMs).toBeGreaterThan(Date.now());
      const result = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      expect(result.kinds.find(entry => entry.kind === "environment_teardown_claim")).toMatchObject({ settled: 1 });
      const settled = (await lease(leaseId)).metadata!;
      expect(settled.pendingCleanupLeaseExpiresAtMs).toBeLessThanOrEqual(Date.now());
      expect(settled).toMatchObject({ pendingCleanupInFlight: true, pendingCleanupAttemptId: attemptId,
        pendingCleanupRetryAttempts: 2, pendingCleanupController: { countedAttempt: false } });
    });

    it("wakes the cleanup worker for the ended fence, and a malformed flag beside it never blocks the settle", async () => {
      const attemptId = randomUUID();
      const malformed = await claim({ pendingCleanupInFlight: "maybe", pendingCleanupAttemptId: randomUUID(),
        pendingCleanupRetryAfterMs: Date.now() + 20 * 60_000 });
      const leaseId = await claim({ pendingCleanupAttemptId: attemptId, pendingCleanupLeaseExpiresAtMs: Date.now() + 14 * 60_000,
        pendingCleanupController: { bootId: "earlier-boot", pid: await exitedPid(), hostHash: currentProcessSpaceHash(),
          processStartedAt: null, attemptId } });
      expect(await nextEnvironmentCleanupAt(db)).toBeGreaterThan(Date.now() + 10 * 60_000);
      let wakes = 0;
      const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.environmentCleanup, () => { wakes += 1; });
      try {
        const result = await recheckSettlingKinds(db);
        expect(result.settled.map(record => record.recordId)).toEqual([leaseId]);
        await vi.waitFor(() => expect(wakes).toBeGreaterThan(0));
      } finally {
        unsubscribe();
      }
      // The worker's next run follows the ended fence, not the old deadline.
      expect(await nextEnvironmentCleanupAt(db)).toBeLessThan(Date.now() + 10 * 60_000);
      expect((await lease(malformed)).metadata?.pendingCleanupInFlight).toBe("maybe");
    });

    it("never ends the fence of a live claimant, another PID space, or a claim held as a fence", async () => {
      const live = randomUUID(), foreign = randomUUID(), fenced = randomUUID();
      const expires = Date.now() + 14 * 60_000;
      const ids = [
        await claim({ pendingCleanupAttemptId: live, pendingCleanupLeaseExpiresAtMs: expires,
          pendingCleanupController: { ...currentControllerProcessStamp(), attemptId: live } }),
        await claim({ pendingCleanupAttemptId: foreign, pendingCleanupLeaseExpiresAtMs: expires,
          pendingCleanupController: { bootId: "other", pid: await exitedPid(), hostHash: "f".repeat(32), processStartedAt: null,
            attemptId: foreign } }),
        await claim({ pendingCleanupAttemptId: fenced, pendingCleanupLeaseExpiresAtMs: expires }),
      ];
      const result = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState() });
      expect(result.kinds.find(entry => entry.kind === "environment_teardown_claim")).toMatchObject({ settled: 0,
        reasons: { current_process: 1, different_process_space: 1, fence_held: 1 } });
      for (const id of ids) expect((await lease(id)).metadata?.pendingCleanupLeaseExpiresAtMs).toBe(expires);
    });

    it("names no owner for an in-flight flag without an attempt", async () => {
      await claim({});
      const { kind, violations } = await report("environment_teardown_claim");
      expect(kind).toMatchObject({ verdicts: { unprovable: 1 }, reasons: { no_owner_stamp: 1 } });
      expect(violations.map(violation => violation.rule)).toEqual(["I1_owned"]);
    });
  });
});
