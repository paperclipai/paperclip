/**
 * Owns one isolated Paperclip control plane and injects K faults.
 *
 * Reuses the runner-e2e process code instead of copying it: the config seed
 * (server-config.ts), port reservation (ports.ts), environment isolation
 * (harness-env.ts), wrapper-owned Postgres (controller-database.ts), the
 * process-tree stopper (server-stop.ts + process-tree-owner.ts), the source
 * server entry (server-entry.ts) and the stop → unhealthy → hold → start →
 * ready receipt in controller-outage.ts `replaceController`.
 *
 * Postgres runs beside, not under, the server process tree, so K1 kills only
 * the controller and its owned descendants (local runners included), never the
 * database (that is K9). The controller runtime cache is kept: discarding it is
 * the separate K11 fault.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, readFileSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prepareControllerDatabase } from "../runner-e2e/controller-database.js";
import { CONTROLLER_READY_BY_MS, replaceController, type ControllerOutageReceipt } from "../runner-e2e/controller-outage.js";
import {
  assertIsolatedServerEnvironment, buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment,
  resolvePaperclipRunnerBinaryForHarness,
} from "../runner-e2e/harness-env.js";
import { reserveRunnerE2EServerPort } from "../runner-e2e/ports.js";
import { createRunnerE2ETemporaryRoot, prepareRunnerE2EServerConfig } from "../runner-e2e/server-config.js";
import { createRunnerE2EServerStopper, runnerE2EServerDetached } from "../runner-e2e/server-stop.js";
import { prepareSourceServerDependencies } from "../runner-e2e/source-startup.js";
import { runnerE2ETypeScriptProcessArgs } from "../runner-e2e/web-server-command.js";
import type { MatrixExecution } from "../runner-e2e/types.js";
import type { Timeline } from "./timeline.js";
import type { FaultKind, FaultReceipt, TriggerId } from "./types.js";

/** First boot applies every migration; a loaded host can need longer (RESTART_CHAOS_HEALTH_TIMEOUT_MS). */
const HEALTH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RESTART_CHAOS_HEALTH_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 30_000 && raw <= 1_800_000 ? raw : 180_000;
})();
const READY_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 30_000;

export const FAULT_SIGNAL: Record<FaultKind, "SIGKILL" | "SIGTERM"> = { K1: "SIGKILL", K2: "SIGTERM", K4: "SIGKILL", K6: "SIGKILL" };

export const CRASH_LOOP_TARGETS = ["recovering", "ready"] as const;
const PHASE_POLL_MS = 50;

export function crashLoopShouldFire(target: (typeof CRASH_LOOP_TARGETS)[number], phase: string): boolean {
  if (target === "recovering") return phase === "recovering" || phase === "ready";
  return phase === "ready";
}

export interface SupervisorPaths { temporaryRoot: string; home: string; configPath: string; serverLogPath: string }

/**
 * Crash-point suite: every server spawn reads its armed point from the control
 * file at each hit (PAPERCLIP_CRASH_POINT_CONTROL), so one booted server serves
 * many points. The supervisor writes "<token> <name>[:<nth>]" to arm a point
 * and empties the file to disarm, including before a crash's replacement starts.
 */
export interface CrashPointControl { controlPath: string; receiptPath: string }

/** The receipt line the crash-point helper appended for this pid, if any. */
export function readCrashPointReceipt(receiptPath: string, pid: number | undefined): { name: string; hit: number; pid: number; token?: string } | null {
  let text: string;
  try { text = readFileSync(receiptPath, "utf8"); } catch { return null; }
  for (const line of text.split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as { point?: unknown; hit?: unknown; pid?: unknown };
      if (pid !== undefined && parsed.pid === pid && typeof parsed.point === "string" && typeof parsed.hit === "number") {
        const token = (parsed as { token?: unknown }).token;
        return { name: parsed.point, hit: parsed.hit, pid, ...(typeof token === "string" ? { token } : {}) };
      }
    } catch { /* partial or blank line */ }
  }
  return null;
}

const secret = () => randomBytes(48).toString("base64url");

