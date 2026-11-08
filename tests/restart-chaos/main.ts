/**
 * Control-plane restart chaos harness, Phase 1 MVP.
 * See doc/plans/2026-11-06-control-plane-restart-chaos.md and ./README.md.
 *
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex,claude,opencode \
 *     --concurrency 4 --tasks 8 --faults K1,K2,K4 --seed 42
 *   node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay <wave>/<task>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi, isSocketTypeOfServiceRace } from "./api.js";
import { CREDENTIAL_FOR_ADAPTER, parseCommand, replayCommand, waveIdFor } from "./config.js";
import { assertControllerMatchesImage, prepareDaytonaImageArtifacts } from "./daytona-image.js";
import { PLUGIN_BUILD_STAMP, pluginBuildState } from "./plugin-build.js";
import { DaytonaWaveSweeper, leaksForTask, unattributedLeaks, type DaytonaSweepResult } from "./daytona-sweep.js";
import { knownSecretValues, writeEvidenceBundle } from "./evidence.js";
import { gradeTask } from "./grader.js";
import { checkPlanInvariants, type InvariantCheck } from "./invariants.js";
import { appendLedger, ledgerLine, writeSummary, type LedgerLine } from "./ledger.js";
import { TaskObserver } from "./observer.js";
import { StormRun, TASK_FAULT_LOG, observedFaultSchedule, planWave, replayRecordFor, replayWave, type TaskFaultLog } from "./scheduler.js";
import { chaosLifecycleOverrides, seedChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { isBrokenStdoutError, markTimelineEchoBroken, Timeline } from "./timeline.js";
import { guardedRunnerOutputs, worktreeFingerprint } from "./wave-guard.js";
import type { FaultKind, FaultReceipt, OracleArtifacts, TriggerId, WavePlan } from "./types.js";

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
    // An interrupted or wedged wave has no grade files; its fault log was written after every fault.
    const logged = await readFile(path.join(sourceDir, TASK_FAULT_LOG), "utf8").then(text => JSON.parse(text) as TaskFaultLog).catch(() => null);
    const crossed = replayRecordFor(command.ref.taskId, graded?.record ?? null, logged);
    const faults = await readFile(path.join(sourceDir, "faults.json"), "utf8").then(text => JSON.parse(text) as FaultReceipt[]).catch(() => []);
    const observed = crossed ? observedFaultSchedule(crossed.createdAt, crossed.faultIds, faults, command.ref.taskId) : [];
    if (!observed.length) console.warn("Replay: no recorded fault sequence for this task; using its planned fault only.");
    return { plan: replayWave(source, command.ref, Date.now(), command.overrides, observed), keep: command.keep };
  }
  return { plan: planWave(waveIdFor(command.options.seed), command.options), keep: command.keep };
}

function run(command: string, args: string[], cwd: string, label: string) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed (${command} ${args.join(" ")})`);
}

/**
 * The bundled Daytona plugin is outside the root workspace; prepare it as CI
 * does, and rebuild it whenever its sources (or the plugin SDK's) changed since
 * the last build, so a worktree that moved to a new master tests that master's
 * plugin rather than an older build.
 */
function ensureDaytonaPlugin(timeline: Timeline) {
  const root = path.join(repositoryRoot, "packages/plugins/sandbox-providers/daytona");
  // Inputs outside the plugin directory: the linked plugin SDK and the tsconfig chain both packages extend.
  const extraInputs = [
    ...["src", "package.json", "tsconfig.json"].map(file => path.join(repositoryRoot, "packages/plugins/sdk", file)),
    ...["tsconfig.json", "tsconfig.base.json"].map(file => path.join(repositoryRoot, file)),
  ];
  const state = pluginBuildState(root, extraInputs);
  timeline.add("daytona_plugin_build_state", { reason: state.reason, inputHash: state.inputHash });
  if (!state.needsBuild) return;
  run("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"], root, "Daytona plugin install");
  run(process.execPath, [path.join(repositoryRoot, "scripts/link-plugin-dev-sdk.mjs")], repositoryRoot, "Plugin SDK link");
  run("pnpm", ["--dir", root, "build"], repositoryRoot, "Daytona plugin build");
  writeFileSync(path.join(root, PLUGIN_BUILD_STAMP), `${state.inputHash}\n`);
  timeline.add("daytona_plugin_built", { inputHash: state.inputHash });
}

