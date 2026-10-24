import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { applyPendingMigrations, inspectMigrations } from "@paperclipai/db";
import {
  canonicalJson,
  MANAGED_DATABASE_CONTRACT_VERSION,
  MANAGED_DATABASE_ENV,
  MANAGED_DATABASE_MAINTENANCE_ONLY_KINDS,
  MANAGED_DATABASE_MAX_CLOCK_SKEW_MS,
  MANAGED_DATABASE_MUTATING_KINDS,
  MANAGED_DATABASE_SNAPSHOT_FORMAT,
  MANAGED_EMBEDDED_DATABASE_PROVIDER,
  managedDatabaseCommandSchema,
  managedDatabaseLeaseRefSchema,
  managedDatabaseSnapshotReceiptDetailsSchema,
  type ManagedDatabaseCommand,
  type ManagedDatabaseConfig,
  type ManagedDatabaseHold,
  type ManagedDatabaseLeaseRef,
  type ManagedDatabaseReadiness,
  type ManagedDatabaseReceipt,
  type ManagedDatabaseReceiptLookup,
  type ManagedDatabaseRejectionCode,
  type ManagedDatabaseRelease,
  type ManagedDatabaseSchemaState,
} from "@paperclipai/shared/managed-database";
import {
  sha256HexOf,
  signManagedDatabaseReceipt,
  verifyManagedDatabaseReceipt,
  verifyManagedDatabaseSignature,
} from "@paperclipai/shared/managed-database-server";
import { createEmbeddedPostgresSupervisor, type EmbeddedPostgresSupervisor } from "../embedded-postgres-supervisor.js";
import {
  createEngine,
  initializeCluster,
  supervisorSql,
  type EngineBinaries,
  type ProcessIdentity,
  type RunningEngine,
} from "./engine.js";
import { fsyncFile, managedDatabaseLayout, readJsonIfExists, writeJsonAtomic, type ManagedDatabaseLayout } from "./layout.js";
import { runManagedDatabasePreflight, type InitializationMarker, type VolumeIdentity } from "./preflight.js";
import {
  APP_ROLE,
  applyDatabaseGrants,
  applyTenantGrants,
  createClusterRoles,
  generatePassword,
  OWNER_ROLE,
  PLUGIN_ROLE,
  rotateTenantPasswords,
  TENANT_DATABASE,
  type ManagedRoleSecrets,
} from "./roles.js";
import {
  createSnapshot,
  listDatabases,
  listSnapshots,
  publishSnapshot,
  readJournalFingerprint,
  readSnapshotDetails,
  reconcileRestoreIntent,
  restoreSnapshot,
  sha256File,
  snapshotPaths,
  type ClusterAccess,
  type PgClientTools,
} from "./snapshots.js";
import { HoldStore, LeaseStore, ReceiptStore } from "./state.js";

export type SupervisorLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

export type ManagedDatabaseSupervisorOptions = {
  config: ManagedDatabaseConfig;
  controlKey: Buffer;
  /** Environment the supervisor was started with (pre-filter). */
  env: NodeJS.ProcessEnv;
  engine: EngineBinaries;
  pgTools: PgClientTools | null;
  release: ManagedDatabaseRelease;
  /** OS identity PostgreSQL runs as. Null = current user (tests). */
  dbIdentity: ProcessIdentity;
  /** OS identity the tenant app runs as. Null = current user (tests). */
  appIdentity: ProcessIdentity;
  pgPort: number;
  /** Tenant app argv; omitted = never launch an app. */
  appCommand?: string[];
  /** TCP port for the maintenance surface while no app is running. */
  httpPort?: number | null;
  httpHost?: string;
  deviceOf?: (target: string) => number;
  now?: () => number;
  logger: SupervisorLogger;
  /** Called when the supervisor cannot continue (app exit, engine recovery exhausted). */
  onFatal?: (code: number, reason: string) => void;
  engineRestartDelaysMs?: number[];
};

/**
 * `closeConnection`: the request body was not read and must not be. The HTTP
 * layer answers with `connection: close` and drops the connection instead of
 * draining whatever the caller keeps sending.
 */
export type CommandResponse = { status: number; body: unknown; closeConnection?: boolean };

type ReceiptMeta = { commandId: string; kind: string; lease: ManagedDatabaseLeaseRef | null };

function receiptMeta(command: ManagedDatabaseCommand): ReceiptMeta {
  return { commandId: command.commandId, kind: command.kind, lease: "lease" in command ? command.lease : null };
}

class CommandRejection extends Error {
  constructor(readonly code: ManagedDatabaseRejectionCode, readonly httpStatus: number, message: string) {
    super(message);
  }
}

function reject(code: ManagedDatabaseRejectionCode, httpStatus: number, message: string): never {
  throw new CommandRejection(code, httpStatus, message);
}

/**
 * The body re-emits a client disconnect as an `error` event; without a
 * listener that is an uncaught exception, so an unsigned request could take
 * the supervisor down.
 */
function ignoreUploadErrors(stream: Readable): void {
  stream.on("error", () => {});
}

/** Drain an authenticated upload body that will not be stored. */
function discardUpload(stream: Readable): void {
  ignoreUploadErrors(stream);
  stream.resume();
}

/**
 * Refuse an upload without reading the rest of its body: an unsigned or
 * malformed upload, so an anonymous caller cannot make the supervisor consume
 * an arbitrarily large or slow body, and a body cut off mid-stream.
 */
function refuseUpload(stream: Readable, response: CommandResponse): CommandResponse {
  ignoreUploadErrors(stream);
  return { ...response, closeConnection: true };
}

