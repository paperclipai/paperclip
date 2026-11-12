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
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, readFileSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { DEFAULT_TIME_AGE_MS, ProcessFreezer, ageWaveDatabase, databaseUrlFromConfig, runFreezeFault, type AgingShift, type TimeFaultRecord } from "./time-faults.js";
import type { Timeline } from "./timeline.js";
import { isRepeatedRestartFault, newRepeatedRestartRecord, recordFirstRestart, runRepeatedRestarts, stopPhaseWatcher, type RepeatedRestartKind, type RepeatedRestartStopOn,
  type RepeatedRestartRecord, type RestartStep } from "./repeated-restarts.js";
import type { FaultKind, FaultReceipt, TriggerId } from "./types.js";
import { isMultiServerFault, runMultiServerFault, type MultiServerKind, type MultiServerRecord, type ServerProcessWindow } from "./multi-server.js";
import { generationHome, nextRedeployIdentity, redeployEnvironment, redeployIdentity, redeployNodeArgs, redeployReceipt, type RedeployIdentity } from "./redeploy.js";
import { startEdgeProxy, type EdgeProxy } from "./edge-proxy.js";
import { ephemeralServerEnvironment } from "./ephemeral-server.js";
import { CLASS_R_PRE_FAULT_DEADLINE_MS, classRRedeploys, isClassRFault, runPluginStall, withReplacementPluginStall, type ClassRHooks } from "./class-r.js";

/** First boot applies every migration; a loaded host can need longer (RESTART_CHAOS_HEALTH_TIMEOUT_MS). */
const HEALTH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RESTART_CHAOS_HEALTH_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= 30_000 && raw <= 1_800_000 ? raw : 180_000;
})();
const READY_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 30_000;

export const FAULT_SIGNAL: Record<FaultKind, FaultReceipt["signal"]> = { K1: "SIGKILL", K2: "SIGTERM", K4: "SIGKILL", K6: "SIGKILL", K14: "SIGTERM", K15: "SIGTERM",
  TM1: "SIGSTOP", TM2: "SIGSTOP", TM3: "SIGKILL", RR1: "SIGKILL", RR2: "SIGKILL", RR3: "SIGKILL",
  // MS1 leaves the primary alone; MS2 freezes it; MS3 stops it gracefully (multi-server.ts).
  MS1: "none", MS2: "SIGSTOP", MS3: "SIGTERM",
  // CR1 stops the server like K15; CR2 signals only the sandbox's provider (SIGTERM to the server with a hold);
  // CR3 and CR5 stop the Daytona plugin worker; CR4 and CR6 kill the server, then stop the replacement's (class-r.ts).
  CR1: "SIGTERM", CR2: "none", CR3: "SIGSTOP", CR4: "SIGKILL", CR5: "SIGSTOP", CR6: "SIGKILL" };

/** The checkout's commit, for the K14 receipt. */
function checkoutSha(root: string): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch { return null; }
}

export const CRASH_LOOP_TARGETS = ["recovering", "ready"] as const;
const PHASE_POLL_MS = 50;

export function crashLoopShouldFire(target: (typeof CRASH_LOOP_TARGETS)[number], phase: string): boolean {
  if (target === "recovering") return phase === "recovering" || phase === "ready";
  return phase === "ready";
}

/**
 * Agents reach the server at PAPERCLIP_API_URL. An explicit value wins over the URL the server
 * derives from its public URL (a developer's .paperclip/.env or shell can name a tailnet origin
 * that serves a different instance). Pin this wave's own loopback origin so an agent's key for
 * the temporary instance is only ever sent to that instance.
 */
