import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PaperclipClient, Redactor } from "./client.ts";
import { metricsCredential, parseOptions, QUALIFIED_OPENCODE_MODEL, readSecrets } from "./config.ts";
import { evaluate, type StepMetrics } from "./criteria.ts";
import { checkSpend, estimateSpend } from "./estimate.ts";
import { FakePaperclip, VirtualClock, type FakeConfig } from "./fake-paperclip.ts";
import { classifyHost, resolveTarget, TargetRefused } from "./guard.ts";
import { EXIT, main, type MainDeps } from "./main.ts";
import { Ramp, serverMetrics } from "./ramp.ts";
import { verdictOf, type RampResult } from "./report.ts";
import { ensureAgents, prepareCompany } from "./setup.ts";
import { distribution } from "./stats.ts";
import { emptyState, fileStateStore, mapLimit, type RunState } from "./state.ts";
import { runTiming } from "./workload.ts";

const TOKEN = "board-token-SECRET-4f2a9c";
const PROVIDER_KEY = "sk-or-v1-SECRET-provider-key-77";
const METRICS_TOKEN = "metrics-token-SECRET-91";
const HOST = "scale1.test.paperclip.app";
const ORIGIN = `https://${HOST}`;
const METRICS_URL = "https://metrics.scale1.test/metrics";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scale-ramp-test-"));
  dirs.push(dir);
  return dir;
}

interface Harness {
  clock: VirtualClock;
  fake: FakePaperclip;
  out: string[];
  err: string[];
  deps: MainDeps;
  fetchCalls: () => number;
  interrupt: () => void;
}

function harness(config: Partial<FakeConfig> = {}, env: Record<string, string> = {}, answer = HOST): Harness {
  const clock = new VirtualClock();
  const fake = new FakePaperclip(clock, { token: TOKEN, origin: ORIGIN, ...config });
  const out: string[] = [];
  const err: string[] = [];
  let calls = 0;
  let handler: (() => void) | null = null;
  const deps: MainDeps = {
    env: { PAPERCLIP_SCALE_TOKEN: TOKEN, OPENROUTER_API_KEY: PROVIDER_KEY, ...env },
    fetcher: async (url, init) => {
      calls += 1;
      return fake.fetch(url, init);
    },
    clock,
    out: line => out.push(line),
    err: line => err.push(line),
    confirm: async () => answer,
    onInterrupt: fn => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    random: () => 0.5,
  };
  return { clock, fake, out, err, deps, fetchCalls: () => calls, interrupt: () => handler?.() };
}

const baseArgs = (out: string, extra: string[] = []) => [
  "--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--label", "scale-test-run", "--yes",
  "--hold-minutes", "2", "--drain-minutes", "3", "--poll-seconds", "15", "--board-probe-seconds", "10", "--task-minutes", "1", ...extra,
];

async function readResult(out: string): Promise<RampResult> {
  return JSON.parse(await readFile(path.join(out, "scale-test-run", "result.json"), "utf8")) as RampResult;
}

function assertCleanedUp(fake: FakePaperclip): void {
  assert.equal(fake.liveRuns().length, 0, "no queued or running run is left");
  assert.equal(fake.agents.size, 0, "every harness agent is deleted");
  assert.ok([...fake.issues.values()].every(issue => issue.hiddenAt), "every task is archived");
  assert.equal(fake.secrets.size, 0, "the stored provider secret is deleted");
  assert.ok([...fake.projects.values()].every(project => project.archivedAt), "the project is archived");
}

const goodMetrics = (running: number) => ({
  eventLoopUtilization: 0.2 + running / 1_000, mainThreadCpu: 0.25, eventLoopDelayP99Ms: 20, statementsPerSecond: 40 * running,
  poolWaitP99Ms: 2, runEventLatenessP99Ms: 120, agentApiPreHandlerP99Ms: 15, leaseRenewalsMissed: 0,
});