/**
 * `--env daytona`: extract the image's Linux runnerd and provider pack (cached
 * per image digest, no Docker) and refuse to run a controller whose runner
 * source differs from the image.
 */
async function prepareDaytona(plan: WavePlan, timeline: Timeline): Promise<Record<string, string>> {
  const image = plan.options.daytonaImage!;
  const artifacts = await prepareDaytonaImageArtifacts({ image, cacheRoot: path.join(resultsRoot, "daytona-images"),
    log: line => console.info(`[daytona-image] ${line}`) });
  const { localContentId } = await assertControllerMatchesImage(artifacts, repositoryRoot);
  timeline.add("daytona_image_matched", { image, contentId: artifacts.contentId, localContentId, sourceRevision: artifacts.sourceRevision,
    runnerdSha256: artifacts.runnerdSha256, providerPackDigest: artifacts.providerPackDigest, platformManifestDigest: artifacts.platformManifestDigest });
  ensureDaytonaPlugin(timeline);
  timeline.add("daytona_vcpu_plan", { cpuPerSandbox: plan.options.daytonaCpu, concurrency: plan.options.concurrency,
    taskVcpu: plan.options.concurrency * (plan.options.daytonaCpu ?? 0) });
  return { PAPERCLIP_RUNNER_REMOTE_BINARY_PATH: artifacts.runnerdPath, PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: artifacts.providerPackPath };
}

