/**
 * Phase 0 speed baseline driver (doc/plans/2026-11-07-ttft-baseline.md).
 *
 * Starts one isolated control plane through the restart chaos supervisor,
 * seeds the Chaos Lab, and per adapter runs:
 *   - cold: a new task (fresh provider session);
 *   - warm: a follow-up comment on the same task (provider session reuse);
 *   - restart: a task in a provider tool call when the control plane is killed
 *     (K1, SIGKILL) or stopped gracefully (K2, SIGTERM).
 * It then writes every run's run log to `<out>/baseline-data.json`. All timing
 * comes from the run log, never from Telemetry (AGENTS.md §5.7).
 *
 *   set -a; source ~/.secrets; set +a
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/ttft-baseline.ts \
 *     --adapters codex,claude,opencode --samples 5 --restarts 2
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/ttft-baseline.ts --report <out>/baseline-data.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER } from "./config.js";
import { ACTIVE_RUN_STATUSES } from "./grader.js";
import { seedChaosLab, type ChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { Timeline } from "./timeline.js";
import type { AdapterId, FaultKind } from "./types.js";
import {
  baselineRows, rankPreTurnSteps, recoverySamples, distribution,
  type BaselineEvent, type BaselineFault, type BaselineRun,
} from "./ttft-baseline-stats.js";

type Json = Record<string, unknown>;
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const TASK_TIMEOUT_MS = 8 * 60_000;

const coldTask = (nonce: string) => [
  `Baseline ${nonce}. Reply on this task with a one-line comment that says \`READY ${nonce}\`.`,
  "Do not create files, documents or other tasks. Then mark this task done.",
].join("\n");
const warmFollowUp = (nonce: string) =>
  `Follow-up ${nonce}: reply with one more one-line comment that says \`AGAIN ${nonce}\`, then mark the task done again.`;
const restartTask = (nonce: string) => [
  `Baseline restart ${nonce}. First run the shell command \`sleep 75\` and wait for it to finish.`,
  `Then reply with a one-line comment that says \`DONE ${nonce}\` and mark this task done.`,
  "Do not create files, documents or other tasks.",
].join("\n");

async function createTask(api: ChaosApi, lab: ChaosLab, adapter: AdapterId, title: string, description: string) {
  const issue = await api.post<Json>(`/api/companies/${lab.companyId}/issues`, {
    title, description, status: "todo", priority: "medium", assigneeAgentId: lab.agents[adapter].id,
  });
  return String(issue.id);
}

/** `/api/issues/:id/runs` rows carry `runId`, not `id`. */
const runIdOf = (run: Json) => String(run.runId ?? run.id);

async function runsFor(api: ChaosApi, issueId: string): Promise<Json[]> {
  return await api.get<Json[]>(`/api/issues/${issueId}/runs`, 10_000).catch(() => []);
}

/** Wait until the task has at least `minRuns` runs and none is active. */
async function waitForRest(api: ChaosApi, supervisor: ChaosSupervisor, issueId: string, minRuns: number): Promise<Json[]> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let restSince: number | null = null;
  while (Date.now() < deadline) {
    if (supervisor.serverReady) {
      const runs = await runsFor(api, issueId);
      const resting = runs.length >= minRuns && runs.every(run => !ACTIVE_RUN_STATUSES.has(String(run.status)));
      restSince = resting ? (restSince ?? Date.now()) : null;
      // A finished run can queue a continuation; confirm the rest for a few seconds.
      if (restSince !== null && Date.now() - restSince >= 6_000) return runs;
    }
    await delay(2_000);
  }
  return await runsFor(api, issueId);
}