describe("target guard", () => {
  it("classifies hosts", () => {
    assert.equal(classifyHost("localhost"), "local");
    assert.equal(classifyHost("app.localhost"), "local");
    assert.equal(classifyHost("127.0.0.1"), "local");
    assert.equal(classifyHost("scale1.test.paperclip.app"), "test-stack");
    assert.equal(classifyHost("chaos-a.staging.paperclip.app"), "test-stack");
    assert.equal(classifyHost("paperclip.staging.paperclip.app"), "shared-staging");
    assert.equal(classifyHost("admin.staging.paperclip.app"), "production");
    assert.equal(classifyHost("paperclip.app"), "production");
    assert.equal(classifyHost("acme.paperclip.app"), "production");
    assert.equal(classifyHost("example.com"), "production");
  });

  it("requires a target kind that matches the host", () => {
    const base = { allowSharedStaging: false, allowProductionHost: undefined };
    assert.throws(() => resolveTarget({ ...base, baseUrl: ORIGIN, kind: undefined }), /--target-kind is required/);
    assert.throws(() => resolveTarget({ ...base, baseUrl: "https://acme.paperclip.app", kind: "test-stack" }), /looks like a production host/);
    assert.throws(() => resolveTarget({ ...base, baseUrl: ORIGIN, kind: "local" }), /looks like a test-stack host/);
    assert.throws(() => resolveTarget({ ...base, baseUrl: `http://${HOST}`, kind: "test-stack" }), /must use https/);
    assert.throws(() => resolveTarget({ ...base, baseUrl: `${ORIGIN}/api`, kind: "test-stack" }), /bare origin/);
    assert.deepEqual(resolveTarget({ ...base, baseUrl: "http://localhost:3100", kind: "local" }), { baseUrl: "http://localhost:3100", host: "localhost", kind: "local" });
  });

  it("refuses production and shared staging without the second explicit flag", () => {
    const base = { allowSharedStaging: false, allowProductionHost: undefined };
    assert.throws(() => resolveTarget({ ...base, baseUrl: "https://acme.paperclip.app", kind: "production" }), TargetRefused);
    assert.throws(() => resolveTarget({ ...base, baseUrl: "https://acme.paperclip.app", kind: "production", allowProductionHost: "other.paperclip.app" }), TargetRefused);
    assert.equal(resolveTarget({ ...base, baseUrl: "https://acme.paperclip.app", kind: "production", allowProductionHost: "acme.paperclip.app" }).kind, "production");
    assert.throws(() => resolveTarget({ ...base, baseUrl: "https://paperclip.staging.paperclip.app", kind: "shared-staging" }), /owner's go-ahead/);
    assert.equal(resolveTarget({ ...base, allowSharedStaging: true, baseUrl: "https://paperclip.staging.paperclip.app", kind: "shared-staging" }).kind, "shared-staging");
  });

  it("stops before any request when the host looks like production", async () => {
    const out = await tempDir();
    const h = harness();
    const code = await main(["--base-url", "https://acme.paperclip.app", "--target-kind", "production", "--out", out, "--yes"], h.deps);
    assert.equal(code, EXIT.usage);
    assert.equal(h.fetchCalls(), 0);
    assert.match(h.err.join("\n"), /looks like a production host/);
  });

  it("stops before any request when the typed confirmation does not match", async () => {
    const out = await tempDir();
    const h = harness({}, {}, "yes");
    const args = baseArgs(out).filter(arg => arg !== "--yes");
    assert.equal(await main(args, h.deps), EXIT.usage);
    assert.equal(h.fetchCalls(), 0);
  });
});

describe("dry run and spend", () => {
  it("prints the plan and estimate and touches nothing", async () => {
    const out = await tempDir();
    const h = harness();
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--dry-run"], h.deps);
    assert.equal(code, EXIT.pass);
    assert.equal(h.fetchCalls(), 0);
    assert.deepEqual(await readdir(out), []);
    const text = h.out.join("\n");
    assert.match(text, /Ramp: 10 -> 50 -> 100 -> 200 -> 500 -> 1000 agents/);
    assert.match(text, /Estimated spend: \$\d/);
    assert.match(text, /retry_needed_zero \[finish-line\]/);
    assert.match(text, /Dry run: nothing was created or contacted/);
  });

  it("estimates tasks, sandbox-hours and cost from the steps", () => {
    const options = parseOptions(["--base-url", ORIGIN, "--target-kind", "test-stack", "--steps", "10,50", "--hold-minutes", "10", "--task-minutes", "5",
      "--drain-minutes", "10"], {}, 0);
    const estimate = estimateSpend(options);
    assert.equal(estimate.agents, 50);
    assert.equal(estimate.tasks, 10 * 2 + 50 * 2);
    assert.equal(estimate.maxTasks, 150);
    assert.equal(estimate.sandboxHours, 18.3);
    assert.equal(estimate.modelUsd, 3);
    assert.equal(estimate.totalUsd, 4.83);
  });

  it("requires --confirm-spend of at least the estimate above the threshold", async () => {
    const estimate = { totalUsd: 120 } as ReturnType<typeof estimateSpend>;
    assert.equal(checkSpend(estimate, 5, null).ok, false);
    assert.equal(checkSpend(estimate, 5, 100).ok, false);
    assert.equal(checkSpend(estimate, 5, 130).ok, true);
    assert.equal(checkSpend(estimate, 200, null).ok, true);
    const out = await tempDir();
    const h = harness();
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--yes"], h.deps);
    assert.equal(code, EXIT.usage);
    assert.equal(h.fetchCalls(), 0);
    assert.match(h.err.join("\n"), /--confirm-spend/);
  });

  it("defaults to the qualified OpenCode model of the runner", async () => {
    const source = await readFile(path.join(import.meta.dirname, "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts"), "utf8");
    const match = /QUALIFIED_OPENCODE_MODEL\s*=\s*"([^"]+)"/.exec(source);
    assert.equal(match?.[1], QUALIFIED_OPENCODE_MODEL);
  });
});