export function waveServerUrlEnvironment(port: number): { PAPERCLIP_API_URL: string } {
  return { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` };
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
      const parsed = JSON.parse(line) as { point?: unknown; hit?: unknown; pid?: unknown; mode?: unknown };
      // A fail-mode hit (`--fail-recovery-step`) threw in the server; it did not kill it.
      if (parsed.mode === "fail") continue;
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
  // A K15 with a fresh home or an overlap prepares the environment again: replace the link.
  await rm(path.join(toolBin, "codex"), { force: true });
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
  /** Crash-point suite: keep the control plane down this long after a self-kill (a K4-style hold). */
  crashPointHoldMs = 0;
  /** TM2/TM3: how far each aging fault shifts the wave's database back. */
  timeAgeMs = DEFAULT_TIME_AGE_MS;
  /** RR1–RR3 (`--rr-stop-on`): stop each replacement on this `/api/ready` status instead of after its gap. */
  rrStopOn: RepeatedRestartStopOn | null = null;
  /** Every server process this wave started, with its lifetime and freezes (MS cross-server invariant). */
  readonly serverWindows: ServerProcessWindow[] = [];
  /** MS1–MS3: the second server, while one is running. */
  private secondary: { child: ChildProcess; port: number; log: WriteStream; exit: string | null } | null = null;
  /** Every aging shift so far, in order; the grader's API reads times through them (time-faults.ts). */
  readonly agingShifts: AgingShift[] = [];
  private readonly createdAt = Date.now();
  /** The checkout the server runs from: the older build (`--upgrade-from`) until the first K14, then this one. */
  private serverRoot: string;
  /** The environment overrides the wave passed to `start`, kept for every restart and for the K14 switch. */
  private extraEnvironment: Record<string, string> = {};
  /** K15 waves: the wave id the emulated deploy identities derive from, and the generation serving now. */
  private redeploy: { waveId: string; identity: RedeployIdentity } | null = null;
  /**
   * K15 evidence hook (main.ts sets it on Daytona waves): runs right after the server stopped and again just
   * before the next deploy starts, while the server is down. It must not throw.
   */
  redeployEvidence: ((faultId: string, phase: "stopped" | "before_start") => Promise<void>) | null = null;
  /** K15 deploy shape (redeploy.ts `parseK15DeployShape`); main.ts sets it before `start`. */
  deployShape: { overlap: boolean; freshHome: boolean } = { overlap: false, freshHome: false };
  ephemeralServer = false;
  /** `--k15-fresh-home`: the instance home and config of the serving generation (generation 0 uses `paths`). */
  private serverHome: { home: string; configPath: string };
  /** `--k15-overlap-seconds`: the edge on the wave's port, and the serving generation's own port behind it. */
  private edge: EdgeProxy | null = null;
  private backendPort: number;
  /** `--fail-recovery-step`: "<point>:<nth>", armed in fail mode when the first restart fault starts its replacement. */
  private pendingRecoveryStep: string | null = null;
  private recoveryStepWatch: NodeJS.Timeout | null = null;
  /** CR1–CR3 waves: sandbox captures and the provider kill (class-r.ts). */
  classR: ClassRHooks | null = null;
  /** Wave secrets, kept across a K14 switch as an in-place upgrade keeps its configuration. */
  private readonly secrets = { PAPERCLIP_AGENT_JWT_SECRET: secret(), PAPERCLIP_DECISION_SIGNING_SECRET: secret(),
    PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: secret(), BETTER_AUTH_SECRET: secret() };

  private constructor(readonly repositoryRoot: string, readonly port: number, readonly paths: SupervisorPaths,
    private readonly timeline: Timeline, upgradeFrom: string | null, redeployWaveId: string | null) {
    this.serverRoot = upgradeFrom ?? repositoryRoot;
    this.serverHome = { home: paths.home, configPath: paths.configPath };
    this.backendPort = port;
    if (redeployWaveId) this.redeploy = { waveId: redeployWaveId, identity: redeployIdentity(redeployWaveId, 0) };
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.log = createWriteStream(paths.serverLogPath, { flags: "a", mode: 0o600 });
    this.stopper = createRunnerE2EServerStopper({
      gracefulTimeoutMs: STOP_TIMEOUT_MS, forcedTimeoutMs: 5_000,
      hasSpawnError: candidate => this.spawnErrors.has(candidate),
      markExpectedStop: candidate => { this.expectedStops.add(candidate); },
      log: message => { this.log.write(message); },
    });
  }

  /** `redeployWaveId`: a K15 wave; every server gets the emulated deploy identity of its generation (redeploy.ts). */
  static async create(input: { repositoryRoot: string; waveDir: string; timeline: Timeline; upgradeFrom?: string;
    redeployWaveId?: string }): Promise<ChaosSupervisor> {
    const temporaryRoot = await createRunnerE2ETemporaryRoot();
    const home = path.join(temporaryRoot, "home");
    const paths: SupervisorPaths = { temporaryRoot, home, configPath: path.join(home, "instances", "default", "config.json"),
      serverLogPath: path.join(input.waveDir, "server.log") };
    const port = await reserveRunnerE2EServerPort();
    const supervisor = new ChaosSupervisor(input.repositoryRoot, port, paths, input.timeline, input.upgradeFrom ?? null,
      input.redeployWaveId ?? null);
    input.timeline.add("supervisor_created", { temporaryRoot, port, ...(input.upgradeFrom
      ? { upgradeFrom: input.upgradeFrom, upgradeFromSha: checkoutSha(input.upgradeFrom) } : {}) });
    return supervisor;
  }

  /** K14 waves: whether the older build or this checkout is serving. */
  get serverBuild(): "upgrade_from" | "current" { return this.serverRoot === this.repositoryRoot ? "current" : "upgrade_from"; }

  serverLogOffset(): number {
    try { return statSync(this.paths.serverLogPath).size + this.log.writableLength; } catch { return 0; }
  }

  /** `extraEnvironment` is kept for every restart (e.g. the Daytona image's runnerd and provider pack paths). */
  async start(extraEnvironment: Record<string, string> = {}): Promise<void> {
    const { temporaryRoot, configPath } = this.paths;
    const reservation = await prepareRunnerE2EServerConfig({ temporaryRoot, configPath, serverPort: this.port });
    await reservation?.close();
    // Wrapper-owned Postgres: survives K1/K2/K4 like a managed database would.
    this.database = await prepareControllerDatabase(configPath, temporaryRoot);
    this.timeline.add("database_started", {});
    this.extraEnvironment = extraEnvironment;
    if (this.deployShape.overlap) {
      // The wave's port becomes the edge; each generation listens behind it on its own port.
      this.backendPort = await reserveRunnerE2EServerPort();
      this.edge = await startEdgeProxy(this.port, this.backendPort);
      this.timeline.add("edge_proxy_started", { port: this.port, target: this.backendPort });
    }
    await this.prepareServerEnvironment(this.serverRoot);
    const child = await this.spawnServer();
    await this.waitForHealth(child);
    await this.waitForReadyPhase([]);
    this.timeline.add("server_ready", { pid: child.pid, serverRoot: this.serverRoot });
  }

  /**
   * The server environment for one checkout: its own runner binary, pinned Codex and source
   * dependencies. The database, instance directory, port and secrets stay the same across a K14
   * switch, as an in-place upgrade keeps them.
   */
  private async prepareServerEnvironment(root: string): Promise<void> {
    const { temporaryRoot } = this.paths;
    const { home, configPath } = this.serverHome;
    const extraEnvironment = this.extraEnvironment;
    const runnerBinary = resolvePaperclipRunnerBinaryForHarness(
      [{ profile: { generation: "native" } } as unknown as MatrixExecution], root);
    // One provider PATH per checkout: the older build keeps its own pinned Codex.
    const providerRoot = root === this.repositoryRoot ? temporaryRoot : path.join(temporaryRoot, "upgrade-from");
    await mkdir(providerRoot, { recursive: true });
    const source = {
      ...buildRunnerE2EProcessEnvironment(process.env, []),
      PATH: await prepareProviderPath(root, providerRoot, process.env.PATH),
      PAPERCLIP_RUNNER_E2E_EXECUTION_IDS: "[]",
      PAPERCLIP_RUNNER_BINARY: runnerBinary,
      PAPERCLIP_VITE_CACHE_DIR: path.join(temporaryRoot, "vite-cache"),
    };
    const overrides = {
      NODE_ENV: "test", PORT: String(this.backendPort), XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
      PAPERCLIP_HOME: home, PAPERCLIP_CONFIG: configPath, PAPERCLIP_INSTANCE_ID: "default",
      ...this.secrets,
      PAPERCLIP_BIND: "loopback", PAPERCLIP_BIND_HOST: "127.0.0.1", PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private", SERVE_UI: "true", PAPERCLIP_STORAGE_PROVIDER: "local_disk",
      PAPERCLIP_STORAGE_LOCAL_DIR: path.join(temporaryRoot, "storage"), PAPERCLIP_SECRETS_PROVIDER: "local_encrypted",
      PAPERCLIP_SECRETS_STRICT_MODE: "true", PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_DB_BACKUP_DIR: path.join(temporaryRoot, "backups"), PAPERCLIP_OPEN_ON_LISTEN: "false",
      // The server loads a .paperclip/.env found above its cwd without overriding
      // set values. A worktree-initialized checkout's file sets
      // PAPERCLIP_IN_WORKTREE=true, which suppresses all scheduling: no run starts.
      PAPERCLIP_IN_WORKTREE: "false",
      ...waveServerUrlEnvironment(this.port),
      ...extraEnvironment,
      // K15: the generation's emulated host name and Railway deployment identity; the volume is the instance home.
      ...(this.redeploy ? redeployEnvironment(this.redeploy.identity, this.deployShape.freshHome ? null : home) : {}),
    };
    const ephemeral = this.ephemeralServer ? await ephemeralServerEnvironment({ configPath: this.paths.configPath, temporaryRoot: this.paths.temporaryRoot, extraEnvironment }) : null;
    const environment = buildPaperclipServerEnvironment(source, { ...overrides, ...ephemeral });
    const workspaceStorage = extraEnvironment.PAPERCLIP_STORAGE_PROVIDER === "s3"
      ? Object.fromEntries(Object.entries(extraEnvironment).filter(([key]) => key.startsWith("PAPERCLIP_STORAGE_"))) : undefined;
    assertIsolatedServerEnvironment(environment, { temporaryRoot, paperclipHome: home, configPath, ...(workspaceStorage ? { workspaceStorage } : {}),
      ...(ephemeral ? { generatedSecretsMasterKey: ephemeral.PAPERCLIP_SECRETS_MASTER_KEY } : {}) });
    this.environment = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
    await prepareSourceServerDependencies(root, this.environment, false);
  }

  private async spawnServer(): Promise<ChildProcess> {
    if (this.shuttingDown) throw new Error("Refusing to start Paperclip during harness shutdown");
    const root = this.serverRoot;
    const entry = path.join(root, "tests/runner-e2e/server-entry.ts");
    const control = this.crashPointControl;
    const env = control ? { ...this.environment, PAPERCLIP_CRASH_POINT_CONTROL: control.controlPath,
      PAPERCLIP_CRASH_POINT_RECEIPT: control.receiptPath } : this.environment;
    const args = runnerE2ETypeScriptProcessArgs(root, entry, ["onboard", "--yes", "--run"]);
    // K15 waves: the emulated host name of the serving deploy generation (redeploy.ts).
    const child = spawn(process.execPath, this.redeploy ? redeployNodeArgs(args) : args,
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: runnerE2EServerDetached });
    this.child = child;
    const window = this.trackWindow(child, "primary");

    child.stdout?.on("data", chunk => this.log.write(chunk));
    child.stderr?.on("data", chunk => this.log.write(chunk));
    child.once("error", error => { this.spawnErrors.set(child, error); });
    child.once("exit", (code, signal) => {
      if (window) window.exitedAt = Date.now();
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

  private trackWindow(child: ChildProcess, role: ServerProcessWindow["role"]): ServerProcessWindow | null {
    if (!child.pid) return null;
    const window: ServerProcessWindow = { pid: child.pid, role, spawnedAt: Date.now(), exitedAt: null, frozen: [] };
    this.serverWindows.push(window);
    return window;
  }

  /** Records a freeze or thaw of a server process for the MS invariant (TM1/TM2 and MS2). */
  private markFrozen(pid: number | undefined, at: number, frozen: boolean): void {
    const window = [...this.serverWindows].reverse().find(candidate => candidate.pid === pid && candidate.exitedAt === null);
    if (!window) return;
    if (frozen) window.frozen.push({ from: at, to: null });
    else { const open = window.frozen.find(span => span.to === null); if (open) open.to = at; }
  }

  private exited(child: ChildProcess) { return child.exitCode !== null || child.signalCode !== null || this.spawnErrors.has(child); }

  private async readPhase(baseUrl = this.baseUrl): Promise<string> {
    try {
      const response = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(1_000), cache: "no-store" });
      return String(((await response.json()) as { status?: string }).status ?? response.status);
    } catch { return "unreachable"; }
  }

  private async waitForHealth(child: ChildProcess, phases?: FaultReceipt["phases"], baseUrl = this.baseUrl): Promise<number> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted startup");
      if (this.exited(child)) throw new Error(`Paperclip server exited during startup (code=${child.exitCode} signal=${child.signalCode})`);
      if (phases) {
        const phase = await this.readPhase(baseUrl);
        if (phase !== phases[phases.length - 1]?.phase) phases.push({ phase, at: Date.now() });
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
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
      faultId: `f${String(this.faultCount).padStart(2, "0")}`, kind: this.crashPointHoldMs ? "K4" : "K1", requestedBy: "crash-point",
      signal: "SIGKILL", holdMs: this.crashPointHoldMs,
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
        if (this.crashPointHoldMs) {
          this.timeline.add("crash_point_hold", { faultId: receipt.faultId, holdMs: this.crashPointHoldMs });
          await delay(this.crashPointHoldMs);
        }
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
  fault(kind: FaultKind, holdMs: number, requestedBy: string, trigger?: { trigger: TriggerId; delayMs: number },
    restartSteps?: readonly RestartStep[]): Promise<FaultReceipt> {
    const requestedAt = Date.now();
    const run = this.faultChain.then(() => this.executeFault(kind, holdMs, requestedBy, requestedAt, trigger, restartSteps));
    this.faultChain = run.catch(() => undefined);
    return run;
  }

  private async executeFault(kind: FaultKind, holdMs: number, requestedBy: string, requestedAt: number,
    trigger?: { trigger: TriggerId; delayMs: number }, restartSteps?: readonly RestartStep[]): Promise<FaultReceipt> {
    const previous = this.child;
    this.faultCount += 1;
    const receipt: FaultReceipt = {
      faultId: `f${String(this.faultCount).padStart(2, "0")}`, kind, requestedBy, signal: FAULT_SIGNAL[kind], holdMs,
      ...(trigger ? { trigger: trigger.trigger, triggerDelayMs: trigger.delayMs } : {}),
      loadAvg1m: Math.round(os.loadavg()[0]! * 100) / 100,
      requestedAt, startedAt: Date.now(), stoppedAt: null, restartedAt: null, healthyAt: null, readyAt: null,
      phases: [], serverLogOffsetAtStart: this.serverLogOffset(), serverLogOffsetAtReady: null, error: null,
    };
    // RR: the planned steps and the first kill are recorded before it, so a failed first restart keeps them for replay.
    if (isRepeatedRestartFault(kind)) receipt.repeatedRestart = this.repeatedRestartRecord(kind, receipt, restartSteps, previous?.pid ?? null);
    this.faultInProgress = true;
    this.serverReady = false;
    this.timeline.add("fault_started", { faultId: receipt.faultId, fault: kind, signal: receipt.signal, loadAvg1m: receipt.loadAvg1m, holdMs, requestedBy, previousPid: previous?.pid });
    this.log.write(`\n[restart-chaos] ${receipt.faultId} ${kind} ${receipt.signal} hold=${holdMs}ms requestedBy=${requestedBy} at ${new Date().toISOString()}\n`);
    // CR1 and CR2 with a hold replace the controller as a K15 deploy does (class-r.ts).
    const redeploys = kind === "K15" || classRRedeploys(kind, holdMs);
    try {
      if (!previous?.pid || this.exited(previous)) throw new Error("No live Paperclip server to fault");
      let outage: ControllerOutageReceipt | undefined;
      if (isClassRFault(kind)) {
        if (!this.classR) throw new Error(`${kind} needs the class R hooks of a Daytona wave (main.ts)`);
        receipt.classR = { kind, redeploy: redeploys, captures: [] };
        if (kind === "CR2" && holdMs > 0) receipt.signal = "SIGTERM";
        // The sandbox just before the fault, while the controller still holds it; the fault starts after it.
        receipt.classR.captures.push(await this.classR.capture(`${receipt.faultId}-before`, CLASS_R_PRE_FAULT_DEADLINE_MS));
        receipt.startedAt = Date.now();
      }
      if (kind === "TM1" || kind === "TM2") await this.freeze(kind, previous, holdMs, receipt);
      else if (isMultiServerFault(kind)) await this.multiServer(kind, previous, holdMs, receipt);
      // `--k15-overlap-seconds`: the next deploy boots beside the old server; its hold is the overlap.
      else if (kind === "K15" && this.deployShape.overlap) await this.rollingRedeploy(previous, holdMs, receipt);
      else if (kind === "CR3" || kind === "CR5") {
        const stall = await runPluginStall({ serverPid: previous.pid, holdMs, cancelled: () => this.shuttingDown,
          record: (event, data) => this.timeline.add(event, { faultId: receipt.faultId, ...data }) });
        Object.assign(receipt, { stoppedAt: stall.frozenAt, restartedAt: stall.thawedAt });
        receipt.classR!.pluginStall = stall;
        if (stall.error) throw new Error(stall.error);
        receipt.healthyAt = await this.waitForHealth(previous, receipt.phases);
      }
      else if (kind === "CR2" && !redeploys) {
        // The controller stays up: only the provider inside the task's sandbox dies.
        receipt.classR!.providerKill = await this.classR!.killProvider(requestedBy);
        receipt.healthyAt = Date.now();
      }
      else outage = await replaceController({
        requestId: `chaos-${receipt.faultId}-${requestedBy}`,
        previousPid: previous.pid,
        outage: { signal: receipt.signal === "SIGTERM" ? "SIGTERM" : "SIGKILL", holdMs: kind === "CR4" || kind === "CR6" ? 0 : holdMs },
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
        // K15: capture the sandbox side as soon as the controller is gone (redeployEvidence).
        ...(kind === "K15" && this.redeployEvidence ? { afterStopped: async () => { await this.redeployEvidence?.(receipt.faultId, "stopped"); } } : {}),
        // CR1/CR2: the sandbox as the controller left it; CR2 then kills the provider while the controller is away.
        ...(receipt.classR ? { afterStopped: async () => {
          receipt.classR!.captures.push(await this.classR!.capture(`${receipt.faultId}-stopped`));
          if (kind === "CR2") receipt.classR!.providerKill = await this.classR!.killProvider(requestedBy);
        } } : {}),
        // TM3: the server is down; every database timestamp moves back by the age before the replacement starts.
        ...(kind === "TM3" ? { afterStopped: async () => {
          const timeFault: TimeFaultRecord = { kind };
          receipt.timeFault = timeFault;
          timeFault.aging = await this.age(receipt.faultId);
        } } : {}),
        start: async () => {
          receipt.restartedAt = Date.now();
          // K14: the replacement is the current build, on the same database and instance directory.
          if (kind === "K14") receipt.upgrade = await this.switchToCurrentBuild(receipt.faultId);
          // K15: the replacement is the next deploy: a new process space and deployment id on the same volume.
          if (redeploys) {
            // After the hold, before the next deploy starts: what its recovery will find in the sandboxes.
            if (receipt.classR) receipt.classR.captures.push(await this.classR!.capture(`${receipt.faultId}-before_start`));
            else await this.redeployEvidence?.(receipt.faultId, "before_start");
            receipt.redeploy = await this.advanceDeploy(receipt.faultId);
          }
          this.timeline.add("fault_restarting", { faultId: receipt.faultId });
          const replacement = await this.spawnServer();
          this.armPendingRecoveryStep(receipt, replacement.pid);
          return replacement;
        },
        waitForReady: async replacement => {
          // RR with `--rr-stop-on`: watch the first replacement from spawn; waiting for health first would let a
          // short recovery pass between two 250 ms health polls. Only the last replacement is waited on to health.
          if (receipt.repeatedRestart?.stopOn) {
            receipt.repeatedRestart.firstStopPhase = await this.waitForCrashLoopPhase(replacement, receipt.repeatedRestart.stopOn, receipt.phases);
            return;
          }
          receipt.healthyAt = await withReplacementPluginStall(kind, { into: receipt.classR, serverPid: replacement.pid!, holdMs, cancelled: () => this.shuttingDown,
            logPath: this.paths.serverLogPath, logOffset: receipt.serverLogOffsetAtStart, record: (event, data) => this.timeline.add(event, { faultId: receipt.faultId, ...data }) },
          () => this.waitForHealth(replacement, receipt.phases));
        },
        cancelled: () => this.shuttingDown,
        record: async progress => { outage = progress; },
      });
      if (kind === "K6") {
        if (!this.child) throw new Error("K6 crash loop has no replacement server to kill");
        receipt.healthyAt = await this.waitForHealth(await this.crashLoop(this.child, receipt), receipt.phases);
      }
      if (receipt.repeatedRestart) receipt.healthyAt = await this.repeatedRestarts(receipt.repeatedRestart, receipt);
      receipt.readyAt = await this.waitForReadyPhase(receipt.phases);
      receipt.serverLogOffsetAtReady = this.serverLogOffset();
      this.timeline.add("fault_ready", { faultId: receipt.faultId, replacementPid: this.child?.pid ?? outage?.replacementPid,
        downMs: (receipt.restartedAt ?? 0) - (receipt.stoppedAt ?? 0), readyAfterMs: receipt.readyAt - receipt.startedAt, phases: receipt.phases });
      // Class R: staging failed about 40 s after adoption; watch the sandbox through that window (not awaited).
      if (receipt.classR) this.classR?.watchAfterReady(receipt);
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      this.timeline.add("fault_failed", { faultId: receipt.faultId, error: receipt.error });
      throw Object.assign(new Error(`Fault ${receipt.faultId} failed: ${receipt.error}`), { receipt });
    } finally {
      if (receipt.repeatedRestart) await this.writeRepeatedRestartEvidence(receipt);
      this.faultInProgress = false;
    }
    return receipt;
  }

  private async age(faultId: string, onLockTimeout?: () => Promise<void>) {
    const aging = await ageWaveDatabase({ connectionString: databaseUrlFromConfig(this.paths.configPath), faultId, ageMs: this.timeAgeMs,
      evidenceDir: path.join(path.dirname(this.paths.serverLogPath), "time-faults"), waveStartedAt: this.createdAt,
      priorAgeMs: this.agingShifts.reduce((sum, shift) => sum + shift.ageMs, 0),
      ...(onLockTimeout ? { onLockTimeout } : {}) });
    this.agingShifts.push({ faultId, ageMs: aging.ageMs, appliedAt: aging.appliedAt, waveStartedAt: aging.waveStartedAt });
    this.timeline.add("time_fault_aged", { faultId, ageMs: aging.ageMs, totalRows: aging.totalRows, triggersDisabled: aging.triggersDisabled,
      lockRetries: aging.lockRetries, tables: aging.tables.map(table => `${table.table}:${table.rows}`), evidence: aging.evidencePath });
    return aging;
  }

  /**
   * TM1 freezes the server process alone; TM2 freezes it with every process under it and ages the database
   * while they are stopped. Both continue the same processes after the hold: no restart. A server that exits
   * on its own after it is continued (a lost-lease self-fence) is recorded and replaced, and the tasks are graded.
   */
  private async freeze(kind: "TM1" | "TM2", server: ChildProcess, holdMs: number, receipt: FaultReceipt): Promise<void> {
    const timeFault: TimeFaultRecord = { kind };
    receipt.timeFault = timeFault;
    const times = await runFreezeFault({ kind, rootPid: server.pid!, holdMs, record: timeFault, freezer: new ProcessFreezer(),
      ...(kind === "TM2" ? { age: (onLockTimeout: () => Promise<void>) => this.age(receipt.faultId, onLockTimeout) } : {}),
      cancelled: () => this.shuttingDown,
      onFrozen: pids => { this.markFrozen(server.pid, Date.now(), true); this.timeline.add("fault_server_frozen", { faultId: receipt.faultId, pids, holdMs }); },
      onThawed: frozenMs => { this.markFrozen(server.pid, Date.now(), false); this.timeline.add("fault_server_thawed", { faultId: receipt.faultId, frozenMs }); },
      waitHealthy: () => this.waitForHealth(server, receipt.phases),
      exitStatus: () => this.exited(server) ? { code: server.exitCode, signal: server.signalCode } : null,
      replaceExited: async () => {
        this.timeline.add("time_fault_server_exited_after_thaw", { faultId: receipt.faultId, ...timeFault.serverExitedAfterThaw });
        // Kills what is left of the exited server's tree; rejects when it cannot prove the tree stopped.
        try { await this.stopper.crashForRestart(server); } finally { if (this.child === server) this.child = null; }
      },
      startReplacement: async () => this.waitForHealth(await this.spawnServer(), receipt.phases),
    });
    receipt.stoppedAt = times.stoppedAt;
    receipt.restartedAt = times.restartedAt;
    receipt.healthyAt = times.healthyAt;
  }

  /**
   * MS1–MS3 (multi-server.ts): a second server B on its own port, with the primary's database, instance
   * directory, storage and secrets. The primary keeps its port, so tasks and agents keep using it.
   */
  private async multiServer(kind: MultiServerKind, primary: ChildProcess, holdMs: number, receipt: FaultReceipt): Promise<void> {
    const record: MultiServerRecord = { kind, secondary: null, steps: [] };
    receipt.multiServer = record;
    await runMultiServerFault(kind, holdMs, record, {
      now: () => Date.now(),
      sleep: ms => delay(ms),
      cancelled: () => this.shuttingDown,
      secondaryFailure: () => this.secondary?.exit ?? null,
      startSecondary: async current => {
        const child = await this.spawnSecondary(current);
        current.secondary!.readyAt = await this.waitForSecondaryReady(child, current.secondary!.port);
        this.timeline.add("multi_server_secondary_ready", { faultId: receipt.faultId, pid: child.pid, port: current.secondary!.port });
      },
      stopSecondary: async current => {
        const secondary = this.secondary;
        if (!secondary) return;
        // An exited B still has its owned tree cleaned up; a live one gets the graceful stop.
        try { await (secondary.exit ? this.stopper.crashForRestart(secondary.child) : this.stopper(secondary.child, "SIGTERM")); }
        finally {
          this.secondary = null;
          await new Promise<void>(resolve => secondary.log.end(resolve));
          if (current.secondary) current.secondary.stoppedAt = Date.now();
          this.timeline.add("multi_server_secondary_stopped", { faultId: receipt.faultId, pid: secondary.child.pid });
        }
      },
      freezePrimary: async (freezeMs, current) => {
        // TM2's tree freeze without aging: the primary and its runners stop; the time passes for real.
        const timeFault: TimeFaultRecord = { kind: "TM2" };
        current.primaryFreeze = timeFault;
        const times = await runFreezeFault({ kind: "TM2", rootPid: primary.pid!, holdMs: freezeMs, record: timeFault, freezer: new ProcessFreezer(),
          cancelled: () => this.shuttingDown,
          onFrozen: pids => { this.markFrozen(primary.pid, Date.now(), true); this.timeline.add("fault_server_frozen", { faultId: receipt.faultId, pids, holdMs: freezeMs }); },
          onThawed: frozenMs => { this.markFrozen(primary.pid, Date.now(), false); this.timeline.add("fault_server_thawed", { faultId: receipt.faultId, frozenMs }); },
          waitHealthy: () => this.waitForHealth(primary, receipt.phases),
          exitStatus: () => this.exited(primary) ? { code: primary.exitCode, signal: primary.signalCode } : null,
          replaceExited: async () => {
            this.timeline.add("time_fault_server_exited_after_thaw", { faultId: receipt.faultId, ...timeFault.serverExitedAfterThaw });
            try { await this.stopper.crashForRestart(primary); } finally { if (this.child === primary) this.child = null; }
          },
          startReplacement: async () => this.waitForHealth(await this.spawnServer(), receipt.phases),
        });
        receipt.stoppedAt = times.stoppedAt;
        receipt.restartedAt = times.restartedAt;
        receipt.healthyAt = times.healthyAt;
      },
      restartPrimary: async current => {
        const restart: NonNullable<MultiServerRecord["primaryRestart"]> = { stoppedAt: null, restartedAt: null, readyAt: null, replacementPid: null };
        current.primaryRestart = restart;
        await this.stopper(primary, "SIGTERM");
        if (this.child === primary) this.child = null;
        await this.waitForHealthToStop();
        receipt.stoppedAt = restart.stoppedAt = Date.now();
        this.timeline.add("fault_server_down", { faultId: receipt.faultId });
        receipt.restartedAt = restart.restartedAt = Date.now();
        const replacement = await this.spawnServer();
        restart.replacementPid = replacement.pid ?? null;
        receipt.healthyAt = await this.waitForHealth(replacement, receipt.phases);
        restart.readyAt = await this.waitForReadyPhase(receipt.phases);
      },
    });
  }

  private async spawnSecondary(record: MultiServerRecord): Promise<ChildProcess> {
    if (this.shuttingDown) throw new Error("Refusing to start a second server during harness shutdown");
    if (this.secondary) throw new Error("A second server is already running");
    const port = await reserveRunnerE2EServerPort();
    const log = createWriteStream(path.join(path.dirname(this.paths.serverLogPath), "server-b.log"), { flags: "a", mode: 0o600 });
    const root = this.serverRoot;
    const entry = path.join(root, "tests/runner-e2e/server-entry.ts");
    // Same database, instance directory, storage and secrets as the primary; its own port and API URL.
    const env = { ...this.environment, PORT: String(port), ...waveServerUrlEnvironment(port) };
    const child = spawn(process.execPath, runnerE2ETypeScriptProcessArgs(root, entry, ["onboard", "--yes", "--run"]),
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: runnerE2EServerDetached });
    const window = this.trackWindow(child, "secondary");
    record.secondary = { pid: child.pid ?? null, port, spawnedAt: Date.now(), readyAt: null, stoppedAt: null };
    const secondary = { child, port, log, exit: null as string | null };
    this.secondary = secondary;
    child.stdout?.on("data", chunk => log.write(chunk));
    child.stderr?.on("data", chunk => log.write(chunk));
    child.once("error", error => { this.spawnErrors.set(child, error); });
    child.once("exit", (code, signal) => {
      if (window) window.exitedAt = Date.now();
      log.write(`\n[restart-chaos] second server pid=${child.pid} exited code=${code} signal=${signal}\n`);
      if (!this.expectedStops.has(child) && !this.shuttingDown) {
        secondary.exit = `code=${code} signal=${signal}`;
        this.timeline.add("multi_server_secondary_exited", { pid: child.pid, code, signal });
      }
    });
    await this.stopper.watch(child);
    this.timeline.add("multi_server_secondary_spawned", { pid: child.pid, port });
    return child;
  }

  /** B is ready when its own /api/ready says so; it never changes the primary's readiness. */
  private async waitForSecondaryReady(child: ChildProcess, port: number): Promise<number> {
    const baseUrl = `http://127.0.0.1:${port}`;
    await this.waitForHealth(child, undefined, baseUrl);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted the second server's start");
      if (this.exited(child)) throw new Error(`Second server exited during startup (code=${child.exitCode} signal=${child.signalCode})`);
      if (await this.readPhase(baseUrl) === "ready") return Date.now();
      await delay(250);
    }
    throw new Error(`Second server did not report ready within ${READY_TIMEOUT_MS}ms`);
  }

  /** K15: move the next server to the next deploy generation (redeploy.ts). */
  private async advanceDeploy(faultId: string): Promise<NonNullable<FaultReceipt["redeploy"]>> {
    if (!this.redeploy || !this.environment) throw new Error("K15 needs a redeploy wave (ChaosSupervisor.create redeployWaveId)");
    const from = this.redeploy.identity;
    const to = nextRedeployIdentity(this.redeploy.waveId, from);
    this.redeploy.identity = to;
    if (this.deployShape.freshHome) this.serverHome = await this.freshGenerationHome(faultId, to.generation);
    if (this.deployShape.overlap) this.backendPort = await reserveRunnerE2EServerPort();
    if (this.deployShape.freshHome || this.deployShape.overlap) await this.prepareServerEnvironment(this.serverRoot);
    else Object.assign(this.environment, redeployEnvironment(to, this.paths.home));
    const receipt = redeployReceipt(from, to);
    this.timeline.add("redeploy_switched", { faultId, ...receipt });
    this.log.write(`\n[restart-chaos] ${faultId} K15 redeploy ${from.hostname}/${from.deploymentId} -> ${to.hostname}/${to.deploymentId}\n`);
    return receipt;
  }

  /**
   * `--k15-fresh-home`: a new, empty instance home for the next generation. Only what a hosted deploy gets from
   * outside its container is carried over: the configuration (database, storage) and the secrets master key.
   */
  private async freshGenerationHome(faultId: string, generation: number): Promise<{ home: string; configPath: string }> {
    const home = generationHome(this.paths.temporaryRoot, this.paths.home, generation);
    const instanceRoot = path.join(home, "instances", "default");
    await mkdir(path.join(instanceRoot, "secrets"), { recursive: true, mode: 0o700 });
    const config = JSON.parse(await readFile(this.paths.configPath, "utf8")) as Record<string, any>;
    const keyFile = path.join(instanceRoot, "secrets", "master.key");
    await copyFile(String(config.secrets?.localEncrypted?.keyFilePath ?? path.join(path.dirname(this.paths.configPath), "secrets", "master.key")), keyFile);
    config.secrets = { ...config.secrets, localEncrypted: { ...config.secrets?.localEncrypted, keyFilePath: keyFile } };
    config.logging = { ...config.logging, logDir: path.join(instanceRoot, "logs") };
    const configPath = path.join(instanceRoot, "config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    this.timeline.add("k15_fresh_home", { faultId, generation, home });
    return { home, configPath };
  }

  /**
   * `--k15-overlap-seconds`: the staging deploy shape. The next generation boots beside the old server on its own
   * port; once it is ready, the edge sends new connections to it; the old server keeps running for the overlap and
   * then gets SIGTERM. There is no outage.
   */
  private async rollingRedeploy(previous: ChildProcess, overlapMs: number, receipt: FaultReceipt): Promise<void> {
    if (!this.edge) throw new Error("--k15-overlap-seconds needs the edge proxy started with the wave");
    const fromPort = this.backendPort;
    receipt.redeploy = await this.advanceDeploy(receipt.faultId);
    receipt.restartedAt = Date.now();
    this.timeline.add("fault_restarting", { faultId: receipt.faultId, overlapMs });
    const next = await this.spawnServer();
    // Bound to the next generation: the old server keeps serving during the overlap and must not count hits.
    this.armPendingRecoveryStep(receipt, next.pid);
    const backendUrl = `http://127.0.0.1:${this.backendPort}`;
    receipt.healthyAt = await this.waitForHealth(next, receipt.phases, backendUrl);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (await this.readPhase(backendUrl) !== "ready") {
      if (this.shuttingDown) throw new Error("Harness shutdown interrupted the rolling redeploy");
      if (this.exited(next)) throw new Error(`Next deploy exited during startup (code=${next.exitCode} signal=${next.signalCode})`);
      if (Date.now() > deadline) throw new Error(`Next deploy did not report ready within ${READY_TIMEOUT_MS}ms`);
      await delay(250);
    }
    this.edge.target = this.backendPort;
    this.timeline.add("k15_traffic_switched", { faultId: receipt.faultId, fromPort, toPort: this.backendPort, overlapMs });
    for (const until = Date.now() + overlapMs; Date.now() < until && !this.shuttingDown;) await delay(Math.min(1_000, until - Date.now()));
    await this.stopper(previous, "SIGTERM");
    receipt.stoppedAt = Date.now();
    this.timeline.add("fault_server_down", { faultId: receipt.faultId, previousPid: previous.pid, overlapMs });
    await this.redeployEvidence?.(receipt.faultId, "stopped");
  }

  /** `--fail-recovery-step`: arm the step in fail mode for the wave's first restart fault only. */
  armRecoveryStepOnFirstFault(spec: string, control: CrashPointControl): void {
    this.useCrashPointControl(control);
    this.pendingRecoveryStep = spec;
  }

  /**
   * Arms the step for the replacement process only (`pid=`), and disarms the control file once its receipt
   * landed, so a later server (RR, K6, another task's restart) never fails the step again.
   */
  private armPendingRecoveryStep(receipt: FaultReceipt, pid: number | undefined): void {
    if (!this.pendingRecoveryStep || !pid || !this.crashPointControl) return;
    const token = `rs-${receipt.faultId}`;
    this.armCrashPoint(token, `${this.pendingRecoveryStep} fail pid=${pid}`);
    receipt.recoveryStep = { spec: this.pendingRecoveryStep, token };
    this.pendingRecoveryStep = null;
    const receiptPath = this.crashPointControl.receiptPath;
    const watch = setInterval(() => {
      let text = "";
      try { text = readFileSync(receiptPath, "utf8"); } catch { return; }
      if (!text.includes(`"token":"${token}"`)) return;
      clearInterval(watch);
      this.disarmCrashPoint();
      this.timeline.add("recovery_step_disarmed", { faultId: receipt.faultId, token });
    }, 500);
    watch.unref();
    this.recoveryStepWatch = watch;
  }

  /**
   * K14: move the server from the older build to this checkout. Only the first K14 switches; a later
   * one restarts the current build (recorded with `switched: false`).
   */
  private async switchToCurrentBuild(faultId: string): Promise<NonNullable<FaultReceipt["upgrade"]>> {
    const fromRoot = this.serverRoot;
    const switched = fromRoot !== this.repositoryRoot;
    if (switched) {
      this.serverRoot = this.repositoryRoot;
      await this.prepareServerEnvironment(this.repositoryRoot);
    }
    const upgrade = { fromRoot, fromSha: checkoutSha(fromRoot), toRoot: this.repositoryRoot, toSha: checkoutSha(this.repositoryRoot), switched };
    this.timeline.add("upgrade_switched", { faultId, ...upgrade });
    this.log.write(`\n[restart-chaos] ${faultId} K14 upgrade ${upgrade.fromSha ?? fromRoot} -> ${upgrade.toSha ?? this.repositoryRoot}${switched ? "" : " (already upgraded)"}\n`);
    return upgrade;
  }

  /** RR1–RR3: the planned steps and the first kill (as K1), recorded before that kill. */
  private repeatedRestartRecord(kind: RepeatedRestartKind, receipt: FaultReceipt, planned: readonly RestartStep[] | undefined,
    firstPid: number | null): RepeatedRestartRecord {
    const record = newRepeatedRestartRecord({ kind, planned, firstPid, startedAt: receipt.startedAt,
      evidencePath: path.join(path.dirname(this.paths.serverLogPath), "repeated-restarts", `${receipt.faultId}.json`),
      int: (min, max) => min + Math.floor(Math.random() * (max - min + 1)) });
    return this.rrStopOn ? { ...record, stopOn: this.rrStopOn } : record;
  }

  /**
   * RR1–RR3: the first kill has a healthy replacement. Stop it again after each planned gap, while it
   * is still recovering, and start another. The sequence is one receipt: one fault window.
   */
  private async repeatedRestarts(record: RepeatedRestartRecord, receipt: FaultReceipt): Promise<number> {
    const first = this.child;
    recordFirstRestart(record, receipt, first?.pid ?? null);
    if (!first || (receipt.healthyAt === null && !record.stopOn)) throw new Error(`${record.kind} has no healthy replacement after its first kill`);
    // `--rr-stop-on`: the first replacement was already watched from spawn to its stop status (`firstStopPhase`).
    const waitForStopPhase = stopPhaseWatcher(first, record.firstStopPhase,
      (server: ChildProcess, target: RepeatedRestartStopOn) => this.waitForCrashLoopPhase(server, target, receipt.phases));
    const result = await runRepeatedRestarts({ record, steps: record.planned, server: first, healthyAt: receipt.healthyAt ?? Date.now(),
      ...(record.stopOn ? { stopOn: record.stopOn } : {}), hooks: {
      now: () => Date.now(),
      sleep: ms => delay(ms),
      cancelled: () => this.shuttingDown,
      pidOf: server => server.pid ?? null,
      exitStatus: server => this.exited(server) ? { code: server.exitCode, signal: server.signalCode } : null,
      readPhase: () => this.readPhase(),
      stop: async (server, signal) => {
        if (signal === "SIGKILL") await this.stopper.crashForRestart(server);
        else await this.stopper(server, "SIGTERM");
        if (this.child === server) this.child = null;
        await this.waitForHealthToStop();
      },
      start: () => this.spawnServer(),
      waitHealthy: server => this.waitForHealth(server, receipt.phases),
      // The K6 phase poll (50 ms): fires on `recovering`, or on `ready` when recovery was too short to see.
      waitForStopPhase,
      onEntry: (entry, stage) => {
        if (stage === "stopping") {
          this.timeline.add("repeated_restart_stop", { faultId: receipt.faultId, index: entry.index, signal: entry.signal, gapMs: entry.gapMs,
            pid: entry.pid, phaseAtStop: entry.phaseAtStop });
          this.log.write(`\n[restart-chaos] ${receipt.faultId} ${record.kind} restart ${entry.index} ${entry.signal} pid=${entry.pid} phase=${entry.phaseAtStop} gap=${entry.gapMs}ms\n`);
        } else {
          this.timeline.add("repeated_restart_healthy", { faultId: receipt.faultId, index: entry.index, replacementPid: entry.replacementPid,
            downMs: (entry.healthyAt ?? 0) - entry.stopAt });
        }
      },
    } });
    return result.healthyAt;
  }

  /** `<wave>/repeated-restarts/<faultId>.json`, written whether the sequence passed or failed; faults.json carries the same record. */
  private async writeRepeatedRestartEvidence(receipt: FaultReceipt): Promise<void> {
    const record = receipt.repeatedRestart!;
    // A first kill that failed before its replacement was healthy still records the times it reached.
    recordFirstRestart(record, receipt, null);
    try {
      await mkdir(path.dirname(record.evidencePath!), { recursive: true });
      await writeFile(record.evidencePath!, `${JSON.stringify({ faultId: receipt.faultId, requestedBy: receipt.requestedBy, error: receipt.error, ...record }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log.write(`[restart-chaos] ${receipt.faultId} could not write repeated-restart evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    }
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
    if (this.recoveryStepWatch) clearInterval(this.recoveryStepWatch);
    const errors: string[] = [];
    try { await this.stopper.stopAll(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    await this.edge?.close().catch(error => { errors.push(error instanceof Error ? error.message : String(error)); });
    try { await this.database?.cleanup(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    await new Promise<void>(resolve => this.log.end(resolve));
    this.timeline.add("supervisor_stopped", { errors });
    if (errors.length) throw new Error(`Supervisor cleanup incomplete: ${errors.join("; ")}`);
  }
}