/** Same provider PATH shape as the runner-e2e launcher: pinned Codex first. */
async function prepareProviderPath(repositoryRoot: string, temporaryRoot: string, inherited: string | undefined) {
  const toolBin = path.join(temporaryRoot, "provider-bin");
  await mkdir(toolBin, { recursive: true });
  const runnerRequire = createRequire(path.join(repositoryRoot, "packages/paperclip-runner/package.json"));
  const codexAcp = runnerRequire.resolve("@agentclientprotocol/codex-acp/package.json");
  const codexPackage = createRequire(codexAcp).resolve("@openai/codex/package.json");
  const manifest = JSON.parse(await readFile(codexPackage, "utf8")) as { bin?: string | Record<string, string> };
  const codexBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex;
  if (!codexBin) throw new Error("Pinned Codex executable not found");
  await symlink(path.resolve(path.dirname(codexPackage), codexBin), path.join(toolBin, "codex"));
  return [toolBin, path.join(repositoryRoot, "packages/paperclip-runner/node_modules/.bin"), inherited].filter(Boolean).join(path.delimiter);
}

export class ChaosSupervisor {
  readonly baseUrl: string;
  private child: ChildProcess | null = null;
  private readonly expectedStops = new WeakSet<ChildProcess>();
  private readonly spawnErrors = new WeakMap<ChildProcess, Error>();
  private readonly log: WriteStream;
  private readonly stopper: ReturnType<typeof createRunnerE2EServerStopper>;
  private database: { cleanup(): Promise<void> } | undefined;
  private environment: Record<string, string> = {};
  private faultChain: Promise<unknown> = Promise.resolve();
  private faultCount = 0;
  private shuttingDown = false;
  /** False from fault start until /api/ready reports `ready` again. */
  serverReady = false;
  faultInProgress = false;
  unexpectedExits = 0;
  private crashPointControl: CrashPointControl | null = null;
  /** Called with the receipt of a crash-point self-kill once the replacement is ready (or failed). */
  onCrashPoint: ((receipt: FaultReceipt) => void) | null = null;