describe("criteria", () => {
  const empty = distribution([]);
  const metrics = (patch: Partial<StepMetrics> = {}): StepMetrics => ({
    step: { index: 0, concurrency: 10, holdMs: 60_000 }, startedAt: 0, endedAt: 1, tasksCreated: 10, tasksStarted: 10, tasksFinished: 10,
    tasksFailed: 0, tasksNeedingRetry: 0, runsFailed: 0, runsInterrupted: 0, runsCancelled: 0, peakRunning: 10, meanRunning: 9,
    queueWaitMs: distribution([1_000, 2_000]), taskToStartMs: empty, ttftMs: empty, firstActivityMs: distribution([4_000]), runDurationMs: empty,
    board: { requests: 10, failures: 0, ms: distribution([100, 120, 130, 140]) },
    server: { mainThreadCpuMax: null, eventLoopUtilizationMax: null, eventLoopDelayP99MsMax: null, statementsPerSecondMax: null, poolWaitP99MsMax: null,
      runEventLatenessP99MsMax: null, agentApiPreHandlerP99MsMax: null, leaseRenewalsMissed: null, samples: 0 },
    recordedSpendUsd: 0, ...patch,
  });
  const thresholds = parseOptions(["--base-url", ORIGIN, "--target-kind", "test-stack"], {}, 0).thresholds;
  const byId = (results: ReturnType<typeof evaluate>) => Object.fromEntries(results.map(result => [result.id, result.status]));

  it("reports missing server metrics as not measured, never as zero", () => {
    const results = byId(evaluate(metrics(), thresholds));
    assert.equal(results.retry_needed_zero, "pass");
    assert.equal(results.board_api_p90, "pass");
    assert.equal(results.main_thread_cpu, "not_measured");
    assert.equal(results.lease_renewals_missed_zero, "not_measured");
    assert.equal(results.run_event_lateness_p99, "not_measured");
    assert.equal(results.kill_one_process_resumes, "not_measured");
    assert.equal(byId(evaluate(metrics({ board: { requests: 0, failures: 0, ms: empty } }), thresholds)).board_api_p90, "not_measured");
  });

  it("fails each finish-line threshold it can measure", () => {
    const server = { mainThreadCpuMax: 0.7, eventLoopUtilizationMax: 0.5, eventLoopDelayP99MsMax: 10, statementsPerSecondMax: 1, poolWaitP99MsMax: 1,
      runEventLatenessP99MsMax: 1_500, agentApiPreHandlerP99MsMax: 100, leaseRenewalsMissed: 2, samples: 3 };
    const results = byId(evaluate(metrics({ tasksNeedingRetry: 1, peakRunning: 8, board: { requests: 4, failures: 1, ms: distribution([100, 600, 700]) }, server }), thresholds));
    assert.deepEqual(results, {
      retry_needed_zero: "fail", failed_runs_zero: "pass", tasks_rested_not_done_zero: "pass", concurrency_reached: "fail", board_api_p90: "fail", board_api_errors_zero: "fail",
      queue_wait_p95: "pass", first_activity_p95: "pass", main_thread_cpu: "fail", run_event_lateness_p99: "fail", agent_api_pre_handler_p99: "fail",
      lease_renewals_missed_zero: "fail", kill_one_process_resumes: "not_measured",
    });
  });

  it("only evaluates retry and failed runs as immediate stops", () => {
    assert.deepEqual(evaluate(metrics(), thresholds, true).map(result => result.id), ["retry_needed_zero", "failed_runs_zero"]);
  });

  it("reads first token and first activity from run spans, with an event fallback", () => {
    const created = Date.parse("2026-11-14T10:00:00Z");
    const spans = runTiming([
      { eventType: "run.performance.span", createdAt: "2026-11-14T10:00:01Z", payload: { span: "heartbeat.queue", startOffsetMs: 200, durationMs: 800 } },
      { eventType: "run.performance.span", createdAt: "2026-11-14T10:00:06Z", payload: { span: "task.time_to_first_token", startOffsetMs: 0, durationMs: 6_200 } },
    ], created);
    assert.deepEqual(spans, { ttftMs: 6_000, firstActivityMs: null });
    const fallback = runTiming([{ eventType: "tool.execution.started", createdAt: "2026-11-14T10:00:03Z" }, { eventType: "item.delta", createdAt: "2026-11-14T10:00:07Z" }], created);
    assert.deepEqual(fallback, { ttftMs: 7_000, firstActivityMs: 3_000 });
  });
});