/** Fails the upload as soon as it carries more bytes than its receipt declares. */
function limitUploadBytes(limit: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) callback(new CommandRejection("precondition_failed", 409, `uploaded archive exceeds the receipt's ${limit} bytes`));
      else callback(null, chunk);
    },
  });
}

function identityOwn(target: string, identity: ProcessIdentity): void {
  if (identity) chownSync(target, identity.uid, identity.gid);
}

function ensureDir(target: string, mode: number, identity: ProcessIdentity = null): void {
  mkdirSync(target, { recursive: true, mode });
  chmodSync(target, mode);
  identityOwn(target, identity);
}

export class ManagedDatabaseSupervisor {
  readonly layout: ManagedDatabaseLayout;
  private readonly leases: LeaseStore;
  private readonly receipts: ReceiptStore;
  private readonly holds: HoldStore;
  private readonly now: () => number;
  private secrets: ManagedRoleSecrets | null = null;
  private engine: RunningEngine | null = null;
  private engineSupervisor: EmbeddedPostgresSupervisor | null = null;
  private app: ChildProcess | null = null;
  private appPasswords: { appPassword: string; pluginPassword: string } | null = null;
  private systemIdentifier: string | null = null;
  private schema: ManagedDatabaseReadiness["schema"] = { state: "unknown", appliedCount: 0, latestApplied: null };
  private status: ManagedDatabaseReadiness["status"] = "starting";
  private busy: string | null = null;
  private stopping = false;
  private engineRecovering = false;

  constructor(private readonly opts: ManagedDatabaseSupervisorOptions) {
    this.layout = managedDatabaseLayout(opts.config);
    this.now = opts.now ?? Date.now;
    this.leases = new LeaseStore(this.layout, this.now);
    this.receipts = new ReceiptStore(this.layout);
    this.holds = new HoldStore(this.layout);
  }

  private get config() {
    return this.opts.config;
  }

  private get access(): ClusterAccess {
    if (!this.secrets) throw new Error("cluster secrets not loaded");
    return { socketDir: this.layout.socketDir, port: this.opts.pgPort, superuserPassword: this.secrets.supervisorPassword };
  }

  private ownerUrl(database = TENANT_DATABASE): string {
    if (!this.secrets) throw new Error("cluster secrets not loaded");
    return `postgres://${OWNER_ROLE}:${this.secrets.ownerPassword}@localhost:${this.opts.pgPort}/${database}?host=${encodeURIComponent(this.layout.socketDir)}`;
  }

  // A method, not an inline comparison: engine recovery can reset the status
  // across an await, and TypeScript keeps property narrowing across awaits.
  private isStarting(): boolean {
    return this.status === "starting";
  }

  get appRunning(): boolean {
    return this.app !== null && this.app.exitCode === null && this.app.signalCode === null;
  }

  // ---------------------------------------------------------------- boot

  async start(): Promise<void> {
    const { config, logger } = this.opts;
    const plan = runManagedDatabasePreflight({
      config,
      layout: this.layout,
      env: this.opts.env,
      engineMajor: this.opts.engine.major,
      deviceOf: this.opts.deviceOf,
    });
    logger.info({ action: plan.action, stackId: config.stackId, generation: config.configGeneration }, "managed database preflight passed");

    this.prepareDirectories();
    cleanupPartialSnapshots(this.layout);
    try {
      await this.bootCluster(plan);
    } catch (error) {
      // Never leave PostgreSQL running behind a failed start.
      await this.engineSupervisor?.shutdown().catch(() => {});
      throw error;
    }
  }

  private async bootCluster(plan: ReturnType<typeof runManagedDatabasePreflight>): Promise<void> {
    const { config, logger } = this.opts;
    if (plan.action === "existing") {
      this.secrets = readJsonIfExists<ManagedRoleSecrets>(this.layout.secretsFile);
      if (!this.secrets) throw new Error("managed database secrets are missing on an established stack");
      await this.startEngine();
      await this.verifyClusterIdentity(plan.marker);
    } else {
      await this.initializeCluster(plan.action === "resume-initialize");
    }

    const reconciled = await reconcileRestoreIntent({ access: this.access, layout: this.layout, database: TENANT_DATABASE });
    if (reconciled) logger.warn({ ...reconciled }, "reconciled an interrupted restore");
    if (reconciled?.outcome === "rolled_back") {
      this.holds.set({ reason: "restore_interrupted", commandId: reconciled.intent.commandId, detail: "restore was interrupted before its swap; the previous database is active" });
      rmSync(this.layout.restoreIntentFile, { force: true });
    }

    await this.applyGrants();
    if (reconciled?.outcome === "completed") {
      // Same bookkeeping as an uninterrupted restore: the restored database
      // replaces whatever state the hold described.
      this.holds.clear();
      rmSync(this.layout.restoreIntentFile, { force: true });
    }
    const admin = supervisorSql(this.access, "postgres");
    try {
      this.appPasswords = await rotateTenantPasswords(admin);
    } finally {
      await admin.end({ timeout: 2 });
    }
    await this.refreshSchemaState();

    if (this.canServe()) {
      this.launchApp();
    } else {
      this.status = this.holds.get() ? "recovery" : "maintenance";
      if (config.mode === "serving") {
        logger.warn({ schema: this.schema, hold: this.holds.get() }, "serving config but the database is not ready for the app; staying in maintenance");
      }
    }
    this.writeReadiness();
  }

  private prepareDirectories(): void {
    const db = this.opts.dbIdentity;
    ensureDir(this.layout.root, 0o711);
    ensureDir(this.layout.secretsDir, 0o700);
    ensureDir(this.layout.stateDir, 0o700);
    ensureDir(this.layout.receiptsDir, 0o700);
    ensureDir(this.layout.snapshotsDir, 0o700);
    ensureDir(this.layout.publicDir, 0o755);
    ensureDir(this.layout.socketDir, 0o700, db);
  }