async function allEvents(api: ChaosApi, runId: string): Promise<BaselineEvent[]> {
  const events: BaselineEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await api.get<Json[]>(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=500`, 15_000);
    for (const row of page) {
      events.push({ eventType: String(row.eventType), createdAt: String(row.createdAt),
        payload: (row.payload ?? null) as Json | null });
    }
    if (page.length < 500) return events;
    afterSeq = Number(page[page.length - 1]!.seq);
  }
}

/** Wait until the run is inside a provider tool call (or has started a turn). */
async function waitForToolCall(api: ChaosApi, issueId: string): Promise<string | null> {
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const active = (await runsFor(api, issueId)).find(run => String(run.status) === "running");
    if (active) {
      const events = await allEvents(api, runIdOf(active)).catch(() => []);
      if (events.some(event => event.eventType === "tool.execution.started")) return runIdOf(active);
    }
    await delay(1_500);
  }
  return null;
}

/**
 * Wait for each agent to pass lifecycle verification. An agent that never
 * reaches `ready` is reported as not measured, never waited on per task.
 */
async function readyAdapters(api: ChaosApi, lab: ChaosLab, adapters: AdapterId[], timeline: Timeline): Promise<AdapterId[]> {
  const deadline = Date.now() + 4 * 60_000;
  const pending = new Set(adapters);
  const ready: AdapterId[] = [];
  while (pending.size && Date.now() < deadline) {
    for (const adapter of [...pending]) {
      const agent = await api.get<Json>(`/api/agents/${lab.agents[adapter].id}`).catch(() => null);
      const state = String(agent?.lifecycleState ?? "unknown");
      if (state === "ready") { ready.push(adapter); pending.delete(adapter); }
      else if (agent?.status === "paused" && agent?.lifecycleError) {
        timeline.add("baseline_adapter_not_ready", { adapter, state, error: String(agent.lifecycleError).slice(0, 300) });
        pending.delete(adapter);
      }
    }
    if (pending.size) await delay(3_000);
  }
  for (const adapter of pending) timeline.add("baseline_adapter_not_ready", { adapter, state: "timeout" });
  return ready;
}

function report(runs: BaselineRun[], faults: BaselineFault[]): string {
  const ms = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(2)} s`;
  const lines = ["| Adapter | Env | Start | n | TTFT p50 | TTFT p95 | Boot p50 | Boot p95 | TTFT anchors |", "|---|---|---|---|---|---|---|---|---|"];
  for (const row of baselineRows(runs)) {
    lines.push(`| ${row.adapter} | ${row.environment} | ${row.warmth} | ${row.ttft.n}/${row.boot.n} | ${ms(row.ttft.p50)} | ${ms(row.ttft.p95)} | ${ms(row.boot.p50)} | ${ms(row.boot.p95)} | ${Object.entries(row.anchors).map(([k, v]) => `${k}×${v}`).join(", ") || "—"} |`);
  }
  lines.push("", "| Pre-turn step | n | p50 | p95 | Adapters |", "|---|---|---|---|---|");
  for (const step of rankPreTurnSteps(runs).slice(0, 25)) lines.push(`| \`${step.step}\` | ${step.n} | ${ms(step.p50)} | ${ms(step.p95)} | ${step.adapters.join(", ")} |`);
  const samples = recoverySamples(runs, faults);
  lines.push("", "| Adapter | Fault | Disposition | n | Recovery p50 | Recovery p95 | No provider event |", "|---|---|---|---|---|---|---|");
  const groups = new Map<string, typeof samples>();
  for (const sample of samples) {
    const key = `${sample.adapter}|${sample.kind}|${sample.disposition}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  for (const [key, group] of [...groups.entries()].sort()) {
    const [adapter, kind, disposition] = key.split("|");
    const d = distribution(group.flatMap(sample => sample.latencyMs === null ? [] : [sample.latencyMs]));
    lines.push(`| ${adapter} | ${kind} | ${disposition} | ${d.n} | ${ms(d.p50)} | ${ms(d.p95)} | ${group.length - d.n} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({ options: {
    adapters: { type: "string", default: "codex,claude,opencode" },
    samples: { type: "string", default: "5" },
    restarts: { type: "string", default: "2" },
    phases: { type: "string", default: "coldwarm,restart" },
    out: { type: "string" },
    report: { type: "string" },
  } });
  if (values.report) {
    const data = JSON.parse(await readFile(values.report, "utf8")) as { runs: BaselineRun[]; faults: BaselineFault[] };
    process.stdout.write(report(data.runs, data.faults));
    return;
  }
  const phases = new Set(values.phases!.split(",").map(value => value.trim()));
  const requested = values.adapters!.split(",").map(value => value.trim()) as AdapterId[];
  const samples = Math.max(1, Number(values.samples));
  const restarts = Math.max(0, Number(values.restarts));
  const missing = requested.map(adapter => CREDENTIAL_FOR_ADAPTER[adapter]).filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing ${missing.join(", ")}; run: set -a; source ~/.secrets; set +a`);
  const waveId = `ttft-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  const outDir = path.resolve(values.out ?? path.join(import.meta.dirname, "results", waveId));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const timeline = new Timeline(path.join(outDir, "timeline.jsonl"));
  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir: outDir, timeline });
  const tasks: Array<{ issueId: string; adapter: AdapterId; phase: BaselineRun["phase"] }> = [];
  const faults: BaselineFault[] = [];
  const runPhase = new Map<string, BaselineRun["phase"]>();
  try {
    await supervisor.start();
    const api = new ChaosApi(supervisor.baseUrl);
    const lab = await seedChaosLab({ api, env: "local", adapters: requested, concurrency: requested.length, budgetCents: 3000,
      masks: ["rc06"], fixtureRoot: supervisor.paths.temporaryRoot, waveId, timeline });
    const adapters = await readyAdapters(api, lab, requested, timeline);
    if (!adapters.length) throw new Error("No agent passed lifecycle verification");

    // Cold then warm, one task per adapter at a time, adapters in parallel.
    if (phases.has("coldwarm")) await Promise.all(adapters.map(async adapter => {
      for (let index = 0; index < samples; index += 1) {
        const nonce = `${adapter}-${index}-${Date.now().toString(36)}`;
        const issueId = await createTask(api, lab, adapter, `TTFT baseline ${nonce}`, coldTask(nonce));
        tasks.push({ issueId, adapter, phase: "cold" });
        const coldRuns = await waitForRest(api, supervisor, issueId, 1);
        for (const run of coldRuns) runPhase.set(runIdOf(run), "cold");
        timeline.add("baseline_cold_done", { adapter, issueId, runs: coldRuns.length });
        await api.post(`/api/issues/${issueId}/comments`, { body: warmFollowUp(nonce), reopen: true });
        const warmRuns = await waitForRest(api, supervisor, issueId, coldRuns.length + 1);
        for (const run of warmRuns) if (!runPhase.has(runIdOf(run))) runPhase.set(runIdOf(run), "warm");
        timeline.add("baseline_warm_done", { adapter, issueId, runs: warmRuns.length - coldRuns.length });
      }
    }));

    // Restart recovery: one in-flight tool call per adapter, then one fault crosses all of them.
    const kinds: FaultKind[] = ["K1", "K2"];
    for (let index = 0; phases.has("restart") && index < restarts * kinds.length; index += 1) {
      const kind = kinds[index % kinds.length]!;
      const inFlight = await Promise.all(adapters.map(async adapter => {
        const nonce = `${adapter}-r${index}-${Date.now().toString(36)}`;
        const issueId = await createTask(api, lab, adapter, `TTFT restart ${nonce}`, restartTask(nonce));
        tasks.push({ issueId, adapter, phase: "restart" });
        return { issueId, runId: await waitForToolCall(api, issueId) };
      }));
      const runIds = inFlight.flatMap(entry => entry.runId ? [entry.runId] : []);
      for (const runId of runIds) runPhase.set(runId, "restart");
      const receipt = await supervisor.fault(kind, 0, `ttft-baseline-${index}`);
      faults.push({ kind, readyAt: receipt.readyAt ?? Date.now(), runIds });
      await Promise.all(inFlight.map(entry => waitForRest(api, supervisor, entry.issueId, 1)));
    }

    const runs: BaselineRun[] = [];
    for (const task of tasks) {
      for (const run of await runsFor(api, task.issueId)) {
        const runId = runIdOf(run);
        runs.push({ runId, adapter: task.adapter, environment: "local",
          phase: runPhase.get(runId) ?? task.phase, events: await allEvents(api, runId) });
      }
    }
    const data = { waveId, adapters, notReady: requested.filter(adapter => !adapters.includes(adapter)), samples, restarts, gitSha: process.env.GIT_SHA ?? null, runs, faults };
    await writeFile(path.join(outDir, "baseline-data.json"), `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await writeFile(path.join(outDir, "baseline-report.md"), report(runs, faults), { mode: 0o600 });
    process.stdout.write(report(runs, faults));
    process.stdout.write(`\nWrote ${outDir}\n`);
  } finally {
    // Always stop the wrapper-owned embedded Postgres (SysV shared memory is scarce).
    await supervisor.stop().catch(error => { process.stderr.write(`supervisor stop: ${String(error)}\n`); });
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