describe("server metrics endpoint contract", () => {
  const fixture = JSON.parse(readFileSync(new URL("./server-metrics.fixture.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const SERVER_METRICS_URL = `${ORIGIN}/api/instance/server-metrics`;

  it("parses every finish-line field of the server's own serialized response except pool wait, which the server does not measure", () => {
    const parsed = serverMetrics([fixture, { ...fixture, leaseRenewalsMissed: 3 }]);
    assert.deepEqual(parsed, {
      mainThreadCpuMax: fixture.mainThreadCpu, eventLoopUtilizationMax: fixture.eventLoopUtilization, eventLoopDelayP99MsMax: fixture.eventLoopDelayP99Ms,
      statementsPerSecondMax: fixture.statementsPerSecond, poolWaitP99MsMax: null, runEventLatenessP99MsMax: fixture.runEventLatenessP99Ms,
      agentApiPreHandlerP99MsMax: fixture.agentApiPreHandlerP99Ms, leaseRenewalsMissed: 2, samples: 2,
    });
    assert.equal("poolWaitP99Ms" in fixture, false);
  });

  it("counts missed lease renewals per server process, so samples from several processes never cancel out", () => {
    const parsed = serverMetrics([
      { processId: "a", leaseRenewalsMissed: 5 }, { processId: "b", leaseRenewalsMissed: 0 },
      { processId: "a", leaseRenewalsMissed: 6 }, { processId: "b", leaseRenewalsMissed: 2 }, { processId: "a", leaseRenewalsMissed: 6 },
    ]);
    assert.equal(parsed.leaseRenewalsMissed, 3);
  });

  it("counts the full counter of a process that started during the run, so a restart cannot hide a missed renewal", () => {
    const runStartedAt = 1_000_000;
    const earlier = [{ processId: "a", uptimeSec: 3_600, sampledAt: runStartedAt + 10_000, leaseRenewalsMissed: 4 }];
    const parsed = serverMetrics([
      { processId: "a", uptimeSec: 3_630, sampledAt: runStartedAt + 40_000, leaseRenewalsMissed: 4 },
      { processId: "b", uptimeSec: 20, sampledAt: runStartedAt + 70_000, leaseRenewalsMissed: 1 },
      { processId: "b", uptimeSec: 35, sampledAt: runStartedAt + 85_000, leaseRenewalsMissed: 1 },
    ], { earlier, runStartedAt });
    assert.equal(parsed.leaseRenewalsMissed, 1);
  });

  it("keeps a process's counter baseline from earlier steps", () => {
    const runStartedAt = 1_000_000;
    const earlier = [
      { processId: "a", uptimeSec: 3_600, sampledAt: runStartedAt + 10_000, leaseRenewalsMissed: 4 },
      { processId: "a", uptimeSec: 3_650, sampledAt: runStartedAt + 60_000, leaseRenewalsMissed: 6 },
    ];
    const parsed = serverMetrics([{ processId: "a", uptimeSec: 3_700, sampledAt: runStartedAt + 110_000, leaseRenewalsMissed: 7 }],
      { earlier, runStartedAt });
    assert.equal(parsed.leaseRenewalsMissed, 1);
    assert.equal(serverMetrics([{ processId: "a", uptimeSec: 3_700, sampledAt: runStartedAt + 110_000, leaseRenewalsMissed: 7 }], { runStartedAt })
      .leaseRenewalsMissed, 0, "a process that predates the run and is first seen now starts from its first sample");
  });

  it("sends the board token to a metrics URL on the target origin, and no token to another origin", () => {
    const options = parseOptions(["--base-url", ORIGIN, "--target-kind", "test-stack"], { PAPERCLIP_SCALE_METRICS_URL: SERVER_METRICS_URL }, 0);
    assert.equal(metricsCredential(options, readSecrets({ PAPERCLIP_SCALE_TOKEN: TOKEN }, null)), TOKEN);
    assert.equal(metricsCredential(options, readSecrets({ PAPERCLIP_SCALE_TOKEN: TOKEN, PAPERCLIP_SCALE_METRICS_TOKEN: METRICS_TOKEN }, null)), METRICS_TOKEN);
    const elsewhere = parseOptions(["--base-url", ORIGIN, "--target-kind", "test-stack"], { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL }, 0);
    assert.equal(metricsCredential(elsewhere, readSecrets({ PAPERCLIP_SCALE_TOKEN: TOKEN }, null)), null);
  });

  it("measures the server criteria from the server metrics endpoint with the board token in the authorization header", async () => {
    const out = await tempDir();
    const h = harness({ metricsUrl: SERVER_METRICS_URL, metrics: () => fixture }, { PAPERCLIP_SCALE_METRICS_URL: SERVER_METRICS_URL });
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const result = await readResult(out);
    const metricsRequests = h.fake.requests.filter(request => request.url === SERVER_METRICS_URL);
    assert.ok(metricsRequests.length > 0);
    assert.ok(metricsRequests.every(request => request.authorization === `Bearer ${TOKEN}`));
    assert.equal(result.sources.serverMetrics, "PAPERCLIP_SCALE_METRICS_URL");
    const statuses = Object.fromEntries(result.steps[0]!.criteriaFinal.map(criterion => [criterion.id, criterion.status]));
    for (const id of ["main_thread_cpu", "run_event_lateness_p99", "agent_api_pre_handler_p99"]) assert.equal(statuses[id], "pass", id);
    assert.equal(statuses.lease_renewals_missed_zero, "pass");
  });
});

describe("ramp against the fake API", () => {
  it("ramps every step, measures it, passes with a metrics endpoint and cleans up", async () => {
    const out = await tempDir();
    const h = harness({ metricsUrl: METRICS_URL, metrics: goodMetrics }, { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL, PAPERCLIP_SCALE_METRICS_TOKEN: METRICS_TOKEN });
    const code = await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "incomplete", "the process-kill criterion is never measured here");
    assert.equal(code, EXIT.incomplete);
    assert.deepEqual(result.notMeasured, ["kill_one_process_resumes"]);
    assert.equal(result.steps.length, 2);
    const [first, second] = result.steps;
    assert.equal(first!.concurrency, 2);
    assert.equal(second!.metrics.peakRunning, 4);
    assert.ok(first!.metrics.tasksFinished >= 2);
    assert.equal(second!.metrics.tasksNeedingRetry, 0);
    assert.ok(second!.metrics.firstActivityMs.n > 0);
    assert.ok(second!.metrics.board.ms.n >= 3);
    assert.equal(second!.metrics.server.statementsPerSecondMax, 160);
    assert.ok(second!.criteriaFinal.filter(criterion => criterion.id !== "kill_one_process_resumes").every(criterion => criterion.status === "pass"));
    assert.equal(result.sources.serverMetrics, "PAPERCLIP_SCALE_METRICS_URL");
    assert.ok(result.recordedSpendUsd! > 0);
    const agents = h.fake.requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/agents"));
    assert.equal(agents.length, 4, "agents are created per step up to the largest step");
    const payload = JSON.parse(agents[0]!.body!);
    assert.equal(payload.adapterConfig.model, QUALIFIED_OPENCODE_MODEL);
    assert.equal(payload.runtimeConfig.heartbeat.maxConcurrentRuns, 1);
    assert.equal(payload.adapterConfig.env.OPENROUTER_API_KEY.type, "secret_ref");
    assertCleanedUp(h.fake);
    assert.ok([...h.fake.companies.values()].every(company => company.status === "archived"), "the created company is archived");
    assert.equal(result.cleanup!.errors.length, 0);
    assert.equal(result.cleanup!.activeSandboxLeases, 0);
  });

  it("reports missing optional sources as not measured", async () => {
    const out = await tempDir();
    const h = harness();
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "incomplete");
    assert.match(result.sources.serverMetrics!, /not measured/);
    assert.ok(result.notMeasured.includes("main_thread_cpu"));
    const summary = await readFile(path.join(out, "scale-test-run", "SUMMARY.md"), "utf8");
    assert.match(summary, /Event-loop utilization max: not measured/);
    assert.doesNotMatch(summary, /Event-loop utilization max: 0\b/);
  });

  it("stops on the first failed criterion and never starts the next step", async () => {
    const out = await tempDir();
    const h = harness({ failWhenRunningAbove: 3 });
    const code = await main(baseArgs(out, ["--steps", "2,4,8"]), h.deps);
    const result = await readResult(out);
    assert.equal(code, EXIT.fail);
    assert.equal(result.verdict, "fail");
    assert.equal(result.stop!.stepIndex, 1);
    assert.equal(result.stop!.criterion, "failed_runs_zero");
    assert.equal(result.steps.length, 2);
    const agents = h.fake.requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/agents"));
    assert.equal(agents.length, 4, "the 8-agent step never created agents");
    assertCleanedUp(h.fake);
  });

  it("stops when a task offers Retry", async () => {
    const out = await tempDir();
    const h = harness({ failWhenRunningAbove: 1, retryOnFailure: true });
    await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "fail");
    assert.equal(result.stop!.stepIndex, 0);
    assert.ok(["retry_needed_zero", "failed_runs_zero"].includes(result.stop!.criterion!));
    assert.ok(result.steps[0]!.metrics.tasksNeedingRetry + result.steps[0]!.metrics.runsFailed > 0);
  });

  it("fails a step whose board requests are slow", async () => {
    const out = await tempDir();
    const h = harness({ boardLatencyMs: running => running >= 3 ? 900 : 50 });
    await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "fail");
    assert.equal(result.stop!.criterion, "board_api_p90");
    assert.equal(result.stop!.stepIndex, 1);
  });

  it("fails a step that cannot reach its concurrency", async () => {
    const out = await tempDir();
    const h = harness({ capacity: 2 });
    await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.stop!.criterion, "concurrency_reached");
    assert.equal(result.steps[1]!.metrics.peakRunning, 2);
  });

  it("stops creating tasks at the task cap and grades the run incomplete", async () => {
    const out = await tempDir();
    const h = harness({ metricsUrl: METRICS_URL, metrics: goodMetrics }, { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL });
    await main(baseArgs(out, ["--steps", "2", "--max-tasks", "3"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.tasksCreated, 3);
    assert.equal(result.taskCapReached, true);
    assert.equal(result.verdict, "incomplete");
    assert.ok(result.incompleteReasons.some(reason => reason.includes("task cap")));
  });

  it("grades a run incomplete when tasks are still open after the drain", async () => {
    const out = await tempDir();
    const h = harness({ runDurationMs: 20 * 60_000 });
    await main(baseArgs(out, ["--steps", "2", "--min-concurrency-ratio", "0.5"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.drained, false);
    assert.ok(result.openTasksAtEnd > 0);
    assert.ok(result.incompleteReasons.some(reason => reason.includes("still open")));
    assertCleanedUp(h.fake);
  });

  it("creates no more tasks once interrupted", async () => {
    const out = await tempDir();
    const h = harness();
    const original = h.deps.fetcher;
    h.deps.fetcher = async (url, init) => {
      if (init.method === "POST" && new URL(url).pathname.endsWith("/issues")) h.interrupt();
      return original(url, init);
    };
    await main(baseArgs(out, ["--steps", "4"]), h.deps);
    assert.equal(h.fake.issues.size, 1);
    assertCleanedUp(h.fake);
  });

  it("keeps tracking its runs when the company run list is full of other runs", async () => {
    const out = await tempDir();
    const h = harness({ metricsUrl: METRICS_URL, metrics: goodMetrics }, { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL });
    h.fake.addNoiseRuns(1_000);
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const result = await readResult(out);
    assert.match(result.sources.runsAndTasks!, /full/);
    assert.equal(result.steps[0]!.metrics.peakRunning, 2);
    assert.ok(result.steps[0]!.metrics.tasksFinished >= 2);
    assert.ok(result.recordedSpendUsd! > 0);
    assert.ok(result.drained, "finished runs are not left counted as running");
  });

  it("cleans up after a crash in the middle of the ramp", async () => {
    const out = await tempDir();
    const h = harness({ failRequest: (method, route, count) => method === "POST" && route.endsWith("/issues") && count === 5 ? { status: 500, body: "boom" } : null });
    const code = await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(code, EXIT.error);
    assert.equal(result.verdict, "error");
    assert.match(result.error!, /returned 500/);
    assertCleanedUp(h.fake);
  });

  it("cleans up when interrupted", async () => {
    const out = await tempDir();
    const h = harness();
    const original = h.deps.fetcher;
    let requests = 0;
    h.deps.fetcher = async (url, init) => {
      requests += 1;
      if (requests === 40) h.interrupt();
      return original(url, init);
    };
    await main(baseArgs(out, ["--steps", "2,4"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "interrupted");
    assertCleanedUp(h.fake);
  });

  it("finishes a cleanup with --cleanup-only after the harness process died", async () => {
    const out = await tempDir();
    const h = harness();
    const options = parseOptions(baseArgs(out, ["--steps", "2"]), h.deps.env, h.clock.now());
    const api = new PaperclipClient(options.target, TOKEN, h.deps.fetcher, h.clock, new Redactor([TOKEN]));
    const store = fileStateStore(options.outDir);
    const state: RunState = emptyState(options.label, options.target.baseUrl, h.clock.now());
    await prepareCompany({ api, options, state, store, credential: PROVIDER_KEY, log: () => {} });
    let ticks = 0;
    await new Ramp({ api, clock: h.clock, fetcher: h.deps.fetcher, options, state, store, maxTasks: 100, spendCapUsd: 100, metricsToken: null,
      log: () => {}, shouldStop: () => (ticks += 1) > 6 }).run();
    assert.ok(h.fake.liveRuns().length > 0, "the dead harness left live runs");
    assert.ok(h.fake.agents.size > 0);
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--cleanup-only", "scale-test-run", "--yes"], h.deps);
    assert.equal(code, EXIT.pass);
    assertCleanedUp(h.fake);
    assert.ok([...h.fake.companies.values()].every(company => company.status === "archived"));
  });

  it("archives a task the state file never recorded", async () => {
    const out = await tempDir();
    const h = harness();
    const options = parseOptions(baseArgs(out, ["--steps", "2"]), h.deps.env, h.clock.now());
    const api = new PaperclipClient(options.target, TOKEN, h.deps.fetcher, h.clock, new Redactor([TOKEN]));
    const store = fileStateStore(options.outDir);
    const state: RunState = emptyState(options.label, options.target.baseUrl, h.clock.now());
    await prepareCompany({ api, options, state, store, credential: PROVIDER_KEY, log: () => {} });
    await ensureAgents({ api, options, state, store, count: 2 });
    const recorded = await api.post<{ id: string }>(`/api/companies/${state.companyId}/issues`, { title: "recorded", assigneeAgentId: state.agentIds[0] });
    state.taskIds.push(recorded.id);
    await store.save(state);
    const unrecorded = await api.post<{ id: string }>(`/api/companies/${state.companyId}/issues`, { title: "unrecorded", assigneeAgentId: state.agentIds[1] });
    assert.equal(await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--cleanup-only", "scale-test-run", "--yes"], h.deps), EXIT.pass);
    assert.ok(h.fake.issues.get(unrecorded.id)!.hiddenAt);
    assertCleanedUp(h.fake);
  });

  it("finds the run by name for --cleanup-only when the state file is gone", async () => {
    const out = await tempDir();
    const h = harness();
    const options = parseOptions(baseArgs(out, ["--steps", "2"]), h.deps.env, h.clock.now());
    const api = new PaperclipClient(options.target, TOKEN, h.deps.fetcher, h.clock, new Redactor([TOKEN]));
    const state: RunState = emptyState(options.label, options.target.baseUrl, h.clock.now());
    const otherCompany = h.fake.addMemberCompany("Someone else");
    await prepareCompany({ api, options, state, store: fileStateStore(path.join(out, "discarded")), credential: PROVIDER_KEY, log: () => {} });
    await api.post(`/api/companies/${otherCompany}/agents`, { name: "Unrelated agent" });
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--cleanup-only", "scale-test-run", "--yes"], h.deps);
    assert.equal(code, EXIT.pass);
    assert.equal(h.fake.secrets.size, 0);
    assert.deepEqual([...h.fake.agents.values()].map(agent => agent.name), ["Unrelated agent"], "only objects carrying the run id are touched");
    assert.equal(h.fake.companies.get(otherCompany)!.status, "active");
  });

  it("uses a supplied company when the instance cannot create one", async () => {
    const out = await tempDir();
    const h = harness({ cloudManaged: true });
    const refused = await main(baseArgs(out, ["--steps", "2"]), h.deps);
    assert.equal(refused, EXIT.error);
    assert.match((await readResult(out)).error!, /pass --company/);
    const companyId = h.fake.addMemberCompany("Existing workspace");
    const out2 = await tempDir();
    const code = await main(baseArgs(out2, ["--steps", "2", "--company", companyId]), h.deps);
    assert.equal(code, EXIT.incomplete);
    assertCleanedUp(h.fake);
    assert.equal(h.fake.companies.get(companyId)!.status, "active", "a supplied company is never archived");
  });
});

describe("state and parallel work", () => {
  it("stops assigning work after a failure and waits for started work", async () => {
    const started: number[] = [];
    let running = 0;
    let finishedAfterFailure = 0;
    let failed = false;
    await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async item => {
      started.push(item);
      running += 1;
      await new Promise(resolve => setTimeout(resolve, item === 2 ? 1 : 10));
      running -= 1;
      if (item === 2) {
        failed = true;
        throw new Error("create failed");
      }
      if (failed) finishedAfterFailure += 1;
    }), /create failed/);
    assert.equal(running, 0, "every started worker finished before the error surfaced");
    assert.deepEqual(started, [1, 2, 3], "no item was started after the failure");
    assert.equal(finishedAfterFailure, 2);
  });

  it("keeps state.json readable under overlapping saves", async () => {
    const dir = await tempDir();
    const store = fileStateStore(dir);
    const state = emptyState("scale-test-run", ORIGIN, 0);
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.save({ ...state, agentIds: Array.from({ length: index + 1 }, (_, n) => `agent-${n}`) })));
    const saved = await store.load();
    assert.equal(saved!.agentIds.length, 25);
    assert.deepEqual(await readdir(dir), ["state.json"]);
  });
});

describe("credentials", () => {
  it("never appear in output, results or state files", async () => {
    const out = await tempDir();
    const h = harness({
      metricsUrl: METRICS_URL, metrics: goodMetrics,
      failRequest: (method, route, count) => method === "GET" && route.endsWith("/sidebar-badges") && count === 1
        ? { status: 400, body: `bad request with Authorization: Bearer ${TOKEN} and key ${PROVIDER_KEY}` } : null,
    }, { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL, PAPERCLIP_SCALE_METRICS_TOKEN: METRICS_TOKEN });
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const files = await readdir(path.join(out, "scale-test-run"));
    assert.ok(files.includes("result.json") && files.includes("state.json") && files.includes("SUMMARY.md"));
    const written = await Promise.all(files.map(file => readFile(path.join(out, "scale-test-run", file), "utf8")));
    const everything = [...h.out, ...h.err, ...written].join("\n");
    for (const secret of [TOKEN, PROVIDER_KEY, METRICS_TOKEN]) assert.ok(!everything.includes(secret), `output leaked ${secret.slice(0, 12)}`);
    assert.ok(h.fake.requests.some(request => request.body?.includes(PROVIDER_KEY)), "the key reaches the instance only through its secrets API");
    assert.ok(h.fake.requests.filter(request => request.body?.includes(PROVIDER_KEY)).every(request => new URL(request.url).pathname.endsWith("/secrets")));
  });

  it("redacts bearer tokens and known values", () => {
    const redactor = new Redactor([TOKEN, null, "abc"]);
    assert.equal(redactor.text(`x ${TOKEN} y`), "x [redacted] y");
    assert.equal(redactor.text("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [redacted]");
    assert.equal(redactor.text("abc"), "abc");
  });

  it("scores an empty outcome as an error", () => {
    assert.equal(verdictOf(null, "boom"), "error");
  });
});
