import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, controllerInstances, createDb, heartbeatRuns, issues, type Db } from "../../packages/db/src/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../server/src/__tests__/helpers/embedded-postgres.js";
import { boundByProcessExit, captureWakeEvidence, servingAt, unshiftRows, wakeEvidenceForIssue, wakeEvidenceOnce, type ControllerRow } from "./wake-evidence.js";
import { runEvents } from "./evidence.js";
import { stagingMixDescription, followUpComment } from "./staging-mix.js";
import type { ChaosApi } from "./api.js";

const support = await getEmbeddedPostgresTestSupport();

const controllers: ControllerRow[] = [
  { bootId: "boot-a", epoch: 1, processSpace: "space-a", pid: 100, startedAt: 0, endedAt: 600_000 },
  { bootId: "boot-b", epoch: 2, processSpace: "space-b", pid: 200, startedAt: 500_000, endedAt: null },
];

describe("wake evidence", () => {
  it("names every server generation alive when a wake or run was created, overlap included", () => {
    const windows = [{ pid: 100, role: "primary" as const, spawnedAt: 0, exitedAt: 600_000, frozen: [] },
      { pid: 200, role: "secondary" as const, spawnedAt: 500_000, exitedAt: null, frozen: [] },
      { pid: 300, role: "primary" as const, spawnedAt: 700_000, exitedAt: null, frozen: [] }];
    expect(servingAt(100_000, controllers, windows).map(server => server.pid)).toEqual([100]);
    expect(servingAt(550_000, controllers, windows).map(server => [server.pid, server.processSpace, server.harnessRole])).toEqual([[100, "space-a", "primary"], [200, "space-b", "secondary"]]);
    expect(servingAt(800_000, controllers, windows).map(server => [server.pid, server.bootId])).toEqual([[200, "boot-b"], [300, null]]);
    expect(servingAt(null, controllers, windows)).toEqual([]);
  });

  it("ends a hard-killed controller at its recorded process exit, so it is not listed as serving a later run", () => {
    const killed: ControllerRow[] = [{ bootId: "boot-k", epoch: 1, processSpace: "space-k", pid: 100, startedAt: 1_000, endedAt: null },
      { bootId: "boot-n", epoch: 2, processSpace: "space-n", pid: 200, startedAt: 61_000, endedAt: null }];
    const windows = [{ pid: 100, role: "primary" as const, spawnedAt: 0, exitedAt: 60_000, frozen: [] },
      { pid: 200, role: "primary" as const, spawnedAt: 60_500, exitedAt: null, frozen: [] }];
    expect(boundByProcessExit(killed, windows).map(controller => controller.endedAt)).toEqual([60_000, null]);
    expect(servingAt(90_000, boundByProcessExit(killed, windows), windows).map(server => server.pid)).toEqual([200]);
    const evidence = wakeEvidenceForIssue("i1", { runs: [{ id: "r1", issueId: "i1", createdAt: 90_000, controllerBootId: "boot-n" }], wakes: [], statusChanges: [],
      controllers: killed, windows });
    expect(evidence.runs[0]!.servingAtCreate.map(server => server.pid)).toEqual([200]);
    expect(boundByProcessExit(killed, [{ pid: 100, role: "primary", spawnedAt: 500_000, exitedAt: 600_000, frozen: [] }])[0]!.endedAt).toBeNull();
  });

  it("puts aged database times back at their real times before comparing them with the harness clock", () => {
    const shifts = [{ faultId: "f1", ageMs: 26 * 3_600_000, appliedAt: 2_000_000_000_000, waveStartedAt: 1_999_999_000_000 }];
    const aged = 1_999_999_500_000 - 26 * 3_600_000;
    const [row] = unshiftRows([{ createdAt: aged, finishedAt: null, contextSnapshot: { at: new Date(aged).toISOString() } }], ["createdAt", "finishedAt"], ["contextSnapshot"], shifts);
    expect(row).toEqual({ createdAt: 1_999_999_500_000, finishedAt: null, contextSnapshot: { at: new Date(1_999_999_500_000).toISOString() } });
    expect(unshiftRows([{ createdAt: 1_999_999_600_000 }], ["createdAt"], [], shifts)[0]!.createdAt).toBe(1_999_999_600_000);
    expect(unshiftRows([{ createdAt: aged }], ["createdAt"], [], [])[0]!.createdAt).toBe(aged);
  });

  it("captures once, falls back to every issue when the task list is not available yet, and records a failure", async () => {
    const notes: Array<[string, Record<string, unknown>]> = [];
    let opened = 0;
    const capture = wakeEvidenceOnce({ databaseUrl: () => "postgres://unused", companyId: "c1", waveDir: "/nonexistent/wave", windows: [], shifts: [],
      observers: () => { throw new ReferenceError("launched is not initialized"); }, redact: text => text, note: (kind, data) => notes.push([kind, data]),
      open: () => { opened += 1; return { $client: { unsafe: async () => { throw new Error("database is gone"); }, end: async () => undefined } } as never; } });
    await Promise.all([capture(), capture()]);
    await capture();
    expect(opened).toBe(1);
    expect(notes).toEqual([["wake_evidence_failed", { error: "Error: database is gone" }]]);
  });

  it("keeps only issue status transitions, not other actions' status fields (w-20261112T223803-s7101 t001)", () => {
    const evidence = wakeEvidenceForIssue("i1", { runs: [], wakes: [], controllers: [], windows: [], statusChanges: [
      { issueId: "i1", action: "issue.created", actorType: "user", actorId: "local-board", fromStatus: null, toStatus: "todo", createdAt: 1_794_523_115_500 },
      { issueId: "i1", action: "runner.api_called", actorType: "agent", runId: "37724b59", fromStatus: null, toStatus: "201", createdAt: 1_794_525_164_631 },
      { issueId: "i1", action: "issue.updated", actorType: "agent", runId: "37724b59", fromStatus: "in_progress", toStatus: "done", createdAt: 1_794_525_165_000 },
      { issueId: "i1", action: "issue.updated", actorType: "agent", fromStatus: null, toStatus: "200", createdAt: 1_794_525_166_000 },
    ] });
    expect(evidence.statusChanges.map(change => [change.action, change.from, change.to])).toEqual([["issue.created", null, "todo"], ["issue.updated", "in_progress", "done"]]);
  });

  it("joins each run to its wake, owner and status changes for one issue", () => {
    const evidence = wakeEvidenceForIssue("i1", {
      runs: [{ id: "r1", issueId: "i1", status: "succeeded", wakeupRequestId: "w2", controllerBootId: "boot-b", createdAt: 550_000, contextSnapshot: { wakeReason: "retry" } },
        { id: "r9", issueId: "i9", status: "succeeded", wakeupRequestId: "w9", createdAt: 1 }],
      wakes: [{ id: "w1", issueId: "i1", reason: "issue_assigned", source: "assignment", createdAt: 10 },
        { id: "w2", issueId: null, reason: "retry", source: "on_demand", requestedByActorType: "user", idempotencyKey: "k", createdAt: 540_000 },
        { id: "w9", issueId: "i9", createdAt: 1 }],
      statusChanges: [{ issueId: "i1", action: "issue.updated", fromStatus: "done", toStatus: "in_progress", createdAt: 560_000 }, { issueId: "i9", toStatus: "done" }],
      controllers, windows: [],
    });
    expect(evidence.runs).toHaveLength(1);
    expect(evidence.runs[0]).toMatchObject({ runId: "r1", wakeupRequestId: "w2", contextSnapshot: { wakeReason: "retry" }, owner: { pid: 200, epoch: 2 } });
    expect(evidence.runs[0]!.servingAtCreate.map(server => server.pid)).toEqual([100, 200]);
    expect(evidence.wakes.map(wake => [wake.id, wake.reason, wake.requestedByActorType, wake.idempotencyKey])).toEqual([["w1", "issue_assigned", null, null], ["w2", "retry", "user", "k"]]);
    expect(evidence.statusChanges).toEqual([{ at: 560_000, action: "issue.updated", actorType: null, actorId: null, runId: null, from: "done", to: "in_progress" }]);
  });

  it("keeps the first 400 events and the last 200 of a long run, and says what it left out", async () => {
    const all = Array.from({ length: 1_291 }, (_, index) => ({ seq: index + 1, eventType: index === 0 ? "turn.submitted" : "log" }));
    const api = { get: async <T>(url: string) => {
      const afterSeq = Number(/afterSeq=(\d+)/.exec(url)![1]);
      return all.filter(event => event.seq > afterSeq).slice(0, 500) as T;
    } } as unknown as ChaosApi;
    const kept = await runEvents(api, "run-1");
    expect(kept).toHaveLength(601);
    expect(kept[0]).toMatchObject({ seq: 1, eventType: "turn.submitted" });
    expect(kept[400]).toEqual({ omittedEvents: 691, fromSeq: 401, toSeq: 1_091 });
    expect(kept.at(-1)).toMatchObject({ seq: 1_291 });
    const short = await runEvents({ get: async <T>(url: string) => (/afterSeq=0/.test(url) ? all.slice(0, 50) : []) as T } as unknown as ChaosApi, "run-2");
    expect(short).toHaveLength(50);
  });
});