  private async initializeCluster(resume: boolean): Promise<void> {
    const { config, logger } = this.opts;
    const createdAt = new Date(this.now()).toISOString();
    if (resume) {
      logger.warn({ initializationId: config.cluster.initializationId }, "resuming an interrupted first initialization");
      rmSync(this.layout.dataDir, { recursive: true, force: true });
    } else {
      if (!existsSync(this.layout.volumeIdentityFile)) {
        writeJsonAtomic(this.layout.volumeIdentityFile, {
          v: 1, stackId: config.stackId, volumeId: config.volume.id, createdAt,
        } satisfies VolumeIdentity);
      }
    }
    const marker: InitializationMarker = {
      v: 1,
      status: "initializing",
      stackId: config.stackId,
      volumeId: config.volume.id,
      initializationId: config.cluster.initializationId,
      engineMajor: config.engineMajor,
      systemIdentifier: null,
      createdAt,
      readyAt: null,
    };
    writeJsonAtomic(this.layout.markerFile, marker);

    this.secrets = { v: 1, supervisorPassword: generatePassword(), ownerPassword: generatePassword() };
    writeJsonAtomic(this.layout.secretsFile, this.secrets);
    ensureDir(this.layout.dataDir, 0o700, this.opts.dbIdentity);
    await initializeCluster({
      binaries: this.opts.engine,
      dataDir: this.layout.dataDir,
      superuserPassword: this.secrets.supervisorPassword,
      identity: this.opts.dbIdentity,
    });
    await this.startEngine();

    const admin = supervisorSql(this.access, "postgres");
    try {
      await createClusterRoles(admin, this.secrets);
      await applyDatabaseGrants(admin);
    } finally {
      await admin.end({ timeout: 2 });
    }
    await this.applyGrants();
    // The authorized first initialization is the only automatic schema
    // change: the database is empty and the migrator is this image's own.
    await applyPendingMigrations(this.ownerUrl());
    await this.applyGrants();

    this.systemIdentifier = await this.readSystemIdentifier();
    writeJsonAtomic(this.layout.markerFile, {
      ...marker,
      status: "ready",
      systemIdentifier: this.systemIdentifier,
      readyAt: new Date(this.now()).toISOString(),
    } satisfies InitializationMarker);
    logger.info({ systemIdentifier: this.systemIdentifier }, "managed database initialized");
  }

  private engineOptions() {
    if (!this.secrets) throw new Error("cluster secrets not loaded");
    return {
      binaries: this.opts.engine,
      dataDir: this.layout.dataDir,
      socketDir: this.layout.socketDir,
      port: this.opts.pgPort,
      database: TENANT_DATABASE,
      superuserPassword: this.secrets.supervisorPassword,
      identity: this.opts.dbIdentity,
      onLog: (line: string) => this.opts.logger.info({ postgres: line }, "postgres"),
    };
  }

  private async startEngine(): Promise<void> {
    const engine = createEngine(this.engineOptions());
    await engine.start();
    this.engine = engine;
    this.engineSupervisor = createEmbeddedPostgresSupervisor({
      initialInstance: engine,
      createInstance: () => {
        const replacement = createEngine(this.engineOptions());
        this.engine = replacement;
        return replacement;
      },
      restartDelaysMs: this.opts.engineRestartDelaysMs,
      beforeRestart: async () => {
        // App writers must stop before the database comes back.
        this.status = "starting";
        this.writeReadiness();
        await this.stopApp();
      },
      onUnexpectedExit: (code, signal) => {
        this.engineRecovering = true;
        this.opts.logger.error({ code, signal }, "PostgreSQL exited unexpectedly; stopping app writers and recovering");
      },
      onRestartAttemptFailed: (err, attempt) => this.opts.logger.error({ err: String(err), attempt }, "PostgreSQL recovery attempt failed"),
      onRestarted: (attempt) => {
        void this.afterEngineRecovery(attempt);
      },
      onRecoveryExhausted: (err) => {
        this.engineRecovering = false;
        this.opts.logger.error({ err: String(err) }, "PostgreSQL recovery exhausted");
        this.status = "recovery";
        this.writeReadiness();
        this.opts.onFatal?.(1, "engine_recovery_exhausted");
      },
    });
  }

  private async afterEngineRecovery(attempt: number): Promise<void> {
    try {
      const marker = readJsonIfExists<InitializationMarker>(this.layout.markerFile);
      if (marker) await this.verifyClusterIdentity(marker);
      await this.refreshSchemaState();
      this.opts.logger.info({ attempt }, "PostgreSQL recovered");
      this.engineRecovering = false;
      if (this.canServe() && !this.stopping && !this.appRunning) this.launchApp();
      else if (!this.appRunning) this.status = this.holds.get() ? "recovery" : "maintenance";
      this.writeReadiness();
    } catch (error) {
      this.engineRecovering = false;
      this.opts.logger.error({ err: String(error) }, "PostgreSQL recovered with an unexpected identity");
      this.opts.onFatal?.(1, "engine_identity_mismatch");
    }
  }

  private async readSystemIdentifier(): Promise<string> {
    const admin = supervisorSql(this.access, "postgres");
    try {
      const [row] = await admin<{ id: string; version: number }[]>`
        select system_identifier::text as id, current_setting('server_version_num')::int as version
        from pg_control_system()
      `;
      const major = Math.floor(Number(row!.version) / 10000);
      if (major !== this.config.engineMajor) {
        throw new Error(`running PostgreSQL reports major ${major}; config pins ${this.config.engineMajor}`);
      }
      return row!.id;
    } finally {
      await admin.end({ timeout: 2 });
    }
  }

