/**
 * Multi-replica dispatch tests for the plugin job scheduler.
 *
 * The scheduler's `tick()` loop runs on EVERY server replica. Without a
 * DB-level guard, two replicas that tick concurrently both see the same due
 * job (`status='active' AND next_run_at <= now`) and both dispatch it —
 * duplicate webhooks / API calls from plugins.
 *
 * The fix under test: an atomic schedule-slot claim. Before dispatching,
 * each replica CAS-advances `next_run_at` (`UPDATE ... WHERE id = $id AND
 * next_run_at = $observed RETURNING id`). Exactly one replica's UPDATE
 * matches; the others see zero rows and skip.
 *
 * These tests run two real scheduler instances against ONE embedded
 * Postgres database (two separate connection pools) to reproduce the
 * multi-replica race.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, plugins, pluginJobs, pluginJobRuns, type Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

/**
 * Minimal worker-manager stub: every plugin "runs", and `runJob` RPCs
 * succeed after a short delay. The delay keeps both replicas' dispatches
 * in flight at the same time so the race is exercised deterministically.
 */
function stubWorkerManager(callDelayMs = 50): PluginWorkerManager {
  return {
    isRunning: () => true,
    call: async () => {
      await new Promise((resolve) => setTimeout(resolve, callDelayMs));
      return {};
    },
  } as unknown as PluginWorkerManager;
}

function testManifest(pluginKey: string): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Claim Test",
    description: "Exercises the scheduler's atomic schedule-slot claim.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["jobs.schedule"],
    entrypoints: { worker: "./dist/worker.js" },
  } as PaperclipPluginManifestV1;
}

describeEmbedded("plugin job scheduler — atomic schedule-slot claim", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let dbA: Db;
  let dbB: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-claim-");
    dbA = createDb(tempDb.connectionString);
    dbB = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seed one plugin + one active job whose nextRunAt is in the past. */
  async function seedDueJob(): Promise<{ jobId: string; seededNextRunAt: Date }> {
    const pluginId = randomUUID();
    const pluginKey = `paperclip.claimtest-${pluginId.slice(0, 8)}`;
    await dbA.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: testManifest(pluginKey),
      status: "installed",
      installOrder: 1,
    });

    const jobId = randomUUID();
    const seededNextRunAt = new Date(Date.now() - 60_000);
    await dbA.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "claim-test",
      schedule: "* * * * *",
      status: "active",
      nextRunAt: seededNextRunAt,
    });

    return { jobId, seededNextRunAt };
  }

  it("dispatches exactly once when two replicas tick concurrently", async () => {
    const { jobId, seededNextRunAt } = await seedDueJob();

    const replicaA = createPluginJobScheduler({
      db: dbA,
      jobStore: pluginJobStore(dbA),
      workerManager: stubWorkerManager(),
    });
    const replicaB = createPluginJobScheduler({
      db: dbB,
      jobStore: pluginJobStore(dbB),
      workerManager: stubWorkerManager(),
    });

    await Promise.all([replicaA.tick(), replicaB.tick()]);

    // Exactly ONE run row — the slot was claimed by exactly one replica.
    const runs = await dbA
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("schedule");
    expect(runs[0]!.status).toBe("succeeded");

    // The schedule pointer advanced past the seeded (due) value.
    const [after] = await dbA
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.id, jobId));
    expect(after!.nextRunAt).not.toBeNull();
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(seededNextRunAt.getTime());
    expect(after!.lastRunAt).not.toBeNull();
  });

  it("still dispatches normally with a single replica", async () => {
    const { jobId, seededNextRunAt } = await seedDueJob();

    const scheduler = createPluginJobScheduler({
      db: dbA,
      jobStore: pluginJobStore(dbA),
      workerManager: stubWorkerManager(10),
    });

    await scheduler.tick();

    const runs = await dbA
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");

    const [after] = await dbA
      .select()
      .from(pluginJobs)
      .where(eq(pluginJobs.id, jobId));
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(seededNextRunAt.getTime());
  });
});
