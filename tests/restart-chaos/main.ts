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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChaosApi, isSocketTypeOfServiceRace } from "./api.js";
import { BoardUi } from "./board-ui.js";
import { DEFAULT_MINIO_BINARY, MINIO_RELEASE, minioBinary, objectStoreServerEnvironment, startMinio, type ObjectStore } from "./object-store.js";
import { StorageChaos, planStorageFaults, replayStorageWindows, type StorageFaultReceipt, type StorageFaultWindow } from "./storage-chaos.js";
import { startStorageFaultProxy } from "./storage-proxy.js";
import { StorageAuditor, auditsStorage, storageAuditMarkdown } from "./storage-audit.js";
import { exposedAfterLaunch, StorageTrigger, storageTriggerMarkdown, storageTriggerShortfall } from "./storage-trigger.js";
import { NativeTrigger, nativeTriggerMarkdown, nativeTriggerShortfall, triggeredOutageWindow } from "./native-trigger.js";
import { needsCredentialRotation, startCredentialRotation, type CredentialRotation } from "./storage-credentials.js";
import { describeProviderFault, installProviderFaultSeam, resolveRealCodex, withProviderFaultCheck, type ProviderFaultSeam } from "./provider-faults.js";
import { installAcpxSidecarSeam, withAcpxSidecarHook, type AcpxSidecarSeam } from "./acpx-provider-faults.js";
import { DiskFullFaultSeam, isDiskFullFault, receiptsForIssue, withDiskFullCheck } from "./disk-full-faults.js";
import { CREDENTIAL_FOR_ADAPTER, parseCommand, replayCommand, waveIdFor } from "./config.js";
import { assertControllerMatchesImage, assertProviderPackMismatch, defaultDaytonaImageCacheRoot, prepareDaytonaImageArtifacts } from "./daytona-image.js";
import { PLUGIN_BUILD_STAMP, pluginBuildState } from "./plugin-build.js";
import { DaytonaWaveSweeper, leaksForTask, unattributedLeaks, type DaytonaSweepResult } from "./daytona-sweep.js";
import { knownSecretValues, redactKnownSecrets, writeEvidenceBundle } from "./evidence.js";
import { gradeTask } from "./grader.js";
import { releaseInstance } from "../runner-e2e/instance-retention.js";
import { checkPlanInvariants, readUniversalDbEvidence, summarizeViolations, type InvariantCheck } from "./invariants.js";
import { collectContentionEvidence, RunRowPressure } from "./contention.js";
import { createDb } from "../../packages/db/src/index.js";
import { appendLedger, ledgerLine, writeSummary, type LedgerLine } from "./ledger.js";
import { collectWaveSpeed, speedMarkdown } from "./wave-speed.js";
import { TaskObserver, childSpeedTasksInTurn } from "./observer.js";
import { closeJourneyApps } from "./journey-driver.js";
import { matrixMayLaunch, planMatrixWave } from "./journey-matrix.js";
import { redeployWave } from "./redeploy.js";
import { withT1CrossingCheck } from "./workloads.js";
import { parseRecoveryStepReceipts, withRecoveryStepCheck } from "./recovery-step-faults.js";
import { captureWaveRunnerLogs, executeInWaveSandboxes } from "./daytona-runner-logs.js";
import { isClassRFault, killedPidsFromOutput, providerKillCommand, watchLabels, withClassRCheck, type ProviderKillRecord } from "./class-r.js";
import { StormRun, TASK_FAULT_LOG, observedFaultSchedule, planWave, replayOnCurrentBuild, replayRecordFor, replayWave, type TaskFaultLog } from "./scheduler.js";
import { chaosLifecycleOverrides, seedChaosLab } from "./seed.js";
import { ChaosSupervisor } from "./supervisor.js";
import { TimeShiftedApi } from "./time-faults.js";
import type { RestartStep } from "./repeated-restarts.js";
import { isBrokenStdoutError, markTimelineEchoBroken, Timeline } from "./timeline.js";
import { guardedRunnerOutputs, worktreeFingerprint } from "./wave-guard.js";
import { checkCrossServer, readCrossServerEvidence } from "./multi-server.js";
import { sessionFaultServerEnvironment } from "./session-faults.js";
import { controllerLogNames, gradeWarmShutdown, isWarmWave, warmShutdownMarkdown, type WarmShutdownCleanup } from "./warm-shutdown.js";
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
      .then(text => JSON.parse(text) as { record: { createdAt: number | null; faultIds: string[]; serverBuildAtLaunch?: "upgrade_from" | "current" } })
      .catch(() => null);
    // An interrupted or wedged wave has no grade files; its fault log was written after every fault.
    const logged = await readFile(path.join(sourceDir, TASK_FAULT_LOG), "utf8").then(text => JSON.parse(text) as TaskFaultLog).catch(() => null);
    const crossed = replayRecordFor(command.ref.taskId, graded?.record ?? null, logged);
    const faults = await readFile(path.join(sourceDir, "faults.json"), "utf8").then(text => JSON.parse(text) as FaultReceipt[]).catch(() => []);
    const observed = crossed ? observedFaultSchedule(crossed.createdAt, crossed.faultIds, faults, command.ref.taskId) : [];
    if (!observed.length) console.warn("Replay: no recorded fault sequence for this task; using its planned fault only.");
    let plan = replayWave(source, command.ref, Date.now(), command.overrides, observed);
    if (source.options.storage === "s3" && crossed?.createdAt) {
      const receipts = await readFile(path.join(sourceDir, "storage-faults.json"), "utf8").then(text => JSON.parse(text) as StorageFaultReceipt[]).catch(() => []);
      const ended = Math.max(crossed.createdAt, ...receipts.map(receipt => receipt.endedAt ?? 0));
      plan = { ...plan, options: { ...plan.options, storageWindows: replayStorageWindows(receipts, crossed.createdAt, ended) } };
    }
    // K14: a task that launched after the upgrade replays on the current build.
    const launchBuild = graded?.record.serverBuildAtLaunch ?? logged?.[command.ref.taskId]?.serverBuildAtLaunch;
    if (plan.options.upgradeFrom && launchBuild === "current") plan = replayOnCurrentBuild(plan);
    // H1 needs the hard stop that the RC-06 mask turns off.
    if (plan.tasks.some(task => task.workload === "H1") && plan.options.masks?.includes("rc06")) {
      throw new Error("An H1 replay needs the budget hard stop; do not combine it with --rc06-masked");
    }
    return { plan, keep: command.keep };
  }
  const waveId = waveIdFor(command.options.seed);
  return { plan: command.options.matrix ? planMatrixWave(waveId, command.options) : planWave(waveId, command.options), keep: command.keep };
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
  const artifacts = await prepareDaytonaImageArtifacts({ image, cacheRoot: defaultDaytonaImageCacheRoot(),
    log: line => console.info(`[daytona-image] ${line}`) });
  const { localContentId } = await assertControllerMatchesImage(artifacts, repositoryRoot);
  timeline.add("daytona_image_matched", { image, contentId: artifacts.contentId, localContentId, sourceRevision: artifacts.sourceRevision,
    runnerdSha256: artifacts.runnerdSha256, providerPackDigest: artifacts.providerPackDigest, platformManifestDigest: artifacts.platformManifestDigest });
  ensureDaytonaPlugin(timeline);
  if (plan.options.daytonaSandboxImage) {
    // Prove the sandbox image's preinstalled pack differs, so every fresh sandbox must upload the controller's.
    const sandbox = await prepareDaytonaImageArtifacts({ image: plan.options.daytonaSandboxImage, cacheRoot: defaultDaytonaImageCacheRoot(),
      log: line => console.info(`[daytona-image] ${line}`) });
    assertProviderPackMismatch(artifacts, sandbox);
    timeline.add("daytona_pack_mismatch", { controllerImage: image, sandboxImage: sandbox.image,
      controllerProviderPackDigest: artifacts.providerPackDigest, sandboxProviderPackDigest: sandbox.providerPackDigest });
  }
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
  // K14: the older checkout must be prepared (installed and built) before the wave, like this one.
  // `--server-from` runs the whole wave on another prepared checkout, prepared like an upgrade's older build.
  const upgradeFrom = plan.options.upgradeFrom ?? plan.options.serverFrom;
  // One runner binary for both builds would not test the older runner's saved state.
  if (upgradeFrom && process.env.PAPERCLIP_RUNNER_BINARY) {
    throw new Error("--upgrade-from runs each build's own runner; unset PAPERCLIP_RUNNER_BINARY");
  }
  if (upgradeFrom) {
    for (const required of ["tests/runner-e2e/server-entry.ts", "node_modules", "packages/paperclip-runner/runner/target/debug/paperclip-runnerd"]) {
      if (!existsSync(path.join(upgradeFrom, required))) {
        throw new Error(`--upgrade-from ${upgradeFrom} is not a prepared checkout (missing ${required}). `
          + "Create it with `git worktree add <dir> <commit>`, then run `node scripts/agent-preflight.mjs` in it.");
      }
    }
    if (path.resolve(upgradeFrom) === repositoryRoot) throw new Error("--upgrade-from must be a different checkout than the one running the harness");
    const oldBuild = spawnSync(process.execPath, [path.join(upgradeFrom, "packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs")],
      { cwd: upgradeFrom, stdio: "inherit" });
    if (oldBuild.status !== 0) throw new Error("Verified provider entrypoint build failed in the --upgrade-from checkout");
  }
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
  const serverEnvironment: Record<string, string> = plan.options.env === "daytona" ? await prepareDaytona(plan, timeline) : {};
  // The suite drives the API only; the Vite dev UI only slows every boot and restart.
  if (plan.options.crashPoint && !plan.replayOf) serverEnvironment.SERVE_UI = "false";
  // Baseline only after the harness's own build steps (preflight rewrites the runner's dist).
  startFingerprint = worktreeFingerprint(repositoryRoot, guardedOutputs);

  const crashPoint = plan.replayOf ? null : plan.options.crashPoint ?? null;
  const crashPoints = crashPoint ? crashPoint.split(",") : [];
  const batchSize = crashPoints.length ? Math.max(1, Math.floor(plan.tasks.length / crashPoints.length)) : 0;
  if (crashPoint && plan.tasks.length !== batchSize * crashPoints.length) throw new Error(`--tasks must be a multiple of the ${crashPoints.length} crash point(s)`);
  const supervisor = await ChaosSupervisor.create({ repositoryRoot, waveDir, timeline,
    ...(plan.options.upgradeFrom ?? plan.options.serverFrom ? { upgradeFrom: plan.options.upgradeFrom ?? plan.options.serverFrom } : {}),
    // K15: every server of the wave runs under an emulated deploy identity; a replay derives the source wave's ones.
    ...(redeployWave(plan) ? { redeployWaveId: plan.replayOf?.waveId ?? plan.waveId } : {}) });
  // Crash-point suite: one booted server, one point at a time. Each point gets
  // its own batch of tasks; the point is armed once the batch launched and the
  // server kills itself at its nth hit (restarted like K1). Invariants are
  // checked when the batch rests, as violations new since the point was armed.
  // A replay fires the recorded faults (the crash point's K1 restart included)
  // at their offsets; re-arming the point could miss its nth hit with fewer tasks.
  type PointResult = { point: string; token: string; taskIds: string[]; armedAt: number; restedAt: number | null;
    fault: FaultReceipt | null; invariants: InvariantCheck | null };
  const pointResults: Array<PointResult & { baseline?: Set<string> }> = [];
  let currentPoint: (PointResult & { baseline: Set<string> }) | null = null;
  let databaseUrl: string | null = null;
  // The wave's own isolated database (never another instance's).
  const waveDatabaseUrl = () => {
    if (!databaseUrl) {
      const config = JSON.parse(readFileSync(supervisor.paths.configPath, "utf8")) as { database?: { connectionString?: string } };
      databaseUrl = config.database?.connectionString ?? null;
      if (!databaseUrl) throw new Error("The instance config has no database connection string");
    }
    return databaseUrl;
  };
  let pressure: RunRowPressure | null = null;
  const stopPressure = async () => {
    if (!pressure) return;
    const stats = await pressure.stop();
    pressure = null;
    timeline.add("db_pressure_stopped", { ...stats });
  };
  const violationKey = (violation: { rule: string; kind: string; recordId: string }) => `${violation.rule}:${violation.kind}:${violation.recordId}`;
  // `--k15-overlap-seconds`, `--k15-fresh-home`: the staging deploy shape (redeploy.ts).
  supervisor.deployShape = { overlap: plan.options.k15Overlap === true, freshHome: plan.options.k15FreshHome === true };
  supervisor.ephemeralServer = plan.options.ephemeralServer === true;
  // `--fail-recovery-step`: fail the nth hit of one recovery step once, after the wave's first restart fault.
  const recoveryStepReceipts = path.join(waveDir, "recovery-step-receipts.jsonl");
  if (plan.options.failRecoveryStep) {
    supervisor.armRecoveryStepOnFirstFault(plan.options.failRecoveryStep, {
      controlPath: path.join(supervisor.paths.temporaryRoot, "crash-point.control"), receiptPath: recoveryStepReceipts });
  }
  if (crashPoint) {
    supervisor.crashPointHoldMs = plan.options.crashPointHoldMs ?? 0;
    supervisor.useCrashPointControl({ controlPath: path.join(supervisor.paths.temporaryRoot, "crash-point.control"),
      receiptPath: path.join(waveDir, "crash-point-receipts.jsonl") });
  }
  let sweeper: DaytonaWaveSweeper | null = null;
  let sandboxSweep: DaytonaSweepResult | null = null;
  let runnerLogTarget: { companyId: string; environmentId: string } | null = null;
  // CR1–CR3 get the class R hooks (class-r.ts). Every Daytona wave captures its sandboxes with the class R probe
  // (daytona-runner-logs.ts): staging's Runner loss also reproduces with no fault at all (W2 re-wake).
  const classRWave = plan.tasks.some(task => isClassRFault(task.fault) || (task.replayFaults?.some(fault => isClassRFault(fault.kind)) ?? false));
  const sandboxEvidence = plan.options.env === "daytona";
  const captureRunnerLogs = async (label: string, deadlineMs?: number) => {
    if (!runnerLogTarget) return;
    const capture = await captureWaveRunnerLogs({ apiKey: process.env.DAYTONA_API_KEY!, ...runnerLogTarget,
      outDir: path.join(waveDir, "daytona-runner"), label, secrets: knownSecretValues(),
      probe: "class_r", ...(deadlineMs ? { deadlineMs } : {}) });
    timeline.add("runner_logs_captured", { label: capture.label, error: capture.error,
      sandboxes: capture.sandboxes.map(sandbox => `${sandbox.id}:${sandbox.state ?? "?"}${sandbox.file ? ":probed" : ""}${sandbox.error ? `:error=${sandbox.error.slice(0, 120)}` : ""}`) });
  };
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
  let stopFailed = false;
  let remoteCleanupPending = false;
  let board: BoardUi | null = null;
  let objectStore: ObjectStore | null = null;
  let storageChaos: StorageChaos | null = null;
  let storageTrigger: StorageTrigger | null = null;
  let nativeTrigger: NativeTrigger | null = null;
  let storageProxy: Awaited<ReturnType<typeof startStorageFaultProxy>> | null = null;
  let credentialRotation: CredentialRotation | null = null;
  let storageAuditor: StorageAuditor | null = null;
  let providerFaults: ProviderFaultSeam | null = null;
  let acpxSidecarSeam: AcpxSidecarSeam | null = null;
  let diskFullSeam: DiskFullFaultSeam | null = null;
  let speedSection: string | null = null;
  let storageSection: string | null = null;
  let warmShutdownSection: string | null = null;
  let daytonaCleanup: WarmShutdownCleanup | null = null;
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
  // CR2 and the class R watch read the task's latest run from the observers (set once they exist).
  let classRObservers: TaskObserver[] = [];
  const killTaskProvider = async (owned: { companyId: string; environmentId: string }, taskId: string): Promise<ProviderKillRecord> => {
    const observer = classRObservers.find(candidate => candidate.plan.taskId === taskId);
    const adapter = observer?.plan.adapter ?? "claude";
    // The latest sample was taken just before the fault (snapshotBeforeFault); the server may already be down.
    const runs = [...(observer?.record.samples ?? [])].reverse().find(sample => sample.runs?.length)?.runs ?? [];
    const runId = runs.find(run => run.status === "running")?.id ?? null;
    const record: ProviderKillRecord = { runId, adapter, at: Date.now(), sandboxId: null, killedPids: [], attempts: [], error: null };
    if (!runId) record.error = "no running run for the task";
    else {
      const result = await executeInWaveSandboxes({ apiKey: process.env.DAYTONA_API_KEY!, ...owned, command: providerKillCommand(runId, adapter),
        secrets: knownSecretValues(), done: attempt => attempt.exitCode === 0 || attempt.exitCode === 4 || attempt.exitCode === 5 });
      record.attempts = result.attempts;
      // Exit 0 is printed only when every selected provider process is confirmed gone.
      const hit = result.attempts.find(attempt => attempt.exitCode === 0);
      record.sandboxId = hit?.sandboxId ?? null;
      record.killedPids = hit ? killedPidsFromOutput(hit.output) : [];
      record.error = result.error ?? (hit ? null : result.attempts.some(attempt => attempt.exitCode === 5)
        ? "a provider process survived the kill" : result.attempts.some(attempt => attempt.exitCode === 4)
          ? "the run's Runner had no provider process" : "no sandbox runs a Runner for the run");
    }
    timeline.add("class_r_provider_killed", { taskId, runId, adapter, sandboxId: record.sandboxId, killedPids: record.killedPids, error: record.error,
      attempts: record.attempts.map(attempt => `${attempt.sandboxId}:${attempt.exitCode ?? attempt.error?.slice(0, 80)}`) });
    await writeFile(path.join(waveDir, "daytona-runner", `provider-kill-${taskId}-${record.at}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      .catch(() => undefined);
    return record;
  };
  // After a class R fault the controller is ready again; staging found the provider gone about 40 s later.
  const watchClassR = async (receipt: FaultReceipt) => {
    const readyAt = receipt.readyAt ?? Date.now();
    for (const { label, atMs } of watchLabels(receipt.faultId)) {
      const owner = classRObservers.find(candidate => candidate.plan.taskId === receipt.requestedBy);
      // Keep watching through the staging window even after a fast rest; stop early only past it.
      if (atMs > 60_000 && (owner?.done ?? true)) break;
      if (interrupted) break;
      const wait = readyAt + atMs - Date.now();
      if (wait > 0) await delay(wait);
      await captureRunnerLogs(label);
      receipt.classR?.captures.push(label);
    }
  };
  let sandboxWatchStopped = false;
  const watchSandboxes = async (intervalMs: number) => {
    const startedAt = Date.now();
    while (!sandboxWatchStopped && !interrupted) {
      const started = Date.now();
      await captureRunnerLogs(`watch+${Math.round((started - startedAt) / 1000)}s`);
      const wait = intervalMs - (Date.now() - started);
      for (let left = wait; left > 0 && !sandboxWatchStopped && !interrupted; left -= 1_000) await delay(Math.min(1_000, left));
    }
  };
  let faultFailures = 0;
  let faultsQueued = 0;
  try {
    if (plan.options.storage === "s3") {
      const binary = minioBinary();
      if (!binary) throw new Error(`--storage s3 needs MinIO ${MINIO_RELEASE} at ${DEFAULT_MINIO_BINARY} or RESTART_CHAOS_MINIO_BIN`);
      objectStore = await startMinio({ binary, root: supervisor.paths.temporaryRoot });
      storageProxy = await startStorageFaultProxy(objectStore.endpoint);
      if (auditsStorage(plan.options)) storageAuditor = new StorageAuditor(objectStore, `chaos/${plan.waveId}/`);
      Object.assign(serverEnvironment, objectStoreServerEnvironment(objectStore, storageProxy.endpoint, `chaos/${plan.waveId}/`));
      if (needsCredentialRotation(plan.options)) {
        const rotating = await startCredentialRotation({ store: objectStore, binary, root: supervisor.paths.temporaryRoot, record: (kind, data) => timeline.add(kind, data) });
        credentialRotation = rotating.rotation;
        Object.assign(serverEnvironment, rotating.environment);
      }
      timeline.add("object_store_started", { release: MINIO_RELEASE, endpoint: objectStore.endpoint, proxy: storageProxy.endpoint, bucket: objectStore.bucket });
    }
    if (plan.tasks.some(task => task.providerFault)) {
      // PV1–PV3: route the server's Codex launches through the fault shim (no product change).
      // The provider the server actually runs: `--server-from` serves another checkout.
      const realCodex = resolveRealCodex(plan.options.serverFrom ?? repositoryRoot);
      providerFaults = await installProviderFaultSeam({ root: supervisor.paths.temporaryRoot, logPath: path.join(waveDir, "provider-faults.jsonl"),
        realCommand: realCodex.command, realVersion: realCodex.version, realManifestPath: realCodex.manifestPath,
        ...(process.env.NODE_OPTIONS ? { inheritedNodeOptions: process.env.NODE_OPTIONS } : {}) });
      await providerFaults.arm(plan.tasks);
      Object.assign(serverEnvironment, providerFaults.serverEnvironment);
      if (plan.tasks.some(task => task.providerFault && task.adapter === "claude")) {
        // Claude (ACPX): the stand-in sidecar taps the verified provider's pipe (acpx-provider-faults.ts).
        // The seam must mirror the runner the server actually loads (`--server-from` runs another checkout).
        acpxSidecarSeam = await installAcpxSidecarSeam({ repositoryRoot: plan.options.serverFrom ?? repositoryRoot, waveId: plan.waveId, controlPath: providerFaults.controlPath,
          logPath: providerFaults.logPath, stateDirectory: providerFaults.stateDirectory });
        Object.assign(serverEnvironment, acpxSidecarSeam.serverEnvironment,
          { NODE_OPTIONS: withAcpxSidecarHook(serverEnvironment.NODE_OPTIONS) });
        timeline.add("acpx_provider_faults_installed", { standInRoot: acpxSidecarSeam.standInRoot, realSidecar: acpxSidecarSeam.realSidecar });
      }
      timeline.add("provider_faults_installed", { realCodex: realCodex.command, codexVersion: realCodex.version,
        rules: plan.tasks.flatMap(task => task.providerFault ? [`${task.taskId}:${describeProviderFault(task.providerFault)}`] : []) });
    }
    if (plan.tasks.some(task => isDiskFullFault(task.fault))) {
      // DF1: the server's test-only hook reads this control file at each final workspace save.
      diskFullSeam = await DiskFullFaultSeam.install({ root: supervisor.paths.temporaryRoot, receiptPath: path.join(waveDir, "disk-full-faults.jsonl") });
      Object.assign(serverEnvironment, diskFullSeam.serverEnvironment);
      timeline.add("disk_full_faults_installed", { tasks: plan.tasks.filter(task => isDiskFullFault(task.fault)).map(task => task.taskId) });
    }
    if (plan.options.timeAgeMs) supervisor.timeAgeMs = plan.options.timeAgeMs;
    if (plan.options.rrStopOn) supervisor.rrStopOn = plan.options.rrStopOn;
    Object.assign(serverEnvironment, sessionFaultServerEnvironment(plan.options.sessionFaults));
    await supervisor.start(serverEnvironment);
    // TM2/TM3 age the database; the observer and grader read run times back at their real times.
    const api: ChaosApi = new TimeShiftedApi(supervisor.baseUrl, supervisor.agingShifts);
    const lab = await seedChaosLab({ api, env: plan.options.env, waitForReadyAgents: true, cancelled: () => interrupted,
      // The controller keeps daytonaImage's runnerd and pack; a pack-mismatch wave starts sandboxes from another image.
      daytonaImage: plan.options.daytonaSandboxImage ?? plan.options.daytonaImage, daytonaCpu: plan.options.daytonaCpu,
      daytonaReuseLease: plan.options.daytonaReuseLease,
      daytonaWarm: plan.options.daytonaWarm, daytonaInherit: plan.options.daytonaInherit,
      adapters: [...new Set([...plan.tasks.map(task => task.adapter),
        ...(plan.tasks.some(task => task.workload === "M1") ? plan.options.adapters : [])])],
      concurrency: plan.options.concurrency, budgetCents: plan.options.budgetCents, masks: plan.options.masks,
      fixtureRoot: path.join(supervisor.paths.temporaryRoot, "fixtures"), workspaceRepo: plan.options.workspaceRepo,
      workspaceCommit: plan.options.workspaceCommit, workspaceGitUrl: plan.options.workspaceGitUrl, waveId: plan.waveId, timeline,
      adapterConfigOverrides: chaosLifecycleOverrides(plan.options.lifecycle),
      onEnvironment: owned => {
        sweeper = new DaytonaWaveSweeper({ apiKey: process.env.DAYTONA_API_KEY!, companyId: owned.companyId, environmentId: owned.environmentId, api });
        // K15 on Daytona: the remote Runner's logs, identity and state while the controller is down (daytona-runner-logs.ts).
        if (sandboxEvidence) {
          runnerLogTarget = { companyId: owned.companyId, environmentId: owned.environmentId };
          if (redeployWave(plan)) supervisor.redeployEvidence = (faultId, phase) => captureRunnerLogs(`${faultId}-${phase}`);
          // `--sandbox-watch-seconds`: capture on a clock too, for Runner exits that no fault announces (W2 re-wake).
          if (plan.options.sandboxWatchMs) faultWork.push(watchSandboxes(plan.options.sandboxWatchMs));
        }
        if (classRWave) supervisor.classR = {
          capture: async (label, deadlineMs) => { await captureRunnerLogs(label, deadlineMs); return label; },
          killProvider: requestedBy => killTaskProvider(owned, requestedBy),
          watchAfterReady: receipt => { faultWork.push(watchClassR(receipt)); },
        };
      } });
    spendTarget = { api, companyId: lab.companyId };
    // --db-pressure: contend with the wave's running run rows from outside the server (contention.ts).
    if (plan.options.dbPressure) {
      pressure = new RunRowPressure(waveDatabaseUrl(), lab.companyId, plan.options.dbPressure).start();
      timeline.add("db_pressure_started", { writers: plan.options.dbPressure });
    }
    // The instance root holds the secrets master key and the database: oracle code may not read it.
    const protectedRoots = [os.homedir(), supervisor.paths.temporaryRoot, resultsRoot];
    board = serverEnvironment.SERVE_UI === "false" ? null
      : new BoardUi(supervisor.baseUrl, undefined, path.join(waveDir, "ui-retry-diagnostics"));
    const observers = plan.tasks.map(task => new TaskObserver(task, api, lab, timeline, supervisor, protectedRoots, board));
    for (const observer of observers) if (isDiskFullFault(observer.plan.fault)) observer.diskFullSeam = diskFullSeam;
    classRObservers = observers;
    const pending = [...observers];
    const launched: TaskObserver[] = [];
    const active: TaskObserver[] = [];
    const lastPoll = new Map<TaskObserver, number>();
    let lastDoneAt = Date.now();
    // K13: storm faults fire on their own clock while tasks keep launching; then the storm drains.
    const storm = plan.storm ? new StormRun(plan.storm, Date.now()) : null;
    if (storageProxy && (plan.options.storageWindows?.length || plan.options.storageFaults?.length)) {
      const windows = plan.options.storageWindows ?? planStorageFaults({ kinds: plan.options.storageFaults!, seed: plan.seed,
        spanMs: plan.storm?.durationMs ?? plan.tasks.length * 4 * 60_000, ...(plan.options.storageFaultMs ? { durationMs: plan.options.storageFaultMs } : {}) });
      storageChaos = new StorageChaos(windows, Date.now(), credentialRotation?.wrap(storageProxy) ?? storageProxy, (kind, data) => timeline.add(kind, data));
      if (!plan.options.storageWindows) storageChaos.start();
      timeline.add("storage_faults_planned", { windows: windows.map(window => `${window.kind}@${window.startMs}ms+${window.durationMs}ms`) });
    }
    if (storm) timeline.add("storm_started", { durationMs: storm.plan.durationMs, plannedFaults: storm.plan.faults.length });
    // Faults are serialized; each one hits every task in flight when it starts.
    const fireFault = (kind: FaultKind, holdMs: number, requestedBy: string, exposed: readonly TaskObserver[],
      trigger?: { trigger: TriggerId; delayMs: number }, onSettled?: () => void, restartSteps?: RestartStep[]) => {
      faultsQueued += 1;
      faultWork.push(supervisor.fault(kind, holdMs, requestedBy, trigger, restartSteps).finally(() => { faultsQueued -= 1; onSettled?.(); }).then(receipt => {
        faults.push(receipt);
        checkWorktree(receipt.faultId);
        for (const candidate of exposed) {
          candidate.noteFault(receipt.faultId, receipt.startedAt);
          candidate.extendDeadline((receipt.readyAt ?? Date.now()) - receipt.startedAt);
          taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds],
            ...(candidate.record.serverBuildAtLaunch ? { serverBuildAtLaunch: candidate.record.serverBuildAtLaunch } : {}) };
        }
        void persistFaultLog();
      }, (error: Error & { receipt?: FaultReceipt }) => {
        if (error.receipt) {
          // A failed fault still crossed the tasks in flight; replay must fire it too.
          const receipt = error.receipt;
          faults.push(receipt);
          for (const candidate of exposed) {
            candidate.noteFault(receipt.faultId, receipt.startedAt);
            taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds],
            ...(candidate.record.serverBuildAtLaunch ? { serverBuildAtLaunch: candidate.record.serverBuildAtLaunch } : {}) };
          }
          void persistFaultLog();
        }
        faultFailures += 1;
        timeline.add("fault_error", { taskId: requestedBy, error: error.message });
      }));
    };

    let launching: Promise<void> | null = null;
    if (storageProxy && plan.options.storageTrigger) {
      storageTrigger = new StorageTrigger(plan.options.storageTrigger, {
        canFire: () => !interrupted && !faultsQueued && !supervisor.faultInProgress && supervisor.serverReady,
        isOpen: taskId => observers.some(observer => observer.plan.taskId === taskId && !observer.done && observer.record.restAt === null),
        record: (kind, data) => timeline.add(kind, data),
        fire: armed => {
          faultsQueued += 1;
          const work = (async () => {
            const exposed = await exposedAfterLaunch(launching, launched);
            await Promise.all(exposed.map(candidate => candidate.snapshotBeforeFault()));
            const queued = faultWork.length;
            fireFault(armed.kind, armed.holdMs, armed.taskId, exposed, undefined, undefined, armed.restartSteps);
            await faultWork[queued];
          })().finally(() => { faultsQueued -= 1; });
          faultWork.push(work);
          return work;
        },
      });
      storageProxy.observe(storageTrigger.listener);
    }
    const outageMs = plan.options.nativeTrigger?.outageMs;
    const outageWindows: StorageFaultWindow[] = [];
    const outageClock = Date.now();
    if (outageMs && storageProxy && !storageChaos && !plan.replayOf) {
      storageChaos = new StorageChaos(outageWindows, outageClock, credentialRotation?.wrap(storageProxy) ?? storageProxy, (kind, data) => timeline.add(kind, data));
      storageChaos.start(1_000, outageClock);
    }
    if (plan.options.nativeTrigger && !plan.replayOf) {
      nativeTrigger = new NativeTrigger(plan.options.nativeTrigger, {
        canFire: () => !interrupted && !faultsQueued && !supervisor.faultInProgress && supervisor.serverReady,
        isOpen: taskId => observers.some(observer => observer.plan.taskId === taskId && !observer.done && observer.record.restAt === null),
        issueId: taskId => observers.find(observer => observer.plan.taskId === taskId)?.record.issueId ?? null,
        runs: issueId => api.get<unknown[]>(`/api/issues/${issueId}/runs`, 5_000),
        events: (runId, afterSeq, limit) => api.get(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=${limit}`, 5_000),
        record: (kind, data) => timeline.add(kind, data),
        fire: armed => {
          faultsQueued += 1;
          const work = (async () => {
            const exposed = await exposedAfterLaunch(launching, launched);
            await Promise.all(exposed.map(candidate => candidate.snapshotBeforeFault()));
            const queued = faultWork.length;
            if (outageMs) {
              outageWindows.push(triggeredOutageWindow(Date.now() - outageClock, outageMs));
              storageChaos?.tick();
            }
            fireFault(armed.kind, armed.holdMs, armed.taskId, exposed, undefined, undefined, armed.restartSteps);
            await faultWork[queued];
          })().finally(() => { faultsQueued -= 1; });
          faultWork.push(work);
          return work;
        },
      });
    }

    supervisor.onCrashPoint = receipt => {
      const owner = pointResults.find(result => result.token === receipt.crashPoint?.token);
      if (owner) owner.fault = receipt;
      faults.push(receipt);
      if (receipt.error) { faultFailures += 1; timeline.add("fault_error", { taskId: "crash-point", error: receipt.error }); }
      for (const candidate of active.filter(observer => !observer.done)) {
        candidate.noteFault(receipt.faultId, receipt.startedAt);
        candidate.extendDeadline((receipt.readyAt ?? Date.now()) - receipt.startedAt);
        taskFaultLog[candidate.plan.taskId] = { createdAt: candidate.record.createdAt, faultIds: [...candidate.record.faultIds],
            ...(candidate.record.serverBuildAtLaunch ? { serverBuildAtLaunch: candidate.record.serverBuildAtLaunch } : {}) };
      }
      checkWorktree(receipt.faultId);
      void persistFaultLog();
    };

    const invariantsNow = async () => {
      return checkPlanInvariants({ connectionString: waveDatabaseUrl(), companyId: lab.companyId,
        paperclipHome: supervisor.paths.home, instanceId: "default" });
    };
    const startCrashPoint = async (batch: TaskObserver[]) => {
      const index = pointResults.length;
      const spec = crashPoints[index]!;
      // Violations already present belong to earlier points, not this one.
      const before = await invariantsNow();
      const baseline = new Set(before.violations.map(violationKey));
      // Stage the batch unassigned (no wake yet), arm the point, then assign:
      // no task's work can start before the point is armed, and an early
      // crash cannot fail a later task's creation. The previous batch has
      // rested, so only this batch's work can hit the point.
      for (const observer of batch) await observer.stage();
      const result = { point: spec, token: `p${String(index + 1).padStart(2, "0")}`, taskIds: batch.map(observer => observer.plan.taskId),
        armedAt: Date.now(), restedAt: null, fault: null, invariants: null, baseline };
      pointResults.push(result);
      supervisor.armCrashPoint(result.token, spec);
      for (const observer of batch) {
        launched.push(observer);
        await observer.release();
        if (!observer.done) active.push(observer);
      }
      return result;
    };
    const finishCrashPoint = async (point: PointResult & { baseline: Set<string> }) => {
      supervisor.disarmCrashPoint();
      point.restedAt = Date.now();
      const check = await invariantsNow();
      const fresh = check.violations.filter(violation => !point.baseline.has(violationKey(violation)));
      point.invariants = { ...check, violations: fresh, byInvariant: summarizeViolations(fresh) };
      timeline.add("crash_point_settled", { point: point.point, token: point.token, reached: point.fault?.crashPoint ?? null,
        seconds: Math.round((point.restedAt - point.armedAt) / 1000), byInvariant: point.invariants.byInvariant,
        errors: check.errors.map(error => redactKnownSecrets(error, knownSecretValues())) });
    };

    while (!interrupted && (pending.length || active.length || storageTrigger?.busy || nativeTrigger?.busy)) {
      const now = Date.now();
      await nativeTrigger?.tick(now);
      if (storm?.endIfDue(now)) {
        // Unlaunched pool tasks are not part of the wave; the in-flight ones drain without new faults.
        timeline.add("storm_ended", { faultsFired: storm.state.fired, inFlight: active.length, unlaunched: pending.length });
        pending.length = 0;
      }
      // A failed fault or an unexpected exit leaves the server not ready.
      // Recover within a bound, or fail the wave instead of waiting forever.
      if (!supervisor.serverReady && !supervisor.faultInProgress) await supervisor.ensureServing();
      if (crashPoint) {
        // One point at a time: settle the previous batch, then launch and arm the next.
        if (!active.length && supervisor.serverReady && !supervisor.faultInProgress) {
          if (currentPoint) { await finishCrashPoint(currentPoint); currentPoint = null; }
          if (pending.length) currentPoint = await startCrashPoint(pending.splice(0, batchSize));
        }
      }
      // Recheck the storm clock per launch: ensureServing or a slow launch can cross the storm's end.
      while (!crashPoint && active.length < plan.options.concurrency && pending.length && supervisor.serverReady && !supervisor.faultInProgress && !storageTrigger?.busy && !nativeTrigger?.busy
        && (!storm || storm.mayLaunch(Date.now()))
        // `--matrix`: no-fault baselines never share the server with a fault cell.
        && (!plan.options.matrix || matrixMayLaunch(pending[0]!.plan, active.filter(observer => !observer.done).map(observer => observer.plan)))) {
        const next = pending.shift()!;
        launched.push(next);
        launching = next.launch().finally(() => { launching = null; });
        await launching;
        if (plan.options.storageWindows && storageChaos && launched.length === 1) storageChaos.start();
        if (!next.done) active.push(next);
      }
      // `--provider-fault-restart`: a task's K1 is armed once the shim logged its fault.
      if (providerFaults) {
        for (const observer of active) {
          if (!observer.plan.providerFault?.restart || observer.record.providerFaultAppliedAt !== undefined) continue;
          const rule = observer.plan.providerFault;
          const applied = (await providerFaults.eventsFor(observer.plan.nonce))
            .find(event => event.event === "applied" && event.kind === rule.kind && event.message === rule.message);
          if (applied) observer.record.providerFaultAppliedAt = applied.at;
        }
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
        if (nativeTrigger) { nativeTrigger.arm({ taskId: observer.plan.taskId, kind: due.kind, holdMs: due.holdMs, armedAt: Date.now(), ...(due.restartSteps ? { restartSteps: due.restartSteps } : {}) }); continue; }
        if (storageTrigger) { storageTrigger.arm({ taskId: observer.plan.taskId, kind: due.kind, holdMs: due.holdMs, armedAt: Date.now(), ...(due.restartSteps ? { restartSteps: due.restartSteps } : {}) }); continue; }
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
        fireFault(due.kind, due.holdMs, observer.plan.taskId, exposed, trigger, storm ? () => storm.settled(Date.now()) : undefined, due.restartSteps);
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
        if (!active[index]!.done) continue;
        // Daytona: the sandboxes as the task rests, before the product releases them (pass or fail).
        if (runnerLogTarget) faultWork.push(captureRunnerLogs(`${active[index]!.plan.taskId}-rest`));
        active.splice(index, 1); lastDoneAt = Date.now();
      }
      await delay(1_000);
    }
    sandboxWatchStopped = true;
    await Promise.all(faultWork);
    if (storageTrigger) {
      const shortfall = storageTriggerShortfall(storageTrigger.finish(faults));
      storageSection = storageTriggerMarkdown(storageTrigger.receipts);
      timeline.add("storage_trigger_settled", { shortfall, receipts: storageTrigger.receipts.length });
      if (shortfall) harnessError ??= new Error(shortfall);
    }
    if (nativeTrigger) {
      const shortfall = nativeTriggerShortfall(nativeTrigger.finish(faults));
      storageSection = [storageSection, nativeTriggerMarkdown(nativeTrigger.receipts)].filter(Boolean).join("\n");
      timeline.add("native_trigger_settled", { shortfall, receipts: nativeTrigger.receipts.length });
      if (shortfall) harnessError ??= new Error(shortfall);
    }
    await stopPressure();
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
    if (interrupted) {
      harnessError ??= new Error("Harness interrupted before the wave finished");
      for (const observer of launched) observer.markUnfinished();
    }

    // R6: let finalizers settle, then sweep for anything still pending.
    const quietFor = Date.now() - lastDoneAt;
    if (quietFor < QUIET_BEFORE_SWEEP_MS) await delay(QUIET_BEFORE_SWEEP_MS - quietFor);
    await recordWaveSpend();
    timeline.add("wave_sweep", {});
    if (runnerLogTarget) await captureRunnerLogs("wave-end");
    if (sweeper) {
      sandboxSweep = await (sweeper as DaytonaWaveSweeper).sweep();
      timeline.add("daytona_sweep", { ...sandboxSweep });
    }
    const attributed = new Set<string>();
    const secrets = knownSecretValues();
    // U3 and L1 read the wave database once, before the instance is removed.
    const evidenceDb = createDb(waveDatabaseUrl());
    const universalByIssue = await readUniversalDbEvidence(evidenceDb, lab.companyId).catch(error => {
      timeline.add("universal_db_evidence_failed", { error: String(error) }); return null; });
    const allRunMessages = new Map([...(universalByIssue?.values() ?? [])].flatMap(entry => [...entry.runMessages]));
    const costSummary = launched.some(observer => observer.plan.workload === "L1")
      ? await api.get<Record<string, unknown>>(`/api/companies/${lab.companyId}/costs/summary?period=all`)
        .then(summary => typeof summary.spendCents === "number"
          ? { spendCents: summary.spendCents, pendingRunCount: Number(summary.pendingRunCount ?? 0) } : null).catch(() => null) : null;
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
      if (artifacts && providerFaults && observer.plan.providerFault) artifacts.providerFaultEvents = await providerFaults.eventsFor(observer.plan.nonce);
      if (artifacts && observer.plan.workload === "L1") {
        const runIds = [...new Set(observer.record.samples.flatMap(sample => (sample.runs ?? []).map(run => run.id)))];
        artifacts.contention = await collectContentionEvidence(evidenceDb, lab.companyId, runIds, costSummary);
      }
      const graded = artifacts ? observer.definition.grade(observer.plan.nonce, artifacts, observer.workloadAgents())
        : { verdict: "fail" as const, checks: [{ name: "artifacts_collected", ok: false, detail: observer.record.launchError ?? "collection failed" }] };
      // A provider-fault task whose fault never happened tested nothing.
      const restart = faults.find(receipt => receipt.requestedBy === observer.plan.taskId && receipt.trigger === "provider");
      const oracle = withProviderFaultCheck(graded, observer.plan, artifacts?.providerFaultEvents ?? [], restart?.startedAt ?? null,
        restart?.stoppedAt ?? restart?.startedAt ?? null);
      if (observer.record.diskFull) {
        observer.record.diskFull.appliedSaves = receiptsForIssue(await diskFullSeam?.receipts() ?? [], observer.record.issueId).length;
      }
      // T1: a mid-tool fault only counts when one of the task's faults started while its loop ran (workloads.ts).
      // DF1 restarts nothing, so T1's mid-tool restart check does not apply; the disk-full check replaces it.
      const t1Oracle = isDiskFullFault(observer.plan.fault) ? withDiskFullCheck(oracle, observer.plan, observer.record)
        : withT1CrossingCheck(oracle, observer.plan, artifacts?.documents.brief, faults);
      // `--fail-recovery-step`: the step failed in the replacement, and no attempt of the task failed (recovery-step-faults.ts).
      const armedStep = faults.find(receipt => receipt.recoveryStep);
      const stepOracle = withRecoveryStepCheck(t1Oracle, armedStep?.recoveryStep ? { faultId: armedStep.faultId, ...armedStep.recoveryStep } : null,
        observer.record.faultIds, parseRecoveryStepReceipts(await readFile(recoveryStepReceipts, "utf8").catch(() => "")), artifacts?.runs ?? []);
      // CR1–CR3: the task's own fault applied (CR2 killed a provider, CR3 stalled the plugin worker; class-r.ts).
      const toolOracle = withClassRCheck(stepOracle, observer.plan, faults);
      const grade = gradeTask(observer.record, faults, observer.definition.budgetMs, toolOracle, universalByIssue ? {
        runMessages: allRunMessages, recoveryActions: universalByIssue.get(observer.record.issueId ?? "")?.recoveryActions ?? [] } : undefined);
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
        rules: Object.fromEntries(Object.entries(grade.rules).map(([id, rule]) => [id, rule.verdict])), T: grade.T.verdict,
        universal: Object.fromEntries(Object.entries(grade.universal ?? {}).map(([id, rule]) => [id, `${rule.verdict}${rule.enforced ? "" : " (warning)"}`])) });
    }
    // MS1–MS3: the cross-server invariant over the whole wave (multi-server.ts).
    if (faults.some(receipt => receipt.multiServer)) {
      const crossServer = await readCrossServerEvidence(evidenceDb, lab.companyId)
        .then(evidence => checkCrossServer({ ...evidence, windows: supervisor.serverWindows }))
        .catch(error => { harnessError ??= new Error(`Cross-server invariant check failed: ${String(error)}`); return null; });
      if (crossServer) {
        await writeFile(path.join(waveDir, "cross-server.json"), `${JSON.stringify(crossServer, null, 2)}\n`, { mode: 0o600 });
        timeline.add("cross_server_invariant", { violations: crossServer.violations.map(violation => ({ rule: violation.rule, runId: violation.runId,
          issueId: violation.issueId, detail: violation.detail })), unattributed: crossServer.unattributed.length });
        if (crossServer.violations.length) anyFailure = true;
      }
    }
    if (storageAuditor) {
      storageChaos?.stop();
      await credentialRotation?.settled();
      await storageAuditor.checkSnapshots(evidenceDb, lab.companyId);
    }
    await evidenceDb.$client.end({ timeout: 5 }).catch(() => undefined);
    await writeFile(path.join(waveDir, "faults.json"), `${JSON.stringify(faults, null, 2)}\n`, { mode: 0o600 });
    const speed = await (async () => {
      const childTasks = await childSpeedTasksInTurn(launched);
      return collectWaveSpeed(api, plan.options.env, [...launched.flatMap(observer => observer.record.issueId
        ? [{ issueId: observer.record.issueId, adapter: observer.plan.adapter, samples: observer.record.samples }] : []), ...childTasks], faults, storageChaos?.receipts ?? []);
    })().catch(error => { timeline.add("wave_speed_failed", { error: String(error) }); anyFailure = true; return null; });
    if (speed) {
      speedSection = speedMarkdown(speed);
      await writeFile(path.join(waveDir, "speed.json"), `${JSON.stringify(speed, null, 2)}\n`, { mode: 0o600 });
      timeline.add("wave_speed", { breaches: speed.breaches, runBudgetExceeded: speed.runBudgetExceeded, singleRunBreaches: speed.singleRunBreaches,
        rows: speed.rows.map(row => ({ adapter: row.adapter, metric: row.metric, start: row.start, n: row.measured.n,
          p50: row.measured.p50, p95: row.measured.p95, breaches: row.breaches })) });
      if (speed.breaches > 0 || speed.errors.length > 0) anyFailure = true;
    }
    if (crashPoint) {
      if (currentPoint) { await finishCrashPoint(currentPoint); currentPoint = null; }
      const byTask = new Map(lines.map(line => [line.taskId, line]));
      for (const point of pointResults) {
        if (point.invariants?.violations.length) anyFailure = true;
        if (point.invariants?.errors.length) harnessError ??= new Error(`Invariant check incomplete at ${point.point}: ${point.invariants.errors.join("; ")}`);
      }
      // Evidence carries run and wake error text; CI uploads this file.
      await writeFile(path.join(waveDir, "crash-point.json"), `${redactKnownSecrets(JSON.stringify({
        schema: "paperclip.restart-chaos.crash-point/v2", gitSha, gitDirty,
        // The server kills itself without warning, so no pre-fault workspace
        // snapshot exists: R2 checks workspace failures, not lost files.
        notMeasured: { R2_lost_files: "no pre-fault workspace snapshot: the crash point fires inside the server" },
        points: pointResults.map(({ baseline: _baseline, ...point }) => ({
          ...(point as PointResult), reached: point.fault?.crashPoint ?? null,
          tasks: point.taskIds.flatMap(id => { const line = byTask.get(id); return line ? [{ taskId: id, adapter: line.adapter,
            workload: line.workload, pass: line.pass, signature: line.signature, rules: line.rules, ruleDetails: line.ruleDetails, T: line.T }] : []; }),
        })),
      }, null, 2), knownSecretValues())}\n`, { mode: 0o600 });
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
    sandboxWatchStopped = true;
    await stopPressure().catch(error => timeline.add("db_pressure_stop_failed", { error: String(error) }));
    // Best effort for an interrupted or failed wave; the server may already be down.
    if (supervisor.serverReady) await recordWaveSpend().catch(() => undefined);
    await board?.close().catch(() => undefined);
    await closeJourneyApps();
    // A failure here (for example writing the report) must not skip stopping the controller and Postgres.
    try { if (sweeper) try {
      const owned = sweeper as DaytonaWaveSweeper;
      // An interrupted wave still reports what it leaked before cleanup.
      sandboxSweep ??= await owned.sweep(0);
      // Cleanup only through Paperclip; the harness never changes a sandbox.
      const cleanup = await owned.cleanUp();
      daytonaCleanup = cleanup;
      timeline.add("daytona_cleanup", cleanup);
      console.info(`Daytona R6 sweep: ${sandboxSweep.liveSandboxes.length} live, ${sandboxSweep.archivedSandboxes.length} archived after release, `
        + `${sandboxSweep.orphanSandboxes.length} orphaned, `
        + `${sandboxSweep.heldLeases.length} held leases${sandboxSweep.error ? `, error ${sandboxSweep.error}` : ""}; `
        + `environment deleted: ${cleanup.environmentDeleted}${cleanup.environmentDeleteBlocked ? " (still blocked by a pending sandbox cleanup)" : ""}; still running after cleanup: ${cleanup.remainingSandboxes.join(", ") || "none"}`);
      // A sandbox neither archived nor destroyed after cleanup is a leak for a person to act on.
      if (cleanup.remainingSandboxes.length) { anyFailure = true; remoteCleanupPending = true; }
      // A delete still blocked by pending sandbox cleanup after the settle window
      // is a leak, not a harness error: fail the wave and keep the instance, whose
      // database owns that cleanup work.
      if (cleanup.environmentDeleteBlocked) {
        anyFailure = true;
        remoteCleanupPending = true;
        timeline.add("daytona_environment_delete_blocked", { detail: cleanup.environmentDeleteBlocked });
      }
      if (cleanup.errors.length) remoteCleanupPending = true;
      if (cleanup.errors.length) harnessError ??= new Error(`Daytona cleanup incomplete: ${cleanup.errors.join("; ")}`);
      await writeFile(path.join(waveDir, "sandbox-sweep.json"), `${JSON.stringify({ sweep: sandboxSweep, cleanup }, null, 2)}\n`, { mode: 0o600 })
        .catch(error => timeline.add("sandbox_sweep_write_failed", { error: String(error) }));
    } catch (error) {
      harnessError ??= error;
      remoteCleanupPending = true;
      timeline.add("daytona_cleanup_failed", { error: String(error) });
    } } finally {
      try { await supervisor.stop(); } catch (error) {
        stopFailed = true;
        // Incomplete cleanup is a harness failure; keep the instance for inspection.
        harnessError ??= error;
        timeline.add("supervisor_stop_failed", { error: String(error) });
      }
    }
    if (isWarmWave(plan.options)) {
      const logDir = path.dirname(supervisor.paths.serverLogPath);
      const controllerLogs = controllerLogNames(await readdir(logDir).catch(() => [] as string[]));
      const serverLog = (await Promise.all(controllerLogs.map(name => readFile(path.join(logDir, name), "utf8").catch(() => "")))).join("\n");
      const warmShutdown = gradeWarmShutdown({ cleanup: daytonaCleanup, serverLog });
      timeline.add("warm_shutdown", { ...warmShutdown });
      if (warmShutdown.verdict === "fail") anyFailure = true;
      warmShutdownSection = warmShutdownMarkdown(warmShutdown);
      await writeFile(path.join(waveDir, "warm-shutdown.json"), `${JSON.stringify(warmShutdown, null, 2)}\n`, { mode: 0o600 })
        .catch(error => timeline.add("warm_shutdown_write_failed", { error: String(error) }));
    }
    storageChaos?.stop();
    await credentialRotation?.settled();
    if (credentialRotation?.failures.length) harnessError ??= new Error(`ST5R credential rotation failed: ${credentialRotation.failures.join("; ")}`);
    if (nativeTrigger) await writeFile(path.join(waveDir, "native-trigger.json"), `${JSON.stringify(nativeTrigger.finish(faults), null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
    if (storageProxy) {
      storageProxy.observe(null);
      if (storageTrigger) await writeFile(path.join(waveDir, "storage-trigger.json"), `${JSON.stringify(storageTrigger.finish(faults), null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
      if (storageChaos) await writeFile(path.join(waveDir, "storage-faults.json"), `${JSON.stringify(storageChaos.receipts, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
      await writeFile(path.join(waveDir, "storage-proxy.json"), `${JSON.stringify(storageProxy.counts(), null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
      await storageProxy.close().catch(() => undefined);
    }
    if (storageAuditor) {
      const failures = await storageAuditor.finish(waveDir, { kinds: storageChaos?.windows.map(window => window.kind) ?? [],
        injectedBy: storageProxy?.counts().injectedBy }).catch(error => [`storage audit failed: ${String(error)}`]);
      timeline.add("storage_audit", { ...storageAuditor.audit, failures });
      if (failures.length) anyFailure = true;
      speedSection = `${speedSection ?? ""}\n${storageAuditMarkdown(storageAuditor.audit)}`;
    }
    await objectStore?.stop().catch(error => timeline.add("object_store_stop_failed", { error: String(error) }));
    await acpxSidecarSeam?.remove().catch(error => timeline.add("acpx_stand_in_cleanup_failed", { error: String(error) }));
    const retention = await releaseInstance(supervisor.paths.temporaryRoot, { keep, stopFailed, remoteCleanupPending, owner: plan.waveId })
      .catch(error => { timeline.add("instance_cleanup_failed", { error: String(error) }); return null; });
    if (retention?.kept) timeline.add("instance_kept", { temporaryRoot: supervisor.paths.temporaryRoot, reason: retention.reason });
    if (lines.length) {
      await appendLedger(resultsRoot, lines);
      const summary = await writeSummary(resultsRoot, plan.waveId);
      await writeFile(path.join(waveDir, "SUMMARY.md"), [summary, warmShutdownSection, speedSection, storageSection].filter(Boolean).join("\n"), { mode: 0o600 });
      console.info(`\n${summary}`);
    }
  }
  console.info(`Wave ${plan.waveId}: results ${waveDir}`);
  for (const line of lines.filter(candidate => !candidate.pass)) console.info(`  FAIL ${line.taskId} ${line.signature} → ${line.evidence ?? "no evidence"}\n    replay: ${replayCommand(plan.waveId, line.taskId)}`);
  if (harnessError) { console.error(harnessError); return 2; }
  return anyFailure ? 1 : 0;
}

process.exit(await main().catch(error => { console.error(error); return 2; }));
