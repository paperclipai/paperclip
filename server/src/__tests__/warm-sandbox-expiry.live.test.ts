// Opt-in live provider proof for warm sandbox expiry. Not a Product E2E
// workflow and no model turn: real Daytona sandboxes, the real Daytona plugin,
// the production environment runtime (acquire, warm retain, resume), and the
// production environment cleanup worker on a real delivery coordinator, which
// must wake itself at the warm-window deadline.
//
// Prerequisite: the Daytona provider is outside the root workspace, so install
// and build it on its own first (this test loads its dist/ and its own SDK):
//   pnpm --dir packages/plugins/sandbox-providers/daytona install
//   pnpm --dir packages/plugins/sandbox-providers/daytona build
// Then, from server/:
//   PAPERCLIP_LIVE_WARM_EXPIRY=1 DAYTONA_API_KEY=... \
//     pnpm exec vitest run src/__tests__/warm-sandbox-expiry.live.test.ts
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { registerEnvironmentCleanupWork } from "../services/environment-cleanup-work.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const enabled = process.env.PAPERCLIP_LIVE_WARM_EXPIRY === "1";
const describeLive = enabled ? describe : describe.skip;
const WINDOW_MS = Number(process.env.PAPERCLIP_LIVE_WARM_EXPIRY_WINDOW_MS ?? 120_000);
const pluginUrl = new URL("../../../packages/plugins/sandbox-providers/daytona/dist/plugin.js", import.meta.url).href;
const manifestUrl = new URL("../../../packages/plugins/sandbox-providers/daytona/dist/manifest.js", import.meta.url).href;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const iso = (ms: number) => new Date(ms).toISOString();