function preflight(plan: WavePlan) {
  const missing = [...new Set([...plan.tasks.map(task => CREDENTIAL_FOR_ADAPTER[task.adapter]),
    ...(plan.options.env === "daytona" ? ["DAYTONA_API_KEY"] : [])])].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing credentials ${missing.join(", ")}. Run: set -a; source ~/.secrets; set +a`);
  const runner = process.env.PAPERCLIP_RUNNER_BINARY
    ?? path.join(repositoryRoot, "packages/paperclip-runner/runner/target/debug/paperclip-runnerd");
  if (!existsSync(runner)) throw new Error(`Runner binary missing at ${runner}. Run: pnpm --filter @paperclipai/paperclip-runner run build:runner-binaries`);
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
  // Builds and branch switches must happen before the wave, never during it.
  const guardedOutputs = guardedRunnerOutputs(repositoryRoot);
  let startFingerprint: string | null = null;
  let worktreeChanged = false;
  const checkWorktree = (at: string) => {
    if (worktreeChanged || startFingerprint === null || worktreeFingerprint(repositoryRoot, guardedOutputs) === startFingerprint) return;
    worktreeChanged = true;
    timeline.add("worktree_changed_mid_wave", { at, gitSha: git(["rev-parse", "HEAD"]) });
  };
  timeline.add("wave_planned", { waveId: plan.waveId, seed: plan.seed, gitSha, gitDirty, replayOf: plan.replayOf ?? null,
    tasks: plan.tasks.map(task => `${task.taskId}:${task.adapter}/${task.workload}/${task.fault}${task.trigger ? `^${task.trigger}+${task.triggerDelayMs ?? 0}ms` : ""}@${task.fireAfterMs}ms${task.holdMs ? ` hold ${task.holdMs}ms` : ""}`),
    ...(plan.storm ? { storm: { durationMs: plan.storm.durationMs, faults: plan.storm.faults.map(fault => `${fault.kind}+${fault.gapMs}ms${fault.holdMs ? ` hold ${fault.holdMs}ms` : ""}`) } } : {}) });
  preflight(plan);
  const serverEnvironment = plan.options.env === "daytona" ? await prepareDaytona(plan, timeline) : {};
  // Baseline only after the harness's own build steps (preflight rewrites the runner's dist).
  startFingerprint = worktreeFingerprint(repositoryRoot, guardedOutputs);

  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir, timeline });
  // Crash-point suite: the server kills itself at the named point once every task launched.
  const crashPoint = plan.options.crashPoint ?? null;
  const crashPointGate = path.join(supervisor.paths.temporaryRoot, "crash-point.gate");
  let crashPointGateOpen = false;
  let crashPointReceipt: FaultReceipt | null = null;
  let invariantCheck: InvariantCheck | null = null;
  if (crashPoint) {
    supervisor.armCrashPoint({ spec: crashPoint, receiptPath: path.join(waveDir, "crash-point-receipts.jsonl"), gatePath: crashPointGate });
  }
  let sweeper: DaytonaWaveSweeper | null = null;
  let sandboxSweep: DaytonaSweepResult | null = null;
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => { if (!interrupted) { interrupted = true; timeline.add("harness_interrupted", { signal }); } };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  const faults: FaultReceipt[] = [];
  // Written after every fault, so an interrupted or wedged storm can still replay what crossed each task.
  const taskFaultLog: TaskFaultLog = {};
  const persistFaultLog = async () => {
    await writeFile(path.join(waveDir, "faults.json"), `${JSON.stringify(faults, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    await writeFile(path.join(waveDir, TASK_FAULT_LOG), `${JSON.stringify(taskFaultLog, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
  };
  const faultWork: Promise<void>[] = [];
  const lines: LedgerLine[] = [];
  let anyFailure = false;
  let harnessError: unknown;
  process.on("uncaughtException", error => {
    if (isSocketTypeOfServiceRace(error)) { timeline.add("harness_socket_race_ignored", { error: String(error) }); return; }
    // A reader of our stdout went away. Keep running (results go to files); the
    // timeline records harness_stdout_lost once on its next entry.
    if (isBrokenStdoutError(error)) { markTimelineEchoBroken(error); return; }
    timeline.add("harness_uncaught_exception", { error: error.stack ?? String(error) });
    harnessError ??= error;
    interrupted = true;
  });
  // Spend is read once per wave: after the tasks, or during cleanup when the wave stopped early.
  let spendTarget: { api: ChaosApi; companyId: string } | null = null;
  let spendRecorded = false;
  const recordWaveSpend = async () => {
    if (!spendTarget || spendRecorded) return;
    spendRecorded = true;
    // Each wave owns its company, so all-time spend is exactly this wave, even across a month boundary.
    const spend = await spendTarget.api.get<Record<string, unknown>>(`/api/companies/${spendTarget.companyId}/costs/summary?period=all`)
      .catch(error => ({ error: String(error) }));
    timeline.add("wave_spend", { spend });
    console.info(`Wave spend: ${JSON.stringify(spend)}`);
  };
  let faultFailures = 0;
  let faultsQueued = 0;
  try {
    await supervisor.start(serverEnvironment);
    const api = new ChaosApi(supervisor.baseUrl);
    const lab = await seedChaosLab({ api, env: plan.options.env, daytonaImage: plan.options.daytonaImage, daytonaCpu: plan.options.daytonaCpu,
      adapters: [...new Set(plan.tasks.map(task => task.adapter))],
      concurrency: plan.options.concurrency, budgetCents: plan.options.budgetCents, masks: plan.options.masks,
      fixtureRoot: path.join(supervisor.paths.temporaryRoot, "fixtures"), waveId: plan.waveId, timeline,
      adapterConfigOverrides: chaosLifecycleOverrides(plan.options.lifecycle),
      onEnvironment: owned => {
        sweeper = new DaytonaWaveSweeper({ apiKey: process.env.DAYTONA_API_KEY!, companyId: owned.companyId, environmentId: owned.environmentId, api });
      } });
    spendTarget = { api, companyId: lab.companyId };
    // The instance root holds the secrets master key and the database: oracle code may not read it.
    const protectedRoots = [os.homedir(), supervisor.paths.temporaryRoot, resultsRoot];
    const observers = plan.tasks.map(task => new TaskObserver(task, api, lab, timeline, supervisor, protectedRoots));
    const pending = [...observers];
    const launched: TaskObserver[] = [];
    const active: TaskObserver[] = [];
    const lastPoll = new Map<TaskObserver, number>();
    let lastDoneAt = Date.now();
    // K13: storm faults fire on their own clock while tasks keep launching; then the storm drains.
    const storm = plan.storm ? new StormRun(plan.storm, Date.now()) : null;
    if (storm) timeline.add("storm_started", { durationMs: storm.plan.durationMs, plannedFaults: storm.plan.faults.length });
    // Faults are serialized; each one hits every task in flight when it starts.
    const fireFault = (kind: FaultKind, holdMs: number, requestedBy: string, exposed: readonly TaskObserver[],
      trigger?: { trigger: TriggerId; delayMs: number }, onSettled?: () => void) => {
      faultsQueued += 1;
      faultWork.push(supervisor.fault(kind, holdMs, requestedBy, trigger).finally(() => { faultsQueued -= 1; onSettled?.(); }).then(receipt => {
        faults.push(receipt);
        checkWorktree(receipt.faultId);
        for (const candidate of exposed) {
          candidate.noteFault(receipt.faultId, receipt.startedAt);
          candidate.extendDeadline((receipt.readyAt ?? Date.now()) - receipt.startedAt);
          taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds] };
        }
        void persistFaultLog();
      }, (error: Error & { receipt?: FaultReceipt }) => {
        if (error.receipt) {
          // A failed fault still crossed the tasks in flight; replay must fire it too.
          const receipt = error.receipt;
          faults.push(receipt);
          for (const candidate of exposed) {
            candidate.noteFault(receipt.faultId, receipt.startedAt);
            taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds] };
          }
          void persistFaultLog();
        }
        faultFailures += 1;
        timeline.add("fault_error", { taskId: requestedBy, error: error.message });
      }));
    };

    supervisor.onCrashPoint = receipt => {
      crashPointReceipt = receipt;
      faults.push(receipt);
      if (receipt.error) { faultFailures += 1; timeline.add("fault_error", { taskId: "crash-point", error: receipt.error }); }
      for (const candidate of active.filter(observer => !observer.done)) {
        candidate.noteFault(receipt.faultId, receipt.startedAt);
        candidate.extendDeadline((receipt.readyAt ?? Date.now()) - receipt.startedAt);
        taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds] };
      }
      checkWorktree(receipt.faultId);
      void persistFaultLog();
    };

    while (!interrupted && (pending.length || active.length)) {
      const now = Date.now();
      if (storm?.endIfDue(now)) {
        // Unlaunched pool tasks are not part of the wave; the in-flight ones drain without new faults.
        timeline.add("storm_ended", { faultsFired: storm.state.fired, inFlight: active.length, unlaunched: pending.length });
        pending.length = 0;
      }
      // A failed fault or an unexpected exit leaves the server not ready.
      // Recover within a bound, or fail the wave instead of waiting forever.
      if (!supervisor.serverReady && !supervisor.faultInProgress) await supervisor.ensureServing();
      // Recheck the storm clock per launch: ensureServing or a slow launch can cross the storm's end.
      while (active.length < plan.options.concurrency && pending.length && supervisor.serverReady && !supervisor.faultInProgress
        && (!storm || storm.mayLaunch(Date.now()))) {
        const next = pending.shift()!;
        launched.push(next);
        await next.launch();
        if (!next.done) active.push(next);
      }
      if (crashPoint && !crashPointGateOpen && !pending.length && supervisor.serverReady) {
        supervisor.openCrashPointGate(crashPointGate);
        crashPointGateOpen = true;
      }
      await Promise.all(active.filter(observer => now - (lastPoll.get(observer) ?? 0) >= plan.options.pollMs).map(async observer => {
        lastPoll.set(observer, now);
        await observer.poll(now);
      }));
      for (const observer of active) {
        // A crash-point wave has no scheduled faults: the armed point is the fault.
        if (crashPoint) break;
        if (faultsQueued || supervisor.faultInProgress || !supervisor.serverReady) break;
        // A storm's drain gets no new fault; an unfired trigger is recorded as missed at rest.
        if (storm && !storm.mayLaunch(Date.now())) break;
        const due = observer.faultDue(Date.now());
        if (!due) continue;
        if (observer.record.restAt !== null) { timeline.add("fault_skipped_task_resting", { taskId: observer.plan.taskId, fault: due.kind }); continue; }
        const exposed = active.filter(candidate => !candidate.done);
        await Promise.all(exposed.map(candidate => candidate.snapshotBeforeFault()));
        if (!(await observer.confirmTrigger(due, Date.now()))) continue;
        if (storm && !storm.mayLaunch(Date.now())) {
          observer.markTriggerMissed(due);
          timeline.add("fault_skipped_storm_ended", { taskId: observer.plan.taskId, fault: due.kind });
          break;
        }
        const trigger = due.trigger && due.trigger !== "time" ? { trigger: due.trigger, delayMs: due.delayMs ?? 0 } : undefined;
        if (trigger) timeline.add("trigger_fired", { taskId: observer.plan.taskId, fault: due.kind, ...trigger });
        // Inside a storm a triggered fault is a restart too: the next storm gap runs from its settle.
        fireFault(due.kind, due.holdMs, observer.plan.taskId, exposed, trigger, storm ? () => storm.settled(Date.now()) : undefined);
      }
      if (storm && !faultsQueued && !supervisor.faultInProgress && supervisor.serverReady) {
        const due = storm.due(Date.now());
        if (due) {
          const exposed = active.filter(candidate => !candidate.done);
          await Promise.all(exposed.map(candidate => candidate.snapshotBeforeFault()));
          // The snapshots take time; a storm that ended meanwhile is draining and gets no new fault.
          if (storm.commit(due, Date.now())) {
            timeline.add("storm_fault", { index: storm.state.fired, kind: due.kind, gapMs: due.gapMs, holdMs: due.holdMs, exposed: exposed.map(candidate => candidate.plan.taskId) });
            fireFault(due.kind, due.holdMs, "storm", exposed, undefined, () => storm.settled(Date.now()));
          }
        }
      }
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (active[index]!.done) { active.splice(index, 1); lastDoneAt = Date.now(); }
      }
      await delay(1_000);
    }
    await Promise.all(faultWork);
    checkWorktree("wave_end");
    if (worktreeChanged) harnessError ??= new Error("The worktree changed during the wave (build, install or branch switch); later restarts may have run different code");
    // A storm whose task pool ran dry early did not cover its storm; it is not a passing wave.
    if (storm && !interrupted && storm.exhaustedEarly(Date.now())) {
      timeline.add("storm_pool_exhausted", { faultsFired: storm.state.fired, launched: launched.length });
      harnessError ??= new Error(`Storm task pool (--tasks ${plan.options.tasks}) ran out before the storm ended; raise --tasks`);
    }
    // An injected fault that did not complete invalidates the wave, even when
    // bounded recovery brought the server back and the tasks passed.
    if (faultFailures) harnessError ??= new Error(`${faultFailures} injected fault(s) failed; see fault_error in the timeline`);
    if (interrupted) throw new Error("Harness interrupted before the wave finished");

    // R6: let finalizers settle, then sweep for anything still pending.
    const quietFor = Date.now() - lastDoneAt;
    if (quietFor < QUIET_BEFORE_SWEEP_MS) await delay(QUIET_BEFORE_SWEEP_MS - quietFor);
    await recordWaveSpend();
    timeline.add("wave_sweep", {});
    if (sweeper) {
      sandboxSweep = await (sweeper as DaytonaWaveSweeper).sweep();
      timeline.add("daytona_sweep", { ...sandboxSweep });
    }
    const attributed = new Set<string>();
    const secrets = knownSecretValues();
    for (const observer of launched) {
      observer.record.sweep = await observer.sweep();
      if (sandboxSweep) {
        const runIds = new Set(observer.record.samples.flatMap(sample => (sample.runs ?? []).map(run => run.id)));
        const leaks = leaksForTask(sandboxSweep, runIds, observer.record.issueId);
        for (const leak of leaks) attributed.add(leak);
        observer.record.sweep.daytonaLeaks = leaks;
      }
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
    if (crashPoint) {
      // I1–I8 against the wave's own database, after every task rested (invariants.ts).
      const config = JSON.parse(readFileSync(supervisor.paths.configPath, "utf8")) as { database?: { connectionString?: string } };
      const connectionString = config.database?.connectionString;
      if (!connectionString) throw new Error("Crash-point wave: the instance config has no database connection string");
      invariantCheck = await checkPlanInvariants({ connectionString, companyId: lab.companyId });
      timeline.add("plan_invariants", { byInvariant: invariantCheck.byInvariant, errors: invariantCheck.errors });
      if (invariantCheck.violations.length) anyFailure = true;
      if (invariantCheck.errors.length) harnessError ??= new Error(`Invariant check incomplete: ${invariantCheck.errors.join("; ")}`);
      const receipt = crashPointReceipt as FaultReceipt | null;
      await writeFile(path.join(waveDir, "crash-point.json"), `${JSON.stringify({
        schema: "paperclip.restart-chaos.crash-point/v1", point: crashPoint, gitSha, gitDirty,
        reached: receipt?.crashPoint ?? null, fault: receipt, gateOpened: crashPointGateOpen,
        tasks: lines.map(line => ({ taskId: line.taskId, adapter: line.adapter, workload: line.workload, pass: line.pass,
          signature: line.signature, rules: line.rules, ruleDetails: line.ruleDetails, T: line.T })),
        invariants: invariantCheck,
      }, null, 2)}\n`, { mode: 0o600 });
    }
    // R6 at wave level: a leak no task's runs account for (e.g. the setup probe) still fails the wave.
    if (sandboxSweep) {
      const unattributed = unattributedLeaks(sandboxSweep, attributed);
      if (sandboxSweep.error || unattributed.length) {
        anyFailure = true;
        timeline.add("daytona_sweep_wave_leak", { error: sandboxSweep.error, unattributed });
      }
    }
  } catch (error) {
    harnessError = error;
    timeline.add("harness_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  } finally {
    // Best effort for an interrupted or failed wave; the server may already be down.
    if (supervisor.serverReady) await recordWaveSpend().catch(() => undefined);
    // A failure here (for example writing the report) must not skip stopping the controller and Postgres.
    try { if (sweeper) try {
      const owned = sweeper as DaytonaWaveSweeper;
      // An interrupted wave still reports what it leaked before cleanup.
      sandboxSweep ??= await owned.sweep(0);
      // Cleanup only through Paperclip; the harness never changes a sandbox.
      const cleanup = await owned.cleanUp();
      timeline.add("daytona_cleanup", cleanup);
      console.info(`Daytona R6 sweep: ${sandboxSweep.liveSandboxes.length} live, ${sandboxSweep.archivedSandboxes.length} archived after release, `
        + `${sandboxSweep.orphanSandboxes.length} orphaned, `
        + `${sandboxSweep.heldLeases.length} held leases${sandboxSweep.error ? `, error ${sandboxSweep.error}` : ""}; `
        + `environment deleted: ${cleanup.environmentDeleted}${cleanup.environmentDeleteBlocked ? " (still blocked by a pending sandbox cleanup)" : ""}; still running after cleanup: ${cleanup.remainingSandboxes.join(", ") || "none"}`);
      // A sandbox neither archived nor destroyed after cleanup is a leak for a person to act on.
      if (cleanup.remainingSandboxes.length) anyFailure = true;
      // A delete still blocked by pending sandbox cleanup after the settle window
      // is a leak, not a harness error: fail the wave and keep the instance, whose
      // database owns that cleanup work.
      if (cleanup.environmentDeleteBlocked) {
        anyFailure = true;
        timeline.add("daytona_environment_delete_blocked", { detail: cleanup.environmentDeleteBlocked });
      }
      if (cleanup.errors.length) harnessError ??= new Error(`Daytona cleanup incomplete: ${cleanup.errors.join("; ")}`);
      await writeFile(path.join(waveDir, "sandbox-sweep.json"), `${JSON.stringify({ sweep: sandboxSweep, cleanup }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      harnessError ??= error;
      timeline.add("daytona_cleanup_failed", { error: String(error) });
    } } finally {
      try { await supervisor.stop(); } catch (error) {
        // Incomplete cleanup is a harness failure; keep the instance for inspection.
        harnessError ??= error;
        timeline.add("supervisor_stop_failed", { error: String(error) });
      }
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
