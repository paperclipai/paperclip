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
  baselineRows, rankPreTurnSteps, recoverySamples, distribution, openShellExecutions,
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
/** The long call a restart sample must interrupt. */
const RESTART_SLEEP_MARKER = "time.sleep(75)";
const restartTask = (nonce: string) => [
  // Claude Code's Bash tool refuses a bare long \`sleep\`; a Python sleep is one ordinary shell call everywhere.
  `Baseline restart ${nonce}. First run the shell command \`python3 -c "import time; time.sleep(75)"\` and wait for it to finish.`,
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

/**
 * Wait until the task has at least `minRuns` runs and none is active. Returns
 * `timedOut: true` at the deadline, so the caller never treats an active run
 * as a finished sample.
 */
async function waitForRest(api: ChaosApi, supervisor: ChaosSupervisor, issueId: string, minRuns: number): Promise<{ runs: Json[]; timedOut: boolean }> {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let restSince: number | null = null;
  while (Date.now() < deadline) {
    if (supervisor.serverReady) {
      const runs = await runsFor(api, issueId);
      const resting = runs.length >= minRuns && runs.every(run => !ACTIVE_RUN_STATUSES.has(String(run.status)));
      restSince = resting ? (restSince ?? Date.now()) : null;
      // A finished run can queue a continuation; confirm the rest for a few seconds.
      if (restSince !== null && Date.now() - restSince >= 6_000) return { runs, timedOut: false };
    }
    await delay(2_000);
  }
  return { runs: await runsFor(api, issueId), timedOut: true };
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

/**
 * The running run of the task, when it is inside the long sleep call. A tool
 * that exposes its command must show the sleep marker. A tool that exposes no
 * command text (OpenCode's `bash`) counts as inside an open shell call, and the
 * sample is marked `commandUnverified`.
 */
async function runInShellCall(api: ChaosApi, issueId: string): Promise<{ runId: string; commandUnverified: boolean } | null> {
  const active = (await runsFor(api, issueId)).find(run => String(run.status) === "running");
  if (!active) return null;
  const events = await allEvents(api, runIdOf(active)).catch(() => []);
  const open = openShellExecutions(events, RESTART_SLEEP_MARKER);
  if (open.some(call => call.matched)) return { runId: runIdOf(active), commandUnverified: false };
  if (open.length && open.every(call => call.unlabelled)) return { runId: runIdOf(active), commandUnverified: true };
  return null;
}

/** Wait until the run is inside its shell tool call (started, not ended). */
async function waitForShellCall(api: ChaosApi, issueId: string): Promise<{ runId: string; commandUnverified: boolean } | null> {
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const inside = await runInShellCall(api, issueId);
    if (inside) return inside;
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
  const timedOutIssues = new Set<string>();
  // One shutdown path for normal completion and for SIGINT/SIGTERM: the server
  // runs in a detached process group and the embedded Postgres has no exit hook.
  let stopping: Promise<void> | null = null;
  const shutdown = () => (stopping ??= supervisor.stop().catch(error => {
    process.stderr.write(`supervisor stop: ${String(error)}\n`);
  }));
  const onSignal = (signal: NodeJS.Signals) => {
    timeline.add("baseline_interrupted", { signal });
    void shutdown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
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
        const cold = await waitForRest(api, supervisor, issueId, 1);
        for (const run of cold.runs) runPhase.set(runIdOf(run), "cold");
        if (cold.timedOut) {
          // Never send the follow-up into an active turn; drop the whole sample.
          timedOutIssues.add(issueId);
          timeline.add("baseline_sample_timeout", { adapter, issueId, phase: "cold" });
          continue;
        }
        timeline.add("baseline_cold_done", { adapter, issueId, runs: cold.runs.length });
        await api.post(`/api/issues/${issueId}/comments`, { body: warmFollowUp(nonce), reopen: true });
        const warm = await waitForRest(api, supervisor, issueId, cold.runs.length + 1);
        for (const run of warm.runs) if (!runPhase.has(runIdOf(run))) runPhase.set(runIdOf(run), "warm");
        if (warm.timedOut) {
          timedOutIssues.add(issueId);
          timeline.add("baseline_sample_timeout", { adapter, issueId, phase: "warm" });
          continue;
        }
        timeline.add("baseline_warm_done", { adapter, issueId, runs: warm.runs.length - cold.runs.length });
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
        const inside = await waitForShellCall(api, issueId);
        return { issueId, adapter, runId: inside?.runId ?? null };
      }));
      // Recheck right before the fault: a fast adapter may have finished its call
      // while a slower one was still starting. Only runs still inside it count.
      const stillInside = await Promise.all(inFlight.map(async entry => {
        if (!entry.runId) return null;
        const inside = await runInShellCall(api, entry.issueId);
        return inside?.runId === entry.runId ? inside : null;
      }));
      for (const [position, entry] of inFlight.entries()) {
        const inside = stillInside[position];
        if (!inside) timeline.add("baseline_restart_sample_skipped", { adapter: entry.adapter, issueId: entry.issueId });
        else if (inside.commandUnverified) {
          timeline.add("baseline_restart_command_unverified", { adapter: entry.adapter, issueId: entry.issueId });
        }
      }
      const runIds = stillInside.flatMap(inside => inside ? [inside.runId] : []);
      for (const runId of runIds) runPhase.set(runId, "restart");
      const receipt = await supervisor.fault(kind, 0, `ttft-baseline-${index}`);
      faults.push({ kind, readyAt: receipt.readyAt ?? Date.now(), runIds });
      const settled = await Promise.all(inFlight.map(entry => waitForRest(api, supervisor, entry.issueId, 1)));
      for (const [position, entry] of inFlight.entries()) {
        if (settled[position]!.timedOut) {
          timedOutIssues.add(entry.issueId);
          timeline.add("baseline_sample_timeout", { adapter: entry.adapter, issueId: entry.issueId, phase: "restart" });
        }
      }
    }

    const runs: BaselineRun[] = [];
    for (const task of tasks) {
      // A sample that never came to rest is reported, not measured.
      if (timedOutIssues.has(task.issueId)) continue;
      for (const run of await runsFor(api, task.issueId)) {
        const runId = runIdOf(run);
        runs.push({ runId, adapter: task.adapter, environment: "local",
          phase: runPhase.get(runId) ?? task.phase, events: await allEvents(api, runId) });
      }
    }
    const data = { waveId, adapters, notReady: requested.filter(adapter => !adapters.includes(adapter)),
      timedOutTasks: timedOutIssues.size, samples, restarts, gitSha: process.env.GIT_SHA ?? null, runs, faults };
    await writeFile(path.join(outDir, "baseline-data.json"), `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await writeFile(path.join(outDir, "baseline-report.md"), report(runs, faults), { mode: 0o600 });
    process.stdout.write(report(runs, faults));
    if (timedOutIssues.size) process.stdout.write(`\n${timedOutIssues.size} sample(s) timed out and were left out.\n`);
    process.stdout.write(`\nWrote ${outDir}\n`);
  } finally {
    // Always stop the wrapper-owned embedded Postgres (SysV shared memory is scarce).
    await shutdown();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