  private async verifyClusterIdentity(marker: InitializationMarker): Promise<void> {
    const actual = await this.readSystemIdentifier();
    if (marker.systemIdentifier !== actual) {
      await this.engineSupervisor?.shutdown();
      throw new Error(`running cluster ${actual} does not match the initialization marker ${marker.systemIdentifier}`);
    }
    this.systemIdentifier = actual;
  }

  private async applyGrants(): Promise<void> {
    const admin = supervisorSql(this.access, "postgres");
    const tenant = supervisorSql(this.access, TENANT_DATABASE);
    try {
      await applyDatabaseGrants(admin);
      await applyTenantGrants(tenant);
    } finally {
      await Promise.all([admin.end({ timeout: 2 }), tenant.end({ timeout: 2 })]);
    }
  }

  private async refreshSchemaState(): Promise<ManagedDatabaseReadiness["schema"]> {
    const state = await inspectMigrations(this.ownerUrl());
    const latest = state.appliedMigrations.length > 0 ? [...state.appliedMigrations].sort().at(-1)! : null;
    let schemaState: ManagedDatabaseSchemaState;
    if (state.journalEntryCount > state.appliedMigrations.length) schemaState = "ahead";
    else if (state.status === "upToDate") schemaState = "current";
    else if (state.reason === "no-migration-journal-empty-db") schemaState = "empty";
    else schemaState = "pending";
    this.schema = { state: schemaState, appliedCount: state.appliedMigrations.length, latestApplied: latest };
    return this.schema;
  }

  private canServe(): boolean {
    return this.config.mode === "serving"
      && this.schema.state === "current"
      && this.holds.get() === null
      && Array.isArray(this.opts.appCommand)
      && this.opts.appCommand.length > 0;
  }

  readiness(): ManagedDatabaseReadiness {
    return {
      v: MANAGED_DATABASE_CONTRACT_VERSION,
      stackId: this.config.stackId,
      configGeneration: this.config.configGeneration,
      mode: this.config.mode,
      status: this.status,
      volumeId: this.config.volume.id,
      initializationId: this.config.cluster.initializationId,
      systemIdentifier: this.systemIdentifier,
      engineVersion: this.opts.engine.version,
      engineMajor: this.config.engineMajor,
      release: this.opts.release,
      schema: this.schema,
      hold: this.holds.get(),
      appRunning: this.appRunning,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private writeReadiness(): void {
    try {
      writeJsonAtomic(this.layout.readinessFile, this.readiness(), 0o644);
    } catch (error) {
      this.opts.logger.error({ err: String(error) }, "failed to write readiness file");
    }
  }

  // ------------------------------------------------------------ tenant app

  appEnvironment(): NodeJS.ProcessEnv {
    if (!this.appPasswords) throw new Error("tenant passwords not provisioned");
    const env: NodeJS.ProcessEnv = { ...this.opts.env };
    for (const name of [
      MANAGED_DATABASE_ENV.controlKey,
      MANAGED_DATABASE_ENV.config,
      "DATABASE_MIGRATION_URL",
    ]) delete env[name];
    for (const name of Object.keys(env)) {
      if (name.startsWith("PAPERCLIP_MANAGED_DATABASE_") || name === "PGPASSWORD") delete env[name];
    }
    const port = this.opts.pgPort;
    return {
      ...env,
      DATABASE_URL: `postgres://${APP_ROLE}:${this.appPasswords.appPassword}@127.0.0.1:${port}/${TENANT_DATABASE}`,
      [MANAGED_DATABASE_ENV.pluginMigrationUrl]: `postgres://${PLUGIN_ROLE}:${this.appPasswords.pluginPassword}@127.0.0.1:${port}/${TENANT_DATABASE}`,
      [MANAGED_DATABASE_ENV.provider]: MANAGED_EMBEDDED_DATABASE_PROVIDER,
      [MANAGED_DATABASE_ENV.readinessFile]: this.layout.readinessFile,
      [MANAGED_DATABASE_ENV.controlSocket]: this.layout.controlSocket,
      [MANAGED_DATABASE_ENV.stackId]: this.config.stackId,
      [MANAGED_DATABASE_ENV.configGeneration]: String(this.config.configGeneration),
      PAPERCLIP_MIGRATION_AUTO_APPLY: "false",
      PAPERCLIP_MIGRATION_PROMPT: "never",
    };
  }

  private launchApp(): void {
    const [command, ...args] = this.opts.appCommand!;
    this.status = "serving";
    this.writeReadiness();
    const child = spawn(command!, args, {
      env: this.appEnvironment(),
      stdio: "inherit",
      ...(this.opts.appIdentity ? { uid: this.opts.appIdentity.uid, gid: this.opts.appIdentity.gid } : {}),
    });
    this.app = child;
    child.once("exit", (code, signal) => {
      if (this.app !== child) return;
      this.app = null;
      void this.onAppExit(code, signal);
    });
    this.opts.logger.info({ pid: child.pid }, "tenant app started");
  }

  private async onAppExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.stopping || this.status === "starting") return;
    // An engine crash usually breaks the app's connections before the
    // postmaster's exit is observed; let engine recovery own that case.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (this.stopping || this.engineRecovering || this.isStarting() || this.appRunning) return;
    this.opts.logger.error({ code, signal }, "tenant app exited");
    this.status = this.holds.get() ? "recovery" : "maintenance";
    this.writeReadiness();
    this.opts.onFatal?.(code ?? 1, "app_exited");
  }