  private constructor(readonly repositoryRoot: string, readonly port: number, readonly paths: SupervisorPaths,
    private readonly timeline: Timeline) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.log = createWriteStream(paths.serverLogPath, { flags: "a", mode: 0o600 });
    this.stopper = createRunnerE2EServerStopper({
      gracefulTimeoutMs: STOP_TIMEOUT_MS, forcedTimeoutMs: 5_000,
      hasSpawnError: candidate => this.spawnErrors.has(candidate),
      markExpectedStop: candidate => { this.expectedStops.add(candidate); },
      log: message => { this.log.write(message); },
    });
  }

  static async create(input: { repositoryRoot: string; waveDir: string; timeline: Timeline }): Promise<ChaosSupervisor> {
    const temporaryRoot = await createRunnerE2ETemporaryRoot();
    const home = path.join(temporaryRoot, "home");
    const paths: SupervisorPaths = { temporaryRoot, home, configPath: path.join(home, "instances", "default", "config.json"),
      serverLogPath: path.join(input.waveDir, "server.log") };
    const port = await reserveRunnerE2EServerPort();
    const supervisor = new ChaosSupervisor(input.repositoryRoot, port, paths, input.timeline);
    input.timeline.add("supervisor_created", { temporaryRoot, port });
    return supervisor;
  }

  serverLogOffset(): number {
    try { return statSync(this.paths.serverLogPath).size + this.log.writableLength; } catch { return 0; }
  }

  /** `extraEnvironment` is kept for every restart (e.g. the Daytona image's runnerd and provider pack paths). */
  async start(extraEnvironment: Record<string, string> = {}): Promise<void> {
    const { temporaryRoot, home, configPath } = this.paths;
    const reservation = await prepareRunnerE2EServerConfig({ temporaryRoot, configPath, serverPort: this.port });
    await reservation?.close();
    // Wrapper-owned Postgres: survives K1/K2/K4 like a managed database would.
    this.database = await prepareControllerDatabase(configPath, temporaryRoot);
    this.timeline.add("database_started", {});
    const runnerBinary = resolvePaperclipRunnerBinaryForHarness(
      [{ profile: { generation: "native" } } as unknown as MatrixExecution], this.repositoryRoot);
    const source = {
      ...buildRunnerE2EProcessEnvironment(process.env, []),
      PATH: await prepareProviderPath(this.repositoryRoot, temporaryRoot, process.env.PATH),
      PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: "[]",
      PAPERCLIP_RUNNER_BINARY: runnerBinary,
      PAPERCLIP_VITE_CACHE_DIR: path.join(temporaryRoot, "vite-cache"),
    };
    const overrides = {
      NODE_ENV: "test", PORT: String(this.port), XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
      PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_AGENT_JWT_SECRET: secret(), PAPERCLIP_DECISION_SIGNING_SECRET: secret(),
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: secret(), BETTER_AUTH_SECRET: secret(),
      PAPERCLIP_BIND: "loopback", PAPERCLIP_BIND_HOST: "127.0.0.1", PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private", SERVE_UI: "true", PAPERCLIP_STORAGE_PROVIDER: "local_disk",
      PAPERCLIP_STORAGE_LOCAL_DIR: path.join(temporaryRoot, "storage"), PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
      PAPERCLIP_SECRETS_STRICT_MODE: "true", PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_DB_BACKUP_DIR: path.join(temporaryRoot, "backups"), PAPERCLIP_OPEN_ON_LISTEN: "false",
      // The server loads a .paperclip/.env found above its cwd without overriding
      // set values. A worktree-initialized checkout's file sets
      // PAPERCLIP_IN_WORKTREE=true, which suppresses all scheduling: no run starts.
      PAPERCLIP_IN_WORKTREE: "false",
      ...extraEnvironment,
    };
    const environment = buildPaperclipServerEnvironment(source, overrides);
    assertIsolatedServerEnvironment(environment, { temporaryRoot, paperclipHome: home, configPath });
    this.environment = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
    await prepareSourceServerDependencies(this.repositoryRoot, this.environment, false);
    const child = await this.spawnServer();
    await this.waitForHealth(child);
    await this.waitForReadyPhase([]);
    this.timeline.add("server_ready", { pid: child.pid });
  }

  private async spawnServer(): Promise<ChildProcess> {
    if (this.shuttingDown) throw new Error("Refusing to start Paperclip during harness shutdown");
    const entry = path.join(this.repositoryRoot, "tests/runner-e2e/server-entry.ts");
    const control = this.crashPointControl;
    const env = control ? { ...this.environment, PAPERCLIP_CRASH_POINT_CONTROL: control.controlPath,
      PAPERCLIP_CRASH_POINT_RECEIPT: control.receiptPath } : this.environment;
    const child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(this.repositoryRoot, entry, ["onboard", "--yes", "--run"]),
      { cwd: this.repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: runnerE2EServerDetached });
    this.child = child;

    child.stdout?.on("data", chunk => this.log.write(chunk));
    child.stderr?.on("data", chunk => this.log.write(chunk));
    child.once("error", error => { this.spawnErrors.set(child, error); });
    child.once("exit", (code, signal) => {
      this.log.write(`\n[restart-chaos] server pid=${child.pid} exited code=${code} signal=${signal}\n`);
      if (control && signal === "SIGKILL" && !this.expectedStops.has(child) && !this.shuttingDown) {
        const hit = readCrashPointReceipt(control.receiptPath, child.pid);
        if (hit) { this.restartAfterCrashPoint(child, hit); return; }
      }
      if (!this.expectedStops.has(child) && !this.shuttingDown) {
        this.unexpectedExits += 1;
        this.serverReady = false;
        this.timeline.add("server_exited_unexpectedly", { pid: child.pid, code, signal });
      }
    });
    await this.stopper.watch(child);
    this.timeline.add("server_spawned", { pid: child.pid });
    return child;
  }

  private exited(child: ChildProcess) { return child.exitCode !== null || child.signalCode !== null || this.spawnErrors.has(child); }

  private async readPhase(): Promise<string> {
    try {
      const response = await fetch(`${this.baseUrl}/api/ready`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      return String(((await response.json()) as { status?: string }).status ?? response.status);
    } catch { return "unreachable"; }
  }

  private async waitForHealth(child: ChildProcess, phases?: FaultReceipt["phases"]): Promise<number> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted startup");
      if (this.exited(child)) throw new Error(`Paperclip server exited during startup (code=${child.exitCode} signal=${child.signalCode})`);
      if (phases) {
        const phase = await this.readPhase();
        if (phase !== phases[phases.length - 1]?.phase) phases.push({ phase, at: Date.now() });
      }
      try {
        const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
        await response.body?.cancel();
        if (response.ok) return Date.now();
      } catch { /* still booting */ }
      await delay(250);
    }
    throw new Error(`Paperclip server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
  }

  private async waitForHealthToStop(): Promise<void> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try { const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(500) }); await response.body?.cancel(); }
      catch { return; }
      await delay(100);
    }
    throw new Error("Old Paperclip server stayed healthy after stop");
  }

  /** Records starting → recovering → ready from /api/ready (liveness gate). */
  private async waitForReadyPhase(phases: FaultReceipt["phases"]): Promise<number> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: string | null = phases[phases.length - 1]?.phase ?? null;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted readiness wait");
      const phase = await this.readPhase();
      if (phase !== last) { phases.push({ phase, at: Date.now() }); last = phase; }
      if (phase === "ready") {
        const liveness = await fetch(`${this.baseUrl}/api/liveness`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
        await liveness?.body?.cancel();
        if (liveness?.ok) { this.serverReady = true; return Date.now(); }
      }
      await delay(250);
    }
    throw new Error(`Paperclip did not report ready within ${READY_TIMEOUT_MS}ms`);
  }

  /** Crash-point suite: run every spawn (from `start` on) with runtime arming. */
  useCrashPointControl(control: CrashPointControl): void {
    writeFileSync(control.controlPath, "", { mode: 0o600 });
    this.crashPointControl = control;
  }

  /** Arms `spec` ("<name>[:<nth>]") with a fresh hit count under `token`. */
  armCrashPoint(token: string, spec: string): void {
    if (!this.crashPointControl) throw new Error("Crash-point control is not enabled");
    writeFileSync(this.crashPointControl.controlPath, `${token} ${spec}\n`, { mode: 0o600 });
    this.timeline.add("crash_point_armed", { token, spec });
  }

  disarmCrashPoint(): void {
    if (this.crashPointControl) writeFileSync(this.crashPointControl.controlPath, "", { mode: 0o600 });
  }

  /**
   * The armed server killed itself at its crash point. Treat it like K1: kill
   * what is left of its owned process tree (local runners), start a
   * replacement without the point armed, and wait for ready.
   */
  private restartAfterCrashPoint(previous: ChildProcess, hit: { name: string; hit: number; pid: number; token?: string }): void {
    // The replacement reads the same control file: disarm before it starts.
    this.disarmCrashPoint();
    this.faultInProgress = true;
    this.serverReady = false;
    this.faultCount += 1;
    const now = Date.now();
    const receipt: FaultReceipt = {
      faultId: `f${String(this.faultCount).padStart(2, "0")}`, kind: "K1", requestedBy: "crash-point", signal: "SIGKILL", holdMs: 0,
      loadAvg1m: Math.round(os.loadavg()[0]! * 100) / 100, crashPoint: hit,
      requestedAt: now, startedAt: now, stoppedAt: null, restartedAt: null, healthyAt: null, readyAt: null,
      phases: [], serverLogOffsetAtStart: this.serverLogOffset(), serverLogOffsetAtReady: null, error: null,
    };
    this.timeline.add("crash_point_fired", { faultId: receipt.faultId, point: hit.name, hit: hit.hit, pid: hit.pid });
    this.log.write(`\n[restart-chaos] ${receipt.faultId} crash point ${hit.name} hit ${hit.hit} killed pid=${hit.pid}\n`);
    let cleanupError: string | null = null;
    const run = this.faultChain.then(async () => {
      try {
        // The leader is already dead; this kills its owned descendants, as K1 does.
        // A cleanup that cannot prove the tree stopped fails the fault (and the
        // wave); the replacement still starts so the tasks can drain.
        await this.stopper.crashForRestart(previous).catch(error => {
          cleanupError = `owned process tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          this.log.write(`[restart-chaos] crash-point ${cleanupError}\n`);
        });
        if (this.child === previous) this.child = null;
        await this.waitForHealthToStop();
        receipt.stoppedAt = Date.now();
        receipt.restartedAt = Date.now();
        const child = await this.spawnServer();
        receipt.healthyAt = await this.waitForHealth(child, receipt.phases);
        receipt.readyAt = await this.waitForReadyPhase(receipt.phases);
        receipt.serverLogOffsetAtReady = this.serverLogOffset();
        this.timeline.add("fault_ready", { faultId: receipt.faultId, replacementPid: child.pid, readyAfterMs: receipt.readyAt - receipt.startedAt });
      } catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error);
        this.timeline.add("fault_failed", { faultId: receipt.faultId, error: receipt.error });
      } finally {
        if (cleanupError && !receipt.error) receipt.error = cleanupError;
        this.faultInProgress = false;
        this.onCrashPoint?.(receipt);
      }
    });
    this.faultChain = run.catch(() => undefined);
  }

  /** Faults are serialized: one control plane, one outage at a time. */
  fault(kind: FaultKind, holdMs: number, requestedBy: string, trigger?: { trigger: TriggerId; delayMs: number }): Promise<FaultReceipt> {
    const requestedAt = Date.now();
    const run = this.faultChain.then(() => this.executeFault(kind, holdMs, requestedBy, requestedAt, trigger));
    this.faultChain = run.catch(() => undefined);
    return run;
  }

  private async executeFault(kind: FaultKind, holdMs: number, requestedBy: string, requestedAt: number,
    trigger?: { trigger: TriggerId; delayMs: number }): Promise<FaultReceipt> {
    const previous = this.child;
    this.faultCount += 1;
    const receipt: FaultReceipt = {
      faultId: `f${String(this.faultCount).padStart(2, "0")}`, kind, requestedBy, signal: FAULT_SIGNAL[kind], holdMs,
      ...(trigger ? { trigger: trigger.trigger, triggerDelayMs: trigger.delayMs } : {}),
      loadAvg1m: Math.round(os.loadavg()[0]! * 100) / 100,
      requestedAt, startedAt: Date.now(), stoppedAt: null, restartedAt: null, healthyAt: null, readyAt: null,
      phases: [], serverLogOffsetAtStart: this.serverLogOffset(), serverLogOffsetAtReady: null, error: null,
    };
    this.faultInProgress = true;
    this.serverReady = false;
    this.timeline.add("fault_started", { faultId: receipt.faultId, fault: kind, signal: receipt.signal, loadAvg1m: receipt.loadAvg1m, holdMs, requestedBy, previousPid: previous?.pid });
    this.log.write(`\n[restart-chaos] ${receipt.faultId} ${kind} ${receipt.signal} hold=${holdMs}ms requestedBy=${requestedBy} at ${new Date().toISOString()}\n`);
    try {
      if (!previous?.pid || this.exited(previous)) throw new Error("No live Paperclip server to fault");
      let outage: ControllerOutageReceipt | undefined;
      outage = await replaceController({
        requestId: `chaos-${receipt.faultId}-${requestedBy}`,
        previousPid: previous.pid,
        outage: { signal: receipt.signal, holdMs },
        // A K4 hold may outlast the Runner's 7-minute reconnect grace on
        // purpose (--k4-hold-max-seconds); the replacement still gets the
        // normal startup allowance after the hold.
        readyByMs: holdMs + CONTROLLER_READY_BY_MS,
        stop: async signal => {
          if (signal === "SIGKILL") await this.stopper.crashForRestart(previous);
          else await this.stopper(previous, "SIGTERM");
          if (this.child === previous) this.child = null;
        },
        waitForUnhealthy: async () => { await this.waitForHealthToStop(); receipt.stoppedAt = Date.now(); this.timeline.add("fault_server_down", { faultId: receipt.faultId }); },
        // K1/K2/K4 keep the controller runtime cache; K11 will discard it.
        discardCache: async () => {},
        start: async () => { receipt.restartedAt = Date.now(); this.timeline.add("fault_restarting", { faultId: receipt.faultId }); return this.spawnServer(); },
        waitForReady: async replacement => { receipt.healthyAt = await this.waitForHealth(replacement, receipt.phases); },
        cancelled: () => this.shuttingDown,
        record: async progress => { outage = progress; },
      });
      if (kind === "K6") {
        if (!this.child) throw new Error("K6 crash loop has no replacement server to kill");
        receipt.healthyAt = await this.waitForHealth(await this.crashLoop(this.child, receipt), receipt.phases);
      }
      receipt.readyAt = await this.waitForReadyPhase(receipt.phases);
      receipt.serverLogOffsetAtReady = this.serverLogOffset();
      this.timeline.add("fault_ready", { faultId: receipt.faultId, replacementPid: this.child?.pid ?? outage?.replacementPid,
        downMs: (receipt.restartedAt ?? 0) - (receipt.stoppedAt ?? 0), readyAfterMs: receipt.readyAt - receipt.startedAt, phases: receipt.phases });
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      this.timeline.add("fault_failed", { faultId: receipt.faultId, error: receipt.error });
      throw Object.assign(new Error(`Fault ${receipt.faultId} failed: ${receipt.error}`), { receipt });
    } finally {
      this.faultInProgress = false;
    }
    return receipt;
  }

  private async waitForCrashLoopPhase(child: ChildProcess, target: (typeof CRASH_LOOP_TARGETS)[number],
    phases: FaultReceipt["phases"]): Promise<string> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted the crash loop");
      if (this.exited(child)) throw new Error(`Paperclip server exited during the crash loop (code=${child.exitCode} signal=${child.signalCode})`);
      const phase = await this.readPhase();
      if (phase !== phases[phases.length - 1]?.phase) phases.push({ phase, at: Date.now() });
      if (crashLoopShouldFire(target, phase)) return phase;
      await delay(PHASE_POLL_MS);
    }
    throw new Error(`Crash loop: phase ${target} not reached within ${READY_TIMEOUT_MS}ms`);
  }

  private async crashLoop(first: ChildProcess, receipt: FaultReceipt): Promise<ChildProcess> {
    let current = first;
    receipt.crashLoop = [];
    for (const target of CRASH_LOOP_TARGETS) {
      const phase = await this.waitForCrashLoopPhase(current, target, receipt.phases);
      receipt.crashLoop.push({ pid: current.pid ?? null, target, phase, at: Date.now() });
      this.timeline.add("fault_crash_loop_kill", { faultId: receipt.faultId, pid: current.pid, target, phase });
      this.log.write(`\n[restart-chaos] ${receipt.faultId} K6 crash-loop SIGKILL pid=${current.pid} target=${target} phase=${phase}\n`);
      await this.stopper.crashForRestart(current);
      if (this.child === current) this.child = null;
      await this.waitForHealthToStop();
      current = await this.spawnServer();
    }
    return current;
  }

  /**
   * Bounded recovery after a failed fault or a crash the harness did not cause:
   * wait for a live server to become ready, or start a new one. Throws when the
   * control plane cannot be brought back, so the wave fails instead of hanging.
   */
  async ensureServing(): Promise<void> {
    if (this.serverReady || this.faultInProgress) return;
    const live = this.child && !this.exited(this.child) ? this.child : null;
    this.timeline.add("server_recovery_attempt", { livePid: live?.pid ?? null });
    const child = live ?? await this.spawnServer();
    await this.waitForHealth(child);
    await this.waitForReadyPhase([]);
    this.timeline.add("server_recovered", { pid: child.pid });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    const errors: string[] = [];
    try { await this.stopper.stopAll(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    try { await this.database?.cleanup(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    await new Promise<void>(resolve => this.log.end(resolve));
    this.timeline.add("supervisor_stopped", { errors });
    if (errors.length) throw new Error(`Supervisor cleanup incomplete: ${errors.join("; ")}`);
  }
}
