/**
 * Plan 3 Phase E1b — guild dispatch end-to-end env wiring.
 *
 * Verifies that for `agent.kind === 'guild'` the dispatcher:
 *   1. Resolves the adapter via `adapterConfig.workerAdapterType`
 *      (not `agent.adapter_type`).
 *   2. Creates a per-run sandbox directory.
 *   3. Exposes `GUILD_ID`, `GUILD_SLUG`, `GUILD_AUTONOMY_JSON_PATH`,
 *      `GUILD_SKILLS_PATH`, `WORKER_LEARNINGS_PATH`, and
 *      `MEMORY_SERVICE_PROJECT` to the spawned worker.
 *
 * For `kind === 'agent'` the same dispatch path leaves those env keys
 * out — the existing non-guild behaviour is unchanged.
 *
 * Mechanism: the test spawns a tiny Node script via the `process`
 * adapter; the script writes `process.env` to a known file. After the
 * run completes the test reads that file and asserts the env shape.
 *
 * E1c will extend this file to assert the `available_skills.json`
 * contents; E2b to assert the worker-exit hook ingests learnings.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  skills,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat guild dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat guild dispatch (Plan 3 Phase E1b)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let testTmpRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-guild-dispatch-");
    db = createDb(tempDb.connectionString);
    // ONE heartbeatService instance shared across all tests in this
    // file so `activeRunExecutions` reflects EVERY dispatch — required
    // for the drain-on-afterEach pattern below to actually drain.
    heartbeat = heartbeatService(db);
    testTmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-guild-dispatch-test-"));
  }, 20_000);

  afterEach(async () => {
    // Drain the dispatcher BEFORE deleting anything. `drainActiveRuns`
    // returns once `activeRunExecutions` is empty, which is the LAST
    // in-memory side-effect of `executeRun`'s outer `finally` (after
    // releaseEnvironmentLeasesForRun, releaseRuntimeServicesForRun,
    // and startNextQueuedRunForAgent all complete). With that signal
    // there's no concurrent dispatcher writing rows behind our backs,
    // so the per-table delete chain in FK-aware order is safe.
    //
    // Earlier attempts using `waitForRunToFinish` alone (returns at
    // setRunStatus) and `agents.status='running'` polling (catches
    // inner-try writes but not outer-finally) both failed on CI under
    // load. TRUNCATE CASCADE deadlocked against dispatcher RowShareLock
    // holders. `drainActiveRuns` is the canonical signal.
    const drained = await heartbeat.drainActiveRuns(15_000);
    if (!drained) {
      throw new Error(
        "heartbeat-guild-dispatch.test.ts: active runs failed to drain within 15s; refusing to delete with dispatcher still writing",
      );
    }
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(skills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await fs.rm(testTmpRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  /** Tiny node script: dump process.env (filtered to the keys we care
   * about) to the path stored in TEST_ENV_DUMP_PATH. The keys must be
   * specifically named in the script because process.env's full
   * serialization is noisy and includes paperclip internals. */
  function envDumpScript(dumpPath: string) {
    return [
      `const fs = require('node:fs');`,
      `const keys = ['GUILD_ID','GUILD_SLUG','GUILD_AUTONOMY_JSON_PATH','GUILD_SKILLS_PATH','WORKER_LEARNINGS_PATH','MEMORY_SERVICE_PROJECT'];`,
      `const out = {};`,
      `for (const k of keys) { if (k in process.env) out[k] = process.env[k]; }`,
      `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(out));`,
      `process.exit(0);`,
    ].join(" ");
  }

  /** Worker script: copy GUILD_SKILLS_PATH out to a test-controlled
   * path before the outer finally cleans the sandbox. Lets the test
   * assert what the worker actually saw at start of run. */
  function skillsSnapshotCopyScript(destPath: string) {
    return [
      `const fs = require('node:fs');`,
      `const src = process.env.GUILD_SKILLS_PATH;`,
      `if (src) fs.copyFileSync(src, ${JSON.stringify(destPath)});`,
      `process.exit(0);`,
    ].join(" ");
  }

  /** Worker script: write a learnings.json file at WORKER_LEARNINGS_PATH
   * with the given payload. Atomic via .partial-then-rename per the
   * spec D12 worker contract. */
  function learningsWriteScript(learnings: {
    skills: Array<{ name: string; body: string }>;
    used?: Array<{ id: string; success: boolean }>;
  }) {
    return [
      `const fs = require('node:fs');`,
      `const dst = process.env.WORKER_LEARNINGS_PATH;`,
      `if (dst) {`,
      `  const payload = ${JSON.stringify(JSON.stringify(learnings))};`,
      `  fs.writeFileSync(dst + '.partial', payload);`,
      `  fs.renameSync(dst + '.partial', dst);`,
      `}`,
      `process.exit(0);`,
    ].join(" ");
  }

  async function setupCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip-test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("spawns a guild worker with GUILD_*/MEMORY_SERVICE_PROJECT/WORKER_LEARNINGS_PATH env", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-${agentId}.json`);

    // Stand up a fake guild instructions bundle so prepareGuildRunSandbox
    // can copy autonomy.json. The contents only need to be valid JSON.
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "guild-bundle-"));
    await fs.writeFile(
      path.join(bundleRoot, "autonomy.json"),
      JSON.stringify({ version: 1, guildName: "eng-guild-test", autonomous: ["read"] }),
      "utf-8",
    );

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "eng-guild-test",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // The dump file should exist and contain the guild env keys.
    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8"));
    expect(dumped.GUILD_ID).toBe(agentId);
    expect(dumped.GUILD_SLUG).toBe("eng-guild-test");
    expect(dumped.MEMORY_SERVICE_PROJECT).toBe("farm/eng-guild-test");
    expect(dumped.WORKER_LEARNINGS_PATH).toMatch(/paperclip-guild-run-/);
    expect(dumped.WORKER_LEARNINGS_PATH).toMatch(/learnings\.json$/);
    expect(dumped.GUILD_AUTONOMY_JSON_PATH).toMatch(/autonomy\.json$/);
    expect(dumped.GUILD_SKILLS_PATH).toMatch(/available_skills\.json$/);

    // All four sandbox paths share the same parent directory.
    const sandboxDir = path.dirname(dumped.WORKER_LEARNINGS_PATH);
    expect(path.dirname(dumped.GUILD_AUTONOMY_JSON_PATH)).toBe(sandboxDir);
    expect(path.dirname(dumped.GUILD_SKILLS_PATH)).toBe(sandboxDir);

    // available_skills.json should have been written by prepareGuildRunSandbox
    // (E1b uses an empty snapshot; E1c will populate the array).
    // The outer finally has by now cleaned the sandbox, so the file
    // is gone — but the dumped paths recorded what was visible to the
    // worker at spawn time.
  }, 30_000);

  it("non-guild dispatch leaves GUILD_*/MEMORY_SERVICE_PROJECT/WORKER_LEARNINGS_PATH absent", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-agent-${agentId}.json`);

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "regular-agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      // kind defaults to 'agent' (per DB schema default)
      adapterConfig: {
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const dumped = JSON.parse(await fs.readFile(dumpPath, "utf-8"));
    // All six guild env keys should be absent from a non-guild dispatch.
    expect(dumped).toEqual({});
  }, 30_000);

  it("guild row stored with kind='guild' is visible after dispatch", async () => {
    // Sanity check: agents.kind column is persisted across the dispatch
    // path and doesn't get clobbered. This guards against future changes
    // to updateRuntimeState or finalizeAgentStatus accidentally dropping
    // the kind value.
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const dumpPath = path.join(testTmpRoot, `env-dump-kindcheck-${agentId}.json`);
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "kindcheck-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "kindcheck-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", envDumpScript(dumpPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const rows = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, agentId));
    expect(rows[0]?.kind).toBe("guild");
  }, 30_000);

  it("(E1c) snapshot exposes only canonical, non-retired skills, ordered desc by createdAt, capped at 20", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const snapshotCopyPath = path.join(testTmpRoot, `skills-snapshot-${agentId}.json`);
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "snapshot-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "snapshot-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", skillsSnapshotCopyScript(snapshotCopyPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });

    // Set up a mix that exercises the filter + ordering:
    //   - canonical, non-retired, OLDER  -> expected at index 1
    //   - canonical, non-retired, NEWER  -> expected at index 0 (desc by createdAt)
    //   - provisional, non-retired       -> excluded (canonical-only)
    //   - canonical, retired             -> excluded (includeRetired=false)
    const now = Date.now();
    await db.insert(skills).values([
      {
        guildId: agentId,
        companyId,
        name: "older-canonical",
        body: "older canonical body",
        provenance: "canonical",
        createdAt: new Date(now - 30_000),
        updatedAt: new Date(now - 30_000),
      },
      {
        guildId: agentId,
        companyId,
        name: "newer-canonical",
        body: "newer canonical body",
        provenance: "canonical",
        createdAt: new Date(now - 5_000),
        updatedAt: new Date(now - 5_000),
      },
      {
        guildId: agentId,
        companyId,
        name: "provisional-only",
        body: "should be excluded",
        provenance: "provisional",
      },
      {
        guildId: agentId,
        companyId,
        name: "retired-canonical",
        body: "should be excluded",
        provenance: "canonical",
        retiredAt: new Date(now - 1_000),
      },
    ]);


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // The worker copied GUILD_SKILLS_PATH out before the finally
    // cleaned the sandbox. Read it now.
    const snapshot = JSON.parse(await fs.readFile(snapshotCopyPath, "utf-8"));
    expect(snapshot.guildId).toBe(agentId);
    expect(snapshot.guildSlug).toBe("snapshot-guild");
    expect(snapshot.totalCanonical).toBe(2);
    expect(snapshot.skills).toHaveLength(2);
    expect(snapshot.skills[0].name).toBe("newer-canonical");
    expect(snapshot.skills[0].body).toBe("newer canonical body");
    expect(snapshot.skills[1].name).toBe("older-canonical");
    // Each entry has the minimal {id, name, body} shape (no provenance, no FK leak).
    expect(Object.keys(snapshot.skills[0]).sort()).toEqual(["body", "id", "name"]);
    // snapshotAt is a real timestamp
    expect(() => new Date(snapshot.snapshotAt).toISOString()).not.toThrow();
  }, 30_000);

  it("(E2b) worker-exit hook ingests learnings.json as provisional skills with createdByRunId, persists resultJson marker, cleans sandbox", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "e2b-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "e2b-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: [
          "-e",
          learningsWriteScript({
            skills: [
              { name: "e2b-learned-skill-a", body: "First thing the worker learned" },
              { name: "e2b-learned-skill-b", body: "Second thing the worker learned" },
            ],
          }),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // Two new provisional skills should exist, FK'd to this run.
    const persisted = await db
      .select()
      .from(skills)
      .where(eq(skills.guildId, agentId));
    expect(persisted).toHaveLength(2);
    const names = persisted.map((row) => row.name).sort();
    expect(names).toEqual(["e2b-learned-skill-a", "e2b-learned-skill-b"]);
    for (const row of persisted) {
      expect(row.provenance).toBe("provisional");
      expect(row.createdByRunId).toBe(queued!.id);
      expect(row.companyId).toBe(companyId);
    }

    // resultJson should carry the marker with ingestedCount=2.
    const marker = (finished?.resultJson as Record<string, unknown>)
      ?.guildLearningsIngested as Record<string, unknown> | undefined;
    expect(marker).toBeTruthy();
    expect(marker?.ingestedCount).toBe(2);
    expect(marker?.rejectedCount).toBe(0);
    expect(marker?.fileMissing).toBe(false);
    expect(typeof marker?.sandboxDir).toBe("string");
    expect(() => new Date(String(marker?.at)).toISOString()).not.toThrow();
    const ingestedList = marker?.ingested as Array<{ id: string; name: string }>;
    expect(ingestedList).toHaveLength(2);
    expect(ingestedList.map((s) => s.name).sort()).toEqual([
      "e2b-learned-skill-a",
      "e2b-learned-skill-b",
    ]);

    // Sandbox dir should be gone after the explicit cleanup.
    const sandboxDir = String(marker?.sandboxDir);
    await expect(fs.access(sandboxDir)).rejects.toThrow();
  }, 30_000);

  it("(E2b) worker writes nothing: marker records fileMissing=true with zero ingested", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "e2b-nolearn-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "e2b-nolearn-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        // Worker that does nothing — no learnings.json written.
        args: ["-e", "process.exit(0);"],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    expect(await db.select().from(skills).where(eq(skills.guildId, agentId))).toEqual([]);

    const marker = (finished?.resultJson as Record<string, unknown>)
      ?.guildLearningsIngested as Record<string, unknown>;
    expect(marker.ingestedCount).toBe(0);
    expect(marker.rejectedCount).toBe(0);
    expect(marker.fileMissing).toBe(true);
  }, 30_000);

  it("(E2b) malformed learnings.json: marker records topLevelError, no skills ingested, sandbox still cleaned", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "e2b-malformed-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    const malformedScript = [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(process.env.WORKER_LEARNINGS_PATH, '{this is not json}');`,
      `process.exit(0);`,
    ].join(" ");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "e2b-malformed-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", malformedScript],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    expect(await db.select().from(skills).where(eq(skills.guildId, agentId))).toEqual([]);

    const marker = (finished?.resultJson as Record<string, unknown>)
      ?.guildLearningsIngested as Record<string, unknown>;
    expect(marker.ingestedCount).toBe(0);
    expect(marker.fileMissing).toBe(false);
    expect(typeof marker.topLevelError).toBe("string");
    expect(String(marker.topLevelError)).toMatch(/valid JSON/);

    await expect(fs.access(String(marker.sandboxDir))).rejects.toThrow();
  }, 30_000);

  it("(E3) telemetry: activity_log has guild.worker.dispatched + guild.worker.skills_ingested; heartbeat_run_events has guild.spawn + guild.ingest", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "e3-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "e3-telemetry-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: [
          "-e",
          learningsWriteScript({
            skills: [{ name: "e3-learned-once", body: "Whatever the worker learned" }],
          }),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // activity_log assertions
    const dispatchedRows = await db
      .select()
      .from(activityLog)
      .where(
        and(eq(activityLog.action, "guild.worker.dispatched"), eq(activityLog.runId, queued!.id)),
      );
    expect(dispatchedRows).toHaveLength(1);
    const dispatched = dispatchedRows[0]!;
    expect(dispatched.agentId).toBe(agentId);
    expect(dispatched.companyId).toBe(companyId);
    expect(dispatched.entityType).toBe("heartbeat_run");
    expect(dispatched.entityId).toBe(queued!.id);
    const dispatchedDetails = dispatched.details as Record<string, unknown>;
    expect(dispatchedDetails.runId).toBe(queued!.id);
    expect(dispatchedDetails.guildId).toBe(agentId);
    expect(dispatchedDetails.guildSlug).toBe("e3-telemetry-guild");
    expect(dispatchedDetails.snapshotedSkillCount).toBe(0);
    expect(dispatchedDetails.autonomyJsonAvailable).toBe(true);
    expect(typeof dispatchedDetails.sandboxDir).toBe("string");

    const ingestedRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "guild.worker.skills_ingested"),
          eq(activityLog.runId, queued!.id),
        ),
      );
    expect(ingestedRows).toHaveLength(1);
    const ingestedDetails = ingestedRows[0]!.details as Record<string, unknown>;
    expect(ingestedDetails.ingestedCount).toBe(1);
    expect(ingestedDetails.rejectedCount).toBe(0);
    expect(ingestedDetails.fileMissing).toBe(false);
    expect(ingestedDetails.guildSlug).toBe("e3-telemetry-guild");
    // Phase F follow-up: emission carries a source discriminator so
    // future audits can distinguish exit-hook vs direct-POST writes.
    expect(ingestedDetails.source).toBe("exit-hook");
    // Phase F follow-up: ingested[] entries carry a truncated body
    // preview so the consumer (ceo-chat notifier) can render the
    // skill body without re-fetching each row.
    const ingestedArr = ingestedDetails.ingested as Array<{
      id?: string;
      name?: string;
      body?: string;
    }>;
    expect(ingestedArr).toHaveLength(1);
    expect(ingestedArr[0]!.name).toBe("e3-learned-once");
    expect(ingestedArr[0]!.body).toBe("Whatever the worker learned");

    // run-event assertions
    const runEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const eventTypes = runEvents.map((row) => row.eventType);
    expect(eventTypes).toContain("guild.spawn");
    expect(eventTypes).toContain("guild.ingest");
  }, 30_000);

  it("(E3) non-guild dispatch emits NEITHER guild.worker.dispatched NOR guild.worker.skills_ingested", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "e3-non-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      // kind defaults to 'agent'
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0);"],
      },
      runtimeConfig: {},
      permissions: {},
    });


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const guildActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, queued!.id));
    const guildActions = guildActivity.map((r) => r.action).filter((a) => a.startsWith("guild."));
    expect(guildActions).toEqual([]);

    const guildEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, queued!.id));
    const guildEventTypes = guildEvents.map((r) => r.eventType).filter((t) => t.startsWith("guild."));
    expect(guildEventTypes).toEqual([]);
  }, 30_000);

  it("(E1c) snapshot is empty when the guild has no canonical skills (worker still spawns successfully)", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const snapshotCopyPath = path.join(testTmpRoot, `empty-snapshot-${agentId}.json`);
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "empty-snapshot-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "empty-snapshot-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: ["-e", skillsSnapshotCopyScript(snapshotCopyPath)],
      },
      runtimeConfig: {},
      permissions: {},
    });

    // ONE provisional skill (excluded) and ONE retired-canonical (excluded).
    // Net: zero canonical non-retired skills.
    await db.insert(skills).values([
      {
        guildId: agentId,
        companyId,
        name: "provisional-only-empty-case",
        body: "provisional",
        provenance: "provisional",
      },
      {
        guildId: agentId,
        companyId,
        name: "retired-only-empty-case",
        body: "retired canonical",
        provenance: "canonical",
        retiredAt: new Date(),
      },
    ]);


    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    const snapshot = JSON.parse(await fs.readFile(snapshotCopyPath, "utf-8"));
    expect(snapshot.totalCanonical).toBe(0);
    expect(snapshot.skills).toEqual([]);
  }, 30_000);

  it("(Plan 3b) worker writes used[] in learnings.json → success_count moves + activity row carries usedSuccessCount + recordedUse", async () => {
    const companyId = await setupCompany();
    const agentId = randomUUID();
    const bundleRoot = await fs.mkdtemp(path.join(testTmpRoot, "p3b-bundle-"));
    await fs.writeFile(path.join(bundleRoot, "autonomy.json"), "{}", "utf-8");

    // Insert agent FIRST so the FK on skills.guild_id is satisfied.
    const reusedSuccessId = randomUUID();
    const reusedFailureId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "p3b-record-use-guild",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      kind: "guild",
      adapterConfig: {
        workerAdapterType: "process",
        instructionsRootPath: bundleRoot,
        command: process.execPath,
        args: [
          "-e",
          learningsWriteScript({
            // Also write a NEW provisional skill, so we cover both
            // ingest + record-use in one batch (matches the documented
            // "mixed-batch happy path" worker contract).
            skills: [{ name: "p3b-newly-learned", body: "something I learned today" }],
            used: [
              { id: reusedSuccessId, success: true },
              { id: reusedFailureId, success: false },
            ],
          }),
        ],
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(skills).values([
      {
        id: reusedSuccessId,
        guildId: agentId,
        companyId,
        name: "p3b-success-skill",
        body: "this skill helped",
        provenance: "canonical",
      },
      {
        id: reusedFailureId,
        guildId: agentId,
        companyId,
        name: "p3b-failure-skill",
        body: "this skill was misleading",
        provenance: "canonical",
      },
    ]);

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");

    // Activity_log: usedCount/usedSuccessCount/usedFailureCount populated.
    const ingestedRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "guild.worker.skills_ingested"),
          eq(activityLog.runId, queued!.id),
        ),
      );
    expect(ingestedRows).toHaveLength(1);
    const d = ingestedRows[0]!.details as Record<string, unknown>;
    expect(d.usedCount).toBe(2);
    expect(d.usedSuccessCount).toBe(1);
    expect(d.usedFailureCount).toBe(1);
    expect(d.usedRejectedCount).toBe(0);
    const recordedUse = d.recordedUse as Array<{
      id: string;
      name: string;
      success: boolean;
    }>;
    expect(recordedUse).toHaveLength(2);
    expect(recordedUse.find((u) => u.id === reusedSuccessId)?.success).toBe(true);
    expect(recordedUse.find((u) => u.id === reusedFailureId)?.success).toBe(false);

    // skills table: counts moved.
    const persistedSuccess = await db
      .select()
      .from(skills)
      .where(eq(skills.id, reusedSuccessId));
    expect(persistedSuccess[0]!.successCount).toBe(1);
    expect(persistedSuccess[0]!.failCount).toBe(0);
    const persistedFailure = await db
      .select()
      .from(skills)
      .where(eq(skills.id, reusedFailureId));
    expect(persistedFailure[0]!.successCount).toBe(0);
    expect(persistedFailure[0]!.failCount).toBe(1);

    // Mixed batch: the new skill was also ingested.
    expect(d.ingestedCount).toBe(1);
    const ingested = d.ingested as Array<{ name: string }>;
    expect(ingested[0]!.name).toBe("p3b-newly-learned");
  }, 30_000);
});