  private async stopApp(timeoutMs = 30_000): Promise<void> {
    const child = this.app;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.app = null;
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs)),
    ]);
    if (timedOut) {
      child.kill("SIGKILL");
      await exited;
    }
    if (this.app === child) this.app = null;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.stopApp();
    await this.engineSupervisor?.shutdown();
    this.status = "starting";
    this.writeReadiness();
  }

  /** Test hook: the running postgres child, to simulate crashes. */
  enginePid(): number | null {
    try {
      return this.engine?.process.pid ?? null;
    } catch {
      return null; // replacement engine not started yet
    }
  }

  appPid(): number | null {
    return this.appRunning ? this.app!.pid ?? null : null;
  }

  async waitForEngineRecovery(): Promise<void> {
    await this.engineSupervisor?.waitForRecovery();
  }

  // -------------------------------------------------------------- commands

  /** Signature, shape, and stack. Enough to answer an exact replay; not enough to execute. */
  private authenticate(body: unknown, signature: string | undefined): { command: ManagedDatabaseCommand; requestSha256: string } {
    if (!verifyManagedDatabaseSignature(this.opts.controlKey, "command", body, signature)) {
      reject("bad_signature", 401, "command signature is invalid");
    }
    const parsed = managedDatabaseCommandSchema.safeParse(body);
    if (!parsed.success) reject("invalid_command", 400, parsed.error.issues.map((issue) => issue.message).join("; "));
    const command = parsed.data;
    if (command.stackId !== this.config.stackId) reject("wrong_stack", 403, "command is for another stack");
    return { command, requestSha256: sha256HexOf(canonicalJson(body)) };
  }

  /** Generation and replay window. Every command that may act must pass this. */
  private requireFresh(command: ManagedDatabaseCommand): void {
    if (command.configGeneration !== this.config.configGeneration) {
      reject("stale_generation", 409, `command generation ${command.configGeneration} ≠ running ${this.config.configGeneration}`);
    }
    if (Math.abs(this.now() - Date.parse(command.issuedAt)) > MANAGED_DATABASE_MAX_CLOCK_SKEW_MS) {
      reject("clock_skew", 401, "command issuedAt is outside the accepted window");
    }
  }

  /**
   * The stored receipt for `commandId`, if it answers exactly this request.
   * The receipt is signed and records the request hash and the generation it
   * ran under, so it can be returned after the replay window or a generation
   * change without executing anything. Returns null when nothing was stored.
   */
  private storedReceiptFor(commandId: string, requestSha256: string, configGeneration: number | null): ManagedDatabaseReceipt | null {
    const stored = this.receipts.get(commandId);
    if (!stored) return null;
    // Receipt files are keyed by a sanitized id. A colliding id must not run
    // and overwrite the recorded command's receipt.
    if (stored.commandId !== commandId || stored.requestSha256 !== requestSha256) {
      reject("command_id_conflict", 409, "commandId was used for a different request");
    }
    const verified = verifyManagedDatabaseReceipt(this.opts.controlKey, stored);
    if (
      !verified
      || verified.stackId !== this.config.stackId
      || (configGeneration !== null && verified.configGeneration !== configGeneration)
    ) {
      reject("precondition_failed", 409, "stored receipt does not verify for this stack and request");
    }
    return verified;
  }

  private gate(command: ManagedDatabaseCommand): void {
    if (MANAGED_DATABASE_MAINTENANCE_ONLY_KINDS.includes(command.kind) && this.config.mode !== "maintenance") {
      reject("mode_forbidden", 409, `${command.kind} requires maintenance mode`);
    }
    if ("lease" in command) {
      const checked = this.leases.check(command.lease);
      if (!checked.ok) reject("lease_stale", 409, "lease is stale, expired, or superseded");
    }
    // A lease cannot change hands while a command is still acting under it.
    const mutating = MANAGED_DATABASE_MUTATING_KINDS.includes(command.kind)
      || command.kind === "lease.acquire"
      || command.kind === "lease.release";
    if (mutating && this.busy) reject("busy", 409, `command ${this.busy} is still running`);
    if (this.status === "starting" && command.kind !== "status" && command.kind !== "receipt.get") {
      reject("busy", 409, "database is starting");
    }
  }

  private sign(
    meta: ReceiptMeta,
    requestSha256: string,
    startedAt: string,
    outcome: ManagedDatabaseReceipt["outcome"],
    details: Record<string, unknown>,
    error: { code: string; message: string } | null,
  ): ManagedDatabaseReceipt {
    return signManagedDatabaseReceipt(this.opts.controlKey, {
      v: MANAGED_DATABASE_CONTRACT_VERSION,
      commandId: meta.commandId,
      kind: meta.kind,
      stackId: this.config.stackId,
      configGeneration: this.config.configGeneration,
      lease: meta.lease,
      outcome,
      code: error?.code ?? null,
      error: error?.message ?? null,
      details,
      requestSha256,
      startedAt,
      finishedAt: new Date(this.now()).toISOString(),
    });
  }

  private rejection(body: unknown, error: CommandRejection, startedAt: string): CommandResponse {
    const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    // Unauthenticated callers learn only the rejection code.
    if (error.code === "bad_signature" || error.code === "invalid_command") {
      return { status: error.httpStatus, body: { outcome: "rejected", code: error.code, error: error.message } };
    }
    const lease = managedDatabaseLeaseRefSchema.safeParse(record.lease);
    const commandId = typeof record.commandId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.commandId)
      ? record.commandId
      : "unknown";
    const receipt = this.sign(
      { commandId, kind: typeof record.kind === "string" ? record.kind.slice(0, 64) : "unknown", lease: lease.success ? lease.data : null },
      sha256HexOf(canonicalJson(body)),
      startedAt,
      "rejected",
      {},
      { code: error.code, message: error.message },
    );
    return { status: error.httpStatus, body: receipt };
  }

  /** POST /command. `body` is the parsed JSON, `signature` the header value. */
  async handleCommand(body: unknown, signature: string | undefined): Promise<CommandResponse> {
    const startedAt = new Date(this.now()).toISOString();
    let command: ManagedDatabaseCommand;
    let requestSha256: string;
    try {
      ({ command, requestSha256 } = this.authenticate(body, signature));
      // An exact replay returns its stored outcome before the freshness
      // checks: a harness that lost the response must be able to recover it
      // after a long restart or a generation change. Anything not already
      // recorded must still be fresh before it can act.
      const stored = this.storedReceiptFor(command.commandId, requestSha256, command.configGeneration);
      if (stored) return { status: stored.outcome === "succeeded" ? 200 : 500, body: stored };
      this.requireFresh(command);
      if (command.kind === "snapshot.download" || command.kind === "snapshot.upload") {
        reject("invalid_command", 400, `${command.kind} uses the archive endpoint`);
      }
      this.gate(command);
    } catch (error) {
      if (error instanceof CommandRejection) return this.rejection(body, error, startedAt);
      throw error;
    }

    const mutating = MANAGED_DATABASE_MUTATING_KINDS.includes(command.kind);
    if (mutating) this.busy = command.commandId;
    try {
      const details = await this.execute(command);
      const receipt = this.sign(receiptMeta(command), requestSha256, startedAt, "succeeded", details, null);
      if (command.kind !== "status" && command.kind !== "receipt.get") this.receipts.put(receipt);
      return { status: 200, body: receipt };
    } catch (error) {
      if (error instanceof CommandRejection) return this.rejection(body, error, startedAt);
      const message = error instanceof Error ? error.message : String(error);
      this.opts.logger.error({ commandId: command.commandId, kind: command.kind, err: message }, "managed database command failed");
      const receipt = this.sign(receiptMeta(command), requestSha256, startedAt, "failed", { schema: this.schema, hold: this.holds.get() }, { code: "operation_failed", message });
      this.receipts.put(receipt);
      return { status: 500, body: receipt };
    } finally {
      if (mutating) this.busy = null;
      this.writeReadiness();
    }
  }

  private async execute(command: ManagedDatabaseCommand): Promise<Record<string, unknown>> {
    switch (command.kind) {
      case "status":
        return this.statusDetails();
      case "receipt.get":
        return this.lookupReceipt(command.args.commandId, command.args.requestSha256);
      case "lease.acquire": {
        const granted = this.leases.acquire(command.args.holder, command.args.ttlSeconds);
        if (!granted.ok) reject("lease_conflict", 409, `lease held by ${granted.lease.holder} until ${granted.lease.expiresAt}`);
        return { lease: granted.lease };
      }
      case "lease.renew": {
        const renewed = this.leases.renew(command.lease, command.args.ttlSeconds);
        if (!renewed.ok) reject("lease_stale", 409, "lease is stale");
        return { lease: renewed.lease };
      }
      case "lease.release":
        this.leases.release(command.lease);
        return { released: true };
      case "snapshot.create":
        return { snapshot: await this.createSnapshot() };
      case "snapshot.delete": {
        const paths = snapshotPaths(this.layout, command.args.snapshotId);
        if (!existsSync(paths.archive)) reject("not_found", 404, "snapshot not found");
        rmSync(paths.archive, { force: true });
        rmSync(paths.metadata, { force: true });
        return { deleted: command.args.snapshotId };
      }
      case "snapshot.restore":
        return this.restore(command);
      case "restore.discard": {
        const admin = supervisorSql(this.access, "postgres");
        try {
          const names = await listDatabases(admin);
          if (!names.includes(command.args.database)) reject("not_found", 404, "database not found");
          await admin.unsafe(`drop database ${command.args.database} with (force)`);
        } finally {
          await admin.end({ timeout: 2 });
        }
        return { dropped: command.args.database };
      }
      case "schema.migrate":
        return this.migrate(command);
      default:
        reject("invalid_command", 400, `unsupported kind ${command.kind}`);
    }
  }

  private async statusDetails(): Promise<Record<string, unknown>> {
    let leftovers: string[] = [];
    if (this.status !== "starting") {
      const admin = supervisorSql(this.access, "postgres");
      try {
        leftovers = (await listDatabases(admin)).filter((name) => name.startsWith("paperclip_pre_restore_") || name.startsWith("paperclip_restore_"));
      } finally {
        await admin.end({ timeout: 2 });
      }
    }
    return {
      readiness: this.readiness(),
      lease: this.leases.current(),
      busy: this.busy,
      retainedDatabases: leftovers,
      snapshots: listSnapshots(this.layout),
      snapshotFormats: this.opts.pgTools ? [MANAGED_DATABASE_SNAPSHOT_FORMAT] : [],
    };
  }

  private lookupReceipt(commandId: string, requestSha256: string): ManagedDatabaseReceiptLookup {
    const hold = this.holds.get();
    // The original ran under whatever generation it carried; the request hash covers it.
    const receipt = this.storedReceiptFor(commandId, requestSha256, null);
    if (receipt) return { state: "found", commandId, receipt, hold };
    return { state: this.busy === commandId ? "running" : "unknown", commandId, receipt: null, hold };
  }

  private requireTools(): PgClientTools {
    if (!this.opts.pgTools) reject("unsupported", 501, `this image has no pg_dump/pg_restore ${this.config.engineMajor}`);
    return this.opts.pgTools;
  }

  private async createSnapshot() {
    const tools = this.requireTools();
    const snapshotId = `snap_${new Date(this.now()).toISOString().replace(/[-:.TZ]/g, "")}_${randomBytes(4).toString("hex")}`;
    return createSnapshot({
      access: this.access,
      tools,
      layout: this.layout,
      database: TENANT_DATABASE,
      snapshotId,
      // Maintenance mode never runs the app, so the database has no writers.
      consistency: this.config.mode === "maintenance" && !this.appRunning ? "quiesced" : "online",
      identity: {
        stackId: this.config.stackId,
        volumeId: this.config.volume.id,
        systemIdentifier: this.systemIdentifier ?? "",
        engineVersion: this.opts.engine.version,
        engineMajor: this.config.engineMajor,
      },
      latestApplied: this.schema.latestApplied,
    });
  }

  private async restore(command: Extract<ManagedDatabaseCommand, { kind: "snapshot.restore" }>) {
    const tools = this.requireTools();
    const details = readSnapshotDetails(this.layout, command.args.snapshotId);
    if (!details) reject("not_found", 404, "snapshot not found on this volume; upload it first");
    if (details.stackId !== this.config.stackId) reject("precondition_failed", 409, "snapshot belongs to another stack");
    if (details.engineMajor !== this.config.engineMajor) reject("precondition_failed", 409, "snapshot engine major differs");
    const restoreId = randomBytes(6).toString("hex");
    const result = await restoreSnapshot({
      access: this.access,
      tools,
      layout: this.layout,
      database: TENANT_DATABASE,
      details,
      restoreId,
      commandId: command.commandId,
      beforeSwap: () => {
        if (!this.leases.check(command.lease).ok) throw new Error("lease expired before the restore swap; nothing was changed");
      },
    });
    await this.applyGrants();
    // Clear the hold before the intent: a crash in between reconciles the
    // restore again at boot, never leaving a hold without its cause.
    this.holds.clear();
    rmSync(this.layout.restoreIntentFile, { force: true });
    await this.refreshSchemaState();
    return { snapshotId: details.snapshotId, retainedDatabase: result.retained, verifiedTables: result.verifiedTables, schema: this.schema };
  }

  private async migrate(command: Extract<ManagedDatabaseCommand, { kind: "schema.migrate" }>) {
    if (this.holds.get()) reject("recovery_hold", 409, "a recovery hold is active; restore a snapshot first");
    if (canonicalJson(command.args.release) !== canonicalJson(this.opts.release)) {
      reject("precondition_failed", 409, "requested release does not match this image's bundled migrator");
    }
    const snapshot = readSnapshotDetails(this.layout, command.args.snapshotId);
    if (!snapshot) reject("precondition_failed", 409, "pre-migration snapshot not found on this volume");
    if (snapshot.consistency !== "quiesced") reject("precondition_failed", 409, "pre-migration snapshot must be quiesced");
    if (snapshot.stackId !== this.config.stackId || snapshot.systemIdentifier !== this.systemIdentifier) {
      reject("precondition_failed", 409, "pre-migration snapshot is from another cluster");
    }
    const tenant = supervisorSql(this.access, TENANT_DATABASE);
    let journal;
    try {
      journal = await readJournalFingerprint(tenant, this.schema.latestApplied);
    } finally {
      await tenant.end({ timeout: 2 });
    }
    if (journal.digest !== snapshot.journal.digest) {
      reject("precondition_failed", 409, "pre-migration snapshot was not taken at the current schema");
    }
    if (this.schema.state === "current") return { alreadyCurrent: true, schema: this.schema };
    if (this.schema.state === "ahead") reject("precondition_failed", 409, "database schema is ahead of this image");

    // The checks above awaited; the lease may have expired since the gate.
    if (!this.leases.check(command.lease).ok) reject("lease_stale", 409, "lease expired before the migration started; nothing was changed");
    const before = this.schema;
    this.holds.set({ reason: "migration_interrupted", commandId: command.commandId, detail: null });
    try {
      await applyPendingMigrations(this.ownerUrl());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.holds.set({ reason: "migration_failed", commandId: command.commandId, detail: message.slice(0, 2000) });
      await this.refreshSchemaState().catch(() => {});
      throw error;
    }
    await this.applyGrants();
    const after = await this.refreshSchemaState();
    if (after.state !== "current") {
      this.holds.set({ reason: "migration_failed", commandId: command.commandId, detail: `schema is ${after.state} after migration` });
      throw new Error(`schema is ${after.state} after migration`);
    }
    this.holds.clear();
    return { before, schema: this.schema, release: this.opts.release, snapshotId: snapshot.snapshotId };
  }

  // -------------------------------------------------------------- archives

  private validateArchiveCommand(body: unknown, signature: string | undefined, kind: "snapshot.download" | "snapshot.upload") {
    const validated = this.authenticate(body, signature);
    if (validated.command.kind !== kind) reject("invalid_command", 400, `archive endpoint expects ${kind}`);
    // An upload that already landed answers with its receipt, like a command replay.
    const stored = kind === "snapshot.upload"
      ? this.storedReceiptFor(validated.command.commandId, validated.requestSha256, validated.command.configGeneration)
      : null;
    if (!stored) {
      this.requireFresh(validated.command);
      this.gate(validated.command);
    }
    return { ...validated, body, stored };
  }

  /** GET /archive: opens the archive to stream, or returns a rejection. The caller owns `fd`. */
  openArchiveDownload(headerValue: string | undefined, signature: string | undefined):
    | { ok: true; fd: number; sha256: string; sizeBytes: number }
    | { ok: false; response: CommandResponse } {
    const startedAt = new Date(this.now()).toISOString();
    try {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(headerValue ?? "", "base64url").toString("utf8"));
      } catch {
        reject("invalid_command", 400, "command header is not base64url JSON");
      }
      const { command } = this.validateArchiveCommand(body, signature, "snapshot.download");
      if (command.kind !== "snapshot.download") throw new Error("unreachable");
      const details = readSnapshotDetails(this.layout, command.args.snapshotId);
      if (!details) reject("not_found", 404, "snapshot not found");
      let fd: number;
      try {
        fd = openSync(snapshotPaths(this.layout, command.args.snapshotId).archive, "r");
      } catch {
        reject("not_found", 404, "snapshot not found");
      }
      return { ok: true, fd, sha256: details.sha256, sizeBytes: fstatSync(fd).size };
    } catch (error) {
      if (error instanceof CommandRejection) return { ok: false, response: this.rejection(null, error, startedAt) };
      throw error;
    }
  }

  /** PUT /archive: stores an archive whose receipt this stack's key signed. `commandBody` is the parsed preamble. */
  async handleArchiveUpload(commandBody: unknown, signature: string | undefined, stream: Readable): Promise<CommandResponse> {
    const startedAt = new Date(this.now()).toISOString();
    let validated: ReturnType<ManagedDatabaseSupervisor["validateArchiveCommand"]>;
    try {
      validated = this.validateArchiveCommand(commandBody, signature, "snapshot.upload");
    } catch (error) {
      if (!(error instanceof CommandRejection)) {
        ignoreUploadErrors(stream);
        throw error;
      }
      const response = this.rejection(null, error, startedAt);
      // An unauthenticated caller gets no further read. A signed caller's
      // body is drained so it reliably receives its rejection.
      if (error.code === "bad_signature" || error.code === "invalid_command") return refuseUpload(stream, response);
      discardUpload(stream);
      return response;
    }
    const { command, requestSha256, body, stored } = validated;
    if (command.kind !== "snapshot.upload") throw new Error("unreachable");
    if (stored) {
      discardUpload(stream);
      return { status: stored.outcome === "succeeded" ? 200 : 500, body: stored };
    }
    this.busy = command.commandId;
    let partial: string | null = null;
    try {
      const receipt = verifyManagedDatabaseReceipt(this.opts.controlKey, command.args.receipt);
      if (!receipt || receipt.kind !== "snapshot.create" || receipt.outcome !== "succeeded") {
        reject("precondition_failed", 409, "upload requires a signed, successful snapshot.create receipt from this stack");
      }
      const parsedDetails = managedDatabaseSnapshotReceiptDetailsSchema.safeParse((receipt.details as { snapshot?: unknown }).snapshot);
      if (!parsedDetails.success) reject("precondition_failed", 409, "receipt has no snapshot details");
      const details = parsedDetails.data;
      if (receipt.stackId !== this.config.stackId || details.stackId !== this.config.stackId) {
        reject("precondition_failed", 409, "archive belongs to another stack");
      }
      if (details.engineMajor !== this.config.engineMajor) reject("precondition_failed", 409, "archive engine major differs");
      const paths = snapshotPaths(this.layout, details.snapshotId);
      if (existsSync(paths.archive)) {
        discardUpload(stream);
        if ((await sha256File(paths.archive)) !== details.sha256) reject("precondition_failed", 409, "a different archive with this id exists");
        // The signed receipt is authoritative; restore missing metadata.
        if (!readSnapshotDetails(this.layout, details.snapshotId)) writeJsonAtomic(paths.metadata, details);
      } else {
        partial = `${paths.archive}.upload-${randomBytes(4).toString("hex")}`;
        const hash = createHash("sha256");
        stream.on("data", (chunk: Buffer) => hash.update(chunk));
        await pipeline(stream, limitUploadBytes(details.sizeBytes), createWriteStream(partial, { mode: 0o600 }));
        const actual = hash.digest("hex");
        if (actual !== details.sha256) reject("precondition_failed", 409, `uploaded archive sha256 ${actual} does not match receipt`);
        fsyncFile(partial);
        publishSnapshot(this.layout, paths, details, partial);
        partial = null;
      }
      const response = this.sign(receiptMeta(command), requestSha256, startedAt, "succeeded", { snapshotId: details.snapshotId, sha256: details.sha256 }, null);
      this.receipts.put(response);
      return { status: 200, body: response };
    } catch (error) {
      const response: CommandResponse = error instanceof CommandRejection
        ? this.rejection(body, error, startedAt)
        : {
          status: 500,
          body: this.sign(receiptMeta(command), requestSha256, startedAt, "failed", {}, {
            code: "operation_failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        };
      // A body cut off mid-stream (too large, or a write failure) cannot be
      // drained; drop the connection instead of reading the rest.
      if (stream.destroyed) return refuseUpload(stream, response);
      discardUpload(stream);
      return response;
    } finally {
      if (partial) rmSync(partial, { force: true });
      this.busy = null;
    }
  }

  publicHealth(): { status: ManagedDatabaseReadiness["status"] } {
    return { status: this.status };
  }
}

/** Remove stale snapshot partials, and metadata whose archive never landed. */
export function cleanupPartialSnapshots(layout: ManagedDatabaseLayout): void {
  if (!existsSync(layout.snapshotsDir)) return;
  const names = readdirSync(layout.snapshotsDir);
  for (const name of names) {
    const orphanMetadata = name.endsWith(".json") && !names.includes(`${name.slice(0, -5)}.dump`);
    const leftover = name.includes(".partial") || name.includes(".upload-") || name.endsWith(".tmp");
    if (leftover || orphanMetadata) rmSync(`${layout.snapshotsDir}/${name}`, { force: true });
  }
}

export type { ManagedDatabaseHold };
