/**
 * Control-plane restart chaos harness, Phase 1 MVP.
 * See doc/plans/2026-11-06-control-plane-restart-chaos.md and ./README.md.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex,claude,opencode \
 *     --concurrency 4 --tasks 8 --faults K1,K2,K4 --seed 42
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay <wave>/<task>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi, isSocketTypeOfServiceRace } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, parseCommand, replayCommand, waveIdFor } from "./config.js";
import { knownSecretValues, writeEvidenceBundle } from "./evidence.js";
import { gradeTask } from "./grader.js";
import { appendLedger, ledgerLine, writeSummary, type LedgerLine } from "./ledger.js";
import { TaskObserver } from "./observer.js";
import { observedFaultSchedule, planWave, replayWave } from "./scheduler.js";
import { seedChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { Timeline } from "./timeline.js";
import type { FaultReceipt, OracleArtifacts, WavePlan } from "./types.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const resultsRoot = path.resolve(process.env.RESTART_CHAOS_RESULTS_DIR ?? path.join(import.meta.dirname, "results"));
const QUIET_BEFORE_SWEEP_MS = 15_000;

function git(args: string[]) {
  try { return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim(); } catch { return ""; }
}

async function loadPlan(): Promise<{ plan: WavePlan; keep: boolean }> {
  const command = parseCommand(process.argv.slice(2));
  if (command.mode === "replay") {
    const sourceDir = path.join(resultsRoot, command.ref.waveId);
    const source = JSON.parse(await readFile(path.join(sourceDir, "plan.json"), "utf8")) as WavePlan;
    // Replay the faults that actually crossed the task, including other tasks' faults.
    const graded = await readFile(path.join(sourceDir, `${command.ref.taskId}.grade.json`), "utf8")
      .then(text => JSON.parse(text) as { record: { createdAt: number | null; faultIds: string[] } }).catch(() => null);
    const faults = await readFile(path.join(sourceDir, "faults.json"), "utf8").then(text => JSON.parse(text) as FaultReceipt[]).catch(() => []);
    const observed = graded ? observedFaultSchedule(graded.record.createdAt, graded.record.faultIds, faults, command.ref.taskId) : [];
    if (!observed.length) console.warn("Replay: no recorded fault sequence for this task; using its planned fault only.");
    return { plan: replayWave(source, command.ref, Date.now(), command.overrides, observed), keep: command.keep };
  }
  return { plan: planWave(waveIdFor(command.options.seed), command.options), keep: command.keep };
}

function preflight(plan: WavePlan) {
  const missing = [...new Set(plan.tasks.map(task => CREDENTIAL_FOR_ADAPTER[task.adapter]))].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing credentials ${missing.join(", ")}. Run: set -a; source ~/.secrets; set +a`);
  const runner = process.env.PAPERCLIP_RUNNER_BINARY
    ?? path.join(repositoryRoot, "packages/paperclip-runner/runner/target/debug/paperclip-runnerd");
  if (!existsSync(runner)) throw new Error(`Runner binary missing at ${runner}. Run: pnpm --filter @paperclipai/paperclip-runner build:runner-binaries`);
  // Same provider bundle preparation as tests/runner-e2e/verified-provider-bundles.setup.mjs.
  const build = spawnSync(process.execPath, [path.join(repositoryRoot, "packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs")],
    { cwd: repositoryRoot, stdio: "inherit" });
  if (build.status !== 0) throw new Error("Verified provider entrypoint build failed");
}

async function main(): Promise<number> {
  const { plan, keep } = await loadPlan();
  const waveDir = path.join(resultsRoot, plan.waveId);
  await mkdir(waveDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(waveDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  const timeline = new Timeline(path.join(waveDir, "timeline.jsonl"));
  const gitSha = git(["rev-parse", "HEAD"]);
  const gitDirty = git(["status", "--porcelain"]).length > 0;
  timeline.add("wave_planned", { waveId: plan.waveId, seed: plan.seed, gitSha, gitDirty, replayOf: plan.replayOf ?? null,
    tasks: plan.tasks.map(task => `${task.taskId}:${task.adapter}/${task.workload}/${task.fault}${task.trigger ? `^${task.trigger}+${task.triggerDelayMs ?? 0}ms` : ""}@${task.fireAfterMs}ms${task.holdMs ? ` hold ${task.holdMs}ms` : ""}`) });
  preflight(plan);

  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir, timeline });
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => { if (!interrupted) { interrupted = true; timeline.add("harness_interrupted", { signal }); } };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  const faults: FaultReceipt[] = [];
  const faultWork: Promise<void>[] = [];
  const lines: LedgerLine[] = [];
  let anyFailure = false;
  let harnessError: unknown;
  process.on("uncaughtException", error => {
    if (isSocketTypeOfServiceRace(error)) { timeline.add("harness_socket_race_ignored", { error: String(error) }); return; }
    timeline.add("harness_uncaught_exception", { error: error.stack ?? String(error) });
    harnessError ??= error;
    interrupted = true;
  });
  let faultFailures = 0;
  let faultsQueued = 0;
  try {
    await supervisor.start();
    const api = new ChaosApi(supervisor.baseUrl);
    const lab = await seedChaosLab({ api, env: plan.options.env, adapters: [...new Set(plan.tasks.map(task => task.adapter))],
      concurrency: plan.options.concurrency, budgetCents: plan.options.budgetCents,
      fixtureRoot: path.join(supervisor.paths.temporaryRoot, "fixtures"), waveId: plan.waveId, timeline });
    // The instance root holds the secrets master key and the database: oracle code may not read it.
    const protectedRoots = [os.homedir(), supervisor.paths.temporaryRoot, resultsRoot];
    const observers = plan.tasks.map(task => new TaskObserver(task, api, lab, timeline, supervisor, protectedRoots));
    const pending = [...observers];
    const active: TaskObserver[] = [];
    const lastPoll = new Map<TaskObserver, number>();
    let lastDoneAt = Date.now();

    while (!interrupted && (pending.length || active.length)) {
      const now = Date.now();
      // A failed fault or an unexpected exit leaves the server not ready.
      // Recover within a bound, or fail the wave instead of waiting forever.
      if (!supervisor.serverReady && !supervisor.faultInProgress) await supervisor.ensureServing();
      while (active.length < plan.options.concurrency && pending.length && supervisor.serverReady && !supervisor.faultInProgress) {
        const next = pending.shift()!;
        await next.launch();
        if (!next.done) active.push(next);
      }
      await Promise.all(active.filter(observer => now - (lastPoll.get(observer) ?? 0) >= plan.options.pollMs).map(async observer => {
        lastPoll.set(observer, now);
        await observer.poll(now);
      }));
      for (const observer of active) {
        if (faultsQueued || supervisor.faultInProgress || !supervisor.serverReady) break;
        const due = observer.faultDue(Date.now());
        if (!due) continue;
        if (observer.record.restAt !== null) { timeline.add("fault_skipped_task_resting", { taskId: observer.plan.taskId, fault: due.kind }); continue; }
        const exposed = active.filter(candidate => !candidate.done);
        await Promise.all(exposed.map(candidate => candidate.snapshotBeforeFault()));
        const trigger = due.trigger && due.trigger !== "time" ? { trigger: due.trigger, delayMs: due.delayMs ?? 0 } : undefined;
        if (trigger) timeline.add("trigger_fired", { taskId: observer.plan.taskId, fault: due.kind, ...trigger });
        faultsQueued += 1;
        faultWork.push(supervisor.fault(due.kind, due.holdMs, observer.plan.taskId, trigger).finally(() => { faultsQueued -= 1; }).then(receipt => {
          faults.push(receipt);
          for (const candidate of exposed) { candidate.noteFault(receipt.faultId, receipt.startedAt); candidate.extendDeadline((receipt.readyAt ?? Date.now()) - receipt.startedAt); }
        }, (error: Error & { receipt?: FaultReceipt }) => {
          if (error.receipt) faults.push(error.receipt);
          faultFailures += 1;
          timeline.add("fault_error", { taskId: observer.plan.taskId, error: error.message });
        }));
      }
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (active[index]!.done) { active.splice(index, 1); lastDoneAt = Date.now(); }
      }
      await delay(1_000);
    }
    await Promise.all(faultWork);
    // An injected fault that did not complete invalidates the wave, even when
    // bounded recovery brought the server back and the tasks passed.
    if (faultFailures) harnessError ??= new Error(`${faultFailures} injected fault(s) failed; see fault_error in the timeline`);
    if (interrupted) throw new Error("Harness interrupted before the wave finished");

    // R6: let finalizers settle, then sweep for anything still pending.
    const quietFor = Date.now() - lastDoneAt;
    if (quietFor < QUIET_BEFORE_SWEEP_MS) await delay(QUIET_BEFORE_SWEEP_MS - quietFor);
    timeline.add("wave_sweep", {});
    const secrets = knownSecretValues();
    for (const observer of observers) {
      observer.record.sweep = await observer.sweep();
      let artifacts: OracleArtifacts | null = null;
      if (observer.record.issueId) artifacts = await observer.collectArtifacts().catch(() => null);
      const oracle = artifacts ? observer.definition.grade(observer.plan.nonce, artifacts)
        : { verdict: "fail" as const, checks: [{ name: "artifacts_collected", ok: false, detail: observer.record.launchError ?? "collection failed" }] };
      const grade = gradeTask(observer.record, faults, observer.definition.budgetMs, oracle);
      let evidence: string | null = null;
      if (!grade.pass) {
        anyFailure = true;
        evidence = await writeEvidenceBundle({ directory: path.join(waveDir, "evidence", observer.plan.taskId), api, plan,
          record: observer.record, grade, artifacts, faults, timeline: timeline.entries, serverLogPath: supervisor.paths.serverLogPath,
          gitSha, gitDirty, issue: observer.issue, secrets }).catch(error => { timeline.add("evidence_failed", { taskId: observer.plan.taskId, error: String(error) }); return null; });
      }
      await writeFile(path.join(waveDir, `${observer.plan.taskId}.grade.json`), `${JSON.stringify({ record: observer.record, grade }, null, 2)}\n`, { mode: 0o600 });
      lines.push(ledgerLine(plan, observer.record, grade, gitSha, evidence, faults));
      timeline.add("task_graded", { taskId: observer.plan.taskId, pass: grade.pass, crossed: grade.crossed, signature: grade.signature,
        rules: Object.fromEntries(Object.entries(grade.rules).map(([id, rule]) => [id, rule.verdict])), T: grade.T.verdict });
    }
    await writeFile(path.join(waveDir, "faults.json"), `${JSON.stringify(faults, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    harnessError = error;
    timeline.add("harness_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  } finally {
    try { await supervisor.stop(); } catch (error) {
      // Incomplete cleanup is a harness failure; keep the instance for inspection.
      harnessError ??= error;
      timeline.add("supervisor_stop_failed", { error: String(error) });
    }
    if (lines.length) {
      await appendLedger(resultsRoot, lines);
      const summary = await writeSummary(resultsRoot, plan.waveId);
      await writeFile(path.join(waveDir, "SUMMARY.md"), summary, { mode: 0o600 });
      console.info(`\n${summary}`);
    }
    if (keep || anyFailure || harnessError) timeline.add("instance_kept", { temporaryRoot: supervisor.paths.temporaryRoot });
    else await rm(supervisor.paths.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  console.info(`Wave ${plan.waveId}: results ${waveDir}`);
  for (const line of lines.filter(candidate => !candidate.pass)) console.info(`  FAIL ${line.taskId} ${line.signature} → ${line.evidence ?? "no evidence"}\n    replay: ${replayCommand(plan.waveId, line.taskId)}`);
  if (harnessError) { console.error(harnessError); return 2; }
  return anyFailure ? 1 : 0;
}

process.exit(await main().catch(error => { console.error(error); return 2; }));
