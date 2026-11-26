/** Real, disposable Daytona target for the opt-in feedback smoke. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
import { environmentLeases, environments, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readEnvironmentCreationCleanupError, type PluginEnvironmentCreationCleanup,
  type PluginEnvironmentLease, type PluginEnvironmentTerminationReceipt } from "@paperclipai/plugin-sdk";

export async function acquireDaytonaLeaseWithCleanup(input: {
  companyId: string; environmentId: string; runId: string;
  acquire: () => Promise<PluginEnvironmentLease>;
  destroy: (cleanup: PluginEnvironmentCreationCleanup) => Promise<PluginEnvironmentTerminationReceipt | void>;
}) {
  try {
    return await input.acquire();
  } catch (error) {
    const cleanup = readEnvironmentCreationCleanupError(error);
    if (cleanup && cleanup.companyId === input.companyId && cleanup.environmentId === input.environmentId
        && (!cleanup.runId || cleanup.runId === input.runId)) {
      const receipt = await input.destroy(cleanup);
      assert.equal(receipt?.state, "destroyed", "Failed Daytona acquisition must be cleaned up");
    }
    throw error;
  }
}

export async function acquireCommentaryDaytonaTarget(db: Db, fixture: {
  companyId: string; agentId: string; issueId: string; runId: string;
}, mode: "legacy" | "native") {
  const envFile = process.env.PAPERCLIP_LIVE_DAYTONA_ENV_FILE;
  const env = envFile ? parse(await readFile(envFile)) : process.env;
  const apiKey = env.DAYTONA_API_KEY;
  const image = env.PAPERCLIP_E2E_DAYTONA_IMAGE;
  assert.ok(apiKey, "DAYTONA_API_KEY required");
  assert.match(image ?? "", /@sha256:[a-f0-9]{64}$/, "Immutable Daytona image required");
  // Import only for explicit remote execution; the optional provider is not a server dependency.
  const { default: plugin } = await import("../../packages/plugins/sandbox-providers/daytona/src/plugin.js");
  const hooks = plugin.definition;
  const environmentId = randomUUID();
  const leaseId = randomUUID();
  const config = { apiKey, image, cpu: 4, memory: 4, disk: 10, reuseLease: false,
    autoStopInterval: 5, autoArchiveInterval: 15, autoDeleteInterval: 60,
    timeoutMs: 300_000, livenessTimeoutMs: 30_000 };
  const base = { driverKey: "daytona", companyId: fixture.companyId, environmentId, issueId: fixture.issueId, config };
  await db.insert(environments).values({ id: environmentId, name: `feedback-smoke-${environmentId}`, driver: "sandbox", config: { provider: "daytona", image } });
  console.error(`Acquiring disposable ${mode} Daytona sandbox.`);
  const lease = await acquireDaytonaLeaseWithCleanup({ ...fixture, environmentId,
    acquire: () => hooks.onEnvironmentAcquireLease!({ ...base, runId: fixture.runId, agentId: fixture.agentId,
      adapterType: mode === "legacy" ? "codex_local" : "paperclip_runner",
      requestedExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString() }),
    destroy: cleanup => hooks.onEnvironmentDestroyLease!({ ...base, providerLeaseId: cleanup.providerLeaseId,
      leaseMetadata: { failedCreateCleanup: cleanup } }),
  });
  assert.ok(lease.providerLeaseId);
  console.error(`Acquired disposable ${mode} Daytona sandbox.`);
  const cleanup = async () => {
    const receipt = await hooks.onEnvironmentDestroyLease!({ ...base, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    assert.equal(receipt?.state, "destroyed", "Daytona deletion must be acknowledged");
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "completed" }).where(eq(environmentLeases.id, leaseId));
  };
  try {
    await db.insert(environmentLeases).values({ id: leaseId, companyId: fixture.companyId, environmentId,
      issueId: fixture.issueId, heartbeatRunId: fixture.runId, provider: "daytona", providerLeaseId: lease.providerLeaseId, metadata: lease.metadata });
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId, leaseId,
      remoteCwd: String(lease.metadata?.remoteCwd), shellCommand: lease.metadata?.shellCommand === "sh" ? "sh" : "bash",
      timeoutMs: 300_000, streamRunLogs: true, reusableLeaseConfigured: false,
      effectiveCapabilities: { reusableLeases: false, nativeSyncIn: true, nativeSyncOut: true,
        persistentProcessSessions: true, independentControlCommands: true, incrementalSessionOutput: true,
        concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: true },
      runnerLifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: lease.providerLeaseId },
      runner: {
        async execute(input) {
          const start = Date.now();
          const result = await hooks.onEnvironmentExecute!({ ...base, lease, ...input,
            bypassSession: input.bypassSession ?? !input.useSession });
          if (result.stdout) await input.onLog?.("stdout", result.stdout);
          if (result.stderr) await input.onLog?.("stderr", result.stderr);
          return { ...result, signal: result.signal ?? null, pid: null,
            startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - start };
        },
        syncIn: operations => hooks.onEnvironmentSyncIn!({ ...base, lease, operations }),
        syncOut: operations => hooks.onEnvironmentSyncOut!({ ...base, lease, operations }),
      },
      async getRunnerIngressEndpoint(input) {
        const refresh = async () => ({ ...await hooks.onEnvironmentRunnerIngressEndpoint!({ ...base, lease, port: input.port, path: input.path }), refresh, close: async () => {} });
        return refresh();
      },
    };
    return { target, cleanup, image, providerLeaseId: lease.providerLeaseId };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