describeLive("live Daytona warm sandbox expiry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let plugin: any;
  let manifest: any;
  let daytona: any;
  let environment: Environment;
  const sandboxIds = new Set<string>();
  const ids = { company: randomUUID(), agent: randomUUID(), environment: randomUUID(), issue: randomUUID(), plugin: randomUUID() };
  const config = { provider: "daytona", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: WINDOW_MS,
    timeoutMs: 180_000, autoStopInterval: 30, autoArchiveInterval: 60, autoDeleteInterval: 120 };
  const timeline: Array<Record<string, unknown>> = [];
  const methods: string[] = [];
  const supported = ["environmentValidateConfig", "environmentProbe", "environmentAcquireLease", "environmentResumeLease",
    "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease", "environmentRealizeWorkspace",
    "environmentExecute", "environmentInspectLease"];
  const manager = () => ({
    isRunning: () => true,
    getWorker: () => ({ supportedMethods: supported }),
    call: async (_id: string, method: string, input: any) => {
      methods.push(method);
      const handler = `on${method[0]!.toUpperCase()}${method.slice(1)}`;
      if (typeof plugin[handler] !== "function") throw new Error(`Unsupported provider operation ${method}`);
      return await plugin[handler](input);
    },
  }) as unknown as PluginWorkerManager;

  async function provider(id: string) {
    const sandbox = await daytona.get(id);
    await sandbox.refreshData();
    return { state: sandbox.state as string, autoDeleteInterval: sandbox.autoDeleteInterval as number,
      labels: sandbox.labels as Record<string, string>, updatedAt: sandbox.updatedAt as string };
  }
  async function note(step: string, providerLeaseId: string, extra: Record<string, unknown> = {}) {
    const observed = await provider(providerLeaseId);
    const entry = { at: new Date().toISOString(), step, sandboxState: observed.state,
      sandboxAutoDelete: observed.autoDeleteInterval, ...extra };
    timeline.push(entry);
    console.log(JSON.stringify(entry));
    return observed;
  }
  async function run(status: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: ids.company, agentId: ids.agent, issueId: ids.issue,
      invocationSource: "on_demand", status, nextEventSeq: 1 });
    return id;
  }
  async function leaseRows() {
    return db.select().from(environmentLeases).where(eq(environmentLeases.companyId, ids.company));
  }
  /** One warm turn: acquire the reusable lease through the production runtime,
   * then end the run the way a succeeded warm run does (keep_running). */
  async function warmTurn(label: string) {
    const runId = await run("running");
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager() });
    const acquired = await runtime.acquireRunLease({ companyId: ids.company, environment, issueId: ids.issue,
      agentId: ids.agent, heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "paperclip_runner", warmRunnerIdleTimeoutMs: WINDOW_MS });
    const providerLeaseId = acquired.lease.providerLeaseId!;
    sandboxIds.add(providerLeaseId);
    await note(`${label}: acquired`, providerLeaseId, { providerLeaseId,
      acquisition: (acquired.lease.metadata?.sandboxLeaseAcquisition as { outcome?: string } | undefined)?.outcome,
      recordedWindowMs: acquired.lease.metadata?.warmSandboxIdleTimeoutMs });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const released = await runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    expect(released).toHaveLength(1);
    const [retained] = (await leaseRows()).filter(row => row.heartbeatRunId === runId);
    expect(retained).toMatchObject({ status: "retained", leasePolicy: "reuse_by_environment", providerLeaseId });
    const windowEndsAt = retained!.lastUsedAt.getTime() + WINDOW_MS;
    await note(`${label}: run ended, lease retained`, providerLeaseId, { releasedAt: iso(retained!.lastUsedAt.getTime()),
      windowEndsAt: iso(windowEndsAt) });
    return { runId, providerLeaseId, windowEndsAt };
  }
  /** The production cleanup worker on a real coordinator, as the server
   * registers it at boot. Returns a stop function. */
  async function startCleanupWorker(workerDb: ReturnType<typeof createDb>) {
    const heartbeat = heartbeatService(workerDb, { environmentRuntime: environmentRuntimeService(workerDb, { pluginWorkerManager: manager() }) });
    const coordinator = createDeliveryWorkCoordinator({ owner: workerDb, canRun: () => true, onError: error => { console.error("cleanup worker error", (error as Error).name); } });
    const sweeps: string[] = [];
    const worker = registerEnvironmentCleanupWork(workerDb, coordinator, {
      sweepPending: async backoffMs => { sweeps.push(new Date().toISOString()); await heartbeat.sweepPendingCleanupLeases({ backoffMs }); },
      canRun: () => true,
      minimumSpacingMs: 1_000,
    });
    await worker.ready;
    return { sweeps, nextWakeAt: () => coordinator.nextWakeAt(), stop: async () => { worker.stop(); await coordinator.stop(); } };
  }
  async function waitForState(providerLeaseId: string, state: string, deadlineMs: number) {
    while (Date.now() < deadlineMs) {
      const observed = await provider(providerLeaseId);
      if (observed.state === state) return Date.now();
      await sleep(3_000);
    }
    return null;
  }

  beforeAll(async () => {
    if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY required");
    for (const url of [pluginUrl, manifestUrl]) {
      await access(new URL(url)).catch(() => {
        throw new Error("Build the Daytona provider first: pnpm --dir packages/plugins/sandbox-providers/daytona install && pnpm --dir packages/plugins/sandbox-providers/daytona build");
      });
    }
    temporary = await startEmbeddedPostgresTestDatabase("live-warm-expiry-");
    db = createDb(temporary.connectionString);
    plugin = (await import(pluginUrl)).default.definition;
    manifest = (await import(manifestUrl)).default;
    const require = createRequire(new URL("../../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
    const { Daytona } = require("@daytonaio/sdk");
    daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
    await db.insert(companies).values({ id: ids.company, name: "Disposable warm expiry", issuePrefix: "LWE" });
    await db.insert(agents).values({ id: ids.agent, companyId: ids.company, name: "No provider turn", adapterType: "paperclip_runner" });
    await db.insert(plugins).values({ id: ids.plugin, pluginKey: manifest.id, packageName: "@paperclipai/plugin-daytona",
      version: manifest.version, apiVersion: 1, categories: ["automation"], manifestJson: manifest, status: "ready", installOrder: 1 });
    await db.insert(environments).values({ id: ids.environment, name: `Warm expiry ${ids.environment.slice(0, 8)}`, driver: "sandbox", config });
    environment = (await db.select().from(environments).where(eq(environments.id, ids.environment)))[0] as unknown as Environment;
    await db.insert(issues).values({ id: ids.issue, companyId: ids.company, title: "Warm sandbox expiry", assigneeAgentId: ids.agent });
  }, 120_000);

  afterAll(async () => {
    const leftBehind: string[] = [];
    for (const id of sandboxIds) {
      try {
        const sandbox = await daytona.get(id);
        if (sandbox.labels?.["paperclip-company-id"] !== ids.company || sandbox.labels?.["paperclip-environment-id"] !== ids.environment) {
          throw new Error("Fixture cleanup ownership mismatch");
        }
        await sandbox.delete(60);
        timeline.push({ at: new Date().toISOString(), step: "cleanup: sandbox deleted", providerLeaseId: id });
      } catch (error) {
        leftBehind.push(id);
        timeline.push({ at: new Date().toISOString(), step: "cleanup failed", providerLeaseId: id, error: (error as Error).message });
      }
    }
    if (process.env.PAPERCLIP_LIVE_WARM_EXPIRY_EVIDENCE) {
      await writeFile(process.env.PAPERCLIP_LIVE_WARM_EXPIRY_EVIDENCE, JSON.stringify({ windowMs: WINDOW_MS, timeline, methods }, null, 2));
    }
    await temporary?.cleanup();
    if (leftBehind.length) {
      // The stop path disables provider auto-delete, so a sandbox left here
      // would never be reaped: fail loudly with the exact IDs to delete.
      console.error(`Live fixture sandboxes left behind: ${leftBehind.join(", ")}`);
      throw new Error(`Live fixture cleanup failed for ${leftBehind.length} sandbox(es): ${leftBehind.join(", ")}`);
    }
  }, 180_000);

  it("keeps a warm sandbox inside its window, stops it after, resumes it, and stops it again after a restart", async () => {
    const worker = await startCleanupWorker(db);
    try {
      // Turn 1.
      const first = await warmTurn("turn 1");
      expect(await nextEnvironmentCleanupAt(db)).toBe(first.windowEndsAt);
      // Inside the window: the worker sleeps until the deadline; the sandbox stays started.
      await sleep(first.windowEndsAt - Date.now() - 20_000);
      expect((await note("turn 1: 20s before window end", first.providerLeaseId)).state).toBe("started");
      // Past the window: the worker wakes by itself and stops the exact sandbox.
      const stoppedAt = await waitForState(first.providerLeaseId, "stopped", first.windowEndsAt + 90_000);
      const afterStop = await note("turn 1: stopped by cleanup worker", first.providerLeaseId,
        { secondsAfterWindowEnd: stoppedAt === null ? null : Math.round((stoppedAt - first.windowEndsAt) / 1000) });
      expect(stoppedAt).not.toBeNull();
      expect(stoppedAt!).toBeGreaterThanOrEqual(first.windowEndsAt);
      expect(afterStop.autoDeleteInterval).toBe(-1);
      const [kept] = (await leaseRows()).filter(row => row.heartbeatRunId === first.runId);
      expect(kept).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped" } } });

      // Turn 2 on the same task resumes the same sandbox.
      const second = await warmTurn("turn 2");
      expect(second.providerLeaseId).toBe(first.providerLeaseId);
      expect((await provider(second.providerLeaseId)).state).toBe("started");
    } finally {
      await worker.stop();
    }

    // Restart mid-window: a fresh database client, a freshly loaded plugin
    // module, and a new cleanup worker, as at server boot.
    const [retained] = (await leaseRows()).filter(row => row.status === "retained");
    const windowEndsAt = retained!.lastUsedAt.getTime() + WINDOW_MS;
    await sleep(Math.min(30_000, windowEndsAt - Date.now() - 30_000));
    plugin = (await import(`${pluginUrl}?restart=${randomUUID()}`)).default.definition;
    const restartedDb = createDb(temporary.connectionString);
    timeline.push({ at: new Date().toISOString(), step: "restart: new process state, cleanup worker boots", windowEndsAt: iso(windowEndsAt) });
    const restarted = await startCleanupWorker(restartedDb);
    try {
      expect((await note("restart: boot pass inside window", retained!.providerLeaseId!)).state).toBe("started");
      const stoppedAt = await waitForState(retained!.providerLeaseId!, "stopped", windowEndsAt + 90_000);
      await note("restart: stopped by rebooted cleanup worker", retained!.providerLeaseId!,
        { secondsAfterWindowEnd: stoppedAt === null ? null : Math.round((stoppedAt - windowEndsAt) / 1000) });
      expect(stoppedAt).not.toBeNull();
      expect(stoppedAt!).toBeGreaterThanOrEqual(windowEndsAt);
    } finally {
      await restarted.stop();
    }
  }, 15 * 60_000);
});
