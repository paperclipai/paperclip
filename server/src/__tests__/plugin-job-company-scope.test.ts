/**
 * Company-scoped plugin jobs.
 *
 * Regression coverage for the defect where a scheduled job got no invocation
 * scope at all: `runJob` shipped without a company, the worker's
 * `AsyncLocalStorage` was never populated, and so every company-scoped host
 * call the handler made (`config.get`, `secrets.resolve`, `issues.*`, company
 * `state.*`) was refused with "company context is required" — on every tick,
 * forever, while the scheduler still recorded the run as succeeded.
 *
 * These run against a real embedded Postgres because the fan-out set is a SQL
 * anti-join over `plugin_company_settings`, and getting that join wrong is the
 * difference between "runs for the right tenants" and "runs for tenants that
 * disabled the plugin".
 *
 * @see doc/plugins/PLUGIN_SPEC.md §17.1 — Job scope
 */

import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  pluginJobs,
  pluginJobRuns,
  plugins,
} from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin job company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** The `job` payload of a captured `runJob` RPC call. */
type CapturedJob = {
  jobKey: string;
  runId: string;
  trigger: string;
  scheduledAt: string;
  companyId: string | null;
};

describeEmbeddedPostgres("company-scoped plugin jobs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.job-company-scope-test",
      packageName: "@paperclipai/plugin-job-company-scope-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.job-company-scope-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Job Company Scope Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany(
    name: string,
    status = "active",
    id?: string,
  ): Promise<string> {
    const companyId = id ?? randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      status,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  /**
   * A scheduler wired to the real store and DB, with the worker faked so the
   * test can read exactly what the `runJob` RPC would have carried.
   */
  function createHarness(
    options: { runJob?: () => Promise<void>; maxConcurrentJobs?: number } = {},
  ) {
    const jobStore = pluginJobStore(db);
    const captured: CapturedJob[] = [];

    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "runJob") {
          captured.push(params.job as CapturedJob);
          if (options.runJob) await options.runJob();
        }
        return null;
      }),
    } as any;

    const scheduler = createPluginJobScheduler({
      db,
      jobStore,
      workerManager,
      ...(options.maxConcurrentJobs !== undefined
        ? { maxConcurrentJobs: options.maxConcurrentJobs }
        : {}),
    });
    return { jobStore, workerManager, scheduler, captured };
  }

  /** Insert a due job row directly — the scheduler picks up anything past `nextRunAt`. */
  async function seedDueJob(
    pluginId: string,
    scope: "instance" | "company",
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "sweep",
      schedule: "*/5 * * * *",
      scope,
      status: "active",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    return jobId;
  }

  async function runsForJob(jobId: string) {
    return db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId))
      .orderBy(asc(pluginJobRuns.companyId));
  }

  // -------------------------------------------------------------------------
  // Manifest → DB
  // -------------------------------------------------------------------------

  it("defaults a job with no declared scope to instance scope", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *" },
    ]);

    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("instance");
  });

  it("persists a declared company scope, and a later change to it", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *", scope: "company" },
    ]);
    let [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("company");

    // A plugin that narrows the job back to instance scope must actually lose
    // the company fan-out — a stale `scope` would keep minting scopes the
    // manifest no longer asks for.
    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *", scope: "instance" },
    ]);
    [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("instance");
  });

  // -------------------------------------------------------------------------
  // The fan-out set
  // -------------------------------------------------------------------------

  it("counts a company with no settings row as enabled, and excludes disabled and non-active companies", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    const enabledByDefault = await seedCompany("no settings row");
    const explicitlyEnabled = await seedCompany("enabled = true");
    const disabled = await seedCompany("enabled = false");
    const paused = await seedCompany("paused", "paused");

    await db.insert(pluginCompanySettings).values([
      { pluginId, companyId: explicitlyEnabled, enabled: true },
      { pluginId, companyId: disabled, enabled: false },
    ]);

    const ids = await jobStore.listEnabledCompanyIds(pluginId);

    expect([...ids].sort()).toEqual([enabledByDefault, explicitlyEnabled].sort());
    expect(ids).not.toContain(disabled);
    expect(ids).not.toContain(paused);
  });

  it("does not let another plugin's disable row shrink this plugin's fan-out", async () => {
    const pluginId = await seedPlugin();
    const otherPluginId = randomUUID();
    await db.insert(plugins).values({
      id: otherPluginId,
      pluginKey: "paperclip.other",
      packageName: "@paperclipai/plugin-other",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {},
      status: "ready",
      installOrder: 2,
    });

    const companyId = await seedCompany("disabled for the other plugin only");
    await db.insert(pluginCompanySettings).values({
      pluginId: otherPluginId,
      companyId,
      enabled: false,
    });

    const jobStore = pluginJobStore(db);
    await expect(jobStore.listEnabledCompanyIds(pluginId)).resolves.toEqual([companyId]);
    await expect(jobStore.listEnabledCompanyIds(otherPluginId)).resolves.toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dispatch — the actual defect
  // -------------------------------------------------------------------------

  it("sends a companyId with runJob for every enabled company, and records it on the run", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(2);
    expect(captured.map((job) => job.companyId).sort()).toEqual([companyA, companyB].sort());
    for (const job of captured) {
      expect(job.jobKey).toBe("sweep");
      expect(job.trigger).toBe("schedule");
    }

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("skips a company that has disabled the plugin", async () => {
    const pluginId = await seedPlugin();
    const included = await seedCompany("included");
    const excluded = await seedCompany("excluded");
    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId: excluded,
      enabled: false,
    });
    await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured.map((job) => job.companyId)).toEqual([included]);
  });

  it("dispatches nothing — and does not fail — when a company-scoped job has no enabled companies", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(0);
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);

    // The pointer still advances, so the job is not stuck permanently due.
    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
    expect(job?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves an instance-scoped job unscoped — one run, companyId null", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "instance");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.companyId).toBeNull();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.companyId).toBeNull();
  });

  it("records a run as failed when the handler throws, per company", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness({
      runJob: async () => {
        throw new Error("handler exploded");
      },
    });
    await scheduler.tick();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "failed")).toBe(true);
    expect(runs.every((run) => run.error === "handler exploded")).toBe(true);
    expect(runs.every((run) => run.companyId !== null)).toBe(true);
  });

  it("does not let one company's failure suppress another company's run", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const failFor = [companyA, companyB].sort()[0]!;
    const jobStore = pluginJobStore(db);
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, _method: string, params: any) => {
        if (params.job.companyId === failFor) throw new Error("only this company fails");
        return null;
      }),
    } as any;
    const scheduler = createPluginJobScheduler({ db, jobStore, workerManager });

    await scheduler.tick();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    const byCompany = new Map(runs.map((run) => [run.companyId, run.status]));
    expect(byCompany.get(failFor)).toBe("failed");
    expect([...byCompany.values()].filter((status) => status === "succeeded")).toHaveLength(1);
  });

  it("reaches every company when the fan-out is wider than the concurrency cap, none twice before all once", async () => {
    const pluginId = await seedPlugin();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) seeded.push(await seedCompany(`company ${i}`));
    const jobId = await seedDueJob(pluginId, "company");

    // 5 companies, cap 2. With any *stable* ordering the same two companies
    // would win every occurrence and the other three would never run at all —
    // starvation, not lateness. Least-recently-run ordering moves a served
    // company to the back.
    const { scheduler, captured } = createHarness({ maxConcurrentJobs: 2 });

    // Group by occurrence. Runs admitted within one tick are dispatched
    // concurrently, so their arrival order is not deterministic — only the set
    // per tick is.
    const perTick: string[][] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const before = captured.length;
      await db
        .update(pluginJobs)
        .set({ nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(pluginJobs.id, jobId));
      await scheduler.tick();
      perTick.push(captured.slice(before).map((job) => job.companyId as string));
    }

    expect(perTick.map((tick) => tick.length)).toEqual([2, 2, 2]);

    // Everyone reached within ceil(5 / 2) = 3 occurrences...
    expect([...new Set(captured.map((job) => job.companyId))].sort()).toEqual(
      [...seeded].sort(),
    );
    // ...and the first four slots went to four *distinct* companies, so no one
    // took a second run while another was still waiting for its first.
    expect(new Set([...perTick[0]!, ...perTick[1]!]).size).toBe(4);

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(6);
    expect(runs.every((run) => run.companyId !== null)).toBe(true);
  });

  it("keeps fan-out progress across a scheduler restart, because the ordering is derived from run history", async () => {
    const pluginId = await seedPlugin();
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) seeded.push(await seedCompany(`company ${i}`));
    const jobId = await seedDueJob(pluginId, "company");

    const first = createHarness({ maxConcurrentJobs: 2 });
    await first.scheduler.tick();
    expect(first.captured).toHaveLength(2);

    // A brand-new scheduler — the process restarted. Any in-memory cursor or
    // carried remainder is gone. The two companies already served must still
    // not be picked ahead of the two that have never run.
    const second = createHarness({ maxConcurrentJobs: 2 });
    await db
      .update(pluginJobs)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(pluginJobs.id, jobId));
    await second.scheduler.tick();

    const servedFirst = first.captured.map((job) => job.companyId);
    const servedSecond = second.captured.map((job) => job.companyId);
    expect(servedSecond).toHaveLength(2);
    expect([...servedFirst, ...servedSecond].sort()).toEqual([...seeded].sort());
  });

  it("counts an interrupted run as service, so a company that dies mid-run cannot monopolise the fan-out", async () => {
    const pluginId = await seedPlugin();
    // Deterministic ids, smallest first for the interrupted pair. The
    // tiebreaker among never-run companies is `company_id asc`, so an ordering
    // that counted only *completed* runs would rank these two first and serve
    // them again — this test would then fail every time rather than on 5 runs
    // out of 6.
    // (They differ in the leading bytes, not the trailing ones, because the
    // test's issue prefix is derived from the first six hex digits and has a
    // unique index on it.)
    const interrupted = [
      await seedCompany("company a", "active", "10000000-0000-4000-8000-000000000000"),
      await seedCompany("company b", "active", "20000000-0000-4000-8000-000000000000"),
    ];
    const neverRun = [
      await seedCompany("company c", "active", "30000000-0000-4000-8000-000000000000"),
      await seedCompany("company d", "active", "40000000-0000-4000-8000-000000000000"),
    ];
    const jobId = await seedDueJob(pluginId, "company");

    // The occurrence that died: rows created, handlers never finished, no
    // completion ever written. Nothing reaps them, so they stay `running`.
    await db.insert(pluginJobRuns).values(
      interrupted.map((companyId) => ({
        jobId,
        pluginId,
        companyId,
        trigger: "schedule" as const,
        status: "running" as const,
      })),
    );

    const { scheduler, captured } = createHarness({ maxConcurrentJobs: 2 });
    await scheduler.tick();

    // Fairness is over *attempts*, not completions — deliberately. Retrying
    // the interrupted pair ahead of companies that have never run once is how
    // a job that reliably dies mid-run for one tenant starves every other
    // tenant forever. The interrupted companies are not dropped; they are
    // behind the never-run pair, and the next occurrence reaches them.
    expect(captured.map((job) => job.companyId).sort()).toEqual([...neverRun].sort());

    await db
      .update(pluginJobs)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(pluginJobs.id, jobId));
    await scheduler.tick();
    expect(captured.slice(2).map((job) => job.companyId).sort()).toEqual(
      [...interrupted].sort(),
    );
  });

  it("stops dispatching to a company that disables the plugin mid-pass", async () => {
    const pluginId = await seedPlugin();
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) seeded.push(await seedCompany(`company ${i}`));
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness({ maxConcurrentJobs: 2 });
    await scheduler.tick();
    expect(captured).toHaveLength(2);

    // Disable the plugin for both companies still owed a run — the ones the
    // cap deferred and that the next occurrence would otherwise serve first.
    const owed = seeded.filter(
      (companyId) => !captured.some((job) => job.companyId === companyId),
    );
    expect(owed).toHaveLength(2);
    await db.insert(pluginCompanySettings).values(
      owed.map((companyId) => ({ pluginId, companyId, enabled: false })),
    );

    await db
      .update(pluginJobs)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(pluginJobs.id, jobId));
    await scheduler.tick();

    // The next occurrence served the two that remain enabled, and neither
    // disabled company was ever dispatched.
    expect(captured).toHaveLength(4);
    for (const companyId of owed) {
      expect(captured.some((job) => job.companyId === companyId)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Manual trigger
  // -------------------------------------------------------------------------

  it("refuses to trigger a company-scoped job without a company", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual")).rejects.toThrow(
      /company-scoped/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("refuses to trigger a company-scoped job for a company that disabled the plugin", async () => {
    const pluginId = await seedPlugin();
    const disabled = await seedCompany("disabled");
    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId: disabled,
      enabled: false,
    });
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual", disabled)).rejects.toThrow(
      /not enabled for company/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("refuses to trigger an instance-scoped job for a company", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany("A");
    const jobId = await seedDueJob(pluginId, "instance");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual", companyId)).rejects.toThrow(
      /instance-scoped/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("triggers a company-scoped job for one enabled company", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    const result = await scheduler.triggerJob(jobId, "manual", companyA);

    expect(result.companyId).toBe(companyA);

    // The dispatch is intentionally backgrounded; wait for it to land.
    await vi.waitFor(async () => {
      const runs = await runsForJob(jobId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("succeeded");
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.companyId).toBe(companyA);
    expect(captured[0]?.trigger).toBe("manual");
  });
});
