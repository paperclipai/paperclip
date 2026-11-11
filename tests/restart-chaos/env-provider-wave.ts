/**
 * Environment-provider fault waves (EP1). See env-provider-faults.ts for the
 * oracle and README.md ("Environment-provider faults") for usage.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/env-provider-wave.ts \
 *     --fault EP1 --adapters codex --tasks 2 --seed 71
 *
 * One fault per wave: the server seam reads one control file, and every task's
 * own first acquisitions fail. The harness launches A1 brief tasks, watches
 * their runs and recovery actions, and for EP1N disarms the fault once every
 * task rests and then uses the task's Retry.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { releaseInstance } from "../runner-e2e/instance-retention.js";
import { ChaosApi } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, waveIdFor } from "./config.js";
import {
  ENV_PROVIDER_FAULT_KINDS, ENV_PROVIDER_FAULTS, gradeEnvProviderTask, leaseFaultControl,
  type EnvProviderFaultKind, type EpGrade, type EpTaskRecord,
} from "./env-provider-faults.js";
import { knownSecretValues, redactKnownSecrets } from "./evidence.js";
import { seedChaosLab, type ChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { Timeline } from "./timeline.js";
import { ADAPTER_IDS, type AdapterId } from "./types.js";
import { workloadDefinitions } from "./workloads.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resultsRoot = path.resolve(process.env.RESTART_CHAOS_RESULTS_DIR ?? path.join(import.meta.dirname, "results"));
const POLL_MS = 4_000;
type Json = Record<string, any>;

interface WaveOptions { fault: EnvProviderFaultKind; adapters: AdapterId[]; tasks: number; seed: number; restBoundMs: number; doneBoundMs: number }

export function parseEnvProviderWaveArgs(argv: readonly string[]): { options: WaveOptions; keep: boolean } {
  const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : [...argv], strict: true, options: {
    fault: { type: "string" }, adapters: { type: "string" }, tasks: { type: "string" }, seed: { type: "string" },
    "rest-seconds": { type: "string" }, "done-seconds": { type: "string" }, keep: { type: "boolean" },
  } });
  const fault = (values.fault ?? "EP1") as EnvProviderFaultKind;
  if (!ENV_PROVIDER_FAULT_KINDS.includes(fault)) throw new Error(`--fault must be one of ${ENV_PROVIDER_FAULT_KINDS.join(", ")}`);
  const adapters = (values.adapters ?? "codex").split(",").map(item => item.trim()).filter(Boolean) as AdapterId[];
  for (const adapter of adapters) if (!ADAPTER_IDS.includes(adapter)) throw new Error(`Unknown adapter "${adapter}"`);
  const int = (raw: string | undefined, name: string, fallback: number, min: number, max: number) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    return value;
  };
  return { keep: values.keep === true, options: { fault, adapters, tasks: int(values.tasks, "tasks", 2, 1, 6),
    seed: int(values.seed, "seed", Date.now() % 100_000, 0, 2 ** 31 - 1),
    // Two automatic retries back off about 30 s and 60 s (with jitter) after each failure.
    restBoundMs: int(values["rest-seconds"], "rest-seconds", 420, 120, 1_800) * 1_000,
    doneBoundMs: int(values["done-seconds"], "done-seconds", 900, 120, 3_600) * 1_000 } };
}

async function sample(api: ChaosApi, record: EpTaskRecord): Promise<{ issue: Json; interruption: Json | null } | null> {
  try {
    const [issue, runs, recovery] = await Promise.all([
      api.get<Json>(`/api/issues/${record.issueId}`, 5_000),
      api.get<Json[]>(`/api/issues/${record.issueId}/runs`, 5_000),
      // A failed read is recorded, never taken as "no actions": the grade needs this evidence.
      api.get<Json>(`/api/issues/${record.issueId}/recovery-actions`, 5_000).catch(() => null),
    ]);
    if (recovery && Array.isArray(recovery.actions)) record.recoveryReads += 1;
    else record.recoveryReadFailures += 1;
    const known = new Map(record.runs.map(run => [run.id, run]));
    for (const run of runs ?? []) {
      const id = String(run.runId ?? run.id);
      known.set(id, { id, status: String(run.status), errorCode: run.errorCode ?? null });
    }
    record.runs = [...known.values()];
    for (const action of (recovery?.actions ?? []) as Json[]) {
      if (!["active", "escalated"].includes(String(action.status))) continue;
      const seen = { ownerType: String(action.ownerType), kind: String(action.kind), cause: action.cause ?? null };
      if (!record.activeRecoveryActions.some(prior => prior.ownerType === seen.ownerType && prior.kind === seen.kind && prior.cause === seen.cause)) {
        record.activeRecoveryActions.push(seen);
      }
    }
    return { issue, interruption: (issue.interruption ?? null) as Json | null };
  } catch {
    return null;
  }
}

async function waitFor(api: ChaosApi, record: EpTaskRecord, boundMs: number, done: (state: { issue: Json; interruption: Json | null }) => boolean) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    const state = await sample(api, record);
    if (state) {
      record.finalStatus = String(state.issue.status);
      if (done(state)) return state;
    }
    await delay(POLL_MS);
  }
  return null;
}

async function runWave(options: WaveOptions, waveDir: string, timeline: Timeline, keep: boolean): Promise<Array<{ record: EpTaskRecord; grade: EpGrade }>> {
  const fault = ENV_PROVIDER_FAULTS[options.fault];
  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir, timeline });
  const control = path.join(supervisor.paths.temporaryRoot, "lease-fault-control.json");
  await writeFile(control, leaseFaultControl(fault, `wave${options.seed}`), { mode: 0o600 });
  let stopFailed = false;
  const records: EpTaskRecord[] = [];
  try {
    await supervisor.start({ PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL: control });
    const api = new ChaosApi(supervisor.baseUrl);
    const lab: ChaosLab = await seedChaosLab({ api, env: "local", waitForReadyAgents: true, adapters: [...new Set(options.adapters)],
      concurrency: options.tasks, budgetCents: 3_000, fixtureRoot: path.join(supervisor.paths.temporaryRoot, "fixtures"),
      waveId: path.basename(waveDir), timeline });
    const a1 = workloadDefinitions.A1;
    for (let index = 0; index < options.tasks; index += 1) {
      const adapter = options.adapters[index % options.adapters.length]!;
      const nonce = randomUUID().slice(0, 8);
      const record: EpTaskRecord = { taskId: `t${String(index + 1).padStart(2, "0")}`, nonce, fault: options.fault, issueId: null, harnessError: null,
        runs: [], activeRecoveryActions: [], recoveryReads: 0, recoveryReadFailures: 0, rested: null, retryClicked: false, finalStatus: null, briefOk: null };
      records.push(record);
      try {
        const issue = await api.post<Json>(`/api/companies/${lab.companyId}/issues`, { title: `Chaos ${options.fault} ${nonce}`,
          description: a1.description(nonce), status: "todo", priority: "medium", assigneeAgentId: lab.agents[adapter].id, projectId: lab.projectId });
        record.issueId = String(issue.id);
        timeline.add("ep_launched", { taskId: record.taskId, issueId: record.issueId, adapter });
      } catch (error) {
        record.harnessError = `launch: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600);
      }
    }
    const live = records.filter(record => record.issueId);
    if (fault.failures === null) {
      // Never clears: each task must rest offering Retry within the bound.
      await Promise.all(live.map(async record => {
        const rested = await waitFor(api, record, options.restBoundMs, state => state.interruption?.canRetry === true
          && ["blocked", "todo", "in_progress"].includes(String(state.issue.status))
          && !record.runs.some(run => ["queued", "running", "scheduled_retry"].includes(run.status)));
        record.rested = rested ? { issueStatus: String(rested.issue.status), canRetry: rested.interruption?.canRetry === true,
          observedRunId: rested.interruption?.observedRunId ?? null } : null;
        timeline.add("ep_rested", { taskId: record.taskId, rested: record.rested });
      }));
      await writeFile(control, "", { mode: 0o600 });
      timeline.add("ep_disarmed", {});
      for (const record of live) {
        if (!record.rested?.observedRunId) continue;
        const response = await api.post<Json>(`/api/issues/${record.issueId}/retry`, { idempotencyKey: randomUUID(), observedRunId: record.rested.observedRunId });
        record.retryClicked = response?.accepted === true;
        timeline.add("ep_retry_clicked", { taskId: record.taskId, accepted: response?.accepted ?? null });
      }
    }
    await Promise.all(live.map(record => waitFor(api, record, options.doneBoundMs, state => state.issue.status === "done")));
    for (const record of live) {
      const brief = await api.get<Json>(`/api/issues/${record.issueId}/documents/brief`).then(row => typeof row?.body === "string" ? row.body : null).catch(() => null);
      record.briefOk = a1.grade(record.nonce, { issueStatus: record.finalStatus, documents: { brief }, agentComments: [], files: {}, commands: {}, workspacePath: null }).verdict === "pass";
    }
  } finally {
    try { await supervisor.stop(); } catch { stopFailed = true; }
    await releaseInstance(supervisor.paths.temporaryRoot, { keep, stopFailed, owner: path.basename(waveDir) })
      .catch(error => timeline.add("instance_cleanup_failed", { error: String(error) }));
  }
  return records.map(record => ({ record, grade: gradeEnvProviderTask(record) }));
}

export function envProviderSummaryMarkdown(waveId: string, gitSha: string, fault: EnvProviderFaultKind, rows: Array<{ record: EpTaskRecord; grade: EpGrade }>): string {
  const lines = [`# Environment-provider fault wave ${waveId}`, "", `Commit ${gitSha}`, "", `Fault ${fault}: ${ENV_PROVIDER_FAULTS[fault].label}`, "",
    "| Task | Runs (errorCode) | Final | Pass |", "| --- | --- | --- | --- |"];
  for (const { record, grade } of rows) {
    lines.push(`| ${record.taskId} | ${record.runs.map(run => `${run.status}${run.errorCode ? `/${run.errorCode}` : ""}`).join(", ")} | ${record.finalStatus ?? "?"} | ${grade.pass ? "pass" : "FAIL"} |`);
  }
  lines.push("", "## Checks", "");
  for (const { record, grade } of rows) {
    lines.push(`### ${record.taskId}`, "", ...grade.checks.map(check => `- ${check.pass ? "pass" : "FAIL"} ${check.name}: ${check.detail}`), "");
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { options, keep } = parseEnvProviderWaveArgs(process.argv.slice(2));
  const missing = [...new Set(options.adapters.map(adapter => CREDENTIAL_FOR_ADAPTER[adapter]))].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing credentials ${missing.join(", ")}. Run: set -a; source ~/.secrets; set +a`);
  const runner = process.env.PAPERCLIP_RUNNER_BINARY ?? path.join(repositoryRoot, "packages/paperclip-runner/runner/target/debug/paperclip-runnerd");
  if (!existsSync(runner)) throw new Error(`Runner binary missing at ${runner}. Run: node scripts/agent-preflight.mjs`);
  const waveId = `${waveIdFor(options.seed)}-ep`;
  const waveDir = path.join(resultsRoot, waveId);
  await mkdir(waveDir, { recursive: true, mode: 0o700 });
  const timeline = new Timeline(path.join(waveDir, "timeline.jsonl"));
  const gitSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  timeline.add("ep_wave_planned", { waveId, gitSha, options });
  const rows = await runWave(options, waveDir, timeline, keep);
  for (const row of rows) {
    await writeFile(path.join(waveDir, `${row.record.taskId}.ep-grade.json`),
      `${redactKnownSecrets(JSON.stringify(row, null, 2), knownSecretValues())}\n`, { mode: 0o600 });
  }
  const summary = envProviderSummaryMarkdown(waveId, gitSha, options.fault, rows);
  await writeFile(path.join(waveDir, "SUMMARY.md"), summary, { mode: 0o600 });
  console.info(`\n${summary}\nWave ${waveId}: results ${waveDir}`);
  return rows.length === options.tasks && rows.every(row => row.grade.pass) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main().catch(error => { console.error(error); return 2; }));
}