describe("staging-mix round wording", () => {
  it("tells the agent to rerun an interrupted round and never one already in the ledger", () => {
    const text = stagingMixDescription("abcd1234", { turnMinutes: 5, rounds: 4, subtasks: 2, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 });
    expect(text).not.toMatch(/do not skip, repeat or shorten/);
    expect(text).toContain("must end up in `ledger-abcd1234.log` exactly once");
    expect(text).toContain("if that round's ROUND line is already there, the round is finished, so never run it again");
    expect(text).toContain("before its ROUND line was written, you must run that round again from the start");
    expect(followUpComment("abcd1234")).not.toMatch(/do not restart/);
    expect(followUpComment("abcd1234")).toContain("a round without one must still be run");
  });
});

describe.skipIf(!support.supported)("wake evidence against real PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("restart-chaos-wake-evidence-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("writes one file per task with the wake row, context snapshot, status changes and serving controller", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), wakeId = randomUUID(), runId = randomUUID(), bootId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake evidence", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process", status: "active",
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 3 } } });
    const wideAgentId = randomUUID();
    await db.insert(agents).values({ id: wideAgentId, companyId, name: "Wide agent", adapterType: "process", status: "active",
      runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 100 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task" });
    await db.insert(controllerInstances).values({ bootId, processSpace: "space-wake", pid: 4242, leaseExpiresAt: new Date(Date.now() + 60_000) });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", reason: "retry", triggerDetail: "manual",
      requestedByActorType: "user", requestedByActorId: "u1", idempotencyKey: "idem-1", payload: { issueId }, runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "succeeded", invocationSource: "on_demand", wakeupRequestId: wakeId,
      contextSnapshot: { wakeReason: "retry", taskId: issueId }, controllerBootId: bootId, startedAt: new Date(1_800_000_000_000), finishedAt: new Date(1_800_000_060_000) });
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { status: "done", _previous: { status: "in_progress" } } });
    const waveDir = await mkdtemp(path.join(os.tmpdir(), "wake-evidence-"));
    try {
      const written = await captureWakeEvidence({ db, companyId, waveDir, observers: [{ plan: { taskId: "t01" }, record: { issueId } }, { plan: { taskId: "t02" }, record: { issueId: null } }],
        windows: [], redact: text => text.replaceAll("u1", "[REDACTED]") });
      expect(written).toBe(1);
      const evidence = JSON.parse(await readFile(path.join(waveDir, "wake-evidence", "t01.json"), "utf8"));
      expect(evidence.runs[0]).toMatchObject({ runId, invocationSource: "on_demand", wakeupRequestId: wakeId, contextSnapshot: { wakeReason: "retry" },
        owner: { pid: 4242, processSpace: "space-wake" } });
      const slots = JSON.parse(await readFile(path.join(waveDir, "wake-evidence", "agent-slots.json"), "utf8"));
      expect(slots.agents).toEqual(expect.arrayContaining([{ agentId, maxConcurrentRuns: 3 }, { agentId: wideAgentId, maxConcurrentRuns: 50 }]));
      expect(slots.runs).toEqual([{ runId, agentId, startedAt: 1_800_000_000_000, finishedAt: 1_800_000_060_000 }]);
      expect(evidence.wakes[0]).toMatchObject({ id: wakeId, reason: "retry", source: "on_demand", triggerDetail: "manual", requestedByActorType: "user",
        requestedByActorId: "[REDACTED]", idempotencyKey: "idem-1", runId });
      expect(evidence.wakes[0].servingAtCreate.map((server: { pid: number }) => server.pid)).toEqual([4242]);
      expect(evidence.statusChanges).toMatchObject([{ action: "issue.updated", from: "in_progress", to: "done" }]);
      expect(JSON.parse(await readFile(path.join(waveDir, "wake-evidence", "servers.json"), "utf8")).controllers[0]).toMatchObject({ pid: 4242 });
      expect(await captureWakeEvidence({ db, companyId, waveDir, observers: null, windows: [], redact: text => text })).toBe(1);
      expect(JSON.parse(await readFile(path.join(waveDir, "wake-evidence", `issue-${issueId}.json`), "utf8")).runs[0]).toMatchObject({ runId });
    } finally {
      await rm(waveDir, { recursive: true, force: true });
    }
  });
});
