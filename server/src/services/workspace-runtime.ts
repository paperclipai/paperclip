import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterRuntimeServiceReport } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issueComments, issues, projectWorkspaces, workspaceRuntimeServices } from "@paperclipai/db";
import {
  DEFAULT_TAILSCALE_HTTPS_EXPOSURE,
  deriveViteHmrPort,
  forceLoopbackBindInCommand,
  isRuntimeExposureAppPort,
  listWorkspaceServiceCommandDefinitions,
  RUNTIME_EXPOSURE_BIND_HOST,
  RUNTIME_EXPOSURE_BIND_MODE,
  rewriteUrlHostToLoopback,
  readRuntimeExposureIntent,
  resolveDeclaredRuntimeExposureConfig,
  type RuntimeExposureConfigInput,
  type RuntimeExposureIntent,
  type RuntimeExposureStatus,
  type GitWorktreeBranchAncestryVerdict,
  type GitWorktreeBranchIncoherenceEvidence as SharedGitWorktreeBranchIncoherenceEvidence,
  type GitWorktreeInProgressOperation,
  type IssueCommentMetadata,
  type IssueCommentPresentation,
  type WorkspaceOperationPhase,
  type WorkspaceRuntimeDesiredState,
  type WorkspaceRuntimeServiceStateMap,
} from "@paperclipai/shared";
import { and, desc, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { asNumber, asString, parseObject, renderTemplate } from "../adapters/utils.js";
import { conflict } from "../errors.js";
import { resolveHomeAwarePath } from "../home-paths.js";
import { hasVerifiedWorktreeSeedManifest, isVerifiedWorktreeSeedManifest } from "../worktree-seed-manifest.js";
import {
  buildManagedWorkspaceGuestEnv,
  logManagedWorkspaceReadinessRejection,
  probeManagedWorkspaceHandoffSubjects,
  probeManagedWorkspaceReadiness,
  resolveManagedWorkspaceIdentity,
  shouldBlockPublicationOnReadiness,
  waitForManagedWorkspaceReadiness,
} from "./managed-workspace-identity.js";
import {
  createLocalServiceKey,
  findLocalServiceRegistryRecordByRuntimeServiceId,
  findAdoptableLocalService,
  isLocalServiceProcessOwnedBy,
  isLocalServiceProcessInWorkspace,
  openLocalServiceLogFile,
  readLocalServiceProcessCwd,
  readLocalServiceProcessGroupId,
  readLocalServicePortOwner,
  removeLocalServiceRegistryRecord,
  terminateLocalService,
  touchLocalServiceRegistryRecord,
  writeLocalServiceRegistryRecord,
} from "./local-service-supervisor.js";
import { workspaceOperationService, type WorkspaceOperationRecorder } from "./workspace-operations.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { logActivity } from "./activity-log.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { workspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";
import {
  cleanupWorktreeInstanceArtifacts,
  deriveWorktreeInstanceId,
  readWorktreeInstancePointer,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
  type WorktreeInstancePointer,
} from "./workspace-instance-cleanup.js";
import { UnixBrokerClient, type BrokerClient } from "./runtime-exposure/broker-client.js";
import {
  deprovisionExposure,
  provisionExposure,
  reserveExposure,
  type ExposureManagerDeps,
} from "./runtime-exposure/exposure-manager.js";
import { diagnoseRuntimeListenerBinds, readListenerBindFacts } from "./runtime-exposure/loopback-listener.js";
import { allocateExposurePortPair } from "./runtime-exposure/port-pair.js";
import {
  buildExposureReservationLedger,
  collectRowExposurePorts,
  describeExposureReservationDrift,
  ExposurePortOwnershipConflictError,
  ExposurePortPairClaims,
  findExposurePairConflict,
  findExposureReservationDrift,
  isExposureAdoptionPermitted,
  type BrokerMappingSnapshot,
  type ExposureOwnerIdentity,
  type ExposureReservationLedger,
  type InMemoryExposureSnapshot,
  type PersistedExposureRowSnapshot,
} from "./runtime-exposure/port-reservation.js";
import { resolveTailscaleDnsName } from "./runtime-exposure/tailscale-hostname.js";

export function resolveShell(): string {
  const fallback = process.platform === "win32" ? "sh" : "/bin/sh";
  const shell = process.env.SHELL?.trim();
  if (!shell) return fallback;
  if (path.isAbsolute(shell) && !existsSync(shell)) return fallback;
  return shell;
}

/**
 * A read-only referenced (mentioned) project workspace carried alongside the anchor. Additive and
 * backward-compatible: it defaults to an empty array. Additional workspaces never get git-worktree
 * realization; the anchor keeps the single scalar realization path.
 */
export interface ExecutionWorkspaceAdditionalInput {
  cwd: string;
  projectId: string;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
}

export interface ExecutionWorkspaceInput {
  baseCwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  additionalWorkspaces?: ExecutionWorkspaceAdditionalInput[];
}

/**
 * A prepared credential-bearing git invocation for one remote URL, or null to keep ambient
 * behavior. Structurally compatible with the provider built by `git-credentials.ts` — this
 * module deliberately takes prepared invocations rather than tokens, so it never imports the
 * secrets layer and test fakes stay trivial.
 */
export type GitRemoteAuthInvocation = {
  configArgs: string[];
  env: Record<string, string>;
  source?: string;
  secretName?: string | null;
};

export type GitRemoteAuthProvider = (remoteUrl: string) => Promise<GitRemoteAuthInvocation | null>;

export interface ExecutionWorkspaceIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  workMode?: string | null;
}

export interface ExecutionWorkspaceAgentRef {
  id: string | null;
  name: string;
  companyId: string;
}

export interface RealizedExecutionWorkspace extends ExecutionWorkspaceInput {
  strategy: "project_primary" | "git_worktree";
  cwd: string;
  branchName: string | null;
  worktreePath: string | null;
  warnings: string[];
  created: boolean;
  baseRefSha?: string | null;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
}

export class WorkspaceRuntimeValidationFailure extends Error {
  code = "workspace_validation_failed" as const;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceRuntimeValidationFailure";
    this.resultJson = resultJson;
  }
}

export interface RuntimeServiceRef {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  serviceName: string;
  status: "provisioning" | "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: string;
  startedAt: string;
  stoppedAt: string | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  exposure: RuntimeExposureStatus | null;
  reused: boolean;
}

interface RuntimeServiceRecord extends RuntimeServiceRef {
  db?: Db;
  child: ChildProcess | null;
  leaseRunIds: Set<string>;
  idleTimer: ReturnType<typeof globalThis.setTimeout> | null;
  envFingerprint: string;
  serviceKey: string;
  profileKind: string;
  processGroupId: number | null;
  /** Server-private broker lease handle; never returned by toRuntimeServiceRef. */
  exposureHandle: string | null;
  /** Loopback URL used for backend readiness/adoption; never serialized. */
  backendUrl: string | null;
  exposureConfig: RuntimeExposureConfigInput | null;
}

type LocalRuntimeServiceStart = {
  record: RuntimeServiceRecord;
  readiness: Promise<void>;
};

type PendingRuntimeServiceReadiness = LocalRuntimeServiceStart & {
  service: Record<string, unknown>;
};

type StoppedRuntimeServiceReuseCandidate = {
  id: string;
  port: number | null;
};

const runtimeServicesById = new Map<string, RuntimeServiceRecord>();
const runtimeServicesByReuseKey = new Map<string, string>();
const runtimeServiceLeasesByRun = new Map<string, string[]>();
const runtimeProvisionByWorkspace = new Map<string, Promise<void>>();
const runtimeControlStartByOwner = new Map<string, Promise<void>>();
const runtimeReplacementClaimsByReuseKey = new Map<string, number>();
const quarantinedRuntimeExposurePorts = new Set<number>();
/**
 * Pair-atomic in-process claims for exposure allocations that have not bound a
 * listener yet. Separate from `inFlightAllocatedPorts` (single ports, non-exposed
 * runtimes) because an exposure claim must cover the app port and its HMR
 * companion together or not at all.
 */
const exposurePortPairClaims = new ExposurePortPairClaims();
/**
 * Execution-workspace statuses that still hold an exclusive lease. `archived`
 * is the only terminal state; everything else — including `idle` — is a lane an
 * operator or agent can still return to, so its port pair stays reserved.
 */
const OPEN_EXECUTION_WORKSPACE_LEASE_STATUSES = ["active", "idle", "in_review"] as const;
const DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES = 256 * 1024;
export const WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS = 32;
const ACTIVE_RUNTIME_PORT_RESERVATION_STATUSES = ["provisioning", "starting", "running"] as const;
const DEFAULT_TAILSCALE_BROKER_SOCKET = "/run/paperclip-tailscale-broker/broker.sock";

class RuntimeServicePortBindCollision extends Error {
  readonly port: number;
  /**
   * Who held the port when the collision was seen, captured at failure time.
   * Null when no owner remained (a transient racer that already released it).
   */
  readonly diagnosis: string | null;

  /**
   * True when the port is only a preference and the caller may re-allocate a
   * different one. Exposed runtimes always draw from the dedicated broker range,
   * so a collision on the assigned port is recoverable by taking the next pair.
   */
  readonly exposureReallocatable: boolean;

  constructor(port: number, diagnosis: string | null = null, exposureReallocatable = false) {
    super(
      `Runtime service could not bind allocated port ${port}` +
        (diagnosis ? ` (${diagnosis})` : ""),
    );
    this.name = "RuntimeServicePortBindCollision";
    this.port = port;
    this.diagnosis = diagnosis;
    this.exposureReallocatable = exposureReallocatable;
  }
}

export type WorkspaceRuntimeExposureDeps = ExposureManagerDeps & {
  resolveHostname: () => Promise<string>;
  isPortAvailable: (port: number) => Promise<boolean>;
  /**
   * Whether this host can actually broker HTTPS exposures right now. Gating the
   * automatic default on broker availability is what keeps a Paperclip install
   * without the host broker from failing every managed runtime start closed.
   * An explicit opt-in still bypasses this and fails loudly.
   */
  isBrokerAvailable: () => Promise<boolean>;
};

async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function resolveTailscaleBrokerSocketPath(): string {
  return process.env.PAPERCLIP_TAILSCALE_BROKER_SOCKET?.trim() || DEFAULT_TAILSCALE_BROKER_SOCKET;
}

function defaultWorkspaceRuntimeExposureDeps(): WorkspaceRuntimeExposureDeps {
  const socketPath = resolveTailscaleBrokerSocketPath();
  const broker: BrokerClient = new UnixBrokerClient({ socketPath });
  return {
    broker,
    resolveHostname: () => resolveTailscaleDnsName(),
    isPortAvailable: isLoopbackPortAvailable,
    isBrokerAvailable: async () => {
      try {
        // Presence of the socket, not a probe request: availability is checked
        // on every managed start, and an unauthenticated connect storm against
        // the broker would be its own problem.
        const stats = await fs.stat(socketPath);
        return stats.isSocket();
      } catch {
        return false;
      }
    },
    probeHealth: async (url) => {
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    now: () => new Date().toISOString(),
    diagnoseListenerBinds: diagnoseRuntimeListenerBinds,
  };
}

let workspaceRuntimeExposureDeps = defaultWorkspaceRuntimeExposureDeps();

/** Test-only seam; resetRuntimeServicesForTests restores production defaults. */
export function setWorkspaceRuntimeExposureDepsForTests(deps: WorkspaceRuntimeExposureDeps) {
  workspaceRuntimeExposureDeps = deps;
}

/**
 * Deployment-level switch for the automatic default (PAP-17158).
 *
 *  - `auto` (default): eligible Paperclip-managed worktree runtimes get
 *    `tailscale_https` without any project template or UI caller supplying an
 *    exposure block, provided the host broker is available.
 *  - `off`: no automatic default. Explicit opt-ins still work.
 *  - `force`: default even when the broker socket is missing, so a
 *    misconfigured host fails closed and loudly instead of silently serving
 *    plain HTTP. Intended for deployments that require HTTPS previews.
 */
export type ManagedRuntimeHttpsMode = "auto" | "off" | "force";

export function resolveManagedRuntimeHttpsMode(): ManagedRuntimeHttpsMode {
  const raw = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "force") return "force";
  return "auto";
}

/**
 * Whether a service would be defaulted to HTTPS if it declared nothing.
 *
 * Intentionally narrow: only the Paperclip-managed dev runtime. Unmanaged and
 * custom external services are left exactly as they are, because the broker
 * only publishes allowlisted loopback ports it can prove Paperclip owns and we
 * do not want to relocate a service somebody else addresses by port.
 *
 * A *pinned* port is still a candidate. The pre-feature Paperclip App template
 * hard-codes `port: 45439`, which the broker's dedicated allowlist can never
 * publish, so defaulting it to HTTPS necessarily relocates it into the
 * dedicated range. "Keep existing runtime ports when safe" is honored one layer
 * down, by preferring the current port when it already *is* an allowlisted app
 * port with a free HMR companion.
 */
function isManagedHttpsDefaultCandidate(input: {
  serviceName: string;
  command: string | null;
}): boolean {
  return isPaperclipDevRuntimeService(input);
}

export type ResolvedRuntimeServiceExposure = {
  config: RuntimeExposureConfigInput;
  /**
   * `declared` — the project template or UI caller asked for HTTPS.
   * `default` — the server applied the automatic default (PAP-17158).
   *
   * The distinction matters for port handling: a declared opt-in on a pinned
   * port is an operator misconfiguration and fails loudly, while the automatic
   * default is allowed to relocate a legacy pinned port into the dedicated
   * exposure range.
   */
  origin: "declared" | "default";
};

/**
 * Resolve the exposure config for one runtime service start.
 *
 * Precedence: deliberate opt-out → explicit opt-in → automatic default for
 * eligible managed runtimes → none.
 */
async function resolveRuntimeServiceExposure(input: {
  service: Record<string, unknown>;
  serviceName: string;
  command: string | null;
}): Promise<ResolvedRuntimeServiceExposure | null> {
  const expose = parseObject(input.service.expose);
  const intent = readRuntimeExposureIntent(expose);
  if (intent === "disabled") return null;
  // An explicit opt-in is honored verbatim and is never gated on broker
  // availability: the operator asked for HTTPS, so a missing broker must fail
  // the start rather than silently downgrade it to HTTP.
  if (intent === "enabled") {
    const declared = resolveDeclaredRuntimeExposureConfig(expose);
    return declared ? { config: declared, origin: "declared" } : null;
  }

  const mode = resolveManagedRuntimeHttpsMode();
  if (mode === "off") return null;
  if (!isManagedHttpsDefaultCandidate({ serviceName: input.serviceName, command: input.command })) {
    return null;
  }
  if (mode !== "force" && !(await workspaceRuntimeExposureDeps.isBrokerAvailable())) return null;
  return { config: DEFAULT_TAILSCALE_HTTPS_EXPOSURE, origin: "default" };
}

/**
 * Whether any entry in a start batch will take the HTTPS exposure path.
 *
 * Reads the service name and command straight off the raw config entry rather
 * than resolving the full reuse identity: templates never rewrite a service
 * name, and the substrings `isPaperclipDevRuntimeService` matches survive
 * rendering, so this agrees with the per-service decision made during spawn.
 */
async function anyRuntimeServiceUsesHttpsExposure(
  services: Record<string, unknown>[],
): Promise<boolean> {
  for (const service of services) {
    const resolved = await resolveRuntimeServiceExposure({
      service,
      serviceName: asString(service.name, "service"),
      command: asString(service.command, ""),
    });
    if (resolved) return true;
  }
  return false;
}

type ProcessOutputCapture = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

type ProcessOutputAccumulator = {
  append(chunk: string): void;
  finish(): ProcessOutputCapture;
};

/**
 * Drops in-memory runtime state between tests.
 *
 * By default the spawned backend processes are deliberately left running: the
 * startup-reconciliation suites use this to simulate a Paperclip restart, where
 * the point is that a live backend survives and has to be adopted.
 *
 * Suites that spawn real backends and do *not* need that must pass
 * `terminateProcesses` — otherwise every test leaks a listener that keeps
 * squatting a port in the dedicated exposure range for the life of the host.
 * Termination runs before the exposure deps are restored so the suite's own
 * broker fake handles the removal rather than the real host broker.
 */
export async function resetRuntimeServicesForTests(
  opts: { terminateProcesses?: boolean; simulateSupervisorExit?: boolean } = {},
) {
  if (opts.terminateProcesses) {
    for (const serviceId of [...runtimeServicesById.keys()]) {
      await stopRuntimeService(serviceId).catch(() => undefined);
    }
  }
  for (const record of runtimeServicesById.values()) {
    clearIdleTimer(record);
    if (opts.simulateSupervisorExit) {
      // A real supervisor exit closes its side of every inherited pipe. Tests
      // use this to prove surviving request-logging services do not depend on
      // Paperclip keeping an anonymous stdio peer alive.
      record.child?.stdout?.destroy();
      record.child?.stderr?.destroy();
    }
  }
  runtimeServicesById.clear();
  runtimeServicesByReuseKey.clear();
  runtimeServiceLeasesByRun.clear();
  runtimeProvisionByWorkspace.clear();
  runtimeControlStartByOwner.clear();
  runtimeReplacementClaimsByReuseKey.clear();
  quarantinedRuntimeExposurePorts.clear();
  exposurePortPairClaims.clear();
  workspaceRuntimeExposureDeps = defaultWorkspaceRuntimeExposureDeps();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type WorkspaceLinkMismatch = {
  packageName: string;
  expectedPath: string;
  actualPath: string | null;
};

function readJsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function findWorkspaceRoot(startCwd: string) {
  let current = path.resolve(startCwd);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isLinkedGitWorktreeCheckout(rootDir: string) {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

function discoverWorkspacePackagePaths(rootDir: string): Map<string, string> {
  const packagePaths = new Map<string, string>();
  const ignoredDirNames = new Set([".git", ".paperclip", "dist", "node_modules"]);

  function visit(dirPath: string) {
    if (!existsSync(dirPath)) return;

    const packageJsonPath = path.join(dirPath, "package.json");
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonFile(packageJsonPath);
      if (typeof packageJson.name === "string" && packageJson.name.length > 0) {
        packagePaths.set(packageJson.name, dirPath);
      }
    }

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (ignoredDirNames.has(entry.name)) continue;
      visit(path.join(dirPath, entry.name));
    }
  }

  visit(path.join(rootDir, "packages"));
  visit(path.join(rootDir, "server"));
  visit(path.join(rootDir, "ui"));
  visit(path.join(rootDir, "cli"));

  return packagePaths;
}

function findServerWorkspaceLinkMismatches(rootDir: string): WorkspaceLinkMismatch[] {
  const serverPackageJsonPath = path.join(rootDir, "server", "package.json");
  if (!existsSync(serverPackageJsonPath)) return [];

  const serverPackageJson = readJsonFile(serverPackageJsonPath);
  const dependencies = {
    ...(serverPackageJson.dependencies as Record<string, unknown> | undefined),
    ...(serverPackageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const workspacePackagePaths = discoverWorkspacePackagePaths(rootDir);
  const mismatches: WorkspaceLinkMismatch[] = [];

  for (const [packageName, version] of Object.entries(dependencies)) {
    if (typeof version !== "string" || !version.startsWith("workspace:")) continue;

    const expectedPath = workspacePackagePaths.get(packageName);
    if (!expectedPath) continue;
    const normalizedExpectedPath = existsSync(expectedPath) ? path.resolve(realpathSync(expectedPath)) : path.resolve(expectedPath);

    const linkPath = path.join(rootDir, "server", "node_modules", ...packageName.split("/"));
    const actualPath = existsSync(linkPath) ? path.resolve(realpathSync(linkPath)) : null;
    if (actualPath === normalizedExpectedPath) continue;

    mismatches.push({
      packageName,
      expectedPath: normalizedExpectedPath,
      actualPath,
    });
  }

  return mismatches;
}

export async function ensureServerWorkspaceLinksCurrent(
  startCwd: string,
  opts?: {
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  const workspaceRoot = findWorkspaceRoot(startCwd);
  if (!workspaceRoot) return;
  if (!isLinkedGitWorktreeCheckout(workspaceRoot)) return;

  const mismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (mismatches.length === 0) return;

  if (opts?.onLog) {
    await opts.onLog("stdout", "[runtime] detected stale workspace package links for server; relinking dependencies...\n");
    for (const mismatch of mismatches) {
      await opts.onLog(
        "stdout",
        `[runtime]   ${mismatch.packageName}: ${mismatch.actualPath ?? "missing"} -> ${mismatch.expectedPath}\n`,
      );
    }
  }

  for (const mismatch of mismatches) {
    const linkPath = path.join(workspaceRoot, "server", "node_modules", ...mismatch.packageName.split("/"));
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.rm(linkPath, { recursive: true, force: true });
    await fs.symlink(mismatch.expectedPath, linkPath);
  }

  const remainingMismatches = findServerWorkspaceLinkMismatches(workspaceRoot);
  if (remainingMismatches.length === 0) return;

  throw new Error(
    `Workspace relink did not repair all server package links: ${remainingMismatches.map((item) => item.packageName).join(", ")}`,
  );
}

export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}

function stableRuntimeServiceId(input: {
  adapterType: string;
  runId: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
  serviceName: string;
  reportId: string | null;
  providerRef: string | null;
  reuseKey: string | null;
}) {
  if (input.reportId) return input.reportId;
  const digest = createHash("sha256")
    .update(
      stableStringify({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        serviceName: input.serviceName,
        providerRef: input.providerRef,
        reuseKey: input.reuseKey,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${input.adapterType}-${digest}`;
}

function toRuntimeServiceRef(record: RuntimeServiceRecord, overrides?: Partial<RuntimeServiceRef>): RuntimeServiceRef {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: record.lastUsedAt,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopPolicy: record.stopPolicy,
    exposure: record.exposure,
    healthStatus: record.healthStatus,
    reused: record.reused,
    ...overrides,
  };
}

function sanitizeSlugPart(value: string | null | undefined, fallback: string): string {
  const raw = (value ?? "").trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function renderWorkspaceTemplate(template: string, input: {
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  projectId: string | null;
  repoRef: string | null;
}) {
  const issueIdentifier = input.issue?.identifier ?? input.issue?.id ?? "issue";
  const slug = sanitizeSlugPart(input.issue?.title, sanitizeSlugPart(issueIdentifier, "issue"));
  return renderTemplate(template, {
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    project: {
      id: input.projectId ?? "",
    },
    workspace: {
      repoRef: input.repoRef ?? "",
    },
    slug,
  });
}

function sanitizeBranchName(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 120) || "paperclip-work";
}

function isAbsolutePath(value: string) {
  return path.isAbsolute(value) || value.startsWith("~");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (isAbsolutePath(value)) {
    return resolveHomeAwarePath(value);
  }
  return path.resolve(baseDir, value);
}

function formatCommandForDisplay(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function trimToLastBytes(value: string, limit: number) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= limit) return value;
  return Buffer.from(value, "utf8").subarray(byteLength - limit).toString("utf8");
}

function createProcessOutputCapture(maxBytes: number): ProcessOutputAccumulator {
  const limit = Math.max(1, Math.trunc(maxBytes));
  let text = "";
  let truncated = false;
  let totalBytes = 0;

  return {
    append(chunk: string) {
      if (!chunk) return;
      totalBytes += Buffer.byteLength(chunk, "utf8");

      const combined = text + chunk;
      if (Buffer.byteLength(combined, "utf8") <= limit) {
        text = combined;
        return;
      }

      text = trimToLastBytes(combined, limit);
      truncated = true;
    },
    finish(): ProcessOutputCapture {
      if (!truncated) {
        return {
          text,
          truncated: false,
          totalBytes,
        };
      }
      return {
        text: `[output truncated to last ${limit} bytes; total ${totalBytes} bytes]\n${text}`,
        truncated: true,
        totalBytes,
      };
    },
  };
}

async function executeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}> {
  const proc = await new Promise<{
    stdout: ProcessOutputAccumulator;
    stderr: ProcessOutputAccumulator;
    code: number | null;
  }>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: input.env ?? process.env,
    });
    const stdout = createProcessOutputCapture(input.maxStdoutBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    const stderr = createProcessOutputCapture(input.maxStderrBytes ?? DEFAULT_EXECUTE_PROCESS_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout.append(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr.append(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
  const stdout = proc.stdout.finish();
  const stderr = proc.stderr.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: proc.code,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutBytes: stdout.totalBytes,
    stderrBytes: stderr.totalBytes,
  };
}

async function runGit(args: string[], cwd: string, opts?: { env?: NodeJS.ProcessEnv }): Promise<string> {
  const proc = await executeProcess({
    command: "git",
    args,
    cwd,
    env: opts?.env,
  });
  if (proc.code !== 0) {
    throw new Error(proc.stderr.trim() || proc.stdout.trim() || `git ${args.join(" ")} failed`);
  }
  return proc.stdout.trim();
}

async function runExpensiveGitStatus(input: {
  args: readonly string[];
  cwd: string;
  operation: string;
  fairnessKeys?: readonly string[];
}): Promise<string> {
  const result = await workspaceGitOperationScheduler.run({
    workspacePath: input.cwd,
    args: input.args,
    operation: input.operation,
    fairnessKeys: input.fairnessKeys,
    cacheTtlMs: 0,
  });
  return result.stdout.trim();
}

function formatShortSha(value: string | null | undefined) {
  return value ? value.slice(0, 12) : "unknown";
}

function gitErrorIncludes(error: unknown, needle: string) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(needle.toLowerCase());
}

function parseRemoteTrackingRef(ref: string): { remote: string; branch: string } | null {
  const trimmed = ref.trim();
  const refsRemotesPrefix = "refs/remotes/";
  const normalized = trimmed.startsWith(refsRemotesPrefix)
    ? trimmed.slice(refsRemotesPrefix.length)
    : trimmed;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) return null;
  const remote = normalized.slice(0, slashIndex);
  const branch = normalized.slice(slashIndex + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) return null;
  return { remote, branch };
}

export async function refreshRemoteTrackingBaseRef(
  repoRoot: string,
  baseRef: string,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<string[]> {
  const remoteTracking = parseRemoteTrackingRef(baseRef);
  if (!remoteTracking) return [];

  const remoteUrl = await runGit(["remote", "get-url", remoteTracking.remote], repoRoot)
    .then((value) => value.trim() || null)
    .catch(() => null);
  if (!remoteUrl) return [];

  const auth = resolveGitAuth ? await resolveGitAuth(remoteUrl).catch(() => null) : null;
  try {
    await runGit([
      ...(auth?.configArgs ?? []),
      "fetch",
      "--prune",
      remoteTracking.remote,
      `+refs/heads/${remoteTracking.branch}:refs/remotes/${remoteTracking.remote}/${remoteTracking.branch}`,
    ], repoRoot, auth ? { env: { ...process.env, ...auth.env } } : undefined);
    return [];
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Mask URL userinfo (any scheme) and whole URL query strings before the message rides
    // warnings that reach run logs.
    const message = rawMessage
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1***@")
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?]*)\?[^\s"']*/gi, "$1?***");
    const authNote = auth
      ? ` The fetch authenticated with ${auth.secretName ? `the ${auth.secretName} company-secret GitHub credential` : "the server-environment GitHub credential"}, which may have been rejected.`
      : "";
    return [`Could not refresh base ref ${baseRef} before preparing the execution workspace: ${message}${authNote}`];
  }
}

async function resolveBaseRefSha(repoRoot: string, baseRef: string): Promise<string | null> {
  return await runGit(["rev-parse", "--verify", `${baseRef}^{commit}`], repoRoot).catch(() => null);
}

function readRecordedBaseRefSha(metadata: Record<string, unknown> | null | undefined): string | null {
  const snapshot = parseObject(metadata?.baseRefSnapshot);
  const resolvedSha = snapshot.resolvedSha;
  return typeof resolvedSha === "string" && resolvedSha.trim().length > 0 ? resolvedSha.trim() : null;
}

export async function inspectExecutionWorkspaceBaseDrift(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string | null;
  recordedBaseRefSha?: string | null;
  skipRefresh?: boolean;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<{
  warnings: string[];
  currentBaseRefSha: string | null;
  branchBaseRefSha: string | null;
}> {
  const baseRef = input.baseRef?.trim();
  if (!baseRef) {
    return { warnings: [], currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const warnings = input.skipRefresh
    ? []
    : await refreshRemoteTrackingBaseRef(input.repoRoot, baseRef, input.resolveGitAuth);
  const currentBaseRefSha = await resolveBaseRefSha(input.repoRoot, baseRef);
  if (!currentBaseRefSha) {
    warnings.push(`Could not resolve base ref ${baseRef} while checking execution workspace freshness.`);
    return { warnings, currentBaseRefSha: null, branchBaseRefSha: null };
  }

  const branchBaseRefSha = await runGit(["merge-base", "HEAD", baseRef], input.worktreePath).catch(() => null);
  if (!branchBaseRefSha) {
    warnings.push(`Could not compare execution workspace ${input.branchName ?? "branch"} against base ref ${baseRef}.`);
    return { warnings, currentBaseRefSha, branchBaseRefSha: null };
  }

  if (branchBaseRefSha !== currentBaseRefSha) {
    const behindCountRaw = await runGit(["rev-list", "--count", `HEAD..${baseRef}`], input.worktreePath).catch(() => "");
    const behindCount = Number.parseInt(behindCountRaw, 10);
    const behindText = Number.isFinite(behindCount) && behindCount > 0
      ? `${behindCount} commit${behindCount === 1 ? "" : "s"}`
      : "newer commits";
    const recordedText = input.recordedBaseRefSha
      ? `recorded base ${formatShortSha(input.recordedBaseRefSha)}`
      : `merge-base ${formatShortSha(branchBaseRefSha)}`;
    warnings.push(
      `Execution workspace branch ${input.branchName ? `"${input.branchName}"` : "HEAD"} is behind ${baseRef} by ${behindText}: ${recordedText}, current base ${formatShortSha(currentBaseRefSha)}. Refresh or rebase the workspace before relying on recent base-branch fixes.`,
    );
  }

  return { warnings, currentBaseRefSha, branchBaseRefSha };
}

async function localBranchExists(repoRoot: string, branch: string): Promise<boolean> {
  return runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)
    .then(() => true)
    .catch(() => false);
}

async function remoteExists(repoRoot: string, remote: string): Promise<boolean> {
  return runGit(["remote", "get-url", remote], repoRoot)
    .then(() => true)
    .catch(() => false);
}

const GIT_WORKTREE_BRANCH_INCOHERENCE_REASON = "git_worktree_branch_incoherence";

type GitWorktreeCleanliness = SharedGitWorktreeBranchIncoherenceEvidence["cleanliness"];

type GitWorktreeBranchIncoherenceEvidence = SharedGitWorktreeBranchIncoherenceEvidence;

type GitWorktreeBranchContention = NonNullable<GitWorktreeBranchIncoherenceEvidence["contention"]>;

type GitWorktreeBranchCoherenceResult = {
  branchName: string | null;
  reconciledForward: boolean;
  pendingForwardBranchReconcile?: PendingForwardBranchReconcile | null;
  dirtyQuarantineRepair?: DirtyQuarantineRepairResult | null;
  warnings: string[];
};

type DirtyQuarantineRepairResult = {
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  clearedInProgressOperation: GitWorktreeInProgressOperation | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
};

export type PendingForwardBranchReconcile = {
  recordedBranchName: string;
  adoptedBranchName: string;
  prePersistenceFingerprint: string;
  reason: string;
};

function formatBranchForMessage(branch: string | null | undefined) {
  return branch && branch.length > 0 ? branch : "<detached>";
}

const GIT_IN_PROGRESS_OPERATION_MARKERS: ReadonlyArray<{
  operation: GitWorktreeInProgressOperation;
  marker: string;
}> = [
  { operation: "rebase", marker: "rebase-merge" },
  { operation: "rebase", marker: "rebase-apply" },
  { operation: "merge", marker: "MERGE_HEAD" },
  { operation: "cherry_pick", marker: "CHERRY_PICK_HEAD" },
  { operation: "revert", marker: "REVERT_HEAD" },
  { operation: "bisect", marker: "BISECT_LOG" },
];

const GIT_IN_PROGRESS_OPERATION_LABELS: Record<GitWorktreeInProgressOperation, string> = {
  rebase: "rebase",
  merge: "merge",
  cherry_pick: "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

// `--quit` clears the interrupted operation's state directory without touching
// the working tree or moving HEAD, unlike `--abort` which resets both.
const GIT_IN_PROGRESS_OPERATION_QUIT_ARGS: Record<GitWorktreeInProgressOperation, string[]> = {
  rebase: ["rebase", "--quit"],
  merge: ["merge", "--quit"],
  cherry_pick: ["cherry-pick", "--quit"],
  revert: ["revert", "--quit"],
  bisect: ["bisect", "reset", "HEAD"],
};

async function detectGitWorktreeInProgressOperation(
  worktreePath: string,
): Promise<GitWorktreeInProgressOperation | null> {
  for (const { operation, marker } of GIT_IN_PROGRESS_OPERATION_MARKERS) {
    const markerPath = await runGit(["rev-parse", "--git-path", marker], worktreePath).catch(() => null);
    if (!markerPath) continue;
    if (existsSync(path.resolve(worktreePath, markerPath))) return operation;
  }
  return null;
}

const DIRTY_PATH_SAMPLE_LIMIT = 5;

function parseGitPorcelainPath(line: string) {
  const raw = line.trimEnd();
  if (raw.trim().length <= 3) return raw.trim();
  if (raw[1] === " " && raw[2] !== " ") return raw.slice(2).trim();
  return raw.slice(3).trim();
}

function sampleDirtyStatusPaths(statusLines: string[] | null) {
  return (statusLines ?? [])
    .map(parseGitPorcelainPath)
    .filter((value) => value.length > 0)
    .slice(0, DIRTY_PATH_SAMPLE_LIMIT);
}

function formatUtcBranchTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDirtyQuarantineRescueBranch(sourceIssue: ExecutionWorkspaceIssueRef | null) {
  const issueComponent = sanitizeBranchName(sourceIssue?.identifier ?? sourceIssue?.id ?? "issue");
  return sanitizeBranchName(`paperclip/rescue/${issueComponent}/${formatUtcBranchTimestamp()}`);
}

function formatIssueReference(issueId: string | null | undefined, identifier: string | null | undefined) {
  if (!identifier) return issueId ? `\`${issueId}\`` : "`unknown`";
  const match = identifier.match(/^([A-Z]+)-\d+$/);
  if (!match) return `\`${identifier}\``;
  return `[${identifier}](/${match[1]}/issues/${identifier})`;
}

async function readIssueCompanyId(db: Db, issueId: string | null | undefined): Promise<string | null> {
  if (!issueId) return null;
  return db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0]?.companyId ?? null);
}

async function findGitWorktreeBranchContention(input: {
  db: Db | null | undefined;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  actualBranchName: string | null;
}): Promise<GitWorktreeBranchContention | null> {
  if (!input.db) return null;
  const companyId = await readIssueCompanyId(input.db, input.sourceIssue?.id);
  if (!companyId) return null;
  return executionWorkspaceService(input.db).findGitWorktreeContention({
    companyId,
    worktreePath: input.worktreePath,
    liveBranchName: input.actualBranchName,
    excludingExecutionWorkspaceId: input.executionWorkspaceId,
  });
}

function executionWorkspaceUsesInheritedProjectRuntimeServices(
  row: typeof executionWorkspaces.$inferSelect,
) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

async function findActiveRuntimeServiceBlockingDirtyQuarantine(input: {
  db: Db;
  workspace: typeof executionWorkspaces.$inferSelect;
}) {
  const inheritedProjectWorkspaceId = executionWorkspaceUsesInheritedProjectRuntimeServices(input.workspace)
    ? input.workspace.projectWorkspaceId
    : null;
  const serviceScopeCondition = inheritedProjectWorkspaceId
    ? and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.projectWorkspaceId, inheritedProjectWorkspaceId),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      )
    : and(
        eq(workspaceRuntimeServices.companyId, input.workspace.companyId),
        eq(workspaceRuntimeServices.executionWorkspaceId, input.workspace.id),
      );

  const [service] = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      serviceName: workspaceRuntimeServices.serviceName,
      status: workspaceRuntimeServices.status,
      scopeType: workspaceRuntimeServices.scopeType,
    })
    .from(workspaceRuntimeServices)
    .where(and(serviceScopeCondition, ne(workspaceRuntimeServices.status, "stopped")))
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt))
    .limit(1);
  return service ?? null;
}

async function assertDirtyQuarantineRuntimeServicesStopped(input: {
  db: Db;
  executionWorkspaceId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
}) {
  if (!input.executionWorkspaceId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires an execution workspace id for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const [workspace] = await input.db
    .select()
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.id, input.executionWorkspaceId));
  if (!workspace) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a persisted execution workspace for runtime-service checks";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const activeService = await findActiveRuntimeServiceBlockingDirtyQuarantine({
    db: input.db,
    workspace,
  });
  if (!activeService) return;

  input.evidence.safeRepair.eligible = false;
  input.evidence.safeRepair.reason =
    `dirty quarantine repair requires runtime service "${activeService.serviceName}" (${activeService.id}) to be stopped; current status is ${activeService.status}`;
  throw branchIncoherenceValidationFailure(input.evidence);
}

async function assertGitIndexIsUnlocked(worktreePath: string) {
  const indexLockPath = await runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
    .catch(() => null);
  if (indexLockPath && existsSync(indexLockPath)) {
    throw new Error(`git index lock exists at ${indexLockPath}`);
  }
}

function fingerprintWorkspaceBranchIncoherence(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: GitWorktreeCleanliness;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringify({
      version: 1,
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

async function getGitWorktreeBranchAncestryVerdict(input: {
  repoRoot: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}): Promise<GitWorktreeBranchAncestryVerdict> {
  if (!input.expectedHeadSha || !input.actualHeadSha) return "unknown";

  const proc = await executeProcess({
    command: "git",
    args: ["merge-base", "--is-ancestor", input.expectedHeadSha, input.actualHeadSha],
    cwd: input.repoRoot,
  }).catch(() => null);
  if (!proc) return "unknown";
  if (proc.code === 0) return "ancestor";
  if (proc.code === 1) return "diverged";
  return "unknown";
}

function explainGitWorktreeBranchIncoherence(input: {
  expectedBranchName: string;
  actualBranchName: string | null;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  sameHead: boolean;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
}) {
  const actualBranch = formatBranchForMessage(input.actualBranchName);
  if (!input.expectedHeadSha || !input.actualHeadSha) {
    return `Paperclip could not determine branch ancestry because the recorded branch "${input.expectedBranchName}" or checked-out branch "${actualBranch}" is missing a resolvable HEAD commit.`;
  }
  if (input.sameHead) {
    return `The recorded branch "${input.expectedBranchName}" and checked-out branch "${actualBranch}" resolve to the same commit, so the mismatch is branch metadata rather than commit divergence.`;
  }
  if (input.ancestryVerdict === "ancestor") {
    return `The recorded branch "${input.expectedBranchName}" is an ancestor of the checked-out branch "${actualBranch}", so the checked-out branch is forward of the recorded branch.`;
  }
  if (input.ancestryVerdict === "diverged") {
    return `The recorded branch "${input.expectedBranchName}" is not an ancestor of the checked-out branch "${actualBranch}", so Paperclip cannot prove a forward-only reconciliation.`;
  }
  return `Paperclip could not determine whether the checked-out branch "${actualBranch}" is forward of the recorded branch "${input.expectedBranchName}".`;
}

async function inspectGitWorktreeBranchIncoherence(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
}): Promise<GitWorktreeBranchIncoherenceEvidence> {
  const status = await runExpensiveGitStatus({
    args: ["status", "--porcelain", "--untracked-files=all"],
    cwd: input.worktreePath,
    operation: "workspace_runtime.branch_incoherence_status",
    fairnessKeys: [
      ...(input.executionWorkspaceId ? [`workspace:${input.executionWorkspaceId}`] : []),
      ...(input.sourceIssue?.id ? [`issue:${input.sourceIssue.id}`] : []),
    ],
  }).catch(() => null);
  const statusLines = status === null
    ? null
    : status.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const dirtyPathSample = sampleDirtyStatusPaths(statusLines);
  const cleanliness: GitWorktreeCleanliness =
    status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const inProgressOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
  const expectedHeadSha = await runGit(
    ["rev-parse", "--verify", `refs/heads/${input.expectedBranchName}^{commit}`],
    input.repoRoot,
  ).catch(() => null);
  const actualHeadSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  const actualBranchExists = input.actualBranchName
    ? await localBranchExists(input.repoRoot, input.actualBranchName)
    : null;
  const registered = await findRegisteredGitWorktreeByPath(input.repoRoot, input.worktreePath);
  const actualBranchRef = input.actualBranchName ? `refs/heads/${input.actualBranchName}` : null;
  const registeredBranchRef = registered?.branch ?? null;
  const registeredBranchMatchesHead = Boolean(registered && registeredBranchRef === actualBranchRef);
  const sameHead = Boolean(expectedHeadSha && actualHeadSha && expectedHeadSha === actualHeadSha);
  const expectedBranchExists = Boolean(expectedHeadSha);
  const ancestryVerdict = await getGitWorktreeBranchAncestryVerdict({
    repoRoot: input.repoRoot,
    expectedHeadSha,
    actualHeadSha,
  });
  const basePlainLanguageReason = explainGitWorktreeBranchIncoherence({
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
    expectedHeadSha,
    actualHeadSha,
    sameHead,
    ancestryVerdict,
  });
  const plainLanguageReason = inProgressOperation
    ? `${basePlainLanguageReason} An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is still in progress in this worktree.`
    : basePlainLanguageReason;
  const canCheckoutRecordedBranch =
    cleanliness === "clean" && expectedBranchExists && sameHead && registeredBranchMatchesHead;
  const canAdoptForwardActualBranch =
    cleanliness === "clean" &&
    expectedBranchExists &&
    actualBranchExists === true &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const canAttachRecordedBranchToDetachedHead =
    cleanliness === "clean" &&
    expectedBranchExists &&
    input.actualBranchName === null &&
    ancestryVerdict === "ancestor" &&
    !sameHead &&
    registeredBranchMatchesHead;
  const eligible =
    canCheckoutRecordedBranch || canAdoptForwardActualBranch || canAttachRecordedBranchToDetachedHead;
  const safeRepairReason = eligible
    ? canCheckoutRecordedBranch
      ? "clean worktree and expected branch points at the current HEAD"
      : canAdoptForwardActualBranch
        ? "clean worktree and checked-out branch is forward of the recorded branch"
        : "clean detached worktree HEAD is forward of the recorded branch"
    : cleanliness !== "clean"
      ? inProgressOperation
        ? `worktree is not clean and a git ${GIT_IN_PROGRESS_OPERATION_LABELS[inProgressOperation]} is in progress`
        : "worktree is not clean"
      : !registered
        ? "worktree path is not registered"
      : !registeredBranchMatchesHead
        ? "registered worktree branch does not match HEAD"
      : !expectedBranchExists
        ? "expected branch does not exist"
        : !sameHead
          ? "expected branch and current HEAD differ"
          : "safe repair could not be proven";
  const fingerprint = fingerprintWorkspaceBranchIncoherence({
    sourceIssueId: input.sourceIssue?.id ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    expectedHeadSha,
    actualHeadSha,
  });
  const contention = await findGitWorktreeBranchContention({
    db: input.db ?? null,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: input.worktreePath,
    actualBranchName: input.actualBranchName,
  });

  return {
    reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
    fingerprint,
    sourceIssueId: input.sourceIssue?.id ?? null,
    sourceIdentifier: input.sourceIssue?.identifier ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    worktreePath: path.resolve(input.worktreePath),
    repoRoot: path.resolve(input.repoRoot),
    expectedBranch: input.expectedBranchName,
    actualBranch: input.actualBranchName,
    cleanliness,
    inProgressOperation,
    statusEntryCount: statusLines?.length ?? null,
    dirtyPathSample,
    contention,
    provenance: {
      expectedBranchRef: `refs/heads/${input.expectedBranchName}`,
      actualBranchRef,
      registeredBranchRef,
      registeredPathFound: Boolean(registered),
      registeredBranchMatchesHead,
      expectedBranchExists,
      actualBranchExists,
      expectedHeadSha,
      actualHeadSha,
      sameHead,
      ancestryVerdict,
      plainLanguageReason,
    },
    safeRepair: {
      eligible,
      attempted: false,
      succeeded: false,
      reason: safeRepairReason,
    },
  };
}

function branchIncoherenceValidationFailure(evidence: GitWorktreeBranchIncoherenceEvidence) {
  return new WorkspaceRuntimeValidationFailure(
    `Execution workspace git worktree expected branch "${evidence.expectedBranch}" but found "${formatBranchForMessage(evidence.actualBranch)}" at "${evidence.worktreePath}". Safe repair ${evidence.safeRepair.succeeded ? "succeeded" : "was not completed"}: ${evidence.safeRepair.reason}.`,
    {
      workspaceValidation: evidence,
    },
  );
}

function formatDirtyQuarantineContentionRefusal(contention: GitWorktreeBranchContention) {
  const activeRunText = contention.activeRun
    ? ` with active run ${contention.activeRun.id}`
    : " with no active run";
  return `dirty quarantine repair refused because workspace ${contention.claimedByWorkspaceId} already claims the live branch${activeRunText}`;
}

function formatDirtyQuarantineFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    gitErrorIncludes(error, "index.lock") ||
    gitErrorIncludes(error, "index lock") ||
    gitErrorIncludes(error, "another git process") ||
    gitErrorIncludes(error, "Unable to create")
  ) {
    return `dirty quarantine repair aborted because git reported index contention: ${message}`;
  }
  return `dirty quarantine repair failed: ${message}`;
}

function formatDirtyQuarantineAuditComment(input: {
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  claimant: GitWorktreeBranchContention | null;
}) {
  const dirtySample = input.evidence.dirtyPathSample.length > 0
    ? input.evidence.dirtyPathSample.map((entry) => `\`${entry}\``).join(", ")
    : "`none captured`";
  return [
    "Execution workspace dirty worktree quarantined before restore.",
    "",
    `- Source issue: ${formatIssueReference(input.evidence.sourceIssueId, input.evidence.sourceIdentifier ?? input.sourceIssue?.identifier ?? null)}`,
    `- Workspace: \`${input.evidence.executionWorkspaceId ?? "unpersisted"}\``,
    `- Worktree: \`${input.evidence.worktreePath}\``,
    `- Recorded branch: \`${input.evidence.expectedBranch}\``,
    `- Live branch: \`${formatBranchForMessage(input.evidence.actualBranch)}\``,
    `- Rescue branch: \`${input.rescueBranch}\``,
    `- Rescue commit: \`${input.rescueCommitSha}\``,
    `- Dirty file count: \`${input.fileCount}\``,
    `- Dirty path sample: ${dirtySample}`,
    ...(input.evidence.inProgressOperation
      ? [`- Interrupted operation: \`git ${GIT_IN_PROGRESS_OPERATION_LABELS[input.evidence.inProgressOperation]}\` (state cleared after rescue; resolution preserved on the rescue branch)`]
      : []),
    `- Fingerprint: \`${input.evidence.fingerprint}\``,
    input.claimant
      ? `- Claimant: workspace \`${input.claimant.claimedByWorkspaceId}\` on issue ${formatIssueReference(input.claimant.claimedByIssueId, input.claimant.claimedByIssueIdentifier)}${input.claimant.activeRun ? ` with active run \`${input.claimant.activeRun.id}\`` : " with no active run"}`
      : "- Claimant: none",
  ].join("\n");
}

async function writeDirtyQuarantineAuditComments(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
}): Promise<{ sourceAuditCommentId: string | null; claimantAuditCommentId: string | null }> {
  const body = formatDirtyQuarantineAuditComment({
    evidence: input.evidence,
    rescueBranch: input.rescueBranch,
    rescueCommitSha: input.rescueCommitSha,
    fileCount: input.fileCount,
    sourceIssue: input.sourceIssue,
    claimant: input.evidence.contention,
  });
  let sourceAuditCommentId: string | null = null;
  let claimantAuditCommentId: string | null = null;
  const now = new Date();
  if (input.evidence.sourceIssueId) {
    const [sourceComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: input.evidence.sourceIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    sourceAuditCommentId = sourceComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, input.evidence.sourceIssueId));
  }

  const claimantIssueId = input.evidence.contention?.claimedByIssueId ?? null;
  if (claimantIssueId && claimantIssueId !== input.evidence.sourceIssueId) {
    const [claimantComment] = await input.db
      .insert(issueComments)
      .values({
        companyId: input.companyId,
        issueId: claimantIssueId,
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        createdByRunId: input.heartbeatRunId,
        body,
      })
      .returning({ id: issueComments.id });
    claimantAuditCommentId = claimantComment?.id ?? null;
    await input.db
      .update(issues)
      .set({ updatedAt: now })
      .where(eq(issues.id, claimantIssueId));
  }

  return { sourceAuditCommentId, claimantAuditCommentId };
}

async function logDirtyQuarantineActivity(input: {
  db: Db;
  companyId: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  heartbeatRunId: string | null;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.heartbeatRunId,
    action: "execution_workspace.dirty_worktree_quarantined",
    entityType: input.evidence.executionWorkspaceId ? "execution_workspace" : "issue",
    entityId: input.evidence.executionWorkspaceId ?? input.evidence.sourceIssueId ?? input.companyId,
    details: {
      reason: GIT_WORKTREE_BRANCH_INCOHERENCE_REASON,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      worktreePath: input.evidence.worktreePath,
      expectedBranch: input.evidence.expectedBranch,
      actualBranch: input.evidence.actualBranch,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      contention: input.evidence.contention,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

async function recordDirtyQuarantineOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  rescueBranch: string;
  rescueCommitSha: string;
  fileCount: number;
  sourceAuditCommentId: string | null;
  claimantAuditCommentId: string | null;
}) {
  if (!input.recorder) return;
  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.evidence.repoRoot,
      worktreePath: input.evidence.worktreePath,
      expectedBranchName: input.evidence.expectedBranch,
      actualBranchName: input.evidence.actualBranch,
      branchIncoherenceDirtyQuarantineRepair: true,
      rescueBranch: input.rescueBranch,
      rescueCommitSha: input.rescueCommitSha,
      fileCount: input.fileCount,
      dirtyPathSample: input.evidence.dirtyPathSample,
      fingerprint: input.evidence.fingerprint,
      sourceIssueId: input.evidence.sourceIssueId,
      executionWorkspaceId: input.evidence.executionWorkspaceId,
      sourceAuditCommentId: input.sourceAuditCommentId,
      claimantAuditCommentId: input.claimantAuditCommentId,
    },
    run: async () => ({
      status: "succeeded",
      system:
        `Quarantined dirty git worktree state on ${input.rescueBranch} (${formatShortSha(input.rescueCommitSha)}) and restored recorded branch ${input.evidence.expectedBranch}.\n`,
    }),
  });
}

async function quarantineDirtyWorktreeBranchIncoherence(input: {
  db: Db;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId: string | null;
  heartbeatRunId: string | null;
  evidence: GitWorktreeBranchIncoherenceEvidence;
  phase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<DirtyQuarantineRepairResult> {
  const companyId = await readIssueCompanyId(input.db, input.evidence.sourceIssueId);
  if (!companyId) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = "dirty quarantine repair requires a source issue company for audit";
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const freshContention = await findGitWorktreeBranchContention({
    db: input.db,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId,
    worktreePath: input.worktreePath,
    actualBranchName: input.evidence.actualBranch,
  });
  input.evidence.contention = freshContention;
  if (freshContention) {
    input.evidence.safeRepair.eligible = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(freshContention);
    throw branchIncoherenceValidationFailure(input.evidence);
  }

  const rescueBranch = buildDirtyQuarantineRescueBranch(input.sourceIssue);
  const fileCount = input.evidence.statusEntryCount ?? input.evidence.dirtyPathSample.length;
  const baseMetadata = {
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.evidence.actualBranch,
    branchIncoherenceDirtyQuarantineRepair: true,
    rescueBranch,
    fingerprint: input.evidence.fingerprint,
    sourceIssueId: input.evidence.sourceIssueId,
    executionWorkspaceId: input.evidence.executionWorkspaceId,
    fileCount,
    dirtyPathSample: input.evidence.dirtyPathSample,
    contention: input.evidence.contention,
  };

  let rescueBranchCreated = false;
  let expectedBranchRestored = false;
  try {
    await assertGitIndexIsUnlocked(input.worktreePath);
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["checkout", "-b", rescueBranch],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Created rescue branch ${rescueBranch} for dirty git worktree state at ${input.worktreePath}\n`,
      failureLabel: `git checkout -b ${rescueBranch}`,
    });
    rescueBranchCreated = true;
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["add", "-A"],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Staged dirty git worktree state for rescue branch ${rescueBranch}\n`,
      failureLabel: "git add -A",
    });
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: [
        "commit",
        "-m",
        "Paperclip dirty workspace rescue",
        "-m",
        [
          `Source-Issue: ${input.evidence.sourceIdentifier ?? input.evidence.sourceIssueId ?? "unknown"}`,
          `Run-Id: ${input.heartbeatRunId ?? "unknown"}`,
          `Recorded-Branch: ${input.expectedBranchName}`,
          `Live-Branch: ${formatBranchForMessage(input.evidence.actualBranch)}`,
          `Fingerprint: ${input.evidence.fingerprint}`,
        ].join("\n"),
      ],
      cwd: input.worktreePath,
      metadata: baseMetadata,
      successMessage: `Committed dirty git worktree state to rescue branch ${rescueBranch}\n`,
      failureLabel: "git commit dirty workspace rescue",
    });
    const rescueCommitSha = await runGit(["rev-parse", "HEAD"], input.worktreePath);
    await recordGitOperation(input.recorder, {
      phase: input.phase ?? "worktree_prepare",
      args: ["checkout", input.expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        ...baseMetadata,
        rescueCommitSha,
      },
      successMessage: `Restored recorded branch ${input.expectedBranchName} after dirty workspace rescue ${rescueBranch}\n`,
      failureLabel: `git checkout ${input.expectedBranchName}`,
    });
    expectedBranchRestored = true;

    // A run that died mid-rebase (or mid-merge/cherry-pick/revert/bisect)
    // leaves the operation's state directory behind even after the recorded
    // branch is checked out, which wedges the next git command in the
    // worktree. The rescue commit above already preserved the in-flight
    // resolution, so clearing the state metadata here loses nothing.
    let clearedInProgressOperation: GitWorktreeInProgressOperation | null = null;
    const lingeringOperation = await detectGitWorktreeInProgressOperation(input.worktreePath);
    if (lingeringOperation) {
      const operationLabel = GIT_IN_PROGRESS_OPERATION_LABELS[lingeringOperation];
      const quitArgs = GIT_IN_PROGRESS_OPERATION_QUIT_ARGS[lingeringOperation];
      await recordGitOperation(input.recorder, {
        phase: input.phase ?? "worktree_prepare",
        args: quitArgs,
        cwd: input.worktreePath,
        metadata: {
          ...baseMetadata,
          clearedInProgressOperation: lingeringOperation,
        },
        successMessage: `Cleared interrupted git ${operationLabel} state after dirty workspace rescue ${rescueBranch}\n`,
        failureLabel: `git ${quitArgs.join(" ")}`,
      });
      const stillInProgress = await detectGitWorktreeInProgressOperation(input.worktreePath);
      if (stillInProgress) {
        input.evidence.safeRepair.succeeded = false;
        input.evidence.safeRepair.reason =
          `dirty quarantine repair could not clear the interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[stillInProgress]} state`;
        throw branchIncoherenceValidationFailure(input.evidence);
      }
      clearedInProgressOperation = lingeringOperation;
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== input.expectedBranchName) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason =
        `dirty quarantine repair checked out ${formatBranchForMessage(repairedBranch)} instead of ${input.expectedBranchName}`;
      throw branchIncoherenceValidationFailure(input.evidence);
    }
    const repairedStatus = await runExpensiveGitStatus({
      args: ["status", "--porcelain", "--untracked-files=all"],
      cwd: input.worktreePath,
      operation: "workspace_runtime.dirty_quarantine_verify",
      fairnessKeys: [
        ...(input.executionWorkspaceId ? [`workspace:${input.executionWorkspaceId}`] : []),
        ...(input.sourceIssue?.id ? [`issue:${input.sourceIssue.id}`] : []),
      ],
    });
    if (repairedStatus.trim().length > 0) {
      input.evidence.safeRepair.succeeded = false;
      input.evidence.safeRepair.reason = "dirty quarantine repair completed but the worktree is still dirty";
      throw branchIncoherenceValidationFailure(input.evidence);
    }

    const comments = await writeDirtyQuarantineAuditComments({
      db: input.db,
      companyId,
      evidence: input.evidence,
      sourceIssue: input.sourceIssue,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
    });
    await logDirtyQuarantineActivity({
      db: input.db,
      companyId,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      heartbeatRunId: input.heartbeatRunId,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    await recordDirtyQuarantineOperation({
      recorder: input.recorder,
      phase: input.phase,
      cwd: input.worktreePath,
      evidence: input.evidence,
      rescueBranch,
      rescueCommitSha,
      fileCount,
      sourceAuditCommentId: comments.sourceAuditCommentId,
      claimantAuditCommentId: comments.claimantAuditCommentId,
    });
    return {
      rescueBranch,
      rescueCommitSha,
      fileCount,
      clearedInProgressOperation,
      ...comments,
    };
  } catch (error) {
    if (rescueBranchCreated && !expectedBranchRestored) {
      await runGit(["checkout", input.expectedBranchName], input.worktreePath).catch(() => null);
    }
    if (error instanceof WorkspaceRuntimeValidationFailure) throw error;
    input.evidence.safeRepair.succeeded = false;
    input.evidence.safeRepair.reason = formatDirtyQuarantineFailure(error);
    throw branchIncoherenceValidationFailure(input.evidence);
  }
}

async function recordForwardBranchReconcileOperation(input: {
  recorder?: WorkspaceOperationRecorder | null;
  phase?: "worktree_prepare" | "workspace_finalize";
  cwd: string;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  actualBranchName: string;
  executionWorkspaceId: string | null;
  sourceIssueId: string | null;
  fingerprint: string;
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  mode: "record_updated" | "adopt_for_realize";
  auditCommentId?: string | null;
  recoveryActionId?: string | null;
}) {
  if (!input.recorder) return;

  await input.recorder.recordOperation({
    phase: input.phase ?? "worktree_prepare",
    cwd: input.cwd,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName: input.expectedBranchName,
      actualBranchName: input.actualBranchName,
      branchIncoherenceReconcileForward: true,
      reconcileMode: input.mode,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
      ancestryVerdict: input.ancestryVerdict,
      auditCommentId: input.auditCommentId ?? null,
      recoveryActionId: input.recoveryActionId ?? null,
    },
    run: async () => ({
      status: "succeeded",
      system:
        input.mode === "record_updated"
          ? `Reconciled execution workspace branch record from ${input.expectedBranchName} to ${input.actualBranchName}; worktree left unchanged.\n`
          : `Adopted live git worktree branch ${input.actualBranchName} for this execution workspace realization; worktree left unchanged.\n`,
    }),
  });
}

async function logForwardBranchReconcileActivity(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  sourceIssueId: string | null;
  runId: string | null;
  mode: "forward";
  reason: string | null;
  fromBranch: string;
  toBranch: string;
  fromSha: string | null;
  toSha: string | null;
  ancestryVerdict: GitWorktreeBranchAncestryVerdict;
  fingerprint: string;
  auditCommentId: string | null;
  recoveryActionId: string | null;
}) {
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "workspace_runtime",
    runId: input.runId,
    action: "execution_workspace.branch_reconciled",
    entityType: "execution_workspace",
    entityId: input.executionWorkspaceId,
    details: {
      mode: input.mode,
      reason: input.reason,
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      fromSha: input.fromSha,
      toSha: input.toSha,
      ancestryVerdict: input.ancestryVerdict,
      fingerprint: input.fingerprint,
      sourceIssueId: input.sourceIssueId,
      auditCommentId: input.auditCommentId,
      recoveryActionId: input.recoveryActionId,
      actor: {
        type: "system",
        id: "workspace_runtime",
        source: "workspace_runtime",
      },
    },
  });
}

export async function reconcilePendingForwardBranchAfterPersistence(input: {
  db: Db;
  executionWorkspaceId: string;
  pending: PendingForwardBranchReconcile;
  heartbeatRunId?: string | null;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
    input.executionWorkspaceId,
    {
      mode: "forward",
      reason: input.pending.reason,
      alternateRecoveryFingerprints: [input.pending.prePersistenceFingerprint],
      actor: {
        actorType: "system",
        actorId: "workspace_runtime",
        agentId: null,
        runId: input.heartbeatRunId ?? null,
      },
    },
  );
  await logForwardBranchReconcileActivity({
    db: input.db,
    companyId: result.workspace.companyId,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    runId: input.heartbeatRunId ?? null,
    mode: "forward",
    reason: input.pending.reason,
    fromBranch: result.inspection.fromBranch,
    toBranch: result.inspection.toBranch,
    fromSha: result.inspection.fromSha,
    toSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    fingerprint: result.inspection.fingerprint,
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  await recordForwardBranchReconcileOperation({
    recorder: input.recorder,
    phase: input.reconcileOperationPhase,
    cwd: result.inspection.worktreePath,
    repoRoot: result.inspection.repoRoot,
    worktreePath: result.inspection.worktreePath,
    expectedBranchName: result.inspection.fromBranch,
    actualBranchName: result.inspection.toBranch,
    executionWorkspaceId: result.workspace.id,
    sourceIssueId: result.workspace.sourceIssueId,
    fingerprint: result.inspection.fingerprint,
    expectedHeadSha: result.inspection.fromSha,
    actualHeadSha: result.inspection.toSha,
    ancestryVerdict: result.inspection.ancestryVerdict,
    mode: "adopt_for_realize",
    auditCommentId: result.auditCommentId,
    recoveryActionId: result.recoveryAction?.id ?? null,
  });
  return result;
}

export async function ensureGitWorktreeBranchCoherent(input: {
  db?: Db | null;
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
  sourceIssue: ExecutionWorkspaceIssueRef | null;
  executionWorkspaceId?: string | null;
  actualBranchName?: string | null;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  persistForwardReconcile?: boolean;
  reconcileOperationPhase?: "worktree_prepare" | "workspace_finalize";
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<GitWorktreeBranchCoherenceResult> {
  const expectedBranchName = input.expectedBranchName?.trim();
  if (!expectedBranchName) return { branchName: null, reconciledForward: false, warnings: [] };

  const currentBranch = input.actualBranchName !== undefined
    ? input.actualBranchName
    : await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  if (currentBranch === expectedBranchName) {
    return { branchName: expectedBranchName, reconciledForward: false, warnings: [] };
  }

  const evidence = await inspectGitWorktreeBranchIncoherence({
    db: input.db ?? null,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName,
    actualBranchName: currentBranch,
    sourceIssue: input.sourceIssue,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
  });

  if (evidence.cleanliness === "dirty" && input.enableWorkspaceDirtyQuarantineRepair === true) {
    if (!input.db) {
      evidence.safeRepair.reason = "dirty quarantine repair requires database access for claimant checks and audit";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.registeredPathFound) {
      evidence.safeRepair.reason = "dirty quarantine repair requires a registered git worktree path";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (!evidence.provenance.expectedBranchExists) {
      evidence.safeRepair.reason = "dirty quarantine repair requires the recorded branch to exist";
      throw branchIncoherenceValidationFailure(evidence);
    }
    if (evidence.contention) {
      evidence.safeRepair.eligible = false;
      evidence.safeRepair.reason = formatDirtyQuarantineContentionRefusal(evidence.contention);
      throw branchIncoherenceValidationFailure(evidence);
    }
    await assertDirtyQuarantineRuntimeServicesStopped({
      db: input.db,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      evidence,
    });
    evidence.safeRepair.eligible = true;
    evidence.safeRepair.attempted = true;
    evidence.safeRepair.reason = "dirty worktree can be quarantined on a rescue branch before restoring the recorded branch";
    const result = await quarantineDirtyWorktreeBranchIncoherence({
      db: input.db,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      expectedBranchName,
      sourceIssue: input.sourceIssue,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      evidence,
      phase: input.reconcileOperationPhase,
      recorder: input.recorder ?? null,
    });
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = result.clearedInProgressOperation
      ? `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}; interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} state cleared`
      : `dirty worktree quarantined on ${result.rescueBranch} at ${formatShortSha(result.rescueCommitSha)}`;
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      dirtyQuarantineRepair: result,
      warnings: [
        `Execution workspace dirty worktree state was quarantined on rescue branch "${result.rescueBranch}" (${formatShortSha(result.rescueCommitSha)}; ${result.fileCount} ${result.fileCount === 1 ? "file" : "files"}) before restoring recorded branch "${expectedBranchName}".${result.clearedInProgressOperation ? ` An interrupted git ${GIT_IN_PROGRESS_OPERATION_LABELS[result.clearedInProgressOperation]} was also cleared; its in-flight state is preserved on the rescue branch.` : ""}`,
      ],
    };
  }

  // A recorded branch that no longer exists anywhere has no commits to lose, so
  // adopting the clean checked-out branch is trivially forward-only. This is the
  // steady state left behind when an agent renames its task branch (e.g. to a
  // feat/* PR branch) and the recorded branch was never created or was deleted.
  const recordedBranchMissingButAdoptable =
    !evidence.provenance.expectedBranchExists &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.registeredBranchMatchesHead;
  if (
    input.enableWorkspaceBranchReconcileForward === true &&
    evidence.cleanliness === "clean" &&
    currentBranch &&
    ((evidence.provenance.ancestryVerdict === "ancestor" && !evidence.provenance.sameHead) ||
      recordedBranchMissingButAdoptable)
  ) {
    const reason = evidence.provenance.expectedBranchExists
      ? "Automatic forward reconciliation: recorded branch is an ancestor of the checked-out branch."
      : "Automatic forward reconciliation: the recorded branch no longer exists, so Paperclip adopted the clean checked-out branch.";
    if (input.executionWorkspaceId && input.persistForwardReconcile !== false) {
      if (!input.db) {
        evidence.safeRepair.reason = "forward reconciliation requires database access to update the execution workspace record";
        throw branchIncoherenceValidationFailure(evidence);
      }
      try {
        const result = await executionWorkspaceService(input.db).reconcileExecutionWorkspaceBranch(
          input.executionWorkspaceId,
          {
            mode: "forward",
            reason,
            actor: {
              actorType: "system",
              actorId: "workspace_runtime",
              agentId: null,
              runId: input.heartbeatRunId ?? null,
            },
          },
        );
        await logForwardBranchReconcileActivity({
          db: input.db,
          companyId: result.workspace.companyId,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          runId: input.heartbeatRunId ?? null,
          mode: "forward",
          reason,
          fromBranch: result.inspection.fromBranch,
          toBranch: result.inspection.toBranch,
          fromSha: result.inspection.fromSha,
          toSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          fingerprint: result.inspection.fingerprint,
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        await recordForwardBranchReconcileOperation({
          recorder: input.recorder,
          phase: input.reconcileOperationPhase,
          cwd: input.worktreePath,
          repoRoot: result.inspection.repoRoot,
          worktreePath: result.inspection.worktreePath,
          expectedBranchName: result.inspection.fromBranch,
          actualBranchName: result.inspection.toBranch,
          executionWorkspaceId: result.workspace.id,
          sourceIssueId: result.workspace.sourceIssueId ?? evidence.sourceIssueId ?? null,
          fingerprint: result.inspection.fingerprint,
          expectedHeadSha: result.inspection.fromSha,
          actualHeadSha: result.inspection.toSha,
          ancestryVerdict: result.inspection.ancestryVerdict,
          mode: "record_updated",
          auditCommentId: result.auditCommentId,
          recoveryActionId: result.recoveryAction?.id ?? null,
        });
        return { branchName: result.inspection.toBranch, reconciledForward: true, warnings: [] };
      } catch (error) {
        evidence.safeRepair.reason =
          `forward reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
        throw branchIncoherenceValidationFailure(evidence);
      }
    }

    if (!input.db) {
      evidence.safeRepair.reason = "forward reconciliation adoption requires database access to audit after workspace realization";
      throw branchIncoherenceValidationFailure(evidence);
    }
    return {
      branchName: currentBranch,
      reconciledForward: true,
      warnings: [],
      pendingForwardBranchReconcile: {
        recordedBranchName: expectedBranchName,
        adoptedBranchName: currentBranch,
        prePersistenceFingerprint: evidence.fingerprint,
        reason,
      },
    };
  }

  if (!evidence.safeRepair.eligible) {
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.attempted = true;
  const warningPrefix =
    `Execution workspace branch metadata was self-healed from "${expectedBranchName}" to "${formatBranchForMessage(currentBranch)}" at ${input.worktreePath}.`;
  if (
    currentBranch &&
    evidence.provenance.actualBranchExists === true &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead
  ) {
    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean worktree adopted the checked-out branch because it is forward of the recorded branch";
    return {
      branchName: currentBranch,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The checked-out branch contains the recorded branch plus newer commits, so Paperclip adopted it for subsequent runs.`,
      ],
    };
  }

  if (
    currentBranch === null &&
    evidence.provenance.ancestryVerdict === "ancestor" &&
    !evidence.provenance.sameHead &&
    evidence.provenance.actualHeadSha
  ) {
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["checkout", "-B", expectedBranchName, evidence.provenance.actualHeadSha],
        cwd: input.worktreePath,
        metadata: {
          repoRoot: input.repoRoot,
          worktreePath: input.worktreePath,
          expectedBranchName,
          actualBranchName: currentBranch,
          branchIncoherenceRepair: true,
          detachedHeadRepair: true,
          fingerprint: evidence.fingerprint,
          sourceIssueId: evidence.sourceIssueId,
          executionWorkspaceId: evidence.executionWorkspaceId,
        },
        successMessage: `Reattached detached git worktree HEAD at ${input.worktreePath} to ${expectedBranchName}\n`,
        failureLabel: `git checkout -B ${expectedBranchName} ${formatShortSha(evidence.provenance.actualHeadSha)}`,
      });
    } catch (error) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `safe detached HEAD reattachment failed: ${error instanceof Error ? error.message : String(error)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
      .catch(() => null);
    if (repairedBranch !== expectedBranchName) {
      evidence.safeRepair.succeeded = false;
      evidence.safeRepair.reason = `reattach completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
      throw branchIncoherenceValidationFailure(evidence);
    }

    evidence.safeRepair.succeeded = true;
    evidence.safeRepair.reason = "clean detached worktree HEAD was reattached to the recorded branch";
    return {
      branchName: expectedBranchName,
      reconciledForward: false,
      warnings: [
        `${warningPrefix} The detached HEAD contained the recorded branch plus newer commits, so Paperclip moved the recorded branch to that HEAD.`,
      ],
    };
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["checkout", expectedBranchName],
      cwd: input.worktreePath,
      metadata: {
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        expectedBranchName,
        actualBranchName: currentBranch,
        branchIncoherenceRepair: true,
        fingerprint: evidence.fingerprint,
        sourceIssueId: evidence.sourceIssueId,
        executionWorkspaceId: evidence.executionWorkspaceId,
      },
      successMessage: `Repaired clean git worktree branch mismatch at ${input.worktreePath}: checked out ${expectedBranchName}\n`,
      failureLabel: `git checkout ${expectedBranchName}`,
    });
  } catch (error) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `safe checkout failed: ${error instanceof Error ? error.message : String(error)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  const repairedBranch = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath)
    .catch(() => null);
  if (repairedBranch !== expectedBranchName) {
    evidence.safeRepair.succeeded = false;
    evidence.safeRepair.reason = `checkout completed but HEAD is ${formatBranchForMessage(repairedBranch)}`;
    throw branchIncoherenceValidationFailure(evidence);
  }

  evidence.safeRepair.succeeded = true;
  evidence.safeRepair.reason = "clean worktree checked out the recorded branch";
  return {
    branchName: expectedBranchName,
    reconciledForward: false,
    warnings: [
      `Execution workspace branch metadata was self-healed by checking out recorded branch "${expectedBranchName}" at ${input.worktreePath}.`,
    ],
  };
}

// A configured base ref that does not resolve to a commit, even after an
// authenticated fetch of its `origin/<branch>` counterpart. The caller must
// stop before `git worktree add` and raise a pre-dispatch configuration
// failure. `requestedRef` keeps the operator spelling for the human notice.
// `recoveryIdentityRef` is the canonical remote ref the resolver probed, so two
// equivalent spellings of one remote branch map to one recovery identity.
// `attemptedRefs` names each ref the resolver tried, and `fetchError` carries
// the first fetch warning (masked) when the fetch itself failed.
export class UnresolvedWorkspaceBaseRefError extends Error {
  requestedRef: string;
  recoveryIdentityRef: string;
  attemptedRefs: string[];
  fetchError: string | null;

  constructor(input: {
    requestedRef: string;
    recoveryIdentityRef: string;
    attemptedRefs: string[];
    fetchError?: string | null;
  }) {
    super(
      `Configured workspace base ref "${input.requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
    );
    this.name = "UnresolvedWorkspaceBaseRefError";
    this.requestedRef = input.requestedRef;
    this.recoveryIdentityRef = input.recoveryIdentityRef;
    this.attemptedRefs = input.attemptedRefs;
    this.fetchError = input.fetchError ?? null;
  }
}

export function isUnresolvedWorkspaceBaseRefError(error: unknown): error is UnresolvedWorkspaceBaseRefError {
  return error instanceof UnresolvedWorkspaceBaseRefError;
}

// A resolved base ref that the caller can pass to `git worktree add`, or an
// unresolved outcome that must stop the caller before it creates the worktree.
type AuthoritativeBaseRefResolution =
  | { resolved: true; baseRef: string; warnings: string[]; refreshed: boolean }
  | {
      resolved: false;
      requestedRef: string;
      // The canonical remote ref the resolver probed for this branch, for
      // example `origin/fix/foo`. Two equivalent spellings of one remote branch
      // (`fix/foo` and `origin/fix/foo`) share this value, so recovery treats
      // them as one identity. Two different branches get different values.
      recoveryIdentityRef: string;
      attemptedRefs: string[];
      warnings: string[];
      fetchError: string | null;
    };

// Resolve the authoritative base ref for a fresh worktree. A configured local
// branch is mapped to its `origin/<branch>` counterpart so unpushed local
// divergence never leaks into the task branch; SHAs and tags are used verbatim,
// and an unset/`HEAD` base falls back to the detected default branch (which
// already prefers `origin/master`).
//
// A remote-only feature branch never has a local ref or a remote-tracking ref
// yet. The resolver fetches `origin/<branch>` with the authenticated helper,
// then re-checks the commit. This covers both the unqualified form (`fix/foo`)
// and the remote-tracking form (`origin/fix/foo`). A ref that still does not
// resolve returns `resolved: false`, so the caller stops before the worktree
// add instead of passing an invalid reference to git.
async function resolveAuthoritativeBaseRef(
  repoRoot: string,
  configuredBaseRef: string | null,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<AuthoritativeBaseRefResolution> {
  const warnings: string[] = [];
  const detectOrHead = async () => (await detectDefaultBranch(repoRoot, resolveGitAuth)) ?? "HEAD";

  const configured = configuredBaseRef?.trim();
  if (!configured || configured === "HEAD") {
    return { resolved: true, baseRef: await detectOrHead(), warnings, refreshed: false };
  }

  // A remote-tracking ref supplied directly (for example `origin/fix/foo`).
  // Use it verbatim when it already resolves. When it does not, fetch it once
  // and re-check, then stop if it is still absent on the remote.
  //
  // `parseRemoteTrackingRef` only checks the `remote/branch` shape. An
  // unqualified branch name that contains a slash (for example `fix/foo`) has
  // the same shape but names no real remote, so it is not a remote-tracking
  // ref. Gate this branch on the first segment naming an existing remote, and
  // let a name like `fix/foo` fall through to the remote-only branch handling
  // below.
  const remoteTracking = parseRemoteTrackingRef(configured);
  if (remoteTracking && await resolveBaseRefSha(repoRoot, configured)) {
    return { resolved: true, baseRef: configured, warnings, refreshed: false };
  }
  if (remoteTracking && await remoteExists(repoRoot, remoteTracking.remote)) {
    const fetchWarnings = await refreshRemoteTrackingBaseRef(repoRoot, configured, resolveGitAuth);
    warnings.push(...fetchWarnings);
    if (await resolveBaseRefSha(repoRoot, configured)) {
      return { resolved: true, baseRef: configured, warnings, refreshed: true };
    }
    // Build the recovery identity from the parsed remote and branch. The raw
    // ref and its remote-tracking spelling (`origin/fix/foo` and
    // `refs/remotes/origin/fix/foo`) then share one recovery fingerprint, so
    // recovery treats them as one identity instead of two.
    const canonicalRemoteRef = `${remoteTracking.remote}/${remoteTracking.branch}`;
    return {
      resolved: false,
      requestedRef: configured,
      recoveryIdentityRef: canonicalRemoteRef,
      attemptedRefs: [configured],
      warnings,
      fetchError: fetchWarnings[0] ?? null,
    };
  }

  if (await localBranchExists(repoRoot, configured)) {
    const remoteCandidate = `origin/${configured}`;
    // Refresh here and keep the warnings; the caller skips its own refresh of
    // the returned ref (see `refreshed`) so we never fetch the same ref twice.
    warnings.push(...await refreshRemoteTrackingBaseRef(repoRoot, remoteCandidate, resolveGitAuth));
    if (await resolveBaseRefSha(repoRoot, remoteCandidate)) {
      return { resolved: true, baseRef: remoteCandidate, warnings, refreshed: true };
    }
    if (await remoteExists(repoRoot, "origin")) {
      warnings.push(
        `Configured base ref "${configured}" is a local branch with no matching origin/${configured}; basing the execution workspace on the local ref, which may include unpushed commits.`,
      );
    }
    return { resolved: true, baseRef: configured, warnings, refreshed: false };
  }

  // Fall-through: an unqualified ref (for example `fix/foo`) that is not `HEAD`,
  // not a remote-tracking ref, and not a local branch. A full SHA or a tag that
  // already resolves stays verbatim. Otherwise treat it as a remote-only branch
  // name: fetch `origin/<ref>` and base the worktree on the remote counterpart.
  if (await resolveBaseRefSha(repoRoot, configured)) {
    return { resolved: true, baseRef: configured, warnings, refreshed: false };
  }
  const remoteCandidate = `origin/${configured}`;
  const fetchWarnings = await refreshRemoteTrackingBaseRef(repoRoot, remoteCandidate, resolveGitAuth);
  warnings.push(...fetchWarnings);
  if (await resolveBaseRefSha(repoRoot, remoteCandidate)) {
    return { resolved: true, baseRef: remoteCandidate, warnings, refreshed: true };
  }
  return {
    resolved: false,
    requestedRef: configured,
    recoveryIdentityRef: remoteCandidate,
    attemptedRefs: [remoteCandidate],
    warnings,
    fetchError: fetchWarnings[0] ?? null,
  };
}

// Auto-refresh a reused worktree to the latest base only when it is provably
// unstarted: no task commits past the base and a clean tree (including untracked
// files). This pulls an idle worktree forward to the freshest `origin/master`
// after a long planning phase without ever destroying in-progress work. Only
// remote-tracking bases are eligible; local-only bases keep warn-only drift.
async function refreshUnstartedWorktreeToBase(input: {
  repoRoot: string;
  worktreePath: string;
  branchName: string | null;
  baseRef: string;
  currentBaseRefSha: string;
  recorder?: WorkspaceOperationRecorder | null;
}): Promise<{ refreshed: boolean; baseRefSha: string | null }> {
  if (!parseRemoteTrackingRef(input.baseRef)) {
    return { refreshed: false, baseRefSha: null };
  }

  const headSha = await runGit(["rev-parse", "HEAD"], input.worktreePath).catch(() => null);
  if (!headSha) {
    return { refreshed: false, baseRefSha: null };
  }
  if (headSha === input.currentBaseRefSha) {
    return { refreshed: false, baseRefSha: input.currentBaseRefSha };
  }

  const commitsPastBaseRaw = await runGit(
    ["rev-list", "--count", `${input.currentBaseRefSha}..HEAD`],
    input.worktreePath,
  ).catch(() => null);
  const commitsPastBase = commitsPastBaseRaw === null ? null : Number.parseInt(commitsPastBaseRaw, 10);
  if (commitsPastBase === null || !Number.isFinite(commitsPastBase) || commitsPastBase > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  // Force `--untracked-files=all` so untracked files are counted regardless of a
  // local `status.showUntrackedFiles=no`; otherwise the clean-tree guard could
  // pass and the `reset --hard` below would destroy untracked work.
  const status = await runExpensiveGitStatus({
    args: ["status", "--porcelain", "--untracked-files=all"],
    cwd: input.worktreePath,
    operation: "workspace_runtime.base_refresh_clean_guard",
    fairnessKeys: [
      ...(input.branchName ? [`branch:${input.branchName}`] : []),
    ],
  }).catch(() => null);
  if (status === null || status.trim().length > 0) {
    return { refreshed: false, baseRefSha: null };
  }

  await recordGitOperation(input.recorder, {
    phase: "worktree_prepare",
    args: ["reset", "--hard", input.currentBaseRefSha],
    cwd: input.worktreePath,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      baseRef: input.baseRef,
      previousHeadSha: headSha,
      baseRefSha: input.currentBaseRefSha,
      refreshedUnstartedWorktree: true,
    },
    successMessage: `Refreshed unstarted git worktree at ${input.worktreePath} to ${input.baseRef} (${formatShortSha(input.currentBaseRefSha)})\n`,
    failureLabel: `git reset --hard ${input.currentBaseRefSha}`,
  });

  return { refreshed: true, baseRefSha: input.currentBaseRefSha };
}


type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
};

export type ManagedGitWorktreeBranchInspection = {
  valid: boolean;
  reason: string | null;
  reasonCode:
    | "missing_worktree"
    | "not_a_git_checkout"
    | "not_registered"
    | "wrong_repository_root"
    | "branch_mismatch"
    | null;
  repoRoot: string | null;
  worktreePath: string;
  expectedBranchName: string | null;
  actualBranchName: string | null;
};

function parseGitWorktreeListPorcelain(raw: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
      continue;
    }
    if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
      });
      current = {};
    }
  }

  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
    });
  }

  return entries;
}

async function resolveGitOwnerRepoRoot(cwd: string): Promise<string> {
  const checkoutRoot = path.resolve(await runGit(["rev-parse", "--show-toplevel"], cwd));
  const commonDir = await runGit(["rev-parse", "--git-common-dir"], checkoutRoot).catch(() => null);
  if (!commonDir) return checkoutRoot;
  return path.dirname(path.resolve(checkoutRoot, commonDir));
}

async function findRegisteredGitWorktreeByBranch(repoRoot: string, branchName: string): Promise<string | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedBranchRef = `refs/heads/${branchName}`;
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (entry.branch !== expectedBranchRef) continue;
    return path.resolve(entry.worktree);
  }

  return null;
}

async function findRegisteredGitWorktreeByPath(repoRoot: string, worktreePath: string): Promise<GitWorktreeListEntry | null> {
  const raw = await runGit(["worktree", "list", "--porcelain"], repoRoot).catch(() => null);
  if (!raw) return null;

  const expectedPath = await resolvePathForWorktreeComparison(worktreePath);
  for (const entry of parseGitWorktreeListPorcelain(raw)) {
    if (await resolvePathForWorktreeComparison(entry.worktree) === expectedPath) {
      return entry;
    }
  }
  return null;
}

async function isGitCheckout(cwd: string): Promise<boolean> {
  return Boolean(await runGit(["rev-parse", "--git-dir"], cwd).catch(() => null));
}

async function detectDefaultBranch(
  repoRoot: string,
  resolveGitAuth?: GitRemoteAuthProvider | null,
): Promise<string | null> {
  const originMasterRef = "origin/master";
  await refreshRemoteTrackingBaseRef(repoRoot, originMasterRef, resolveGitAuth);
  if (await resolveBaseRefSha(repoRoot, originMasterRef)) {
    return originMasterRef;
  }

  // Try the explicit remote HEAD first (set by git clone or git remote set-head)
  try {
    const remoteHead = await runGit(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      repoRoot,
    );
    if (remoteHead) {
      await refreshRemoteTrackingBaseRef(repoRoot, remoteHead, resolveGitAuth);
      if (await resolveBaseRefSha(repoRoot, remoteHead)) return remoteHead;
    }
  } catch {
    // Not set — fall through to heuristic
  }

  // Fallback: check for common default branch names on the remote
  for (const candidate of ["origin/master", "origin/main", "main", "master"]) {
    try {
      await refreshRemoteTrackingBaseRef(repoRoot, candidate, resolveGitAuth);
      await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot);
      return candidate;
    } catch {
      // Not found — try next
    }
  }

  return null;
}

async function directoryExists(value: string) {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

async function resolvePathForWorktreeComparison(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return fs.realpath(resolved).then((realPath) => path.resolve(realPath)).catch(() => resolved);
}

async function listLinkedGitWorktreePaths(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  const paths = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length).trim();
    if (!worktree) continue;
    paths.add(await resolvePathForWorktreeComparison(worktree));
  }
  return paths;
}

export async function inspectManagedGitWorktreeBranch(input: {
  worktreePath: string;
  expectedBranchName: string | null | undefined;
  repoRoot?: string | null;
}): Promise<ManagedGitWorktreeBranchInspection> {
  const worktreePath = await resolvePathForWorktreeComparison(input.worktreePath);
  const expectedBranchName = asString(input.expectedBranchName, "").trim() || null;
  const base = {
    worktreePath,
    expectedBranchName,
    actualBranchName: null,
  };

  if (!await directoryExists(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: `worktree path "${worktreePath}" does not exist`,
      reasonCode: "missing_worktree",
      repoRoot: input.repoRoot ? path.resolve(input.repoRoot) : null,
    };
  }

  const repoRoot = input.repoRoot
    ? path.resolve(input.repoRoot)
    : await resolveGitOwnerRepoRoot(worktreePath).catch(() => null);
  if (!repoRoot) {
    return {
      ...base,
      valid: false,
      reason: "path is not a git checkout",
      reasonCode: "not_a_git_checkout",
      repoRoot: null,
    };
  }

  const listedWorktrees = await listLinkedGitWorktreePaths(repoRoot).catch(() => null);
  if (!listedWorktrees?.has(worktreePath)) {
    return {
      ...base,
      valid: false,
      reason: "path is not registered in `git worktree list`",
      reasonCode: "not_registered",
      repoRoot,
    };
  }

  const worktreeTopLevel = await runGit(["rev-parse", "--show-toplevel"], worktreePath).catch(() => null);
  if (!worktreeTopLevel || path.resolve(worktreeTopLevel) !== worktreePath) {
    return {
      ...base,
      valid: false,
      reason: "git resolves this path to a different repository root",
      reasonCode: "wrong_repository_root",
      repoRoot,
    };
  }

  const actualBranchName = await runGit(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    worktreePath,
  ).catch(() => null);
  if (expectedBranchName && actualBranchName !== expectedBranchName) {
    return {
      ...base,
      valid: false,
      reason: `worktree HEAD is on "${actualBranchName ?? "<detached>"}" instead of "${expectedBranchName}"`,
      reasonCode: "branch_mismatch",
      repoRoot,
      actualBranchName,
    };
  }

  return {
    ...base,
    valid: true,
    reason: null,
    reasonCode: null,
    repoRoot,
    actualBranchName,
  };
}

async function validateLinkedGitWorktree(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranchName: string | null;
}): Promise<
  | { valid: true }
  | {
    valid: false;
    reason: string;
    reasonCode: Exclude<ManagedGitWorktreeBranchInspection["reasonCode"], null>;
    actualBranchName?: string | null;
  }
> {
  const inspection = await inspectManagedGitWorktreeBranch({
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
  });
  return inspection.valid
    ? { valid: true }
    : {
        valid: false,
        reason: inspection.reason ?? "unknown git worktree mismatch",
        reasonCode: inspection.reasonCode ?? "not_a_git_checkout",
        actualBranchName: inspection.actualBranchName,
      };
}

export function formatManagedGitWorktreeBranchInspection(input: ManagedGitWorktreeBranchInspection) {
  return {
    valid: input.valid,
    reason: input.reason,
    reasonCode: input.reasonCode,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    expectedBranchName: input.expectedBranchName,
    actualBranchName: input.actualBranchName,
  };
}

function buildWorkspaceCommandEnv(input: {
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PAPERCLIP_WORKSPACE_CWD = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = input.worktreePath;
  env.PAPERCLIP_WORKSPACE_BRANCH = input.branchName;
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.base.baseCwd;
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.repoRoot;
  env.PAPERCLIP_WORKSPACE_SOURCE = input.base.source;
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.base.repoRef ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.base.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_CREATED = input.created ? "true" : "false";
  env.PAPERCLIP_PROJECT_ID = input.base.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.base.workspaceId ?? "";
  env.PAPERCLIP_AGENT_ID = input.agent.id ?? "";
  env.PAPERCLIP_AGENT_NAME = input.agent.name;
  env.PAPERCLIP_COMPANY_ID = input.agent.companyId;
  env.PAPERCLIP_ISSUE_ID = input.issue?.id ?? "";
  env.PAPERCLIP_ISSUE_IDENTIFIER = input.issue?.identifier ?? "";
  env.PAPERCLIP_ISSUE_TITLE = input.issue?.title ?? "";
  env.PAPERCLIP_ISSUE_WORK_MODE = input.issue?.workMode ?? "";
  return env;
}

function quoteShellArg(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const BUILTIN_WORKSPACE_PROVISION_COMMAND = "bash ./scripts/provision-worktree.sh";

function resolveWorkspaceProvisionCommand(
  strategy: Record<string, unknown>,
  repoRoot: string,
) {
  const configuredCommand = asString(strategy.provisionCommand, "").trim();
  if (configuredCommand) return configuredCommand;

  return existsSync(path.join(repoRoot, "scripts", "provision-worktree.sh"))
    ? BUILTIN_WORKSPACE_PROVISION_COMMAND
    : "";
}

function resolveRepoManagedWorkspaceCommand(command: string, repoRoot: string) {
  const patterns = [
    /^(?<prefix>(?:bash|sh|zsh)\s+)(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
    /^(?<quote>["']?)(?<relative>\.\/[^"'\s]+)\k<quote>(?<suffix>(?:\s.*)?)$/s,
  ];

  for (const pattern of patterns) {
    const match = command.match(pattern);
    if (!match?.groups) continue;

    const relativePath = match.groups.relative;
    const repoManagedPath = path.join(repoRoot, relativePath.slice(2));
    if (!existsSync(repoManagedPath)) continue;

    const prefix = match.groups.prefix ?? "";
    const suffix = match.groups.suffix ?? "";
    return `${prefix}${quoteShellArg(repoManagedPath)}${suffix}`;
  }

  return command;
}

async function runWorkspaceCommand(input: {
  command: string;
  resolvedCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const shell = resolveShell();
  const proc = await executeProcess({
    command: shell,
    args: ["-c", input.resolvedCommand ?? input.command],
    cwd: input.cwd,
    env: input.env,
  });
  if (proc.stdout && input.onLog) await input.onLog("stdout", `[runtime-provision] ${proc.stdout}`);
  if (proc.stderr && input.onLog) await input.onLog("stderr", `[runtime-provision] ${proc.stderr}`);
  if (proc.code === 0) return;

  const details = [proc.stderr.trim(), proc.stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${proc.code ?? -1}`,
  );
}

async function recordGitOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: WorkspaceOperationPhase;
    args: string[];
    cwd: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    failureLabel?: string | null;
  },
): Promise<string> {
  if (!recorder) {
    return runGit(input.args, input.cwd);
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  await recorder.recordOperation({
    phase: input.phase,
    command: formatCommandForDisplay("git", input.args),
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const result = await executeProcess({
        command: "git",
        args: input.args,
        cwd: input.cwd,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      code = result.code;
      return {
        status: result.code === 0 ? "succeeded" : "failed",
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        system: result.code === 0 ? input.successMessage ?? null : null,
        metadata:
          result.stdoutTruncated || result.stderrTruncated
            ? {
                stdoutTruncated: result.stdoutTruncated,
                stderrTruncated: result.stderrTruncated,
                stdoutBytes: result.stdoutBytes,
                stderrBytes: result.stderrBytes,
              }
            : null,
      };
    },
  });

  if (code !== 0) {
    const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(
      details.length > 0
        ? `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed: ${details}`
        : `${input.failureLabel ?? `git ${input.args.join(" ")}`} failed with exit code ${code ?? -1}`,
    );
  }
  return stdout.trim();
}

async function recordWorkspaceCommandOperation(
  recorder: WorkspaceOperationRecorder | null | undefined,
  input: {
    phase: "workspace_provision" | "workspace_seed" | "workspace_runtime_provision" | "workspace_teardown";
    command: string;
    resolvedCommand?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    metadata?: Record<string, unknown> | null;
    successMessage?: string | null;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  },
) {
  if (!recorder) {
    await runWorkspaceCommand(input);
    return null;
  }

  let stdout = "";
  let stderr = "";
  let code: number | null = null;
  const operation = await recorder.recordOperation({
    phase: input.phase,
    command: input.command,
    cwd: input.cwd,
    metadata: input.metadata ?? null,
    run: async () => {
      const shell = resolveShell();
      const result = await executeProcess({
        command: shell,
        args: ["-c", input.resolvedCommand ?? input.command],
        cwd: input.cwd,
        env: input.env,
      });
      const seedEvidence = input.phase === "workspace_seed"
        ? readWorkspaceSeedOperationEvidence(input.cwd)
        : null;
      stdout = result.stdout;
      stderr = [result.stderr, seedEvidence?.error].filter(Boolean).join("\n");
      code = result.code === 0 && seedEvidence && !seedEvidence.verified ? 1 : result.code;
      if (result.stdout && input.onLog) await input.onLog("stdout", `[runtime-provision] ${result.stdout}`);
      if (stderr && input.onLog) await input.onLog("stderr", `[runtime-provision] ${stderr}`);
      const truncationMetadata = result.stdoutTruncated || result.stderrTruncated
        ? {
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
          }
        : null;
      return {
        status: code === 0 ? "succeeded" : "failed",
        exitCode: code,
        stdout: result.stdout,
        stderr,
        system: code === 0 ? input.successMessage ?? null : null,
        metadata: seedEvidence
          ? { ...seedEvidence.metadata, ...(truncationMetadata ?? {}) }
          : truncationMetadata,
      };
    },
  });

  if (code === 0) return operation;

  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  throw new Error(
    details.length > 0
      ? `${input.label} failed: ${details}`
      : `${input.label} failed with exit code ${code ?? -1}`,
  );
}

async function provisionExecutionWorktree(input: {
  strategy: Record<string, unknown>;
  base: ExecutionWorkspaceInput;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  created: boolean;
  recorder?: WorkspaceOperationRecorder | null;
}) {
  const provisionCommand = resolveWorkspaceProvisionCommand(input.strategy, input.repoRoot);
  if (!provisionCommand) return;
  const resolvedProvisionCommand = resolveRepoManagedWorkspaceCommand(provisionCommand, input.repoRoot);

  await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: provisionCommand,
    resolvedCommand: resolvedProvisionCommand,
    cwd: input.worktreePath,
    env: buildWorkspaceCommandEnv({
      base: input.base,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      issue: input.issue,
      agent: input.agent,
      created: input.created,
    }),
    label: `Execution workspace provision command "${provisionCommand}"`,
    metadata: {
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      created: input.created,
      resolvedCommand: resolvedProvisionCommand === provisionCommand ? null : resolvedProvisionCommand,
    },
    successMessage: `Provisioned workspace at ${input.worktreePath}\n`,
  });
}

function buildExecutionWorkspaceCleanupEnv(input: {
  workspace: {
    cwd: string | null;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
  };
  projectWorkspaceCwd?: string | null;
}) {
  const env: NodeJS.ProcessEnv = sanitizeRuntimeServiceBaseEnv(process.env);
  env.PAPERCLIP_WORKSPACE_CWD = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_PATH = input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_WORKTREE_PATH =
    input.workspace.providerRef ?? input.workspace.cwd ?? "";
  env.PAPERCLIP_WORKSPACE_BRANCH = input.workspace.branchName ?? "";
  env.PAPERCLIP_WORKSPACE_BASE_CWD = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_ROOT = input.projectWorkspaceCwd ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_URL = input.workspace.repoUrl ?? "";
  env.PAPERCLIP_WORKSPACE_REPO_REF = input.workspace.baseRef ?? "";
  env.PAPERCLIP_PROJECT_ID = input.workspace.projectId ?? "";
  env.PAPERCLIP_PROJECT_WORKSPACE_ID = input.workspace.projectWorkspaceId ?? "";
  env.PAPERCLIP_ISSUE_ID = input.workspace.sourceIssueId ?? "";
  return env;
}

async function resolveGitRepoRootForWorkspaceCleanup(
  worktreePath: string,
  projectWorkspaceCwd: string | null,
): Promise<string | null> {
  if (projectWorkspaceCwd) {
    const resolvedProjectWorkspaceCwd = path.resolve(projectWorkspaceCwd);
    const gitDir = await runGit(["rev-parse", "--git-common-dir"], resolvedProjectWorkspaceCwd)
      .catch(() => null);
    if (gitDir) {
      const resolvedGitDir = path.resolve(resolvedProjectWorkspaceCwd, gitDir);
      return path.dirname(resolvedGitDir);
    }
  }

  const gitDir = await runGit(["rev-parse", "--git-common-dir"], worktreePath).catch(() => null);
  if (!gitDir) return null;
  const resolvedGitDir = path.resolve(worktreePath, gitDir);
  return path.dirname(resolvedGitDir);
}

export async function realizeExecutionWorkspace(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  config: Record<string, unknown>;
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<RealizedExecutionWorkspace> {
  const rawStrategy = parseObject(input.config.workspaceStrategy);
  const strategyType = asString(rawStrategy.type, "project_primary");
  if (strategyType !== "git_worktree") {
    return {
      ...input.base,
      strategy: "project_primary",
      cwd: input.base.baseCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      baseRefSha: null,
    };
  }

  const repoRoot = await resolveGitOwnerRepoRoot(input.base.baseCwd);
  const branchTemplate = asString(rawStrategy.branchTemplate, "{{issue.identifier}}-{{slug}}");
  const renderedBranch = renderWorkspaceTemplate(branchTemplate, {
    issue: input.issue,
    agent: input.agent,
    projectId: input.base.projectId,
    repoRef: input.base.repoRef,
  });
  let branchName = sanitizeBranchName(renderedBranch);
  const configuredParentDir = asString(rawStrategy.worktreeParentDir, "");
  const worktreeParentDir = configuredParentDir
    ? resolveConfiguredPath(configuredParentDir, repoRoot)
    : path.join(repoRoot, ".paperclip", "worktrees");
  const worktreePath = path.join(worktreeParentDir, branchName);
  let pendingForwardBranchReconcile: PendingForwardBranchReconcile | null = null;
  const configuredBaseRef = typeof rawStrategy.baseRef === "string" && rawStrategy.baseRef.length > 0
    ? rawStrategy.baseRef
    : input.base.repoRef ?? null;
  const baseRefResolution = await resolveAuthoritativeBaseRef(repoRoot, configuredBaseRef, input.resolveGitAuth);
  // Keep a usable base ref for the reuse and drift paths even when the ref is
  // unresolved: those paths tolerate a null base-ref SHA and never run
  // `git worktree add -b <branch> <baseRef>`. Only the fresh-create path below
  // stops on an unresolved ref. `baseRefAlreadyRefreshed` is true for the
  // unresolved case because the resolver already attempted the fetch.
  const baseRef = baseRefResolution.resolved ? baseRefResolution.baseRef : baseRefResolution.requestedRef;
  const baseRefResolutionWarnings = baseRefResolution.warnings;
  const baseRefAlreadyRefreshed = baseRefResolution.resolved ? baseRefResolution.refreshed : true;
  const baseRefreshWarnings = [
    ...baseRefResolutionWarnings,
    ...(baseRefAlreadyRefreshed ? [] : await refreshRemoteTrackingBaseRef(repoRoot, baseRef, input.resolveGitAuth)),
  ];
  const currentBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);

  await fs.mkdir(worktreeParentDir, { recursive: true });

  async function reuseExistingWorktree(reusablePath: string, effectiveBranchName = branchName, extraWarnings: string[] = []) {
    const refresh = currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reusablePath,
      branchName,
      baseRef,
      recordedBaseRefSha: null,
      skipRefresh: true,
    });
    if (input.recorder) {
      await input.recorder.recordOperation({
        phase: "worktree_prepare",
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath: reusablePath,
          branchName: effectiveBranchName,
          baseRef,
          currentBaseRefSha: baseDrift.currentBaseRefSha,
          branchBaseRefSha: baseDrift.branchBaseRefSha,
          created: false,
          reused: true,
        },
        run: async () => ({
          status: "succeeded",
          exitCode: 0,
          system: `Reused existing git worktree at ${reusablePath}\n`,
        }),
      });
    }
    await provisionExecutionWorktree({
      strategy: rawStrategy,
      base: input.base,
      repoRoot,
      worktreePath: reusablePath,
      branchName: effectiveBranchName,
      issue: input.issue,
      agent: input.agent,
      created: false,
      recorder: input.recorder ?? null,
    });
    return {
      ...input.base,
      repoRef: baseRef,
      strategy: "git_worktree" as const,
      cwd: reusablePath,
      branchName: effectiveBranchName,
      worktreePath: reusablePath,
      warnings: [...extraWarnings, ...baseRefreshWarnings, ...baseDrift.warnings],
      created: false,
      baseRefSha: refresh.baseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha,
      pendingForwardBranchReconcile,
    };
  }

  async function validateReusableWorktree(reusablePath: string) {
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reusablePath,
      expectedBranchName: branchName,
    }).catch(() => null);
    if (validation && !validation.valid && validation.reasonCode === "branch_mismatch") {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: branchName,
        actualBranchName: validation.actualBranchName ?? null,
        sourceIssue: input.issue,
        executionWorkspaceId: null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      const effectiveBranchName = coherence.branchName ?? branchName;
      if (coherence.reconciledForward) {
        branchName = effectiveBranchName;
        pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      const nextValidation = await validateLinkedGitWorktree({
        repoRoot,
        worktreePath: reusablePath,
        expectedBranchName: effectiveBranchName,
      }).catch(() => null);
      return {
        validation: nextValidation,
        branchName: effectiveBranchName,
        warnings: coherence.warnings,
      };
    }
    return { validation, branchName, warnings: [] };
  }

  const existingWorktree = await directoryExists(worktreePath);
  if (existingWorktree) {
    const reusable = await validateReusableWorktree(worktreePath);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(worktreePath, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Configured worktree path "${worktreePath}" already exists and is not a reusable git worktree${reason}.`);
  }

  const registeredBranchWorktree = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
  if (registeredBranchWorktree) {
    const reusable = await validateReusableWorktree(registeredBranchWorktree);
    if (reusable.validation?.valid) {
      return await reuseExistingWorktree(registeredBranchWorktree, reusable.branchName, reusable.warnings);
    }
    const validation = reusable.validation;
    const reason = validation && !validation.valid ? ` (${validation.reason})` : "";
    throw new Error(`Registered worktree for branch "${branchName}" at "${registeredBranchWorktree}" is not reusable${reason}.`);
  }

  // No reusable worktree exists, so a fresh `git worktree add -b <branch> <baseRef>`
  // must run next. An unresolved base ref would make git fail with
  // `fatal: invalid reference`. Stop here instead and raise a pre-dispatch
  // configuration failure that the setup catch routes to a human owner.
  if (!baseRefResolution.resolved) {
    throw new UnresolvedWorkspaceBaseRefError({
      requestedRef: baseRefResolution.requestedRef,
      recoveryIdentityRef: baseRefResolution.recoveryIdentityRef,
      attemptedRefs: baseRefResolution.attemptedRefs,
      fetchError: baseRefResolution.fetchError,
    });
  }

  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: currentBaseRefSha,
        created: true,
      },
      successMessage: `Created git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (!gitErrorIncludes(error, "already exists")) {
      throw error;
    }
    try {
      await recordGitOperation(input.recorder, {
        phase: "worktree_prepare",
        args: ["worktree", "add", worktreePath, branchName],
        cwd: repoRoot,
        metadata: {
          repoRoot,
          worktreePath,
          branchName,
          baseRef,
          baseRefSha: currentBaseRefSha,
          created: false,
          reusedExistingBranch: true,
        },
        successMessage: `Attached existing branch ${branchName} at ${worktreePath}\n`,
        failureLabel: `git worktree add ${worktreePath}`,
      });
    } catch (attachError) {
      if (!gitErrorIncludes(attachError, "already checked out")) {
        throw attachError;
      }
      const reusablePath = await findRegisteredGitWorktreeByBranch(repoRoot, branchName);
      if (!reusablePath || !await isGitCheckout(reusablePath)) {
        throw attachError;
      }
      return await reuseExistingWorktree(reusablePath);
    }
  }
  await provisionExecutionWorktree({
    strategy: rawStrategy,
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created: true,
    recorder: input.recorder ?? null,
  });

  return {
    ...input.base,
    repoRef: baseRef,
    strategy: "git_worktree",
    cwd: worktreePath,
    branchName,
    worktreePath,
    warnings: baseRefreshWarnings,
    created: true,
    baseRefSha: currentBaseRefSha,
  };
}

export async function ensurePersistedExecutionWorkspaceAvailable(input: {
  db?: Db | null;
  base: ExecutionWorkspaceInput;
  workspace: {
    id?: string | null;
    mode: string | null | undefined;
    strategyType: string | null | undefined;
    cwd: string | null | undefined;
    providerRef: string | null | undefined;
    projectId: string | null | undefined;
    projectWorkspaceId: string | null | undefined;
    repoUrl: string | null | undefined;
    baseRef: string | null | undefined;
    branchName: string | null | undefined;
    metadata?: Record<string, unknown> | null;
    config?: {
      provisionCommand?: string | null;
      runtimeProvisionCommand?: string | null;
    } | null;
  };
  issue: ExecutionWorkspaceIssueRef | null;
  agent: ExecutionWorkspaceAgentRef;
  heartbeatRunId?: string | null;
  enableWorkspaceBranchReconcileForward?: boolean;
  enableWorkspaceDirtyQuarantineRepair?: boolean;
  recorder?: WorkspaceOperationRecorder | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<RealizedExecutionWorkspace | null> {
  const cwd = asString(input.workspace.cwd ?? input.workspace.providerRef, "").trim();
  if (!cwd) return null;

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  const realized: RealizedExecutionWorkspace = {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    additionalWorkspaces: input.base.additionalWorkspaces ?? [],
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (input.workspace.providerRef ?? cwd) : null,
    warnings: [],
    created: false,
    baseRefSha: readRecordedBaseRefSha(input.workspace.metadata),
  };
  const provisionCommand = asString(input.workspace.config?.provisionCommand, "").trim();

  if (strategy !== "git_worktree") {
    if (!await directoryExists(cwd)) {
      return null;
    }
    return realized;
  }
  // Validate the base checkout before the git spawn. A missing or empty base
  // path makes the "git" spawn fail with a raw "spawn git ENOENT" error. That
  // error hides the real cause: the base project checkout is not on disk.
  // Throw a clear cause first so a future failure names the missing checkout.
  // Keep the persisted path exact. A directory name can start or end with a
  // space, so a trim would change a valid checkout path.
  const baseCwd = asString(input.base.baseCwd, "");
  if (!baseCwd) {
    throw new Error(
      "Cannot rebuild the git worktree: the base project checkout path is empty.",
    );
  }
  if (!await directoryExists(baseCwd)) {
    throw new Error(
      "Cannot rebuild the git worktree: the base project checkout directory does not exist.",
    );
  }
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], baseCwd);
  const recordedBaseRefSha = readRecordedBaseRefSha(input.workspace.metadata);
  if (await directoryExists(cwd)) {
    const reuseBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
    const reuseWorktreePath = realized.worktreePath ?? cwd;
    const repairWarnings: string[] = [];
    if (await isGitCheckout(reuseWorktreePath)) {
      const coherence = await ensureGitWorktreeBranchCoherent({
        db: input.db ?? null,
        repoRoot,
        worktreePath: reuseWorktreePath,
        expectedBranchName: realized.branchName,
        sourceIssue: input.issue,
        executionWorkspaceId: input.workspace.id ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
        enableWorkspaceBranchReconcileForward: input.enableWorkspaceBranchReconcileForward === true,
        enableWorkspaceDirtyQuarantineRepair: input.enableWorkspaceDirtyQuarantineRepair === true,
        persistForwardReconcile: false,
        reconcileOperationPhase: "worktree_prepare",
        recorder: input.recorder ?? null,
      });
      if (coherence.branchName) {
        realized.branchName = coherence.branchName;
      }
      if (coherence.reconciledForward) {
        realized.pendingForwardBranchReconcile = coherence.pendingForwardBranchReconcile ?? null;
      }
      repairWarnings.push(...coherence.warnings);
    }
    const validation = await validateLinkedGitWorktree({
      repoRoot,
      worktreePath: reuseWorktreePath,
      expectedBranchName: realized.branchName,
    });
    if (!validation.valid) {
      throw new WorkspaceRuntimeValidationFailure(
        `Persisted git worktree "${reuseWorktreePath}" is not reusable (${validation.reason}).`,
        {
          workspaceValidation: {
            reason: "git_worktree_not_reusable",
            reasonCode: validation.reasonCode,
            worktreePath: reuseWorktreePath,
            executionWorkspaceId: input.workspace.id ?? null,
          },
        },
      );
    }
    const baseRefreshWarnings = reuseBaseRef
      ? await refreshRemoteTrackingBaseRef(repoRoot, reuseBaseRef, input.resolveGitAuth)
      : [];
    const currentBaseRefSha = reuseBaseRef ? await resolveBaseRefSha(repoRoot, reuseBaseRef) : null;
    const refresh = reuseBaseRef && currentBaseRefSha
      ? await refreshUnstartedWorktreeToBase({
          repoRoot,
          worktreePath: reuseWorktreePath,
          branchName: realized.branchName,
          baseRef: reuseBaseRef,
          currentBaseRefSha,
          recorder: input.recorder ?? null,
        })
      : { refreshed: false, baseRefSha: null };
    const baseDrift = await inspectExecutionWorkspaceBaseDrift({
      repoRoot,
      worktreePath: reuseWorktreePath,
      branchName: realized.branchName,
      baseRef: reuseBaseRef,
      recordedBaseRefSha,
      skipRefresh: true,
    });
    realized.warnings = [...repairWarnings, ...baseRefreshWarnings, ...baseDrift.warnings];
    realized.baseRefSha = refresh.baseRefSha ?? recordedBaseRefSha ?? baseDrift.branchBaseRefSha ?? baseDrift.currentBaseRefSha;
    await provisionExecutionWorktree({
      strategy: {
        type: "git_worktree",
        ...(provisionCommand ? { provisionCommand } : {}),
      },
      base: input.base,
      repoRoot,
      worktreePath: realized.worktreePath ?? cwd,
      branchName: realized.branchName ?? "",
      issue: input.issue,
      agent: input.agent,
      created: false,
      recorder: input.recorder ?? null,
    });
    return realized;
  }

  const worktreePath = realized.worktreePath ?? cwd;
  const branchName = asString(input.workspace.branchName, "").trim();
  if (!branchName) {
    throw new Error(`Execution workspace "${cwd}" is missing and cannot be restored because no branch name is recorded.`);
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await runGit(["worktree", "prune"], repoRoot).catch(() => {});
  const restoreBaseRef = input.workspace.baseRef ?? input.base.repoRef ?? null;
  const restoreRefreshWarnings = restoreBaseRef
    ? await refreshRemoteTrackingBaseRef(repoRoot, restoreBaseRef, input.resolveGitAuth)
    : [];
  const restoreCurrentBaseRefSha = restoreBaseRef ? await resolveBaseRefSha(repoRoot, restoreBaseRef) : null;

  let created = false;
  try {
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", worktreePath, branchName],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
        currentBaseRefSha: restoreCurrentBaseRefSha,
        created: false,
        restored: true,
      },
      successMessage: `Reattached missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
  } catch (error) {
    if (
      !gitErrorIncludes(error, "invalid reference")
      && !gitErrorIncludes(error, "not a commit")
      && !gitErrorIncludes(error, "unknown revision")
    ) {
      throw error;
    }
    const baseRef = input.workspace.baseRef ?? await detectDefaultBranch(repoRoot) ?? "HEAD";
    const recreatedBaseRefSha = await resolveBaseRefSha(repoRoot, baseRef);
    await recordGitOperation(input.recorder, {
      phase: "worktree_prepare",
      args: ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      cwd: repoRoot,
      metadata: {
        repoRoot,
        worktreePath,
        branchName,
        baseRef,
        baseRefSha: recreatedBaseRefSha,
        created: true,
        restored: true,
      },
      successMessage: `Recreated missing git worktree at ${worktreePath}\n`,
      failureLabel: `git worktree add ${worktreePath}`,
    });
    created = true;
  }

  const baseDrift = await inspectExecutionWorkspaceBaseDrift({
    repoRoot,
    worktreePath,
    branchName,
    baseRef: input.workspace.baseRef ?? input.base.repoRef ?? null,
    recordedBaseRefSha,
    skipRefresh: true,
  });

  await provisionExecutionWorktree({
    strategy: {
      type: "git_worktree",
      ...(provisionCommand ? { provisionCommand } : {}),
    },
    base: input.base,
    repoRoot,
    worktreePath,
    branchName,
    issue: input.issue,
    agent: input.agent,
    created,
    recorder: input.recorder ?? null,
  });

  return {
    ...realized,
    cwd: worktreePath,
    worktreePath,
    warnings: [...restoreRefreshWarnings, ...baseDrift.warnings],
    created,
    baseRefSha:
      recordedBaseRefSha
      ?? (created ? restoreCurrentBaseRefSha : baseDrift.branchBaseRefSha)
      ?? baseDrift.currentBaseRefSha,
  };
}

export async function acquireGitWorktreeCleanupLock(worktreePath: string) {
  const branchRef = await runGit(["symbolic-ref", "--quiet", "HEAD"], worktreePath).catch(() => null);
  const rawLocks = await Promise.all([
    runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
      .then((lockPath) => ({ kind: "index" as const, lockPath })),
    runGit(["rev-parse", "--git-path", "HEAD.lock"], worktreePath)
      .then((lockPath) => ({ kind: "head" as const, lockPath })),
    ...(branchRef
      ? [runGit(["rev-parse", "--git-path", `${branchRef}.lock`], worktreePath)
          .then((lockPath) => ({ kind: "branch" as const, lockPath }))]
      : []),
  ]);
  const locks = [...new Map(rawLocks.map(({ kind, lockPath }) => {
    const resolvedLockPath = path.isAbsolute(lockPath)
      ? lockPath
      : path.resolve(worktreePath, lockPath);
    return [resolvedLockPath, { kind, lockPath: resolvedLockPath }];
  })).values()];
  const lockHandles: Array<{
    handle: fs.FileHandle;
    kind: "index" | "head" | "branch";
    lockPath: string;
  }> = [];

  async function releaseLocks(kind?: "branch") {
    for (let index = lockHandles.length - 1; index >= 0; index -= 1) {
      const lock = lockHandles[index];
      if (!lock || (kind && lock.kind !== kind)) continue;
      lockHandles.splice(index, 1);
      await lock.handle.close().catch(() => {});
      await fs.rm(lock.lockPath, { force: true }).catch(() => {});
    }
  }

  try {
    for (const lock of locks) {
      lockHandles.push({
        ...lock,
        handle: await fs.open(lock.lockPath, "wx", 0o600),
      });
    }
  } catch (error) {
    await releaseLocks();
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("git worktree cleanup lock is already held");
    }
    throw error;
  }

  return {
    // Branch deletion must acquire this native ref lock itself. Callers release
    // only that lock after the guarded worktree removal, while retaining the
    // index and HEAD locks until the whole cleanup transaction finishes.
    releaseBranchRefLock: () => releaseLocks("branch"),
    release: () => releaseLocks(),
  };
}

async function deleteGitBranchAtVerifiedTip(input: {
  repoRoot: string;
  branchName: string;
  expectedHeadSha: string;
  recorder?: WorkspaceOperationRecorder | null;
  metadata: Record<string, unknown>;
}) {
  const commonDirRaw = await runGit(["rev-parse", "--git-common-dir"], input.repoRoot);
  const commonDir = path.isAbsolute(commonDirRaw)
    ? commonDirRaw
    : path.resolve(input.repoRoot, commonDirRaw);
  const detachedGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-branch-delete-"));
  const detachedWorktree = `${detachedGitDir}-worktree`;

  try {
    // `git branch -d` refuses branches checked out by another worktree and its
    // ref transaction fails if the tip changes concurrently. A detached HEAD
    // at the delivered SHA additionally lets squash/cross-branch deliveries
    // delete only the exact branch history that was verified before cleanup.
    await Promise.all([
      fs.writeFile(path.join(detachedGitDir, "HEAD"), `${input.expectedHeadSha}\n`, "utf8"),
      fs.writeFile(path.join(detachedGitDir, "commondir"), `${commonDir}\n`, "utf8"),
    ]);
    await recordGitOperation(input.recorder, {
      phase: "worktree_cleanup",
      args: [
        `--git-dir=${detachedGitDir}`,
        `--work-tree=${detachedWorktree}`,
        "branch",
        "-d",
        input.branchName,
      ],
      cwd: input.repoRoot,
      metadata: input.metadata,
      successMessage: `Deleted branch ${input.branchName}\n`,
      failureLabel: `git branch -d ${input.branchName}`,
    });
  } finally {
    await fs.rm(detachedGitDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cleanupExecutionWorkspaceArtifacts(input: {
  workspace: {
    id: string;
    cwd: string | null;
    providerType: string;
    providerRef: string | null;
    branchName: string | null;
    repoUrl: string | null;
    baseRef: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    sourceIssueId: string | null;
    metadata?: Record<string, unknown> | null;
  };
  projectWorkspace?: {
    cwd: string | null;
    cleanupCommand: string | null;
  } | null;
  cleanupCommand?: string | null;
  teardownCommand?: string | null;
  recorder?: WorkspaceOperationRecorder | null;
  assertSafeToCleanup?: (() => Promise<void>) | null;
  beforeBranchDelete?: (() => Promise<void>) | null;
  expectedBranchHeadSha?: string | null;
  runCleanupCommands?: boolean;
  forceWorktreeRemoval?: boolean;
}) {
  const warnings: string[] = [];
  const workspacePath = input.workspace.providerRef ?? input.workspace.cwd;
  const repoRoot = input.workspace.providerType === "git_worktree" && workspacePath
    ? await resolveGitRepoRootForWorkspaceCleanup(
      workspacePath,
      input.projectWorkspace?.cwd ?? null,
    )
    : null;
  const cleanupEnv = buildExecutionWorkspaceCleanupEnv({
    workspace: input.workspace,
    projectWorkspaceCwd: input.projectWorkspace?.cwd ?? null,
  });
  // Callers can require the workspace to match an assessed snapshot before
  // cleanup begins. Destructive paths recheck immediately before removal.
  await input.assertSafeToCleanup?.();
  let worktreeInstancePointer: WorktreeInstancePointer | null = null;
  let expectedWorktreeInstanceId: string | null = null;
  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    expectedWorktreeInstanceId = deriveWorktreeInstanceId(workspacePath);
    try {
      // Capture the pointer before custom cleanup commands can remove the repo-local env file.
      worktreeInstancePointer = await readWorktreeInstancePointer(workspacePath);
    } catch (err) {
      warnings.push(`Could not read worktree instance pointer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const createdByRuntime = input.workspace.metadata?.createdByRuntime === true;
  const cleanupCommands = input.runCleanupCommands === false
    ? []
    : [
        input.cleanupCommand ?? null,
        input.projectWorkspace?.cleanupCommand ?? null,
        input.teardownCommand ?? null,
      ]
        .map((value) => asString(value, "").trim())
        .filter(Boolean);

  for (const command of cleanupCommands) {
    try {
      const resolvedCommand = repoRoot
        ? resolveRepoManagedWorkspaceCommand(command, repoRoot)
        : command;
      await recordWorkspaceCommandOperation(input.recorder, {
        phase: "workspace_teardown",
        command,
        resolvedCommand,
        cwd: workspacePath ?? input.projectWorkspace?.cwd ?? process.cwd(),
        env: cleanupEnv,
        label: `Execution workspace cleanup command "${command}"`,
        metadata: {
          workspaceId: input.workspace.id,
          workspacePath,
          branchName: input.workspace.branchName,
          providerType: input.workspace.providerType,
          resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
        },
        successMessage: `Completed cleanup command "${command}"\n`,
      });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (worktreeInstancePointer && workspacePath && expectedWorktreeInstanceId) {
    try {
      const result = await cleanupWorktreeInstanceArtifacts({
        pointer: worktreeInstancePointer,
        workspaceId: input.workspace.id,
        workspacePath,
        expectedInstanceId: expectedWorktreeInstanceId,
        expectedInstanceRoot:
          typeof input.workspace.metadata?.[WORKTREE_INSTANCE_ROOT_METADATA_KEY] === "string"
            ? input.workspace.metadata[WORKTREE_INSTANCE_ROOT_METADATA_KEY]
            : null,
        recorder: input.recorder,
      });
      if (result.status === "refused") warnings.push(result.warning);
    } catch (err) {
      warnings.push(`Failed to clean worktree instance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (input.workspace.providerType === "git_worktree" && workspacePath) {
    const worktreeExists = await directoryExists(workspacePath);
    if (worktreeExists) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root for "${workspacePath}".`);
      } else {
        try {
          await input.assertSafeToCleanup?.();
          await recordGitOperation(input.recorder, {
            phase: "worktree_cleanup",
            args: [
              "worktree",
              "remove",
              ...(input.forceWorktreeRemoval === false ? [] : ["--force"]),
              workspacePath,
            ],
            cwd: repoRoot,
            metadata: {
              workspaceId: input.workspace.id,
              workspacePath,
              branchName: input.workspace.branchName,
              cleanupAction: "worktree_remove",
            },
            successMessage: `Removed git worktree ${workspacePath}\n`,
            failureLabel: `git worktree remove ${workspacePath}`,
          });
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
    if (createdByRuntime && input.workspace.branchName) {
      if (!repoRoot) {
        warnings.push(`Could not resolve git repo root to delete branch "${input.workspace.branchName}".`);
      } else {
        try {
          await input.beforeBranchDelete?.();
          const metadata = {
            workspaceId: input.workspace.id,
            workspacePath,
            branchName: input.workspace.branchName,
            cleanupAction: "branch_delete",
          };
          if (input.expectedBranchHeadSha) {
            await deleteGitBranchAtVerifiedTip({
              repoRoot,
              branchName: input.workspace.branchName,
              expectedHeadSha: input.expectedBranchHeadSha,
              recorder: input.recorder,
              metadata,
            });
          } else {
            await recordGitOperation(input.recorder, {
              phase: "worktree_cleanup",
              args: ["branch", "-d", input.workspace.branchName],
              cwd: repoRoot,
              metadata,
              successMessage: `Deleted branch ${input.workspace.branchName}\n`,
              failureLabel: `git branch -d ${input.workspace.branchName}`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Skipped deleting branch "${input.workspace.branchName}": ${message}`);
        }
      }
    }
  } else if (input.workspace.providerType === "local_fs" && createdByRuntime && workspacePath) {
    const projectWorkspaceCwd = input.projectWorkspace?.cwd ? path.resolve(input.projectWorkspace.cwd) : null;
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const containsProjectWorkspace = projectWorkspaceCwd
      ? (
          resolvedWorkspacePath === projectWorkspaceCwd ||
          projectWorkspaceCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
        )
      : false;
    if (containsProjectWorkspace) {
      warnings.push(`Refusing to remove path "${workspacePath}" because it contains the project workspace.`);
    } else {
      await input.assertSafeToCleanup?.();
      await fs.rm(resolvedWorkspacePath, { recursive: true, force: true });
      if (input.recorder) {
        await input.recorder.recordOperation({
          phase: "workspace_teardown",
          cwd: projectWorkspaceCwd ?? process.cwd(),
          metadata: {
            workspaceId: input.workspace.id,
            workspacePath: resolvedWorkspacePath,
            cleanupAction: "remove_local_fs",
          },
          run: async () => ({
            status: "succeeded",
            exitCode: 0,
            system: `Removed local workspace directory ${resolvedWorkspacePath}\n`,
          }),
        });
      }
    }
  }

  const cleaned =
    !workspacePath ||
    !(await directoryExists(workspacePath));

  return {
    cleanedPath: workspacePath,
    cleaned,
    warnings,
  };
}

/**
 * Ports this process has handed to a starting runtime service but that no listener owns yet.
 * The kernel will happily hand the same ephemeral port to two concurrent `listen(0)` probes
 * once each probe socket closes, which is how two isolated workspaces starting at the same
 * moment ended up fighting over one port pair. Reserving the port for the duration of the
 * start makes concurrent allocations distinct.
 */
const inFlightAllocatedPorts = new Map<number, number>();
const PORT_RESERVATION_TTL_MS = 120_000;
const PORT_ALLOCATION_ATTEMPTS = 12;

export function resetRuntimeServicePortReservationsForTests() {
  inFlightAllocatedPorts.clear();
}

function reservePortIfFree(port: number, now = Date.now()): boolean {
  const heldUntil = inFlightAllocatedPorts.get(port);
  if (heldUntil !== undefined && heldUntil > now) return false;
  inFlightAllocatedPorts.set(port, now + PORT_RESERVATION_TTL_MS);
  return true;
}

/**
 * Claim the loopback port a start is about to bind. A configured port that reads free right now
 * can still be taken by a sibling workspace that is mid-start — neither has bound yet and
 * neither has a persisted row — so the claim is what makes the loser fail terminally here
 * instead of racing to bind and then hanging on a readiness probe it can never satisfy.
 * A start already holding the port from its own allocation must not be refused by itself.
 */
export function claimRuntimeServiceBindPort(bindPort: number, alreadyReservedPort: number | null) {
  if (bindPort === alreadyReservedPort) return true;
  return reservePortIfFree(bindPort);
}

function releasePortReservation(port: number | null | undefined) {
  if (typeof port !== "number") return;
  inFlightAllocatedPorts.delete(port);
}

async function probeEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate port"));
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

/**
 * Execution workspaces whose exclusive lease is still open.
 *
 * "Open" is deliberately generous — every non-archived, non-closed status
 * counts — because the reservation must outlive the *process*, not track it.
 * A lane that is stopped, torn down, and reported `removed` still owns its
 * pair until the workspace itself is released (PAP-17419).
 */
async function readActiveExecutionWorkspaceLeases(db: Db | undefined, companyId: string): Promise<Set<string>> {
  if (!db) return new Set<string>();
  const rows = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, companyId),
        inArray(executionWorkspaces.status, [...OPEN_EXECUTION_WORKSPACE_LEASE_STATUSES]),
        isNull(executionWorkspaces.closedAt),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Every reservation view the allocator must respect, merged into one ledger.
 *
 * This replaced a set-of-ports that only ever saw rows whose `exposure.state`
 * was not `removed`. That view could not represent the case that actually
 * broke: a leased workspace whose exposure had been torn down. See
 * `port-reservation.ts` for why the pair is re-derived from the `port` column.
 */
async function buildCompanyExposureReservationLedger(input: {
  db?: Db;
  companyId: string;
  brokerMappings?: BrokerMappingSnapshot[];
}): Promise<ExposureReservationLedger> {
  const inMemoryRuntimes: InMemoryExposureSnapshot[] = [];
  for (const record of runtimeServicesById.values()) {
    if (record.companyId !== input.companyId || !record.exposure) continue;
    inMemoryRuntimes.push({
      runtimeServiceId: record.id,
      executionWorkspaceId: record.executionWorkspaceId,
      projectWorkspaceId: record.projectWorkspaceId,
      issueId: record.issueId,
      ports: record.exposure.listeners.map((listener) => listener.targetPort),
    });
  }

  const persistedRows: PersistedExposureRowSnapshot[] = input.db
    ? (
      await input.db
        .select({
          id: workspaceRuntimeServices.id,
          status: workspaceRuntimeServices.status,
          port: workspaceRuntimeServices.port,
          exposure: workspaceRuntimeServices.exposure,
          executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId,
          projectWorkspaceId: workspaceRuntimeServices.projectWorkspaceId,
          issueId: workspaceRuntimeServices.issueId,
        })
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.companyId, input.companyId))
    ).map((row) => ({
      id: row.id,
      status: row.status,
      port: row.port,
      exposure: row.exposure,
      executionWorkspaceId: row.executionWorkspaceId,
      projectWorkspaceId: row.projectWorkspaceId,
      issueId: row.issueId,
    }))
    : [];

  return buildExposureReservationLedger({
    persistedRows,
    inMemoryRuntimes,
    brokerMappings: input.brokerMappings ?? [],
    quarantinedPorts: quarantinedRuntimeExposurePorts,
    activeExecutionWorkspaceIds: await readActiveExecutionWorkspaceLeases(input.db, input.companyId),
    inFlightClaimedPorts: exposurePortPairClaims.activePorts(),
  });
}

/**
 * Rows Paperclip reports stopped/removed whose reserved pair is still live on
 * the host or still mapped to someone else (PAP-17419 regression #3).
 *
 * The point is visibility. A false `stopped`/`removed` row used to be
 * indistinguishable from a genuinely released one, so the pair silently
 * returned to the free list and the next managed start collided with — or
 * adopted — an unrelated workspace's service. Surfacing it does not stop or
 * mutate the occupying service; that stays the owning issue's call.
 */
async function detectPersistedExposureReservationDrift(input: {
  rows: ReadonlyArray<{
    id: string;
    status: string;
    port: number | null;
    exposure: RuntimeExposureStatus | null;
    executionWorkspaceId: string | null;
    projectWorkspaceId: string | null;
    issueId: string | null;
  }>;
  ownedListeners: Awaited<ReturnType<BrokerClient["list"]>> | null;
}) {
  const snapshots: PersistedExposureRowSnapshot[] = input.rows.map((row) => ({
    id: row.id,
    status: row.status,
    port: row.port,
    exposure: row.exposure,
    executionWorkspaceId: row.executionWorkspaceId,
    projectWorkspaceId: row.projectWorkspaceId,
    issueId: row.issueId,
  }));

  // Probe only the ports dormant rows actually reserve; a startup sweep must not
  // walk the whole dedicated range.
  const candidatePorts = new Set<number>();
  for (const row of snapshots) {
    if (row.status !== "stopped" && row.status !== "failed" && row.exposure && row.exposure.state !== "removed") {
      continue;
    }
    for (const port of collectRowExposurePorts(row)) candidatePorts.add(port);
  }

  const livePorts = new Set<number>();
  for (const port of candidatePorts) {
    // "Not bindable" is the liveness signal the rest of this module already uses.
    const available = await workspaceRuntimeExposureDeps.isPortAvailable(port).catch(() => true);
    if (!available) livePorts.add(port);
  }

  return findExposureReservationDrift({
    persistedRows: snapshots,
    livePorts,
    listenerOwners: await readExposureListenerOwners([...livePorts]),
    brokerMappings: (input.ownedListeners ?? []).map((listener) => ({
      runtimeId: listener.runtimeId,
      port: listener.port,
    })),
  });
}

/** Paperclip-owned Serve mappings, or null when the broker cannot be read. */
async function readBrokerExposureMappings(): Promise<BrokerMappingSnapshot[] | null> {
  try {
    const owned = await workspaceRuntimeExposureDeps.broker.list();
    return owned.map((listener) => ({ runtimeId: listener.runtimeId, port: listener.port }));
  } catch {
    return null;
  }
}

/**
 * Resolve who owns the process listening on each of a pair's ports.
 *
 * A port with no listener is absent from the map; a port with a listener we
 * cannot attribute maps to `null`, which the mediator treats as a conflict.
 * Attribution goes through this process's own runtime records: a pid we did not
 * start is by definition not ours to adopt.
 */
async function readExposureListenerOwners(ports: number[]): Promise<Map<number, ExposureOwnerIdentity | null>> {
  const owners = new Map<number, ExposureOwnerIdentity | null>();
  for (const port of ports) {
    const ownerPid = await readLocalServicePortOwner(port).catch(() => null);
    if (!ownerPid) continue;
    let identity: ExposureOwnerIdentity | null = null;
    for (const record of runtimeServicesById.values()) {
      const recordPid = record.child?.pid ?? null;
      if (recordPid === null) continue;
      if (recordPid !== ownerPid && record.processGroupId !== ownerPid) continue;
      identity = {
        runtimeServiceId: record.id,
        executionWorkspaceId: record.executionWorkspaceId,
        projectWorkspaceId: record.projectWorkspaceId,
        issueId: record.issueId,
      };
      break;
    }
    owners.set(port, identity);
  }
  return owners;
}

async function allocateAndReserveExposure(input: {
  db?: Db;
  companyId: string;
  runtimeId: string;
  config: RuntimeExposureConfigInput;
  /** Identity claiming the pair; governs every ownership decision below. */
  claimant: ExposureOwnerIdentity;
  /** Port this runtime already used, preserved when it is still safe to use. */
  preferredAppPort?: number | null;
}): Promise<{ appPort: number; hmrPort: number; status: RuntimeExposureStatus; handle: string }> {
  const brokerMappings = await readBrokerExposureMappings();
  const ledger = await buildCompanyExposureReservationLedger({
    db: input.db,
    companyId: input.companyId,
    brokerMappings: brokerMappings ?? [],
  });
  // Serve mappings are checked as their own view, not folded into the ledger:
  // an unreadable broker must not silently downgrade to "no mapping exists".
  const serveMappingOwners = new Map<number, ExposureOwnerIdentity | null>();
  for (const mapping of brokerMappings ?? []) {
    serveMappingOwners.set(mapping.port, ledger.reservationByPort.get(mapping.port)?.owner ?? null);
  }

  // Reserve only what this claimant may NOT have. A leaseholder restarting its
  // own lane has to be offered its own pair back, or every restart would walk
  // the range and undo "keep existing runtime ports when safe" (PAP-17158).
  // Quarantined ports are withheld from everyone, including the owner.
  const reserved = new Set<number>();
  for (const [port, reservation] of ledger.reservationByPort) {
    if (reservation.source === "quarantine" || !isExposureAdoptionPermitted(reservation.owner, input.claimant)) {
      reserved.add(port);
    }
  }
  const retryable = new Set(["reservation_conflict", "manual_mapping_present", "quarantined"]);
  const claimed: Array<{ appPort: number; hmrPort: number }> = [];
  let preferredAppPort = input.preferredAppPort ?? null;
  try {
    while (true) {
      const pair = await allocateExposurePortPair({
        isPortAvailable: workspaceRuntimeExposureDeps.isPortAvailable,
        reserved,
        preferredAppPort,
        claimPair: (candidate) => exposurePortPairClaims.claim(candidate),
      });
      claimed.push(pair);

      // Complete mediation before the broker is asked for anything: persisted
      // reservations were already folded into `reserved`, so what remains is the
      // live host — the listener actually bound, and the Serve mapping actually
      // published. Either one belonging to a different execution workspace is
      // terminal, never an adoption.
      const conflict = findExposurePairConflict({
        pair,
        claimant: input.claimant,
        ledger,
        listenerOwners: await readExposureListenerOwners([pair.appPort, pair.hmrPort]),
        serveMappingOwners,
      });
      if (conflict) throw new ExposurePortOwnershipConflictError(conflict);

      const result = await reserveExposure(workspaceRuntimeExposureDeps, {
        runtimeId: input.runtimeId,
        config: input.config,
        appPort: pair.appPort,
      });
      if (result.handle) {
        // Keep this pair's claim; the caller releases it on stop/teardown.
        claimed.pop();
        return { appPort: pair.appPort, hmrPort: pair.hmrPort, status: result.status, handle: result.handle };
      }
      if (!result.status.lastError || !retryable.has(result.status.lastError)) {
        throw new Error(`HTTPS exposure reservation failed: ${result.status.lastError ?? "unknown broker error"}`);
      }
      reserved.add(pair.appPort);
      reserved.add(pair.hmrPort);
      // The preference lost its race with a conflicting/manual/quarantined
      // mapping; drop it so the retry scans instead of re-offering the same port.
      preferredAppPort = null;
    }
  } finally {
    // Every pair this call took but did not hand back — rejected candidates and
    // the in-flight pair on a thrown failure — goes back immediately. Leaving
    // them held would burn the range down over a retry storm.
    for (const pair of claimed) exposurePortPairClaims.release(pair);
  }
}

async function canBindRuntimePort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

/**
 * True when a loopback listener is present on the port, read WITHOUT binding it.
 *
 * The readiness wait must never bind the exact port the guest is about to bind.
 * A probe `listen()` holds the port for the length of one bind/close, and if the
 * guest's own `listen()` lands in that window the guest fails with EADDRINUSE on
 * its assigned port. That self-inflicted race is the runtime exposure port flake
 * (a slow guest under load loses the race to the parent probe). A `/proc` read
 * carries the same "a listener appeared" signal with no bind. Where `/proc` is
 * absent (non-Linux dev hosts), fall back to the bind probe; those hosts do not
 * run the concurrent managed lanes that expose the race.
 */
async function hasLoopbackPortListener(port: number): Promise<boolean> {
  const facts = await readListenerBindFacts(port).catch(() => null);
  if (facts) return facts.present;
  return !(await canBindRuntimePort(port));
}

/**
 * True when one line of the failure text reports an EADDRINUSE bind conflict on
 * the given port.
 *
 * Node prints the failing bind on a single line, for example
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:42000`. The match
 * requires the EADDRINUSE marker and the port on the SAME line. So an
 * auxiliary-port conflict on one line cannot combine with an unrelated
 * assigned-port mention on a different, benign line and trigger a wrong
 * quarantine.
 *
 * Node formats a bind address as `host:port`, so the failing port always
 * follows a colon (for example `127.0.0.1:42000` or `:::42000`). The match
 * requires that colon and a full-number boundary. So a different port in the
 * same line cannot look like the assigned app or HMR port, and port 4200 never
 * matches `:42000`.
 */
function eaddrinuseTextNamesPort(text: string, port: number): boolean {
  const eaddrinusePattern = /EADDRINUSE|address already in use/i;
  const portPattern = new RegExp(`:${port}(?![0-9])`);
  return text
    .split(/\r?\n/)
    .some((line) => eaddrinusePattern.test(line) && portPattern.test(line));
}

/** Live host listener state for one assigned exposure port, read after a failure. */
export interface ExposurePortHostState {
  port: number;
  /** True when the failure text reports EADDRINUSE for this port on one line. */
  named: boolean;
  /** True when a real listener holds the port now (from /proc or lsof). */
  listenerPresent: boolean;
  /** The listener pid, or null when unknown. */
  ownerPid: number | null;
  /** The process group id of the listener owner, or null when unknown. */
  ownerProcessGroupId: number | null;
}

/**
 * Decide which assigned exposure ports a real host listener owns after a guest
 * start failure.
 *
 * The guest owns its own output, so an assigned-port EADDRINUSE line is a claim,
 * not proof. A managed guest can print a synthetic EADDRINUSE line for its
 * assigned port with no host listener behind it. A quarantine on that text alone
 * would drain the shared exposure-port pool across repeated starts. So a port
 * counts as a host collision only when all of the following hold:
 * - the failure text names the port with EADDRINUSE, and
 * - a real listener is present on the port now, and
 * - the listener owner is not the guest process the runtime just launched, nor a
 *   descendant of it.
 *
 * The runtime launches the guest as a shell process group leader, so the real dev
 * server usually binds the port from a descendant, not the shell pid itself. The
 * ownership test therefore matches the shell pid against both the owner pid and
 * the owner process group id. This is the same process-group attribution that
 * `isLocalServiceProcessOwnedBy` applies on the host platform. A raw pid equality
 * would treat a guest descendant as an external owner and quarantine a valid pair.
 *
 * An unknown owner with a present listener counts as a host owner: the /proc read
 * proves a listener, and a guest that lost its assigned port does not hold it.
 */
export function classifyExposureHostCollisions(input: {
  childPid: number | null;
  ports: ExposurePortHostState[];
}): { hostCollisionPorts: number[]; hostCollision: boolean } {
  const hostCollisionPorts: number[] = [];
  for (const state of input.ports) {
    const guestOwnsPort =
      input.childPid != null &&
      (state.ownerPid === input.childPid || state.ownerProcessGroupId === input.childPid);
    if (state.named && state.listenerPresent && !guestOwnsPort) {
      hostCollisionPorts.push(state.port);
    }
  }
  return { hostCollisionPorts, hostCollision: hostCollisionPorts.length > 0 };
}

async function readReservedRuntimePorts(input: {
  db?: Db;
  ports: number[];
  executionWorkspaceId: string | null;
}) {
  if (!input.db || input.ports.length === 0) return new Set<number>();
  const lowerBound = Math.min(...input.ports);
  const upperBound = Math.max(...input.ports);
  const otherWorkspaceCondition = input.executionWorkspaceId
    ? or(
        isNull(workspaceRuntimeServices.executionWorkspaceId),
        ne(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
      )
    : undefined;
  const rows = await input.db
    .select({ port: workspaceRuntimeServices.port })
    .from(workspaceRuntimeServices)
    .where(
      and(
        inArray(workspaceRuntimeServices.status, [...ACTIVE_RUNTIME_PORT_RESERVATION_STATUSES]),
        gte(workspaceRuntimeServices.port, lowerBound),
        lte(workspaceRuntimeServices.port, upperBound),
        otherWorkspaceCondition,
      ),
    );
  return new Set(rows.flatMap((row) => row.port === null ? [] : [row.port]));
}

async function buildRuntimePortAllocationConflict(input: {
  db?: Db;
  companyId: string;
  executionWorkspaceId: string | null;
  preferredPort: number;
  attemptedPorts: number[];
}) {
  const conflictRows = input.db && input.attemptedPorts.length > 0
    ? await input.db
        .select({
          port: workspaceRuntimeServices.port,
          executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId,
          projectWorkspaceId: workspaceRuntimeServices.projectWorkspaceId,
        })
        .from(workspaceRuntimeServices)
        .where(
          and(
            eq(workspaceRuntimeServices.companyId, input.companyId),
            inArray(workspaceRuntimeServices.status, [...ACTIVE_RUNTIME_PORT_RESERVATION_STATUSES]),
            inArray(workspaceRuntimeServices.port, input.attemptedPorts),
            input.executionWorkspaceId
              ? or(
                  isNull(workspaceRuntimeServices.executionWorkspaceId),
                  ne(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
                )
              : undefined,
          ),
        )
    : [];
  const attemptedRank = new Map(input.attemptedPorts.map((port, index) => [port, index]));
  const authorizedConflict = conflictRows
    .sort((left, right) =>
      (attemptedRank.get(left.port ?? -1) ?? Number.MAX_SAFE_INTEGER)
      - (attemptedRank.get(right.port ?? -1) ?? Number.MAX_SAFE_INTEGER))
    .find((row) => row.executionWorkspaceId || row.projectWorkspaceId) ?? null;
  const remediation =
    "Stop the conflicting managed service or configure a different preferred port, then retry the start.";

  return conflict(
    `No safe runtime service port is available in the bounded allocation range starting at ${input.preferredPort}.`,
    {
      code: "workspace_runtime_port_allocation_exhausted",
      port: input.preferredPort,
      attemptedPortCount: input.attemptedPorts.length,
      ...(authorizedConflict?.executionWorkspaceId
        ? { conflictingExecutionWorkspaceId: authorizedConflict.executionWorkspaceId }
        : {}),
      ...(authorizedConflict?.projectWorkspaceId
        ? { conflictingProjectWorkspaceId: authorizedConflict.projectWorkspaceId }
        : {}),
      remediation,
    },
  );
}

async function allocateIsolatedWorkspacePort(input: {
  db?: Db;
  companyId: string;
  executionWorkspaceId: string;
  preferredPort: number;
  stoppedPort: number | null;
  excludedPorts: ReadonlySet<number>;
}) {
  const lastPort = Math.min(
    65_535,
    input.preferredPort + WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS - 1,
  );
  const candidates: number[] = [];
  const addCandidate = (port: number | null) => {
    if (
      port === null
      || port < input.preferredPort
      || port > lastPort
      || input.excludedPorts.has(port)
      || candidates.includes(port)
    ) return;
    candidates.push(port);
  };
  addCandidate(input.stoppedPort);
  for (let port = input.preferredPort; port <= lastPort; port += 1) addCandidate(port);

  const reservedPorts = await readReservedRuntimePorts({
    db: input.db,
    ports: candidates,
    executionWorkspaceId: input.executionWorkspaceId,
  });
  for (const port of candidates) {
    if (reservedPorts.has(port)) continue;
    // Claim the candidate in-process before probing it: a sibling start that already holds it
    // has not persisted a row yet, so `reservedPorts` cannot see it and both lanes would
    // otherwise pick the same port (PAP-17249).
    if (!reservePortIfFree(port)) continue;
    if (await canBindRuntimePort(port)) return port;
    releasePortReservation(port);
  }
  const attemptedPorts = [
    ...input.excludedPorts,
    ...candidates,
  ].filter((port, index, ports) =>
    port >= input.preferredPort
    && port <= lastPort
    && ports.indexOf(port) === index);

  throw await buildRuntimePortAllocationConflict({
    db: input.db,
    companyId: input.companyId,
    executionWorkspaceId: input.executionWorkspaceId,
    preferredPort: input.preferredPort,
    attemptedPorts,
  });
}


/**
 * Allocate a loopback port that no other in-flight managed start already holds and that no
 * live process owns. Callers must {@link releasePortReservation} once the service either
 * reached a terminal state or bound the port itself.
 */
export async function allocateRuntimeServicePort(overrides?: {
  probe?: () => Promise<number>;
  portOwnerLookup?: (port: number) => Promise<number | null>;
}): Promise<number> {
  const probe = overrides?.probe ?? probeEphemeralPort;
  const portOwnerLookup = overrides?.portOwnerLookup ?? readLocalServicePortOwner;
  let lastCandidate: number | null = null;
  for (let attempt = 0; attempt < PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidate = await probe();
    lastCandidate = candidate;
    if (!reservePortIfFree(candidate)) continue;
    const ownerPid = await portOwnerLookup(candidate);
    if (!ownerPid) return candidate;
    releasePortReservation(candidate);
  }
  throw new Error(
    `Could not allocate a free loopback port for a managed runtime service after ${PORT_ALLOCATION_ATTEMPTS} attempts`
      + `${lastCandidate ? ` (last candidate ${lastCandidate})` : ""}.`,
  );
}

function buildTemplateData(input: {
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  port: number | null;
}) {
  return {
    workspace: {
      cwd: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      worktreePath: input.workspace.worktreePath ?? "",
      repoUrl: input.workspace.repoUrl ?? "",
      repoRef: input.workspace.repoRef ?? "",
      env: input.adapterEnv,
    },
    issue: {
      id: input.issue?.id ?? "",
      identifier: input.issue?.identifier ?? "",
      title: input.issue?.title ?? "",
    },
    agent: {
      id: input.agent.id ?? "",
      name: input.agent.name,
    },
    port: input.port ?? "",
  };
}

function renderRuntimeServiceEnv(input: {
  envConfig: Record<string, unknown>;
  templateData: ReturnType<typeof buildTemplateData>;
}) {
  const rendered: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.envConfig)) {
    if (typeof value !== "string") continue;
    rendered[key] = renderTemplate(value, input.templateData);
  }
  return rendered;
}

function resolveRuntimeServiceReuseIdentity(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): {
  serviceName: string;
  lifecycle: RuntimeServiceRef["lifecycle"];
  command: string;
  serviceCwd: string;
  envConfig: Record<string, unknown>;
  envFingerprint: string;
  explicitPort: number;
  identityPort: number | null;
  reuseKey: string | null;
} {
  const serviceName = asString(input.service.name, "service");
  const lifecycle = asString(input.service.lifecycle, "shared") === "ephemeral" ? "ephemeral" : "shared";
  const command = asString(input.service.command, "");
  const serviceCwdTemplate = asString(input.service.cwd, ".");
  const portConfig = parseObject(input.service.port);
  const envConfig = parseObject(input.service.env);
  const explicitPort = asNumber(portConfig.value, asNumber(input.service.port, 0));
  const identityPort = explicitPort > 0 ? explicitPort : null;
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: identityPort,
  });
  const serviceCwd = resolveConfiguredPath(renderTemplate(serviceCwdTemplate, templateData), input.workspace.cwd);
  const renderedEnv = renderRuntimeServiceEnv({
    envConfig,
    templateData,
  });
  const envFingerprint = createHash("sha256").update(stableStringify(renderedEnv)).digest("hex");
  const reuseKey =
    lifecycle === "shared"
      ? createHash("sha256")
          .update(
            stableStringify({
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              serviceName,
              command,
              cwd: serviceCwd,
              port: identityPort,
              env: renderedEnv,
              expose: input.service.expose ?? null,
            }),
          )
          .digest("hex")
      : null;

  return {
    serviceName,
    lifecycle,
    command,
    serviceCwd,
    envConfig,
    envFingerprint,
    explicitPort,
    identityPort,
    reuseKey,
  };
}

function resolveWorkspaceCommandExecution(input: {
  command: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  adapterEnv: Record<string, string>;
}) {
  const name =
    asString(input.command.name, "")
    || asString(input.command.label, "")
    || asString(input.command.title, "")
    || "workspace command";
  const command = asString(input.command.command, "");
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port: null,
  });
  const cwd = resolveConfiguredPath(
    renderTemplate(asString(input.command.cwd, "."), templateData),
    input.workspace.cwd,
  );
  const env = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
    ...renderRuntimeServiceEnv({
      envConfig: parseObject(input.command.env),
      templateData,
    }),
  } as Record<string, string>;

  return {
    name,
    command,
    cwd,
    env,
  };
}

export async function runWorkspaceJobForControl(input: {
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  command: Record<string, unknown>;
  adapterEnv?: Record<string, string>;
  recorder?: WorkspaceOperationRecorder | null;
  metadata?: Record<string, unknown> | null;
}) {
  const resolved = resolveWorkspaceCommandExecution({
    command: input.command,
    workspace: input.workspace,
    agent: input.actor,
    issue: input.issue,
    adapterEnv: input.adapterEnv ?? {},
  });
  if (!resolved.command) {
    throw new Error(`Workspace job "${resolved.name}" is missing command`);
  }

  await ensureServerWorkspaceLinksCurrent(resolved.cwd);
  return await recordWorkspaceCommandOperation(input.recorder, {
    phase: "workspace_provision",
    command: resolved.command,
    cwd: resolved.cwd,
    env: resolved.env,
    label: `Workspace job "${resolved.name}"`,
    metadata: {
      workspaceCommandKind: "job",
      workspaceCommandName: resolved.name,
      ...(input.metadata ?? {}),
    },
    successMessage: `Completed workspace job "${resolved.name}"\n`,
  });
}

function resolveServiceScopeId(input: {
  service: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
}): {
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
} {
  const scopeTypeRaw = asString(input.service.reuseScope, input.service.lifecycle === "shared" ? "project_workspace" : "run");
  const scopeType =
    scopeTypeRaw === "project_workspace" ||
    scopeTypeRaw === "execution_workspace" ||
    scopeTypeRaw === "agent"
      ? scopeTypeRaw
      : "run";
  if (scopeType === "project_workspace") return { scopeType, scopeId: input.workspace.workspaceId ?? input.workspace.projectId };
  if (scopeType === "execution_workspace") {
    return { scopeType, scopeId: input.executionWorkspaceId ?? input.workspace.cwd };
  }
  if (scopeType === "agent") return { scopeType, scopeId: input.agent.id };
  return { scopeType: "run" as const, scopeId: input.runId };
}

function looksLikeWorkspaceDevServerCommand(command: string) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^|\s)(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?dev(?:\s|$)/.test(normalized);
}

export function resolveWorkspaceRuntimeReadinessTimeoutSec(service: Record<string, unknown>) {
  const readiness = parseObject(service.readiness);
  const explicitTimeoutSec = asNumber(readiness.timeoutSec, 0);
  if (explicitTimeoutSec > 0) {
    return Math.max(1, explicitTimeoutSec);
  }
  return looksLikeWorkspaceDevServerCommand(asString(service.command, "")) ? 90 : 30;
}

/**
 * Longest a single readiness probe may stay outstanding. Without this an unrelated process
 * that accepts the connection but never answers (exactly what a reallocated port produces)
 * parks `fetch` forever, the readiness deadline is never re-checked, and the managed start
 * never reaches a terminal state.
 */
export const RUNTIME_SERVICE_READINESS_PROBE_TIMEOUT_MS = 5_000;

export async function waitForRuntimeServiceReadiness(input: {
  service: Record<string, unknown>;
  serviceName?: string | null;
  command?: string | null;
  url: string | null;
  readinessUrl: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const readiness = parseObject(input.service.readiness);
  const readinessType = asString(readiness.type, "");
  const readinessTargetUrl = input.readinessUrl ?? input.url;
  if (readinessType !== "http" || !readinessTargetUrl) return;
  const readinessUrl = resolveRuntimeServiceHealthUrl(readinessTargetUrl, {
    serviceName: input.serviceName,
    command: input.command,
  });
  if (!readinessUrl) {
    throw new Error(`Readiness check failed: could not resolve health URL for ${input.url}`);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const timeoutSec = resolveWorkspaceRuntimeReadinessTimeoutSec(input.service);
  const intervalMs = Math.max(100, asNumber(readiness.intervalMs, 500));
  const deadline = now() + timeoutSec * 1000;
  let lastError = "service did not become ready";
  while (now() < deadline) {
    const probeBudgetMs = Math.max(1, Math.min(RUNTIME_SERVICE_READINESS_PROBE_TIMEOUT_MS, deadline - now()));
    try {
      const response = await fetchImpl(readinessUrl, { signal: AbortSignal.timeout(probeBudgetMs) });
      if (response.ok) return;
      lastError = `received HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (now() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Readiness check failed for ${readinessUrl}: ${lastError}`);
}

async function waitForAllocatedPortBind(input: {
  service: Record<string, unknown>;
  port: number;
  child: ChildProcess;
}) {
  const deadline = Date.now() + resolveWorkspaceRuntimeReadinessTimeoutSec(input.service) * 1000;
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error("service process exited before binding its allocated port");
    }

    const ownerPid = await readLocalServicePortOwner(input.port);
    if (ownerPid) {
      const childPid = input.child.pid ?? null;
      if (!childPid || !(await isLocalServiceProcessOwnedBy(ownerPid, childPid))) {
        throw new RuntimeServicePortBindCollision(input.port);
      }
      // Require the same launched process group to retain ownership across a stability delay.
      // Cwd matching alone is insufficient because sibling services can share a workspace.
      await delay(250);
      if (input.child.exitCode !== null || input.child.signalCode !== null) {
        throw new Error("service process exited after losing its allocated port");
      }
      const stableOwnerPid = await readLocalServicePortOwner(input.port);
      if (!stableOwnerPid || !(await isLocalServiceProcessOwnedBy(stableOwnerPid, childPid))) {
        throw new RuntimeServicePortBindCollision(input.port);
      }
      return;
    }

    // A present listener proves only that some listener appeared. If listener ownership cannot
    // be attributed to this child after a stability delay, retry instead of accepting a sibling.
    // The presence read never binds the port, so it cannot steal the port from the child.
    if (await hasLoopbackPortListener(input.port)) {
      await delay(250);
      if (input.child.exitCode !== null || input.child.signalCode !== null) {
        throw new Error("service process exited after losing its allocated port");
      }
      const stableOwnerPid = await readLocalServicePortOwner(input.port);
      const childPid = input.child.pid ?? null;
      if (stableOwnerPid && childPid && await isLocalServiceProcessOwnedBy(stableOwnerPid, childPid)) return;
      throw new RuntimeServicePortBindCollision(input.port);
    }
    await delay(50);
  }
  throw new Error(`Runtime service did not bind allocated port ${input.port} before timeout`);
}

function isPaperclipDevRuntimeService(input: { serviceName?: string | null; command?: string | null }) {
  const serviceName = (input.serviceName ?? "").trim().toLowerCase();
  const command = (input.command ?? "").trim().toLowerCase();
  return (
    serviceName === "paperclip-dev"
    || serviceName === "paperclip-dev-once"
    || (command.includes("dev:once") && command.includes("tailscale-auth"))
  );
}

function resolveRuntimeServiceHealthUrl(
  url: string | null,
  input?: { serviceName?: string | null; command?: string | null },
) {
  if (!url || !isPaperclipDevRuntimeService(input ?? {})) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/health";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
  } catch {
    return url;
  }
  return url;
}

type RuntimeServiceHealthProbeInput = {
  db?: Db;
  serviceName?: string | null;
  command?: string | null;
  provider?: string | null;
  port?: number | null;
  /**
   * Workspace identity, when the caller knows it. Supplying all three upgrades
   * the probe from "the port answered with status ok" to the full protected
   * readiness contract, which is what stops a relocated port or a half-restored
   * clone from masquerading as healthy (PAP-17572).
   */
  cwd?: string | null;
  executionWorkspaceId?: string | null;
  companyId?: string | null;
};

/**
 * Whether a managed workspace runtime satisfies the *user* readiness contract.
 *
 * Returns null when this service is not an identity-resolvable managed workspace
 * runtime, so non-workspace services keep their existing behavior.
 *
 * For a workspace runtime this *replaces* the semantic transport check rather
 * than adding to it. The probe reads the same `/api/health` response the legacy
 * check read, so every legacy verdict is already implied: reaching
 * `readiness_missing` means the response was `200` with `status: ok` (exactly
 * what the legacy check asserted), and every other rejection means it was not.
 * Stacking a second request on top would double the latency of every reuse
 * decision for no extra information.
 */
async function probeManagedWorkspaceRuntimeReadiness(
  healthUrl: string,
  input: RuntimeServiceHealthProbeInput,
): Promise<boolean | null> {
  if (!isPaperclipDevRuntimeService(input)) return null;
  const identity = resolveManagedWorkspaceIdentity({
    workspaceCwd: input.cwd ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    companyId: input.companyId ?? null,
  });
  if (!identity) return null;

  const result = await probeManagedWorkspaceReadiness({ healthUrl, identity });
  const verified = !result.ok
    ? result
    : input.db
      ? await probeManagedWorkspaceHandoffSubjects({ db: input.db, healthUrl, identity })
      : {
          ok: false as const,
          reason: "not_ready" as const,
          readiness: result.readiness,
          detail: "control-plane database is unavailable for board identity verification",
        };
  if (verified.ok) return true;
  logManagedWorkspaceReadinessRejection({
    executionWorkspaceId: identity.executionWorkspaceId,
    healthUrl,
    result: verified,
  });
  // A guest that does not implement the readiness contract yet is not evidence of
  // an unhealthy clone; it is only evidence that the contract cannot be checked.
  return !shouldBlockPublicationOnReadiness(verified);
}

async function isRuntimeServiceUrlHealthy(
  url: string | null,
  input?: RuntimeServiceHealthProbeInput,
) {
  const localProbeUrl = input?.provider === "local_process" && input.port && isPaperclipDevRuntimeService(input)
    ? `http://127.0.0.1:${input.port}`
    : null;
  const probeUrl = localProbeUrl ?? url;
  if (!probeUrl) return true;
  const healthUrl = resolveRuntimeServiceHealthUrl(probeUrl, input);
  if (!healthUrl) return false;

  const readiness = await probeManagedWorkspaceRuntimeReadiness(healthUrl, input ?? {});
  if (readiness !== null) return readiness;

  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    if (!isPaperclipDevRuntimeService(input ?? {})) return true;
    const payload = await response.json().catch(() => null) as { status?: unknown } | null;
    return payload?.status === "ok";
  } catch {
    return false;
  }
}

function toPersistedWorkspaceRuntimeService(record: RuntimeServiceRecord): typeof workspaceRuntimeServices.$inferInsert {
  return {
    id: record.id,
    companyId: record.companyId,
    projectId: record.projectId,
    projectWorkspaceId: record.projectWorkspaceId,
    executionWorkspaceId: record.executionWorkspaceId,
    issueId: record.issueId,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    serviceName: record.serviceName,
    status: record.status,
    lifecycle: record.lifecycle,
    reuseKey: record.reuseKey,
    command: record.command,
    cwd: record.cwd,
    port: record.port,
    url: record.url,
    provider: record.provider,
    providerRef: record.providerRef,
    ownerAgentId: record.ownerAgentId,
    startedByRunId: record.startedByRunId,
    lastUsedAt: new Date(record.lastUsedAt),
    startedAt: new Date(record.startedAt),
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt) : null,
    stopPolicy: record.stopPolicy,
    exposure: record.exposure,
    exposureHandle: record.exposureHandle,
    backendUrl: record.backendUrl,
    healthStatus: record.healthStatus,
    updatedAt: new Date(),
  };
}

async function persistRuntimeServiceRecord(db: Db | undefined, record: RuntimeServiceRecord) {
  if (!db) return;
  const values = toPersistedWorkspaceRuntimeService(record);
  await db
    .insert(workspaceRuntimeServices)
    .values(values)
    .onConflictDoUpdate({
      target: workspaceRuntimeServices.id,
      set: {
        projectId: values.projectId,
        projectWorkspaceId: values.projectWorkspaceId,
        executionWorkspaceId: values.executionWorkspaceId,
        issueId: values.issueId,
        scopeType: values.scopeType,
        scopeId: values.scopeId,
        serviceName: values.serviceName,
        status: values.status,
        lifecycle: values.lifecycle,
        reuseKey: values.reuseKey,
        command: values.command,
        cwd: values.cwd,
        port: values.port,
        url: values.url,
        provider: values.provider,
        providerRef: values.providerRef,
        ownerAgentId: values.ownerAgentId,
        startedByRunId: values.startedByRunId,
        lastUsedAt: values.lastUsedAt,
        startedAt: values.startedAt,
        stoppedAt: values.stoppedAt,
        stopPolicy: values.stopPolicy,
        exposure: values.exposure,
        exposureHandle: values.exposureHandle,
        backendUrl: values.backendUrl,
        healthStatus: values.healthStatus,
        updatedAt: values.updatedAt,
      },
    });
}

async function findStoppedRuntimeServiceReuseCandidate(input: {
  db?: Db;
  companyId: string;
  reuseKey: string | null;
  serviceName: string;
  command: string;
  cwd: string;
  scopeType: RuntimeServiceRef["scopeType"];
  scopeId: string | null;
}): Promise<StoppedRuntimeServiceReuseCandidate | null> {
  if (!input.db) return null;
  if (input.reuseKey) {
    const row = await input.db
      .select({
        id: workspaceRuntimeServices.id,
        port: workspaceRuntimeServices.port,
      })
      .from(workspaceRuntimeServices)
      .where(
        and(
          eq(workspaceRuntimeServices.companyId, input.companyId),
          eq(workspaceRuntimeServices.reuseKey, input.reuseKey),
          eq(workspaceRuntimeServices.provider, "local_process"),
          eq(workspaceRuntimeServices.status, "stopped"),
        ),
      )
      .orderBy(desc(workspaceRuntimeServices.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (row) return row;
  }

  const scopeIdCondition = input.scopeId === null
    ? isNull(workspaceRuntimeServices.scopeId)
    : eq(workspaceRuntimeServices.scopeId, input.scopeId);
  const row = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      port: workspaceRuntimeServices.port,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, input.companyId),
        eq(workspaceRuntimeServices.provider, "local_process"),
        eq(workspaceRuntimeServices.status, "stopped"),
        eq(workspaceRuntimeServices.scopeType, input.scopeType),
        scopeIdCondition,
        eq(workspaceRuntimeServices.serviceName, input.serviceName),
        eq(workspaceRuntimeServices.command, input.command),
        eq(workspaceRuntimeServices.cwd, input.cwd),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row ?? null;
}

function clearIdleTimer(record: RuntimeServiceRecord) {
  if (!record.idleTimer) return;
  clearTimeout(record.idleTimer);
  record.idleTimer = null;
}

export function normalizeAdapterManagedRuntimeServices(input: {
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
  now?: Date;
}): RuntimeServiceRef[] {
  const nowIso = (input.now ?? new Date()).toISOString();
  return input.reports.map((report) => {
    const scopeType = report.scopeType ?? "run";
    const scopeId =
      report.scopeId ??
      (scopeType === "project_workspace"
        ? input.workspace.workspaceId
        : scopeType === "execution_workspace"
          ? input.executionWorkspaceId ?? input.workspace.cwd
          : scopeType === "agent"
            ? input.agent.id
            : input.runId) ??
      null;
    const serviceName = asString(report.serviceName, "").trim() || "service";
    const status = report.status ?? "running";
    const lifecycle = report.lifecycle ?? "ephemeral";
    const healthStatus =
      report.healthStatus ??
      (status === "running" ? "healthy" : status === "failed" ? "unhealthy" : "unknown");
    return {
      id: stableRuntimeServiceId({
        adapterType: input.adapterType,
        runId: input.runId,
        scopeType,
        scopeId,
        serviceName,
        reportId: report.id ?? null,
        providerRef: report.providerRef ?? null,
        reuseKey: report.reuseKey ?? null,
      }),
      companyId: input.agent.companyId,
      projectId: report.projectId ?? input.workspace.projectId,
      projectWorkspaceId: report.projectWorkspaceId ?? input.workspace.workspaceId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      issueId: report.issueId ?? input.issue?.id ?? null,
      serviceName,
      status,
      lifecycle,
      scopeType,
      scopeId,
      reuseKey: report.reuseKey ?? null,
      command: report.command ?? null,
      cwd: report.cwd ?? null,
      port: report.port ?? null,
      url: report.url ?? null,
      provider: "adapter_managed",
      providerRef: report.providerRef ?? null,
      ownerAgentId: report.ownerAgentId ?? input.agent.id ?? null,
      startedByRunId: input.runId,
      lastUsedAt: nowIso,
      startedAt: nowIso,
      stoppedAt: status === "running" || status === "starting" ? null : nowIso,
      stopPolicy: report.stopPolicy ?? null,
      healthStatus,
      exposure: null,
      reused: false,
    };
  });
}

type StartLocalRuntimeServiceInput = {
  db?: Db;
  runId: string;
  leaseRunId?: string | null;
  startedByRunId?: string | null;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  adapterEnv: Record<string, string>;
  service: Record<string, unknown>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  runtimeProvisionCommand?: string | null;
  runtimeProvisionKind?: RuntimeProvisionKind | null;
  recorder?: WorkspaceOperationRecorder | null;
  provisionCoordinator?: RuntimeProvisionCoordinator;
  preparedProvisioningRecord?: RuntimeServiceRecord | null;
  runtimeServiceId?: string;
  allowFixedPortFallback?: boolean;
  excludedPorts?: ReadonlySet<number>;
  reuseKey: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
};

type RuntimeProvisionCoordinator = {
  promise: Promise<void> | null;
};

function createRuntimeProvisionCoordinator(): RuntimeProvisionCoordinator {
  return { promise: null };
}

function readRuntimeProvisionCommand(config: Record<string, unknown>) {
  const workspaceStrategy = parseObject(config.workspaceStrategy);
  return asString(
    config.runtimeProvisionCommand,
    asString(workspaceStrategy.runtimeProvisionCommand, ""),
  ).trim();
}

const BUILTIN_WORKSPACE_SEED_COMMAND = "bash ./scripts/provision-worktree-runtime.sh";

type RuntimeProvisionKind = "workspace_seed" | "runtime_dependencies";

function readWorkspaceSeedOperationEvidence(worktreePath: string): {
  verified: boolean;
  error: string | null;
  metadata: Record<string, unknown>;
} {
  const manifestPath = path.join(worktreePath, ".paperclip", "seed-manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const state = typeof manifest.state === "string" ? manifest.state : "unknown";
    const phase = typeof manifest.phase === "string" ? manifest.phase : null;
    const verified = isVerifiedWorktreeSeedManifest(manifest);
    return {
      verified,
      error: verified
        ? null
        : phase
          ? `Workspace seed command returned without a verified manifest (state: ${state}, phase: ${phase}).`
          : `Workspace seed command returned without a verified manifest (state: ${state}).`,
      metadata: {
        provisionKind: "workspace_seed",
        seedState: state,
        seedPhase: phase,
        seedFailurePhase: state === "failed" ? phase : null,
      },
    };
  } catch {
    return {
      verified: false,
      error: "Workspace seed command returned without a readable seed manifest.",
      metadata: {
        provisionKind: "workspace_seed",
        seedState: existsSync(manifestPath) ? "unreadable" : "absent",
        seedPhase: null,
        seedFailurePhase: "seed_manifest_unreadable",
      },
    };
  }
}

export function resolveRuntimeProvisionCommand(input: {
  config: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
}) {
  const configuredCommand = readRuntimeProvisionCommand(input.config);
  if (configuredCommand) return configuredCommand;

  if (input.workspace.strategy !== "git_worktree") return "";

  const stateDir = path.join(input.workspace.cwd, ".paperclip");
  const manifestPath = path.join(stateDir, "seed-manifest.json");
  const provisionScript = path.join(
    input.workspace.baseCwd,
    "scripts",
    "provision-worktree-runtime.sh",
  );
  const needsSeed = !existsSync(manifestPath) || !hasVerifiedWorktreeSeedManifest(manifestPath);
  if (!needsSeed || !existsSync(provisionScript)) {
    return "";
  }

  return BUILTIN_WORKSPACE_SEED_COMMAND;
}

function resolveRuntimeProvision(input: {
  config: Record<string, unknown>;
  workspace: RealizedExecutionWorkspace;
}): { command: string; kind: RuntimeProvisionKind | null } {
  const command = resolveRuntimeProvisionCommand(input);
  if (!command) return { command, kind: null };
  return {
    command,
    kind: readRuntimeProvisionCommand(input.config)
      ? "runtime_dependencies"
      : "workspace_seed",
  };
}

function runtimeProvisionWorkspaceKey(input: StartLocalRuntimeServiceInput) {
  return input.executionWorkspaceId
    ? `execution-workspace:${input.executionWorkspaceId}`
    : input.workspace.workspaceId
      ? `project-workspace:${input.workspace.workspaceId}`
      : `cwd:${path.resolve(input.workspace.cwd)}`;
}

async function runRuntimeProvisionWithWorkspaceMutex(input: StartLocalRuntimeServiceInput) {
  const command = asString(input.runtimeProvisionCommand, "").trim();
  if (!command) return;

  const workspaceKey = runtimeProvisionWorkspaceKey(input);
  const existing = runtimeProvisionByWorkspace.get(workspaceKey);
  if (existing) {
    await existing;
    return;
  }

  const recorder = input.recorder ?? (input.db
    ? workspaceOperationService(input.db).createRecorder({
        companyId: input.agent.companyId,
        heartbeatRunId: input.startedByRunId === undefined ? input.runId : input.startedByRunId,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        issueId: input.issue?.id ?? null,
      })
    : null);
  const resolvedCommand = resolveRepoManagedWorkspaceCommand(command, input.workspace.baseCwd);
  const workspaceSeed = input.runtimeProvisionKind === "workspace_seed";
  const promise = recordWorkspaceCommandOperation(recorder, {
    phase: workspaceSeed ? "workspace_seed" : "workspace_runtime_provision",
    command,
    resolvedCommand,
    cwd: input.workspace.cwd,
    env: buildWorkspaceCommandEnv({
      base: input.workspace,
      repoRoot: input.workspace.baseCwd,
      worktreePath: input.workspace.cwd,
      branchName: input.workspace.branchName ?? "",
      issue: input.issue,
      agent: input.agent,
      created: input.workspace.created,
    }),
    label: workspaceSeed
      ? `Workspace seed command "${command}"`
      : `Runtime provision command "${command}"`,
    metadata: {
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      projectWorkspaceId: input.workspace.workspaceId,
      serviceName: asString(input.service.name, "service"),
      provisionKind: workspaceSeed ? "workspace_seed" : "runtime_dependencies",
      resolvedCommand: resolvedCommand === command ? null : resolvedCommand,
    },
    successMessage: workspaceSeed
      ? `Verified the workspace database seed for ${input.workspace.cwd}\n`
      : `Provisioned runtime dependencies for ${input.workspace.cwd}\n`,
    onLog: input.onLog,
  }).then(() => undefined);

  runtimeProvisionByWorkspace.set(workspaceKey, promise);
  try {
    await promise;
  } finally {
    if (runtimeProvisionByWorkspace.get(workspaceKey) === promise) {
      runtimeProvisionByWorkspace.delete(workspaceKey);
    }
  }
}

function createProvisioningRuntimeServiceRecord(
  input: StartLocalRuntimeServiceInput,
  identity: ReturnType<typeof resolveRuntimeServiceReuseIdentity>,
): RuntimeServiceRecord {
  const nowIso = new Date().toISOString();
  const id = input.runtimeServiceId ?? randomUUID();
  return {
    id,
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName: identity.serviceName,
    status: "provisioning",
    lifecycle: identity.lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command: identity.command,
    cwd: identity.serviceCwd,
    port: identity.identityPort,
    url: null,
    provider: "local_process",
    providerRef: null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId: input.startedByRunId === undefined ? input.runId : input.startedByRunId,
    lastUsedAt: nowIso,
    startedAt: nowIso,
    stoppedAt: null,
    stopPolicy: parseObject(input.service.stopPolicy),
    healthStatus: "unknown",
    exposure: null,
    reused: false,
    db: input.db,
    child: null,
    leaseRunIds: new Set(),
    idleTimer: null,
    envFingerprint: identity.envFingerprint,
    serviceKey: `runtime-provision:${runtimeProvisionWorkspaceKey(input)}:${id}`,
    profileKind: "workspace-runtime",
    processGroupId: null,
    exposureHandle: null,
    backendUrl: null,
    exposureConfig: null,
  };
}

async function spawnLocalRuntimeService(input: StartLocalRuntimeServiceInput): Promise<LocalRuntimeServiceStart> {
  const leaseRunId = input.leaseRunId === undefined ? input.runId : input.leaseRunId;
  const startedByRunId = input.startedByRunId === undefined ? input.runId : input.startedByRunId;
  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  const serviceName = identity.serviceName;
  const lifecycle = identity.lifecycle;
  const declaredCommand = identity.command;
  if (!declaredCommand) throw new Error(`Runtime service "${serviceName}" is missing command`);
  const portConfig = parseObject(input.service.port);
  const envConfig = identity.envConfig;
  const envFingerprint = identity.envFingerprint;
  const serviceIdentityFingerprint = input.reuseKey ?? envFingerprint;
  const explicitPort = identity.explicitPort;
  const identityPort = identity.identityPort;
  const resolvedExposure = await resolveRuntimeServiceExposure({
    service: input.service,
    serviceName,
    command: declaredCommand,
  });
  const exposureConfig = resolvedExposure?.config ?? null;
  // An exposed listener MUST be loopback-only or the broker denies it. Env vars
  // alone cannot guarantee that: the process that has to honour them is the
  // *guest checkout's* dev runner, and one from before managed exposure existed
  // overwrites PAPERCLIP_BIND from its own `--bind` argv and deletes
  // PAPERCLIP_BIND_HOST — which is exactly how a branch pinned at plain master
  // bound 0.0.0.0 and failed every start (PAP-17256). argv is honoured by every
  // dev-runner version, so put the loopback bind there.
  //
  // Scoped by `forceLoopbackBindInCommand` to commands that actually parse these
  // flags: `--bind` means something else entirely to an unrelated service (the
  // HTTPS probe canaries pass it to `python3 -m http.server`), and appending
  // flags a command cannot parse would make it exit on startup.
  const command = exposureConfig ? forceLoopbackBindInCommand(declaredCommand) : declaredCommand;
  const portType = asString(portConfig.type, "");
  const canAllocateFixedPort = Boolean(
    !exposureConfig
    && input.allowFixedPortFallback
    && input.db
    && input.executionWorkspaceId
    && explicitPort > 0,
  );
  const stoppedReuseCandidate = await findStoppedRuntimeServiceReuseCandidate({
    db: input.db,
    companyId: input.agent.companyId,
    reuseKey: input.reuseKey,
    serviceName,
    command,
    cwd: identity.serviceCwd,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  let fixedPortRegistryMatch = false;
  if (!exposureConfig && canAllocateFixedPort && identityPort) {
    const identityTemplateData = buildTemplateData({
      workspace: input.workspace,
      agent: input.agent,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      port: identityPort,
    });
    const identityExpose = parseObject(input.service.expose);
    const identityReadiness = parseObject(input.service.readiness);
    const identityUrlTemplate =
      asString(identityExpose.urlTemplate, "")
      || asString(identityReadiness.urlTemplate, "");
    const identityBackendUrl = identityUrlTemplate
      ? renderTemplate(identityUrlTemplate, identityTemplateData)
      : null;
    const identityServiceKey = createLocalServiceKey({
      profileKind: "workspace-runtime",
      serviceName,
      cwd: identity.serviceCwd,
      command,
      envFingerprint: serviceIdentityFingerprint,
      port: identityPort,
      scope: {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        reuseKey: input.reuseKey,
      },
    });
    fixedPortRegistryMatch = Boolean(await findAdoptableLocalService({
      serviceKey: identityServiceKey,
      profileKind: "workspace-runtime",
      serviceName,
      command,
      cwd: identity.serviceCwd,
      envFingerprint: serviceIdentityFingerprint,
      port: identityPort,
      url: identityBackendUrl,
    }));
  }
  const runtimeId = input.runtimeServiceId ?? stoppedReuseCandidate?.id ?? randomUUID();
  // An exposed runtime always takes its port from the dedicated broker range, so
  // a configured or previously used port is a *preference*, not a constraint. It
  // is honored when it is already an allowlisted app port whose HMR companion is
  // free — that keeps a restart on the same port and keeps a backfilled service
  // stable across deploys — and quietly relocated when it is not, which is the
  // only way a legacy pinned port (the Paperclip App template's 45439) can be
  // published at all. If the backend then fails to listen where we allocated,
  // the broker's /proc ownership proof refuses the mapping and the start fails
  // closed; it never falls back to HTTP.
  const reservedExposure = exposureConfig
    ? await allocateAndReserveExposure({
        db: input.db,
        companyId: input.agent.companyId,
        runtimeId,
        config: exposureConfig,
        claimant: {
          runtimeServiceId: runtimeId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          projectWorkspaceId: input.workspace.workspaceId,
          issueId: input.issue?.id ?? null,
        },
        preferredAppPort: stoppedReuseCandidate?.port ?? (explicitPort > 0 ? explicitPort : null),
      })
    : null;
  // Loopback port this start claimed in-process for its own duration (PAP-17249). A bare
  // `listen(0)` probe is closed before the child binds, so the kernel is free to hand the same
  // candidate to a sibling start; holding the claim until the child owns the port — or until the
  // start reaches a terminal state — is what keeps two concurrent lanes distinct. Exposed
  // runtimes carry no in-process claim: their port pair is held by the broker reservation.
  let reservedPort: number | null = null;
  let port: number | null = reservedExposure?.appPort ?? null;
  if (!reservedExposure && portType === "auto") {
    if (
      stoppedReuseCandidate?.port
      && !input.excludedPorts?.has(stoppedReuseCandidate.port)
      // Reserving the reuse candidate keeps two concurrent starts of the same stopped service
      // from both deciding the old port is free.
      && reservePortIfFree(stoppedReuseCandidate.port)
    ) {
      if (await canBindRuntimePort(stoppedReuseCandidate.port)) {
        port = stoppedReuseCandidate.port;
        reservedPort = stoppedReuseCandidate.port;
      } else {
        releasePortReservation(stoppedReuseCandidate.port);
      }
    }
    for (let attempt = 0; port === null && attempt < WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
      // Reserves its candidate in-process and re-checks it for a live owner before returning.
      const candidate = await allocateRuntimeServicePort();
      if (input.excludedPorts?.has(candidate)) {
        releasePortReservation(candidate);
        continue;
      }
      port = candidate;
      reservedPort = candidate;
    }
    if (port === null) {
      throw conflict("No safe automatically allocated runtime service port is available.", {
        code: "workspace_runtime_port_allocation_exhausted",
        attemptedPortCount: WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS,
        remediation: "Retry the start or configure a different runtime service port.",
      });
    }
  } else if (!reservedExposure && canAllocateFixedPort && fixedPortRegistryMatch) {
    port = explicitPort;
  } else if (!reservedExposure && canAllocateFixedPort) {
    port = await allocateIsolatedWorkspacePort({
      db: input.db,
      companyId: input.agent.companyId,
      executionWorkspaceId: input.executionWorkspaceId!,
      preferredPort: explicitPort,
      stoppedPort: stoppedReuseCandidate?.port ?? null,
      excludedPorts: input.excludedPorts ?? new Set<number>(),
    });
    // The bounded fixed-port scan reserves the port it hands back for the same reason.
    reservedPort = port;
  } else if (!reservedExposure) {
    port = explicitPort > 0 ? explicitPort : null;
  }
  let exposureHostname: string | null = null;
  if (reservedExposure) {
    try {
      exposureHostname = await workspaceRuntimeExposureDeps.resolveHostname();
      reservedExposure.status.hostname = exposureHostname;
      reservedExposure.status.updatedAt = new Date().toISOString();
    } catch {
      await workspaceRuntimeExposureDeps.broker
        .remove(runtimeId, reservedExposure.handle)
        .catch(() => undefined);
      // The reservation deliberately keeps the winning pair's in-process claim for
      // the caller to release on stop/teardown. No runtime record exists yet, so
      // that teardown path can never run for this pair — releasing the broker
      // reservation alone would leave the claim held. A hostname outage would then
      // burn one pair per attempt, and a retry storm inside the claim TTL would
      // report the range exhausted rather than the real cause.
      exposurePortPairClaims.release({
        appPort: reservedExposure.appPort,
        hmrPort: reservedExposure.hmrPort,
      });
      throw new Error("HTTPS exposure failed: Tailscale MagicDNS hostname unavailable");
    }
  }
  const templateData = buildTemplateData({
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    port,
  });
  const serviceCwd =
    port === identityPort
      ? identity.serviceCwd
      : resolveConfiguredPath(renderTemplate(asString(input.service.cwd, "."), templateData), input.workspace.cwd);
  const env: Record<string, string> = {
    ...sanitizeRuntimeServiceBaseEnv(process.env),
    ...input.adapterEnv,
  } as Record<string, string>;
  for (const [key, value] of Object.entries(renderRuntimeServiceEnv({ envConfig, templateData }))) {
    env[key] = value;
  }
  if (port) {
    const portEnvKey = asString(portConfig.envKey, "PORT");
    env[portEnvKey] = String(port);
  }

  // Per-workspace handoff key, readiness token, and workspace id. Injected for
  // the Paperclip dev runtime whether or not it is HTTPS-exposed, because the
  // password-independent login handoff and the protected readiness probe are
  // both needed for a plain-HTTP loopback workspace too (PAP-17572).
  const managedWorkspaceIdentity = isPaperclipDevRuntimeService({ serviceName, command })
    ? resolveManagedWorkspaceIdentity({
        workspaceCwd: input.workspace.cwd,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        companyId: input.agent.companyId,
      })
    : null;
  if (managedWorkspaceIdentity) {
    Object.assign(env, buildManagedWorkspaceGuestEnv(managedWorkspaceIdentity));
  }

  if (exposureConfig) {
    // Paperclip dev-runtime-specific hardening. Other managed processes are
    // still rejected by the broker unless /proc proves loopback-only listeners.
    //
    // Three independent layers force the loopback bind, because a guest checkout
    // can be arbitrarily old (PAP-17256): the `--bind loopback` argv
    // added above, these env vars for a runner that reads them, and HOST for one
    // old enough to ignore both and infer its bind mode from HOST alone.
    env.PAPERCLIP_BIND = RUNTIME_EXPOSURE_BIND_MODE;
    env.PAPERCLIP_BIND_HOST = RUNTIME_EXPOSURE_BIND_HOST;
    env.HOST = RUNTIME_EXPOSURE_BIND_HOST;
    env.PAPERCLIP_VITE_HMR_PROTOCOL = "wss";
    env.PAPERCLIP_MANAGED_RUNTIME_EXPOSURE = "tailscale_https";
    env.PAPERCLIP_ALLOWED_HOSTNAMES = exposureHostname!;
    env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
    env.PAPERCLIP_AUTH_PUBLIC_BASE_URL = `https://${exposureHostname}:${port}`;
    env.PAPERCLIP_PUBLIC_URL = `https://${exposureHostname}:${port}`;
  }

  const expose = parseObject(input.service.expose);
  const readiness = parseObject(input.service.readiness);
  const urlTemplate =
    asString(expose.urlTemplate, "") ||
    asString(readiness.urlTemplate, "");
  const backendUrl = urlTemplate ? renderTemplate(urlTemplate, templateData) : null;
  let url = exposureConfig ? null : backendUrl;
  const readinessUrlTemplate = asString(readiness.urlTemplate, "");
  const readinessUrl = readinessUrlTemplate ? renderTemplate(readinessUrlTemplate, templateData) : null;
  const stopPolicy = parseObject(input.service.stopPolicy);
  const serviceKey = createLocalServiceKey({
    profileKind: "workspace-runtime",
    serviceName,
    cwd: serviceCwd,
    command,
    envFingerprint: serviceIdentityFingerprint,
    port: identityPort,
    scope: {
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      reuseKey: input.reuseKey,
    },
  });
  const adoptedRecord = exposureConfig ? null : await findAdoptableLocalService({
    serviceKey,
    profileKind: "workspace-runtime",
    serviceName,
    command,
    cwd: serviceCwd,
    envFingerprint: serviceIdentityFingerprint,
    port: port ?? identityPort,
    url: backendUrl,
  });
  if (adoptedRecord) {
    const adoptedUrl = adoptedRecord.url ?? backendUrl;
    if (!(await isRuntimeServiceUrlHealthy(adoptedUrl, {
      db: input.db,
      serviceName,
      command,
      cwd: input.workspace.cwd,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      companyId: input.agent.companyId,
    }))) {
      await terminateLocalService(adoptedRecord);
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
    } else {
      releasePortReservation(reservedPort);
      return {
        record: {
          id: adoptedRecord.runtimeServiceId ?? randomUUID(),
          companyId: input.agent.companyId,
          projectId: input.workspace.projectId,
          projectWorkspaceId: input.workspace.workspaceId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issue?.id ?? null,
          serviceName,
          status: "running",
          lifecycle,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          reuseKey: input.reuseKey,
          command,
          cwd: serviceCwd,
          port: adoptedRecord.port ?? port,
          url: adoptedRecord.url ?? url,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: input.agent.id ?? null,
          startedByRunId,
          lastUsedAt: new Date().toISOString(),
          startedAt: adoptedRecord.startedAt,
          stoppedAt: null,
          stopPolicy,
          healthStatus: "healthy",
          exposure: null,
          reused: true,
          db: input.db,
          child: null,
          leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
          idleTimer: null,
          envFingerprint,
          serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
          exposureHandle: null,
          backendUrl: adoptedUrl,
          exposureConfig: null,
        },
        readiness: Promise.resolve(),
      };
    }
  }
  // A pinned port is only worth a conflict check when the service will actually
  // bind it. Under HTTPS exposure the port comes from the broker's dedicated
  // range instead, and both ports in that pair were already probed free before
  // the lease was taken — so checking the pinned port here would reject a
  // legacy `port: 45439` service purely because the pre-backfill instance still
  // holds 45439, which is exactly the workspace this feature has to upgrade.
  const conflictPort = reservedExposure ? null : port;
  if (conflictPort) {
    const ownerPid = await readLocalServicePortOwner(conflictPort);
    if (ownerPid) {
      if (canAllocateFixedPort || portType === "auto") {
        throw new RuntimeServicePortBindCollision(conflictPort);
      }
      const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
      const ownerIsInWorkspace = ownerCwd
        ? await isLocalServiceProcessInWorkspace(ownerCwd, serviceCwd)
        : null;
      const ownerDescription = ownerCwd ? `pid ${ownerPid} (cwd: ${ownerCwd})` : `pid ${ownerPid} (cwd unavailable)`;
      releasePortReservation(reservedPort);
      if (ownerIsInWorkspace === false) {
        throw new Error(
          `Runtime service "${serviceName}" could not start because port ${conflictPort} has a cross-workspace port conflict with ${ownerDescription}; requested workspace: ${serviceCwd}. Stop the other service or configure a different port.`,
        );
      }
      throw new Error(
        `Runtime service "${serviceName}" could not start because port ${conflictPort} is already in use by ${ownerDescription}`,
      );
    }
    // A configured port that is free right now can still be taken by a sibling workspace that
    // is mid-start. Claiming it in-process makes the loser fail terminally here instead of
    // silently racing to bind and then hanging on a readiness probe it can never satisfy.
    // `conflictPort !== reservedPort` guards the port this start allocated for itself: we
    // must not fail a start by colliding with our own reservation.
    if (!claimRuntimeServiceBindPort(conflictPort, reservedPort)) {
      releasePortReservation(reservedPort);
      throw new Error(
        `Runtime service "${serviceName}" could not start because configured port ${conflictPort} is already being claimed by another managed start in this instance. Retry once that start settles, or configure a different port.`,
      );
    }
  }
  const claimedIdentityPort = conflictPort && conflictPort !== reservedPort ? conflictPort : null;

  const nowIso = new Date().toISOString();
  const record: RuntimeServiceRecord = {
    id: runtimeId,
    companyId: input.agent.companyId,
    projectId: input.workspace.projectId,
    projectWorkspaceId: input.workspace.workspaceId,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    issueId: input.issue?.id ?? null,
    serviceName,
    status: "starting",
    lifecycle,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    reuseKey: input.reuseKey,
    command,
    cwd: serviceCwd,
    port,
    url,
    provider: "local_process",
    providerRef: null,
    ownerAgentId: input.agent.id ?? null,
    startedByRunId,
    lastUsedAt: nowIso,
    startedAt: nowIso,
    stoppedAt: null,
    stopPolicy,
    healthStatus: "unknown",
    exposure: reservedExposure?.status ?? null,
    reused: false,
    db: input.db,
    child: null,
    leaseRunIds: leaseRunId ? new Set([leaseRunId]) : new Set(),
    idleTimer: null,
    envFingerprint,
    serviceKey,
    profileKind: "workspace-runtime",
    processGroupId: null,
    exposureHandle: reservedExposure?.handle ?? null,
    backendUrl,
    exposureConfig,
  };
  if (reservedExposure) {
    // The broker reservation and its unguessable handle must be durable before
    // the child can bind, so a server crash cannot lose cleanup authority.
    try {
      await persistRuntimeServiceRecord(input.db, record);
    } catch (error) {
      await cleanupRecordExposure(record);
      throw error;
    }
  }

  try {
    await ensureServerWorkspaceLinksCurrent(serviceCwd, {
      onLog: input.onLog,
    });
  } catch (error) {
    releasePortReservation(reservedPort);
    releasePortReservation(claimedIdentityPort);
    if (reservedExposure) await cleanupRecordExposure(record);
    throw error;
  }

  const shell = resolveShell();
  const serviceLog = await openLocalServiceLogFile(serviceKey);
  let child: ChildProcess;
  try {
    child = spawn(shell, ["-lc", command], {
      cwd: serviceCwd,
      env,
      detached: process.platform !== "win32",
      // The service receives duplicate append-only file descriptors. Closing
      // Paperclip (or this parent handle below) cannot strand a request logger
      // on an orphaned socketpair during startup reconciliation.
      stdio: ["ignore", serviceLog.handle.fd, serviceLog.handle.fd],
    });
  } finally {
    await serviceLog.handle.close();
  }
  record.child = child;
  record.providerRef = child.pid ? String(child.pid) : null;
  record.processGroupId = child.pid ?? null;
  const spawnErrorPromise = new Promise<never>((_, reject) => {
    child.once("error", (err) => {
      reject(err);
    });
  });
  const earlyExitPromise = new Promise<never>((_, reject) => {
    // `close` follows `exit` after the child's inherited stdout/stderr file
    // descriptors are closed. Waiting for it makes the startup log excerpt
    // deterministic instead of racing the final validation line.
    child.once("close", (code, signal) => {
      reject(new Error(
        `service process exited before readiness (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
      ));
    });
  });
  const readServiceOutputExcerpt = async () => {
    try {
      const contents = await fs.readFile(serviceLog.logPath);
      return contents.subarray(Math.max(serviceLog.startOffset, contents.length - 4096)).toString("utf8");
    } catch {
      return "";
    }
  };

  if (child.pid) {
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey,
      profileKind: "workspace-runtime",
      serviceName,
      command,
      cwd: serviceCwd,
      envFingerprint: serviceIdentityFingerprint,
      port,
      url: backendUrl,
      pid: child.pid,
      processGroupId: child.pid,
      provider: "local_process",
      runtimeServiceId: record.id,
      reuseKey: input.reuseKey,
      startedAt: record.startedAt,
      lastSeenAt: record.lastUsedAt,
      metadata: {
        projectId: record.projectId,
        projectWorkspaceId: record.projectWorkspaceId,
        executionWorkspaceId: record.executionWorkspaceId,
        issueId: record.issueId,
        scopeType: record.scopeType,
        scopeId: record.scopeId,
      },
    });
  }

  const ownershipCheckedPorts = port
    ? exposureConfig
      ? [
          port,
          ...(exposureConfig.includePaperclipViteHmr ? [deriveViteHmrPort(port)] : []),
        ]
      : canAllocateFixedPort
        ? [port]
        : []
    : [];
  const readinessPromise = Promise.race([
    Promise.all([
      waitForRuntimeServiceReadiness({
        service: input.service,
        serviceName,
        command,
        // An exposed runtime is loopback-only by construction, so its readiness
        // probe has to target loopback too. The fallback target is the display
        // URL (a MagicDNS name), which only ever answered because the guest was
        // wrongly bound to the wildcard (PAP-17256).
        url: exposureConfig ? rewriteUrlHostToLoopback(backendUrl) : backendUrl,
        readinessUrl: exposureConfig ? rewriteUrlHostToLoopback(readinessUrl) : readinessUrl,
      }),
      ...ownershipCheckedPorts.map((ownedPort) =>
        waitForAllocatedPortBind({ service: input.service, port: ownedPort, child })
      ),
    ]).then(() => undefined),
    spawnErrorPromise,
    earlyExitPromise,
  ]).then(async () => {
    releasePortReservation(reservedPort);
    releasePortReservation(claimedIdentityPort);
    if (record.exposureConfig && record.exposureHandle && record.port) {
      const provisioned = await provisionExposure(workspaceRuntimeExposureDeps, {
        runtimeId: record.id,
        config: record.exposureConfig,
        handle: record.exposureHandle,
        hostname: exposureHostname!,
        appPort: record.port,
      });
      record.exposure = provisioned.status;
      record.exposureHandle = provisioned.handle;
      record.url = provisioned.status.publicUrl;
      await persistRuntimeServiceRecord(record.db, record);
      if (provisioned.status.state !== "ready" || !record.url) {
        // Carry the reason, not just the code: a bare `listener_ownership_mismatch`
        // in the operation log is what made PAP-17254 undiagnosable (PAP-17256).
        const code = provisioned.status.lastError ?? "unknown error";
        throw new Error(
          `HTTPS exposure failed: ${code}${provisioned.errorDetail ? ` — ${provisioned.errorDetail}` : ""}`,
        );
      }
    }
    // Transport readiness only proves a listener answered. A managed workspace
    // must additionally satisfy the protected readiness contract — own database,
    // cloned rows, login handoff, and matching instance/workspace identity —
    // before it may be published as running/healthy (PAP-17572).
    if (managedWorkspaceIdentity) {
      const publishHealthUrl = resolveRuntimeServiceHealthUrl(
        record.port ? `http://127.0.0.1:${record.port}` : rewriteUrlHostToLoopback(record.url ?? backendUrl),
        { serviceName, command },
      );
      if (!publishHealthUrl) {
        throw new Error("Managed workspace readiness gate could not resolve a health URL");
      }
      let gate = await waitForManagedWorkspaceReadiness({
        healthUrl: publishHealthUrl,
        identity: managedWorkspaceIdentity,
      });
      if (gate.ok) {
        if (!record.db) {
          throw new Error("Managed workspace readiness gate could not resolve the control-plane database");
        }
        gate = await probeManagedWorkspaceHandoffSubjects({
          db: record.db,
          healthUrl: publishHealthUrl,
          identity: managedWorkspaceIdentity,
        });
      }
      if (!gate.ok) {
        logManagedWorkspaceReadinessRejection({
          executionWorkspaceId: managedWorkspaceIdentity.executionWorkspaceId,
          healthUrl: publishHealthUrl,
          result: gate,
        });
        if (shouldBlockPublicationOnReadiness(gate)) {
          throw new Error(
            `Workspace is not ready to publish (${gate.reason}${gate.detail ? `: ${gate.detail}` : ""})`,
          );
        }
      }
    }
    record.status = "running";
    record.healthStatus = "healthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = null;
    const serviceOutputExcerpt = await readServiceOutputExcerpt();
    if (serviceOutputExcerpt && input.onLog) {
      await input.onLog("stdout", `[service:${serviceName}] ${serviceOutputExcerpt}`);
    }
    await touchLocalServiceRegistryRecord(record.serviceKey, {
      runtimeServiceId: record.id,
      lastSeenAt: record.lastUsedAt,
    });
  }).catch(async (err) => {
    releasePortReservation(reservedPort);
    releasePortReservation(claimedIdentityPort);
    const failureMessage = err instanceof Error ? err.message : String(err);
    const serviceOutputExcerpt = await readServiceOutputExcerpt();
    const bindCollision = !exposureConfig && (
      err instanceof RuntimeServicePortBindCollision || Boolean(
        port
        && (input.allowFixedPortFallback || portType === "auto")
        && /(?:EADDRINUSE|address already in use)/i.test(`${failureMessage}\n${serviceOutputExcerpt}`),
      )
    );
    // An exposed guest that exits with EADDRINUSE on its ASSIGNED port lost the
    // port after allocation. Only the assigned app or HMR port is re-allocatable
    // from the dedicated broker range, so quarantine and re-allocation apply only
    // when the failure names one of those ports. An unrelated auxiliary-port
    // conflict (a different port the guest also bound) leaves the valid pair
    // intact and surfaces as a terminal error, not a quarantine that burns the
    // bounded retries.
    const exposureAssignedPorts: number[] =
      exposureConfig && port
        ? [port, ...(exposureConfig.includePaperclipViteHmr ? [deriveViteHmrPort(port)] : [])]
        : [];
    const collisionText = `${failureMessage}\n${serviceOutputExcerpt}`;
    const exposureNamedPorts = exposureAssignedPorts.filter((candidate) =>
      eaddrinuseTextNamesPort(collisionText, candidate),
    );
    // The guest owns its own output, so an assigned-port EADDRINUSE line is a
    // claim, not proof. A managed guest can print a synthetic EADDRINUSE line for
    // its assigned port with no host listener behind it. A quarantine on that text
    // alone would burn the shared exposure-port pool across repeated starts. So the
    // runtime reads live host listener state and quarantines only after it confirms
    // that a real host listener owns the port.
    const exposureTextNamesAssignedPort = Boolean(
      exposureConfig && port && exposureNamedPorts.length > 0,
    );
    let exposureCollisionDiagnosis: string | null = null;
    let exposureHostCollision = false;
    if (exposureTextNamesAssignedPort) {
      const facts: string[] = [];
      const hostStates: ExposurePortHostState[] = [];
      for (const collisionPort of exposureAssignedPorts) {
        // `readLocalServicePortOwner` reads lsof and returns the listener pid, so a
        // non-null pid also proves a present listener. `readListenerBindFacts` reads
        // /proc for the same presence signal and the bound addresses.
        const ownerPid = await readLocalServicePortOwner(collisionPort).catch(() => null);
        const bind = await readListenerBindFacts(collisionPort).catch(() => null);
        // Read the owner process group id too. The guest runs as a shell process
        // group leader, so the real dev server usually binds the port from a
        // descendant. The classify step matches the shell pid against the owner pgid
        // to keep a guest descendant from looking like an external owner.
        const ownerProcessGroupId =
          ownerPid != null ? await readLocalServiceProcessGroupId(ownerPid).catch(() => null) : null;
        hostStates.push({
          port: collisionPort,
          named: exposureNamedPorts.includes(collisionPort),
          listenerPresent: Boolean(bind?.present) || ownerPid != null,
          ownerPid,
          ownerProcessGroupId,
        });
        const boundTo = bind?.present ? bind.addresses.join(", ") : "no listener";
        facts.push(`port ${collisionPort} bound to ${boundTo}, owner pid ${ownerPid ?? "none"}`);
      }
      exposureHostCollision = classifyExposureHostCollisions({
        childPid: child.pid ?? null,
        ports: hostStates,
      }).hostCollision;
      exposureCollisionDiagnosis = facts.join("; ");
    }
    // Quarantine the whole assigned pair, not only the named port. The broker
    // allocates the app and HMR ports as one unit, so a re-allocation must skip
    // both to land on the next free pair.
    const exposureCollisionPorts: number[] = exposureHostCollision ? exposureAssignedPorts : [];
    if (child.pid) {
      await terminateLocalService({
        pid: child.pid,
        processGroupId: child.pid,
        port,
      });
    }
    await cleanupRecordExposure(record, { preserveFailure: true });
    record.status = "stopped";
    record.healthStatus = "unhealthy";
    record.lastUsedAt = new Date().toISOString();
    record.stoppedAt = new Date().toISOString();
    await removeLocalServiceRegistryRecord(record.serviceKey).catch(() => undefined);
    if (exposureConfig) {
      await persistRuntimeServiceRecord(record.db, record).catch(() => undefined);
    }
    if (bindCollision && port) throw new RuntimeServicePortBindCollision(port);
    if (exposureHostCollision && port) {
      // A verified host listener holds the assigned exposure port. Quarantine the
      // pair so the bounded re-allocation never re-offers it, then throw a retryable
      // collision. `startLocalRuntimeService` re-runs allocation, which skips the
      // quarantined pair and takes the next free pair inside the dedicated range.
      // This hardens a real host that races an external process for a range port.
      for (const collisionPort of exposureCollisionPorts) {
        quarantinedRuntimeExposurePorts.add(collisionPort);
      }
      if (input.onLog) {
        await input.onLog(
          "stderr",
          `[service:${serviceName}] exposure port ${port} collided during startup (EADDRINUSE); `
            + `${exposureCollisionDiagnosis ?? "owner unavailable"}. `
            + `Quarantined pair ${exposureCollisionPorts.join("/")} and reallocating.\n`,
        ).catch(() => undefined);
      }
      throw new RuntimeServicePortBindCollision(port, exposureCollisionDiagnosis, true);
    }
    const deploymentBindConflict = /local_trusted requires server\.bind=loopback/i.test(
      `${failureMessage}\n${serviceOutputExcerpt}`,
    );
    // The guest reported an assigned-port EADDRINUSE, but no host listener owned
    // the port. Explain that the runtime did not quarantine the pair, so a future
    // occurrence needs no diagnostic cycle and the pool stays intact.
    const unverifiedExposureCollision = exposureTextNamesAssignedPort && !exposureHostCollision;
    const actionableFailure = deploymentBindConflict
      ? `${failureMessage} | deployment/bind conflict: local_trusted requires server.bind=loopback; the managed runtime requested an incompatible bind mode`
      : unverifiedExposureCollision
        ? `${failureMessage} | exposure port collision not verified: the guest reported EADDRINUSE on assigned port ${exposureNamedPorts.join("/")}, but no host listener owns it (${exposureCollisionDiagnosis ?? "owner unavailable"}); the runtime did not quarantine the pair`
        : failureMessage;
    throw new Error(
      `Failed to start runtime service "${serviceName}": ${actionableFailure}${serviceOutputExcerpt ? ` | output: ${serviceOutputExcerpt.trim()}` : ""}`,
    );
  });

  return { record, readiness: readinessPromise };
}

async function prepareRuntimeProvisioning(
  input: StartLocalRuntimeServiceInput,
): Promise<RuntimeServiceRecord | null> {
  const runtimeProvisionCommand = asString(input.runtimeProvisionCommand, "").trim();
  if (!runtimeProvisionCommand) return null;
  const coordinator = input.provisionCoordinator ?? createRuntimeProvisionCoordinator();
  if (coordinator.promise) {
    await coordinator.promise;
    return null;
  }

  const identity = resolveRuntimeServiceReuseIdentity({
    service: input.service,
    workspace: input.workspace,
    agent: input.agent,
    issue: input.issue,
    adapterEnv: input.adapterEnv,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
  });
  if (!identity.command) throw new Error(`Runtime service "${identity.serviceName}" is missing command`);
  const provisioningRecord = createProvisioningRuntimeServiceRecord(input, identity);
  await persistRuntimeServiceRecord(input.db, provisioningRecord);
  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[service:${identity.serviceName}] provisioning runtime dependencies...\n`,
    );
  }

  try {
    coordinator.promise = runRuntimeProvisionWithWorkspaceMutex(input);
    await coordinator.promise;
    provisioningRecord.status = "starting";
    provisioningRecord.lastUsedAt = new Date().toISOString();
    await persistRuntimeServiceRecord(input.db, provisioningRecord);
    return provisioningRecord;
  } catch (error) {
    const nowIso = new Date().toISOString();
    provisioningRecord.status = "failed";
    provisioningRecord.healthStatus = "unhealthy";
    provisioningRecord.lastUsedAt = nowIso;
    provisioningRecord.stoppedAt = nowIso;
    await persistRuntimeServiceRecord(input.db, provisioningRecord).catch(() => undefined);
    if (input.onLog) {
      await input.onLog(
        "stderr",
        `[service:${provisioningRecord.serviceName}] runtime provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    throw error;
  }
}

async function startLocalRuntimeService(
  input: StartLocalRuntimeServiceInput,
  options?: { deferReadiness?: boolean },
): Promise<LocalRuntimeServiceStart> {
  const runtimeProvisionCommand = asString(input.runtimeProvisionCommand, "").trim();
  const provisioningRecord = input.preparedProvisioningRecord === undefined
    ? await prepareRuntimeProvisioning(input)
    : input.preparedProvisioningRecord;
  let started: LocalRuntimeServiceStart | null = null;
  const excludedPorts = new Set(input.excludedPorts ?? []);
  const portConfig = parseObject(input.service.port);
  const portType = asString(portConfig.type, "");
  const explicitPort = asNumber(portConfig.value, asNumber(input.service.port, 0));
  const fixedPortFallbackEnabled = Boolean(
    input.allowFixedPortFallback && portType !== "auto" && explicitPort > 0,
  );
  const retryBindCollisions = fixedPortFallbackEnabled || portType === "auto";
  const deferReadiness = Boolean(options?.deferReadiness);

  try {
    for (let attempt = 0; attempt < WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
      try {
        started = await spawnLocalRuntimeService({
          ...input,
          excludedPorts,
          runtimeServiceId: provisioningRecord?.id ?? input.runtimeServiceId,
        });
        if (runtimeProvisionCommand) {
          await persistRuntimeServiceRecord(input.db, started.record);
        }
        if (provisioningRecord && started.record.id !== provisioningRecord.id && input.db) {
          await input.db
            .delete(workspaceRuntimeServices)
            .where(eq(workspaceRuntimeServices.id, provisioningRecord.id));
        }
        if (!deferReadiness) {
          await started.readiness;
        }
        return started;
      } catch (error) {
        if (
          !(error instanceof RuntimeServicePortBindCollision)
          || !(retryBindCollisions || error.exposureReallocatable)
        ) {
          throw error;
        }
        excludedPorts.add(error.port);
        started = null;
      }
    }

    if (fixedPortFallbackEnabled && input.executionWorkspaceId) {
      throw await buildRuntimePortAllocationConflict({
        db: input.db,
        companyId: input.agent.companyId,
        executionWorkspaceId: input.executionWorkspaceId,
        preferredPort: explicitPort,
        attemptedPorts: [...excludedPorts],
      });
    }
    throw conflict("No safe automatically allocated runtime service port is available.", {
      code: "workspace_runtime_port_allocation_exhausted",
      attemptedPortCount: excludedPorts.size,
      remediation: "Retry the start or configure a different runtime service port.",
    });
  } catch (error) {
    if (!started && provisioningRecord && provisioningRecord.status === "starting") {
      const nowIso = new Date().toISOString();
      provisioningRecord.status = "failed";
      provisioningRecord.healthStatus = "unhealthy";
      provisioningRecord.lastUsedAt = nowIso;
      provisioningRecord.stoppedAt = nowIso;
      await persistRuntimeServiceRecord(input.db, provisioningRecord).catch(() => undefined);
    }
    throw error;
  }
}

function scheduleIdleStop(record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  const stopType = asString(record.stopPolicy?.type, "manual");
  if (stopType !== "idle_timeout") return;
  const idleSeconds = Math.max(1, asNumber(record.stopPolicy?.idleSeconds, 1800));
  record.idleTimer = setTimeout(() => {
    stopRuntimeService(record.id).catch(() => undefined);
  }, idleSeconds * 1000);
}

async function cleanupRecordExposure(
  record: RuntimeServiceRecord,
  options?: { preserveFailure?: boolean },
) {
  if (!record.exposure) return;
  const previous = record.exposure;
  const ports = previous.listeners.map((listener) => listener.targetPort);
  const result = await deprovisionExposure(workspaceRuntimeExposureDeps, {
    runtimeId: record.id,
    handle: record.exposureHandle,
    ports,
  });
  for (const port of result.quarantinedPorts) quarantinedRuntimeExposurePorts.add(port);
  // Drop the in-process pair claim on teardown. The *lease* reservation is what
  // still protects the pair from another workspace (PAP-17419) — this only
  // releases the short-lived hold that keeps concurrent allocators apart, and
  // keeping it would block this very lane's own restart.
  if (record.port !== null && isRuntimeExposureAppPort(record.port)) {
    exposurePortPairClaims.release({ appPort: record.port, hmrPort: deriveViteHmrPort(record.port) });
  }
  if (result.status.state === "removed") {
    record.exposureHandle = null;
    record.exposure = options?.preserveFailure && previous.state === "failed"
      ? { ...previous, publicUrl: null, updatedAt: new Date().toISOString() }
      : { ...previous, state: "removed", publicUrl: null, lastError: null, updatedAt: new Date().toISOString() };
  } else {
    record.exposure = {
      ...previous,
      state: "cleanup_pending",
      publicUrl: null,
      lastError: result.status.lastError,
      updatedAt: new Date().toISOString(),
    };
  }
  record.url = null;
  await persistRuntimeServiceRecord(record.db, record).catch(() => undefined);
}

async function stopRuntimeService(serviceId: string) {
  const record = runtimeServicesById.get(serviceId);
  if (!record) return;
  clearIdleTimer(record);
  // Remove any public exposure first, but keep the process registered and the
  // row non-stopped until verified termination succeeds.
  await cleanupRecordExposure(record);
  if (record.child && record.child.pid) {
    await terminateLocalService({
      pid: record.child.pid,
      processGroupId: record.processGroupId ?? record.child.pid,
      port: record.port,
    });
  } else if (record.providerRef) {
    const pid = Number.parseInt(record.providerRef, 10);
    if (Number.isInteger(pid) && pid > 0) {
      await terminateLocalService({
        pid,
        processGroupId: record.processGroupId,
        port: record.port,
      });
    }
  }
  record.status = "stopped";
  record.healthStatus = "unknown";
  record.lastUsedAt = new Date().toISOString();
  record.stoppedAt = new Date().toISOString();
  runtimeServicesById.delete(serviceId);
  if (record.reuseKey && runtimeServicesByReuseKey.get(record.reuseKey) === record.id) {
    runtimeServicesByReuseKey.delete(record.reuseKey);
  }
  await removeLocalServiceRegistryRecord(record.serviceKey);
  await persistRuntimeServiceRecord(record.db, record);
}

async function findHealthyRunningRuntimeService(reuseKey: string | null) {
  const existingId = reuseKey ? runtimeServicesByReuseKey.get(reuseKey) : null;
  const existing = existingId ? runtimeServicesById.get(existingId) : null;
  if (!existing || existing.status !== "running") return null;
  const healthInput = {
    db: existing.db,
    serviceName: existing.serviceName,
    command: existing.command,
    provider: existing.provider,
    port: existing.port,
    cwd: existing.cwd,
    executionWorkspaceId: existing.executionWorkspaceId,
    companyId: existing.companyId,
  };
  let healthy = await isRuntimeServiceUrlHealthy(existing.url, healthInput);
  if (!healthy) {
    // A single timeout or connection reset is not enough evidence to destroy a
    // shared runtime that active runs may still use. Confirm the failure after
    // a short bounded delay before entering the destructive replacement path.
    await delay(250);
    healthy = await isRuntimeServiceUrlHealthy(existing.url, healthInput);
  }
  if (healthy) return existing;
  if (existing.leaseRunIds.size > 0) {
    existing.healthStatus = "unhealthy";
    if (reuseKey && runtimeServicesByReuseKey.get(reuseKey) === existing.id) {
      runtimeServicesByReuseKey.delete(reuseKey);
    }
    await persistRuntimeServiceRecord(existing.db, existing);
    return null;
  }
  await stopRuntimeService(existing.id);
  return null;
}

async function markPersistedRuntimeServicesStoppedForExecutionWorkspace(input: {
  db: Db;
  executionWorkspaceId: string;
}) {
  const now = new Date();
  const exposureRows = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      exposure: workspaceRuntimeServices.exposure,
      exposureHandle: workspaceRuntimeServices.exposureHandle,
    })
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"]),
      ),
    );
  for (const row of exposureRows) {
    if (!row.exposure) continue;
    const cleanup = await deprovisionExposure(workspaceRuntimeExposureDeps, {
      runtimeId: row.id,
      handle: row.exposureHandle,
      ports: row.exposure.listeners.map((listener) => listener.targetPort),
    });
    for (const port of cleanup.quarantinedPorts) quarantinedRuntimeExposurePorts.add(port);
    const exposure: RuntimeExposureStatus = {
      ...row.exposure,
      state: cleanup.status.state,
      publicUrl: null,
      lastError: cleanup.status.lastError,
      updatedAt: now.toISOString(),
    };
    await input.db
      .update(workspaceRuntimeServices)
      .set({
        exposure,
        exposureHandle: cleanup.status.state === "removed" ? null : row.exposureHandle,
        url: null,
      })
      .where(eq(workspaceRuntimeServices.id, row.id));
  }
  await input.db
    .update(workspaceRuntimeServices)
    .set({
      status: "stopped",
      healthStatus: "unknown",
      stoppedAt: now,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"]),
      ),
    );
}

/**
 * Corroboration for a reclamation driven by persisted rows rather than by a live
 * operation (PAP-17285).
 *
 * `ownedListeners` is the broker's own current ownership view (`broker.list()`),
 * or `null` when the broker could not be reached. Passing it switches
 * `cleanupPersistedExposureRows` from "trust the row" to "trust the broker",
 * which is the difference between reclaiming what is actually published and
 * issuing removals from stale bookkeeping. Targeted stop paths omit it and keep
 * their existing behaviour, because there the caller named the runtime.
 */
interface ExposureReclaimCorroboration {
  ownedListeners: Array<{ runtimeId: string; port: number }> | null;
}

export type StaleExposureReclaimDecision =
  /** Broker unreachable: prove nothing, mutate nothing, surface cleanup_pending. */
  | { action: "defer"; reason: "broker_unreachable" }
  /** Broker owns nothing for this runtime: clear local bookkeeping, no Serve op. */
  | { action: "clear_bookkeeping"; reason: "not_owned_by_broker" }
  /** Broker still publishes this runtime's mapping: reclaiming it is correct. */
  | { action: "reclaim"; reason: "owned_by_broker" };

/**
 * Decide what a persisted-row-driven reclamation may do, given the broker's live
 * ownership view (PAP-17285).
 *
 * Extracted as a pure function because it is the entire safety contract for the
 * global startup sweep, and the sweep itself needs a database. Every branch is
 * asserted by reason code in `workspace-runtime-exposure-backfill.test.ts`.
 */
export function decideStaleExposureReclaim(input: {
  runtimeId: string;
  ownedListeners: Array<{ runtimeId: string; port: number }> | null;
}): StaleExposureReclaimDecision {
  if (input.ownedListeners === null) {
    return { action: "defer", reason: "broker_unreachable" };
  }
  const owned = input.ownedListeners.some((listener) => listener.runtimeId === input.runtimeId);
  return owned
    ? { action: "reclaim", reason: "owned_by_broker" }
    : { action: "clear_bookkeeping", reason: "not_owned_by_broker" };
}

async function cleanupPersistedExposureRows(
  db: Db,
  rows: Array<{
    id: string;
    exposure: RuntimeExposureStatus | null;
    exposureHandle: string | null;
  }>,
  corroboration?: ExposureReclaimCorroboration,
) {
  for (const row of rows) {
    if (!row.exposure) continue;

    if (corroboration) {
      // Fail closed toward PRESERVATION. A stale row is not evidence that a
      // mapping is ours to delete: rows outlive the lanes that created them, get
      // duplicated as ports are recycled, and can be days old. Reclaiming on that
      // basis alone is what destroyed the `42000/52000` mappings.
      const decision = decideStaleExposureReclaim({
        runtimeId: row.id,
        ownedListeners: corroboration.ownedListeners,
      });
      if (decision.action === "defer") {
        // Broker unreachable — we cannot prove anything. Never guess; surface it.
        await db
          .update(workspaceRuntimeServices)
          .set({
            exposure: {
              ...row.exposure,
              state: "cleanup_pending",
              publicUrl: null,
              lastError: decision.reason,
              updatedAt: new Date().toISOString(),
            },
          })
          .where(eq(workspaceRuntimeServices.id, row.id));
        continue;
      }
      if (decision.action === "clear_bookkeeping") {
        // The broker attributes nothing to this runtime, so there is nothing of
        // ours published. This is stale local bookkeeping: clear it WITHOUT
        // issuing any Serve mutation. `exposure.listeners` is retained so the
        // historical mapping stays inspectable and restorable.
        await db
          .update(workspaceRuntimeServices)
          .set({
            url: null,
            exposure: {
              ...row.exposure,
              state: "removed",
              publicUrl: null,
              lastError: null,
              updatedAt: new Date().toISOString(),
            },
            exposureHandle: null,
          })
          .where(eq(workspaceRuntimeServices.id, row.id));
        continue;
      }
    }

    const cleanup = await deprovisionExposure(workspaceRuntimeExposureDeps, {
      runtimeId: row.id,
      handle: row.exposureHandle,
      ports: row.exposure.listeners.map((listener) => listener.targetPort),
    });
    for (const port of cleanup.quarantinedPorts) quarantinedRuntimeExposurePorts.add(port);
    await db
      .update(workspaceRuntimeServices)
      .set({
        url: null,
        exposure: {
          ...row.exposure,
          state: cleanup.status.state,
          publicUrl: null,
          lastError: cleanup.status.lastError,
          updatedAt: new Date().toISOString(),
        },
        exposureHandle: cleanup.status.state === "removed" ? null : row.exposureHandle,
      })
      .where(eq(workspaceRuntimeServices.id, row.id));
  }
}

function registerRuntimeService(db: Db | undefined, record: RuntimeServiceRecord) {
  record.db = db;
  runtimeServicesById.set(record.id, record);
  if (record.reuseKey) {
    runtimeServicesByReuseKey.set(record.reuseKey, record.id);
  }

  record.child?.on("exit", (code, signal) => {
    const current = runtimeServicesById.get(record.id);
    if (!current) return;
    clearIdleTimer(current);
    current.status = code === 0 || signal === "SIGTERM" ? "stopped" : "failed";
    current.healthStatus = current.status === "failed" ? "unhealthy" : "unknown";
    current.lastUsedAt = new Date().toISOString();
    current.stoppedAt = new Date().toISOString();
    runtimeServicesById.delete(current.id);
    if (current.reuseKey && runtimeServicesByReuseKey.get(current.reuseKey) === current.id) {
      runtimeServicesByReuseKey.delete(current.reuseKey);
    }
    void (async () => {
      // The child exited on its own. Record the terminal status as best effort.
      // The persist can fail when a parent row is already gone: a caller can
      // delete the project or the company while this service still runs, and the
      // `project_id` foreign key then rejects the write. Catch every error here,
      // or the detached persist becomes an unhandled rejection and crashes the
      // host. This path runs off the child `exit` event, so no caller awaits it.
      try {
        await cleanupRecordExposure(current);
        await removeLocalServiceRegistryRecord(current.serviceKey);
        await persistRuntimeServiceRecord(db, current);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[workspace-runtime] runtime service exit cleanup failed for ${current.id}: ${detail}`,
        );
      }
    })();
  });
}

function readRuntimeServiceEntries(config: Record<string, unknown>) {
  return listWorkspaceServiceCommandDefinitions(parseObject(config.workspaceRuntime))
    .map((command) => command.rawConfig);
}

export function listConfiguredRuntimeServiceEntries(config: Record<string, unknown>) {
  return readRuntimeServiceEntries(config);
}

function readConfiguredServiceStates(config: Record<string, unknown>) {
  const raw = parseObject(config.serviceStates);
  const states: WorkspaceRuntimeServiceStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === "running" || value === "stopped" || value === "manual") {
      states[key] = value;
    }
  }
  return states;
}

function readDesiredRuntimeState(value: unknown): WorkspaceRuntimeDesiredState | null {
  return value === "running" || value === "stopped" || value === "manual" ? value : null;
}

export function buildWorkspaceRuntimeDesiredStatePatch(input: {
  config: Record<string, unknown>;
  currentDesiredState: WorkspaceRuntimeDesiredState | null;
  currentServiceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
  action: "start" | "stop" | "restart";
  serviceIndex?: number | null;
}): {
  desiredState: WorkspaceRuntimeDesiredState;
  serviceStates: WorkspaceRuntimeServiceStateMap | null;
} {
  const configuredServices = listConfiguredRuntimeServiceEntries(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.currentDesiredState) ?? "stopped";
  const nextServiceStates: WorkspaceRuntimeServiceStateMap = {};

  for (let index = 0; index < configuredServices.length; index += 1) {
    nextServiceStates[String(index)] = input.currentServiceStates?.[String(index)] ?? fallbackState;
  }

  const nextState: WorkspaceRuntimeDesiredState = input.action === "stop" ? "stopped" : "running";
  const applyActionState = (index: number) => {
    const key = String(index);
    // Manual services are intentionally left under operator control even when
    // an API action targets that individual service.
    if (nextServiceStates[key] === "manual") return;
    nextServiceStates[key] = nextState;
  };
  if (input.serviceIndex === undefined || input.serviceIndex === null) {
    for (let index = 0; index < configuredServices.length; index += 1) {
      applyActionState(index);
    }
  } else if (input.serviceIndex >= 0 && input.serviceIndex < configuredServices.length) {
    applyActionState(input.serviceIndex);
  }

  const desiredState = Object.values(nextServiceStates).some((state) => state === "running")
    ? "running"
    : Object.values(nextServiceStates).some((state) => state === "manual")
      ? "manual"
      : "stopped";

  return {
    desiredState,
    serviceStates: Object.keys(nextServiceStates).length > 0 ? nextServiceStates : null,
  };
}

function selectRuntimeServiceEntries(input: {
  config: Record<string, unknown>;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
  defaultDesiredState?: WorkspaceRuntimeDesiredState | null;
  serviceStates?: WorkspaceRuntimeServiceStateMap | null;
}) {
  const entries = listConfiguredRuntimeServiceEntries(input.config);
  const states = input.serviceStates ?? readConfiguredServiceStates(input.config);
  const fallbackState: WorkspaceRuntimeDesiredState = readDesiredRuntimeState(input.defaultDesiredState) ?? "stopped";

  return entries.filter((_, index) => {
    if (input.serviceIndex !== undefined && input.serviceIndex !== null) {
      return index === input.serviceIndex;
    }
    if (!input.respectDesiredStates) return true;
    return (states[String(index)] ?? fallbackState) === "running";
  });
}

async function isPersistedIsolatedExecutionWorkspace(input: {
  db?: Db;
  companyId: string;
  executionWorkspaceId?: string | null;
}) {
  if (!input.db || !input.executionWorkspaceId) return false;
  const row = await input.db
    .select({ mode: executionWorkspaces.mode })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.id, input.executionWorkspaceId),
        eq(executionWorkspaces.companyId, input.companyId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.mode === "isolated_workspace";
}

type EnsureRuntimeServicesForRunInput = {
  db?: Db;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  recorder?: WorkspaceOperationRecorder | null;
};

async function ensureRuntimeServicesForRunInvocation(
  input: EnsureRuntimeServicesForRunInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    respectDesiredStates: true,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "running",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const acquiredServiceIds: string[] = [];
  const refs: RuntimeServiceRef[] = [];
  const runtimeProvision = resolveRuntimeProvision(input);
  const runtimeProvisionCommand = runtimeProvision.command;
  const provisionCoordinator = createRuntimeProvisionCoordinator();
  const allowFixedPortFallback = await isPersistedIsolatedExecutionWorkspace({
    db: input.db,
    companyId: input.agent.companyId,
    executionWorkspaceId: input.executionWorkspaceId,
  });
  runtimeServiceLeasesByRun.set(input.runId, acquiredServiceIds);

  try {
    for (const service of rawServices) {
      const { scopeType, scopeId } = resolveServiceScopeId({
        service,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        issue: input.issue,
        runId: input.runId,
        agent: input.agent,
      });
      const reuseKey = resolveRuntimeServiceReuseIdentity({
        service,
        workspace: input.workspace,
        agent: input.agent,
        issue: input.issue,
        adapterEnv: input.adapterEnv,
        scopeType,
        scopeId,
      }).reuseKey;

      if (reuseKey) {
        const existing = await findHealthyRunningRuntimeService(reuseKey);
        if (existing) {
          existing.leaseRunIds.add(input.runId);
          existing.lastUsedAt = new Date().toISOString();
          existing.stoppedAt = null;
          clearIdleTimer(existing);
          void touchLocalServiceRegistryRecord(existing.serviceKey, {
            runtimeServiceId: existing.id,
            lastSeenAt: existing.lastUsedAt,
          });
          await persistRuntimeServiceRecord(input.db, existing);
          acquiredServiceIds.push(existing.id);
          refs.push(toRuntimeServiceRef(existing, { reused: true }));
          continue;
        }
      }

      const started = await startLocalRuntimeService({
        db: input.db,
        runId: input.runId,
        agent: input.agent,
        issue: input.issue,
        workspace: input.workspace,
        executionWorkspaceId: input.executionWorkspaceId,
        adapterEnv: input.adapterEnv,
        service,
        onLog: input.onLog,
        runtimeProvisionCommand,
        runtimeProvisionKind: runtimeProvision.kind,
        recorder: input.recorder,
        provisionCoordinator,
        allowFixedPortFallback,
        reuseKey,
        scopeType,
        scopeId,
      });
      const record = started.record;
      registerRuntimeService(input.db, record);
      await persistRuntimeServiceRecord(input.db, record);
      acquiredServiceIds.push(record.id);
      refs.push(toRuntimeServiceRef(record));
    }
  } catch (err) {
    await releaseRuntimeServicesForRun(input.runId);
    throw err;
  }

  return refs;
}

async function withRuntimeStartMutex<T>(ownerKey: string, start: () => Promise<T>): Promise<T> {
  const previous = runtimeControlStartByOwner.get(ownerKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  runtimeControlStartByOwner.set(ownerKey, queued);
  await previous;
  try {
    return await start();
  } finally {
    release();
    if (runtimeControlStartByOwner.get(ownerKey) === queued) runtimeControlStartByOwner.delete(ownerKey);
  }
}

function resolveRuntimeStartMutexPlan(input: {
  services: Array<Record<string, unknown>>;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  issue: ExecutionWorkspaceIssueRef | null;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  adapterEnv: Record<string, string>;
}) {
  const fallbackOwnerId = input.executionWorkspaceId
    ?? input.workspace.workspaceId
    ?? path.resolve(input.workspace.cwd);
  const replacementReuseKeys: string[] = [];
  const keys = input.services.map((service) => {
    const { scopeType, scopeId } = resolveServiceScopeId({
      service,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      issue: input.issue,
      runId: input.runId,
      agent: input.agent,
    });
    const reuseKey = resolveRuntimeServiceReuseIdentity({
      service,
      workspace: input.workspace,
      agent: input.agent,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      scopeType,
      scopeId,
    }).reuseKey;
    // Converge all callers that can replace an existing shared runtime on its
    // reuse identity. For an initial start, retain owner-level concurrency so
    // the exposure allocator's in-flight pair claims remain authoritative.
    if (
      reuseKey
      && (runtimeServicesByReuseKey.has(reuseKey) || runtimeReplacementClaimsByReuseKey.has(reuseKey))
    ) {
      runtimeReplacementClaimsByReuseKey.set(
        reuseKey,
        (runtimeReplacementClaimsByReuseKey.get(reuseKey) ?? 0) + 1,
      );
      replacementReuseKeys.push(reuseKey);
      return `reuse:${reuseKey}`;
    }
    return `${input.agent.companyId}:owner:${fallbackOwnerId}`;
  });
  return {
    ownerKeys: [...new Set(keys)].sort(),
    replacementReuseKeys,
  };
}

function releaseRuntimeReplacementClaims(reuseKeys: string[]) {
  for (const reuseKey of reuseKeys) {
    const next = (runtimeReplacementClaimsByReuseKey.get(reuseKey) ?? 1) - 1;
    if (next <= 0) runtimeReplacementClaimsByReuseKey.delete(reuseKey);
    else runtimeReplacementClaimsByReuseKey.set(reuseKey, next);
  }
}

async function withRuntimeStartMutexes<T>(
  ownerKeys: string[],
  start: () => Promise<T>,
): Promise<T> {
  const acquire = async (index: number): Promise<T> => {
    const ownerKey = ownerKeys[index];
    if (!ownerKey) return await start();
    return await withRuntimeStartMutex(ownerKey, () => acquire(index + 1));
  };
  return await acquire(0);
}

export async function ensureRuntimeServicesForRun(
  input: EnsureRuntimeServicesForRunInput,
): Promise<RuntimeServiceRef[]> {
  const services = selectRuntimeServiceEntries({
    config: input.config,
    respectDesiredStates: true,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "running",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const mutexPlan = resolveRuntimeStartMutexPlan({
    services,
    workspace: input.workspace,
    executionWorkspaceId: input.executionWorkspaceId,
    issue: input.issue,
    runId: input.runId,
    agent: input.agent,
    adapterEnv: input.adapterEnv,
  });
  try {
    return await withRuntimeStartMutexes(
      mutexPlan.ownerKeys,
      () => ensureRuntimeServicesForRunInvocation(input),
    );
  } finally {
    releaseRuntimeReplacementClaims(mutexPlan.replacementReuseKeys);
  }
}

type StartRuntimeServicesForWorkspaceControlInput = {
  db?: Db;
  invocationId?: string;
  actor: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  config: Record<string, unknown>;
  adapterEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  recorder?: WorkspaceOperationRecorder | null;
  serviceIndex?: number | null;
  respectDesiredStates?: boolean;
};

type WorkspaceControlStartBatch = {
  refs: RuntimeServiceRef[];
  pendingReadiness: PendingRuntimeServiceReadiness[];
  startedServiceIds: string[];
};

async function startRuntimeServicesForWorkspaceControlUnlocked(
  input: StartRuntimeServicesForWorkspaceControlInput,
  rawServices: Record<string, unknown>[],
  invocationId: string,
  persistenceDb = input.db,
  registryDb = input.db,
  options?: {
    deferReadiness?: boolean;
    allowFixedPortFallback?: boolean;
    runtimeProvisionCommand?: string;
    runtimeProvisionKind?: RuntimeProvisionKind | null;
    provisionCoordinator?: RuntimeProvisionCoordinator;
    preparedProvisioning?: {
      service: Record<string, unknown>;
      record: RuntimeServiceRecord;
    } | null;
    excludedPorts?: ReadonlySet<number>;
  },
): Promise<WorkspaceControlStartBatch> {
  const refs: RuntimeServiceRef[] = [];
  const pendingReadiness: PendingRuntimeServiceReadiness[] = [];
  const startedServiceIds: string[] = [];

  for (const service of rawServices) {
    const { scopeType, scopeId } = resolveServiceScopeId({
      service,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      issue: input.issue,
      runId: invocationId,
      agent: input.actor,
    });
    const reuseKey = resolveRuntimeServiceReuseIdentity({
      service,
      workspace: input.workspace,
      agent: input.actor,
      issue: input.issue,
      adapterEnv: input.adapterEnv,
      scopeType,
      scopeId,
    }).reuseKey;

    if (reuseKey) {
      const existing = await findHealthyRunningRuntimeService(reuseKey);
      if (existing) {
        const prepared = options?.preparedProvisioning;
        if (prepared?.service === service && prepared.record.id !== existing.id && persistenceDb) {
          await persistenceDb
            .delete(workspaceRuntimeServices)
            .where(eq(workspaceRuntimeServices.id, prepared.record.id));
        }
        existing.lastUsedAt = new Date().toISOString();
        existing.stoppedAt = null;
        clearIdleTimer(existing);
        void touchLocalServiceRegistryRecord(existing.serviceKey, {
          runtimeServiceId: existing.id,
          lastSeenAt: existing.lastUsedAt,
        });
        await persistRuntimeServiceRecord(persistenceDb, existing);
        refs.push(toRuntimeServiceRef(existing, { reused: true }));
        continue;
      }
    }

    const startInput: StartLocalRuntimeServiceInput = {
      db: persistenceDb,
      runId: invocationId,
      leaseRunId: null,
      startedByRunId: null,
      agent: input.actor,
      issue: input.issue,
      workspace: input.workspace,
      executionWorkspaceId: input.executionWorkspaceId,
      adapterEnv: input.adapterEnv,
      service,
      onLog: input.onLog,
      runtimeProvisionCommand: options?.runtimeProvisionCommand,
      runtimeProvisionKind: options?.runtimeProvisionKind,
      recorder: input.recorder,
      provisionCoordinator: options?.provisionCoordinator,
      preparedProvisioningRecord:
        options?.preparedProvisioning?.service === service
          ? options.preparedProvisioning.record
          : undefined,
      allowFixedPortFallback: options?.allowFixedPortFallback,
      excludedPorts: options?.excludedPorts,
      reuseKey,
      scopeType,
      scopeId,
    };

    // Manually controlled services are not tied to a heartbeat run lifecycle, so they do not
    // retain a run lease and never persist a startedByRunId foreign key.
    const started = await startLocalRuntimeService(startInput, {
      deferReadiness: options?.deferReadiness,
    });
    registerRuntimeService(registryDb, started.record);
    await persistRuntimeServiceRecord(persistenceDb, started.record);
    refs.push(toRuntimeServiceRef(started.record));

    if (options?.deferReadiness && started.record.status === "starting" && !started.record.reused) {
      // Attach a rejection handler immediately; the caller awaits the same promise after
      // the DB transaction commits, but transaction failures may skip that wait path.
      started.readiness.catch(() => undefined);
      pendingReadiness.push({ ...started, service });
      startedServiceIds.push(started.record.id);
    }
  }

  return { refs, pendingReadiness, startedServiceIds };
}

async function lockWorkspaceRuntimeStartParents(
  db: Db,
  input: StartRuntimeServicesForWorkspaceControlInput,
) {
  let allowFixedPortFallback = false;
  if (input.executionWorkspaceId) {
    const [lockedExecutionWorkspace] = await db
      .select({ id: executionWorkspaces.id, mode: executionWorkspaces.mode })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.id, input.executionWorkspaceId),
          eq(executionWorkspaces.companyId, input.actor.companyId),
        ),
      )
      .for("update");
    if (!lockedExecutionWorkspace) throw new Error("Execution workspace not found before starting runtime services");
    allowFixedPortFallback = lockedExecutionWorkspace.mode === "isolated_workspace";
  }

  if (input.workspace.workspaceId) {
    const [lockedProjectWorkspace] = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, input.workspace.workspaceId),
          eq(projectWorkspaces.companyId, input.actor.companyId),
        ),
      )
      .for("update");
    if (!lockedProjectWorkspace) throw new Error("Project workspace not found before starting runtime services");
  }

  return allowFixedPortFallback;
}

function canRetryDeferredPortBindCollision(
  service: Record<string, unknown>,
  allowFixedPortFallback: boolean,
) {
  const portConfig = parseObject(service.port);
  const portType = asString(portConfig.type, "");
  const explicitPort = asNumber(portConfig.value, asNumber(service.port, 0));
  return portType === "auto" || Boolean(allowFixedPortFallback && explicitPort > 0);
}

async function discardFailedDeferredRuntimeStart(db: Db, record: RuntimeServiceRecord) {
  clearIdleTimer(record);
  if (runtimeServicesById.get(record.id) === record) runtimeServicesById.delete(record.id);
  if (record.reuseKey && runtimeServicesByReuseKey.get(record.reuseKey) === record.id) {
    runtimeServicesByReuseKey.delete(record.reuseKey);
  }
  await removeLocalServiceRegistryRecord(record.serviceKey).catch(() => undefined);
  await persistRuntimeServiceRecord(db, record);
}

async function startRuntimeServicesForWorkspaceControlInvocation(
  input: StartRuntimeServicesForWorkspaceControlInput,
): Promise<RuntimeServiceRef[]> {
  const rawServices = selectRuntimeServiceEntries({
    config: input.config,
    serviceIndex: input.serviceIndex,
    respectDesiredStates: input.respectDesiredStates,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "stopped",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const invocationId = input.invocationId ?? randomUUID();
  const runtimeProvision = resolveRuntimeProvision(input);
  const runtimeProvisionCommand = runtimeProvision.command;
  const provisionCoordinator = createRuntimeProvisionCoordinator();
  const hasHttpsExposure = await anyRuntimeServiceUsesHttpsExposure(rawServices);

  if (
    rawServices.length === 0
    || !input.db
    || (!input.executionWorkspaceId && !input.workspace.workspaceId)
    // The reservation row must commit before the backend binds. Keeping this
    // path outside the parent-row transaction avoids a crash window where the
    // broker lease exists but the DB transaction has not committed its handle.
    || hasHttpsExposure
  ) {
    const batch = await startRuntimeServicesForWorkspaceControlUnlocked(
      input,
      rawServices,
      invocationId,
      input.db,
      input.db,
      {
        runtimeProvisionCommand,
        runtimeProvisionKind: runtimeProvision.kind,
        provisionCoordinator,
      },
    );
    return batch.refs;
  }

  let startBatch: WorkspaceControlStartBatch = {
    refs: [],
    pendingReadiness: [],
    startedServiceIds: [],
  };
  let preparedProvisioning: {
    service: Record<string, unknown>;
    record: RuntimeServiceRecord;
  } | null = null;
  let allowFixedPortFallback = false;
  try {
    if (runtimeProvisionCommand) {
      for (const service of rawServices) {
        const { scopeType, scopeId } = resolveServiceScopeId({
          service,
          workspace: input.workspace,
          executionWorkspaceId: input.executionWorkspaceId,
          issue: input.issue,
          runId: invocationId,
          agent: input.actor,
        });
        const reuseKey = resolveRuntimeServiceReuseIdentity({
          service,
          workspace: input.workspace,
          agent: input.actor,
          issue: input.issue,
          adapterEnv: input.adapterEnv,
          scopeType,
          scopeId,
        }).reuseKey;
        const existing = await findHealthyRunningRuntimeService(reuseKey);
        if (existing) continue;

        const record = await prepareRuntimeProvisioning({
          db: input.db,
          runId: invocationId,
          leaseRunId: null,
          startedByRunId: null,
          agent: input.actor,
          issue: input.issue,
          workspace: input.workspace,
          executionWorkspaceId: input.executionWorkspaceId,
          adapterEnv: input.adapterEnv,
          service,
          onLog: input.onLog,
          runtimeProvisionCommand,
          runtimeProvisionKind: runtimeProvision.kind,
          recorder: input.recorder,
          provisionCoordinator,
          reuseKey,
          scopeType,
          scopeId,
        });
        if (record) preparedProvisioning = { service, record };
        break;
      }
    }

    await input.db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      allowFixedPortFallback = await lockWorkspaceRuntimeStartParents(txDb, input);

      // Branch reconciliation takes these same parent row locks before mutating
      // a recorded branch. Persisting a `starting` service row before commit closes
      // the process-start window without holding the DB transaction for readiness.
      startBatch = await startRuntimeServicesForWorkspaceControlUnlocked(
        { ...input, db: txDb },
        rawServices,
        invocationId,
        txDb,
        input.db,
        {
          deferReadiness: true,
          allowFixedPortFallback,
          runtimeProvisionCommand,
          runtimeProvisionKind: runtimeProvision.kind,
          provisionCoordinator,
          preparedProvisioning,
        },
      );
    });

    // Readiness never uses the transaction-scoped DB handle. A late bind collision is
    // recorded after commit, then only the next bounded reservation re-enters a short
    // parent-locked transaction. Slow builds therefore cannot retain the parent locks.
    for (const initialPending of startBatch.pendingReadiness) {
      let pending: PendingRuntimeServiceReadiness | null = initialPending;
      const excludedPorts = new Set<number>();

      while (pending) {
        try {
          await pending.readiness;
          await persistRuntimeServiceRecord(input.db, pending.record);
          break;
        } catch (error) {
          await discardFailedDeferredRuntimeStart(input.db, pending.record);
          if (
            !(error instanceof RuntimeServicePortBindCollision)
            || !canRetryDeferredPortBindCollision(pending.service, allowFixedPortFallback)
          ) {
            throw error;
          }

          excludedPorts.add(error.port);
          if (excludedPorts.size >= WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS) {
            const portConfig = parseObject(pending.service.port);
            const portType = asString(portConfig.type, "");
            const preferredPort = asNumber(portConfig.value, asNumber(pending.service.port, 0));
            if (allowFixedPortFallback && portType !== "auto" && preferredPort > 0 && input.executionWorkspaceId) {
              throw await buildRuntimePortAllocationConflict({
                db: input.db,
                companyId: input.actor.companyId,
                executionWorkspaceId: input.executionWorkspaceId,
                preferredPort,
                attemptedPorts: [...excludedPorts],
              });
            }
            throw conflict("No safe automatically allocated runtime service port is available.", {
              code: "workspace_runtime_port_allocation_exhausted",
              attemptedPortCount: excludedPorts.size,
              remediation: "Retry the start or configure a different runtime service port.",
            });
          }

          const failedRecordId = pending.record.id;
          let retryBatch: WorkspaceControlStartBatch = {
            refs: [],
            pendingReadiness: [],
            startedServiceIds: [],
          };
          let retryAllowsFixedPortFallback = false;
          await input.db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            retryAllowsFixedPortFallback = await lockWorkspaceRuntimeStartParents(txDb, input);
            if (!canRetryDeferredPortBindCollision(pending!.service, retryAllowsFixedPortFallback)) {
              throw error;
            }
            retryBatch = await startRuntimeServicesForWorkspaceControlUnlocked(
              { ...input, db: txDb },
              [pending!.service],
              invocationId,
              txDb,
              input.db,
              {
                deferReadiness: true,
                allowFixedPortFallback: retryAllowsFixedPortFallback,
                provisionCoordinator,
                excludedPorts,
              },
            );
          });
          allowFixedPortFallback = retryAllowsFixedPortFallback;
          for (const serviceId of retryBatch.startedServiceIds) {
            if (!startBatch.startedServiceIds.includes(serviceId)) {
              startBatch.startedServiceIds.push(serviceId);
            }
          }
          const replacementRef = retryBatch.refs[0];
          const failedRefIndex = startBatch.refs.findIndex((ref) => ref.id === failedRecordId);
          if (replacementRef && failedRefIndex >= 0) startBatch.refs[failedRefIndex] = replacementRef;
          pending = retryBatch.pendingReadiness[0] ?? null;
        }
      }
    }

    return startBatch.refs.map((ref) => {
      const record = runtimeServicesById.get(ref.id);
      return record ? toRuntimeServiceRef(record, { reused: ref.reused }) : ref;
    });
  } catch (error) {
    for (const serviceId of startBatch.startedServiceIds) {
      await stopRuntimeService(serviceId).catch(() => undefined);
    }
    if (preparedProvisioning && startBatch.startedServiceIds.length === 0) {
      const nowIso = new Date().toISOString();
      preparedProvisioning.record.status = "failed";
      preparedProvisioning.record.healthStatus = "unhealthy";
      preparedProvisioning.record.lastUsedAt = nowIso;
      preparedProvisioning.record.stoppedAt = nowIso;
      await persistRuntimeServiceRecord(input.db, preparedProvisioning.record).catch(() => undefined);
    }
    throw error;
  }
}

export async function startRuntimeServicesForWorkspaceControl(
  input: StartRuntimeServicesForWorkspaceControlInput,
): Promise<RuntimeServiceRef[]> {
  const services = selectRuntimeServiceEntries({
    config: input.config,
    serviceIndex: input.serviceIndex,
    respectDesiredStates: input.respectDesiredStates,
    defaultDesiredState: readDesiredRuntimeState(input.config.desiredState) ?? "stopped",
    serviceStates: readConfiguredServiceStates(input.config),
  });
  const invocationId = input.invocationId ?? "workspace_control";
  const mutexPlan = resolveRuntimeStartMutexPlan({
    services,
    workspace: input.workspace,
    executionWorkspaceId: input.executionWorkspaceId,
    issue: input.issue,
    runId: invocationId,
    agent: input.actor,
    adapterEnv: input.adapterEnv,
  });
  try {
    return await withRuntimeStartMutexes(
      mutexPlan.ownerKeys,
      () => startRuntimeServicesForWorkspaceControlInvocation(input),
    );
  } finally {
    releaseRuntimeReplacementClaims(mutexPlan.replacementReuseKeys);
  }
}

export async function releaseRuntimeServicesForRun(runId: string) {
  const acquired = runtimeServiceLeasesByRun.get(runId) ?? [];
  runtimeServiceLeasesByRun.delete(runId);
  for (const serviceId of acquired) {
    const record = runtimeServicesById.get(serviceId);
    if (!record) continue;
    record.leaseRunIds.delete(runId);
    record.lastUsedAt = new Date().toISOString();
    const stopType = asString(record.stopPolicy?.type, record.lifecycle === "ephemeral" ? "on_run_finish" : "manual");
    await persistRuntimeServiceRecord(record.db, record);
    if (record.leaseRunIds.size === 0) {
      const detachedUnhealthySharedRuntime = record.healthStatus === "unhealthy"
        && Boolean(record.reuseKey)
        && runtimeServicesByReuseKey.get(record.reuseKey!) !== record.id;
      if (
        record.lifecycle === "ephemeral"
        || stopType === "on_run_finish"
        || detachedUnhealthySharedRuntime
      ) {
        await stopRuntimeService(serviceId);
        continue;
      }
      scheduleIdleStop(record);
    }
  }
}

export async function stopRuntimeServicesForExecutionWorkspace(input: {
  db?: Db;
  executionWorkspaceId: string;
  workspaceCwd?: string | null;
  runtimeServiceId?: string | null;
}) {
  const normalizedWorkspaceCwd = input.workspaceCwd ? path.resolve(input.workspaceCwd) : null;
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      if (record.executionWorkspaceId === input.executionWorkspaceId) return true;
      if (!normalizedWorkspaceCwd || !record.cwd) return false;
      const resolvedCwd = path.resolve(record.cwd);
      return (
        resolvedCwd === normalizedWorkspaceCwd ||
        resolvedCwd.startsWith(`${normalizedWorkspaceCwd}${path.sep}`)
      );
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    if (input.runtimeServiceId) {
      const now = new Date();
      const rows = await input.db
        .select({
          id: workspaceRuntimeServices.id,
          exposure: workspaceRuntimeServices.exposure,
          exposureHandle: workspaceRuntimeServices.exposureHandle,
        })
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
      await cleanupPersistedExposureRows(input.db, rows);
      await input.db
        .update(workspaceRuntimeServices)
        .set({
          status: "stopped",
          healthStatus: "unknown",
          stoppedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(workspaceRuntimeServices.id, input.runtimeServiceId));
    } else {
      await markPersistedRuntimeServicesStoppedForExecutionWorkspace({
        db: input.db,
        executionWorkspaceId: input.executionWorkspaceId,
      });
    }
  }
}

export async function stopRuntimeServicesForProjectWorkspace(input: {
  db?: Db;
  projectWorkspaceId: string;
  runtimeServiceId?: string | null;
}) {
  const matchingServiceIds = Array.from(runtimeServicesById.values())
    .filter((record) => {
      if (input.runtimeServiceId) return record.id === input.runtimeServiceId;
      return record.projectWorkspaceId === input.projectWorkspaceId && record.scopeType === "project_workspace";
    })
    .map((record) => record.id);

  for (const serviceId of matchingServiceIds) {
    await stopRuntimeService(serviceId);
  }

  if (input.db) {
    const now = new Date();
    const exposureCondition = input.runtimeServiceId
      ? eq(workspaceRuntimeServices.id, input.runtimeServiceId)
      : and(
          eq(workspaceRuntimeServices.projectWorkspaceId, input.projectWorkspaceId),
          eq(workspaceRuntimeServices.scopeType, "project_workspace"),
          inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running"]),
        );
    const exposureRows = await input.db
      .select({
        id: workspaceRuntimeServices.id,
        exposure: workspaceRuntimeServices.exposure,
        exposureHandle: workspaceRuntimeServices.exposureHandle,
      })
      .from(workspaceRuntimeServices)
      .where(exposureCondition);
    await cleanupPersistedExposureRows(input.db, exposureRows);
    await input.db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        exposureCondition,
      );
  }
}

export async function listWorkspaceRuntimeServicesForProjectWorkspaces(
  db: Db,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, typeof workspaceRuntimeServices.$inferSelect[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId);
    if (existing) existing.push(row);
    else grouped.set(row.projectWorkspaceId, [row]);
  }
  return grouped;
}

/**
 * Statuses that mean "there is, or is supposed to be, a live backend process".
 * A row in one of these states is what the backfill has to reprovision; a
 * `stopped` row simply picks the default up on its next start.
 */
const LIVE_RUNTIME_SERVICE_STATUSES = new Set(["provisioning", "starting", "running"]);

export type ManagedRuntimeExposureBackfillDecision = {
  action: "keep" | "reprovision";
  reason: string;
};

/**
 * Decide what the HTTPS backfill should do with one persisted runtime-service
 * row (PAP-17158).
 *
 * Pure so every branch is directly testable: the reasons below are the whole
 * contract for which pre-feature workspaces get upgraded and which are left
 * exactly as they are.
 *
 * `declaredIntent === null` means no configured service entry could be matched
 * to this row. Such a row is deliberately left alone: reprovisioning works by
 * stopping the HTTP backend and letting the desired-state restart bring it back
 * with exposure, so without a config to restart from we would take a service
 * down and never bring it back.
 */
export function decideManagedRuntimeExposureBackfill(input: {
  mode: ManagedRuntimeHttpsMode;
  brokerAvailable: boolean;
  provider: string;
  serviceName: string;
  command: string | null;
  status: string;
  hasExposure: boolean;
  declaredIntent: RuntimeExposureIntent | null;
}): ManagedRuntimeExposureBackfillDecision {
  if (input.mode === "off") return { action: "keep", reason: "https_default_disabled" };
  if (input.provider !== "local_process") return { action: "keep", reason: "not_a_managed_local_process" };
  // Idempotence: a row that already carries exposure state is never re-driven,
  // so repeated deploys and restarts converge instead of churning listeners.
  if (input.hasExposure) return { action: "keep", reason: "already_exposed" };
  if (input.declaredIntent === "disabled") return { action: "keep", reason: "deliberate_opt_out" };
  if (input.declaredIntent === null) return { action: "keep", reason: "no_configured_service_entry" };
  if (!isManagedHttpsDefaultCandidate({ serviceName: input.serviceName, command: input.command })) {
    return { action: "keep", reason: "unmanaged_or_custom_service" };
  }
  if (input.mode !== "force" && !input.brokerAvailable) {
    return { action: "keep", reason: "broker_unavailable" };
  }
  if (!LIVE_RUNTIME_SERVICE_STATUSES.has(input.status)) {
    return { action: "keep", reason: "stopped_defaults_on_next_start" };
  }
  return { action: "reprovision", reason: "http_only_managed_service" };
}

/**
 * Look up the exposure intent a persisted runtime-service row inherits from its
 * owning workspace configuration, by matching the row's service name against the
 * configured entries. Returns null when no entry matches.
 */
async function buildPersistedRuntimeExposureIntentLookup(db: Db) {
  const [projectWorkspaceRows, executionWorkspaceRows] = await Promise.all([
    db.select().from(projectWorkspaces),
    db.select().from(executionWorkspaces),
  ]);
  const projectRuntimeById = new Map(projectWorkspaceRows.map((row) => [
    row.id,
    readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime ?? null,
  ] as const));
  const executionRuntimeById = new Map(executionWorkspaceRows.map((row) => [
    row.id,
    readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime
      ?? (row.projectWorkspaceId ? projectRuntimeById.get(row.projectWorkspaceId) ?? null : null),
  ] as const));

  return (row: {
    serviceName: string;
    projectWorkspaceId: string | null;
    executionWorkspaceId: string | null;
  }): RuntimeExposureIntent | null => {
    const runtime = (row.executionWorkspaceId ? executionRuntimeById.get(row.executionWorkspaceId) : null)
      ?? (row.projectWorkspaceId ? projectRuntimeById.get(row.projectWorkspaceId) ?? null : null);
    if (!runtime) return null;
    const entries = listConfiguredRuntimeServiceEntries({ workspaceRuntime: runtime });
    const entry = entries.find((candidate) => asString(candidate.name, "service") === row.serviceName);
    if (!entry) return null;
    return readRuntimeExposureIntent(parseObject(entry.expose));
  };
}

export async function refreshPersistedRuntimeServiceHealth(input: {
  db: Db;
  companyId: string;
  executionWorkspaceId: string;
  projectWorkspaceId?: string | null;
}) {
  const ownershipCondition = input.projectWorkspaceId
    ? or(
        eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId),
        and(
          eq(workspaceRuntimeServices.projectWorkspaceId, input.projectWorkspaceId),
          eq(workspaceRuntimeServices.scopeType, "project_workspace"),
        ),
      )
    : eq(workspaceRuntimeServices.executionWorkspaceId, input.executionWorkspaceId);
  const rows = await input.db
    .select({
      id: workspaceRuntimeServices.id,
      serviceName: workspaceRuntimeServices.serviceName,
      command: workspaceRuntimeServices.command,
      provider: workspaceRuntimeServices.provider,
      port: workspaceRuntimeServices.port,
      url: workspaceRuntimeServices.url,
      healthStatus: workspaceRuntimeServices.healthStatus,
      cwd: workspaceRuntimeServices.cwd,
      executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId,
      companyId: workspaceRuntimeServices.companyId,
    })
    .from(workspaceRuntimeServices)
    .where(and(
      eq(workspaceRuntimeServices.companyId, input.companyId),
      eq(workspaceRuntimeServices.provider, "local_process"),
      eq(workspaceRuntimeServices.status, "running"),
      ownershipCondition,
    ));
  const results = await Promise.all(rows.map(async (row) => ({
    row,
    healthStatus: await isRuntimeServiceUrlHealthy(row.url, { ...row, db: input.db })
      ? "healthy" as const
      : "unhealthy" as const,
  })));
  await Promise.all(results.map(async ({ row, healthStatus }) => {
    const liveRecord = runtimeServicesById.get(row.id);
    if (liveRecord) liveRecord.healthStatus = healthStatus;
    if (row.healthStatus === healthStatus) return;
    await input.db.update(workspaceRuntimeServices).set({ healthStatus, updatedAt: new Date() }).where(and(
      eq(workspaceRuntimeServices.id, row.id),
      eq(workspaceRuntimeServices.companyId, input.companyId),
      eq(workspaceRuntimeServices.status, "running"),
    ));
  }));
  return {
    checked: results.length,
    healthy: results.filter((result) => result.healthStatus === "healthy").length,
    unhealthy: results.filter((result) => result.healthStatus === "unhealthy").length,
  };
}

export async function reconcilePersistedRuntimeServicesOnStartup(db: Db) {
  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.provider, "local_process"),
        inArray(workspaceRuntimeServices.status, ["provisioning", "starting", "running", "stopped"]),
      ),
    );

  // Backfill inputs, resolved once per startup rather than per row.
  const httpsMode = resolveManagedRuntimeHttpsMode();
  const brokerAvailable = httpsMode === "off"
    ? false
    : await workspaceRuntimeExposureDeps.isBrokerAvailable().catch(() => false);
  const readDeclaredExposureIntent = await buildPersistedRuntimeExposureIntentLookup(db);

  let ownedExposureListeners: Awaited<ReturnType<BrokerClient["list"]>> | null = [];
  // Also fetch when a row merely *reserves* a dedicated-range port. The row that
  // matters most to PAP-17419 is exactly the one with `exposure.state ===
  // "removed"`: it claims nothing, yet its leased pair can still be mapped by
  // someone else. Skipping the broker read for those rows is what let a false
  // `removed` go unnoticed.
  if (rows.some((row) => (
    (row.exposure && row.exposure.state !== "removed")
    || (row.port !== null && isRuntimeExposureAppPort(row.port))
  ))) {
    try {
      ownedExposureListeners = await workspaceRuntimeExposureDeps.broker.list();
    } catch {
      ownedExposureListeners = null;
    }
  }

  const exposureReservationDrift = await detectPersistedExposureReservationDrift({
    rows,
    ownedListeners: ownedExposureListeners,
  });
  const companyIdByRowId = new Map(rows.map((row) => [row.id, row.companyId] as const));
  for (const entry of exposureReservationDrift) {
    const description = describeExposureReservationDrift(entry);
    console.warn(`[workspace-runtime] exposure reservation drift: ${description}`);
    const companyId = companyIdByRowId.get(entry.runtimeServiceId);
    if (!companyId) continue;
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "workspace_runtime",
      action: "workspace_runtime.exposure_reservation_drift",
      entityType: entry.owner.executionWorkspaceId ? "execution_workspace" : "workspace_runtime_service",
      entityId: entry.owner.executionWorkspaceId ?? entry.runtimeServiceId,
      issueId: entry.owner.issueId,
      details: {
        description,
        runtimeServiceId: entry.runtimeServiceId,
        port: entry.port,
        reason: entry.reason,
        executionWorkspaceId: entry.owner.executionWorkspaceId,
        conflictingExecutionWorkspaceId: entry.conflictingOwner?.executionWorkspaceId ?? null,
        conflictingRuntimeServiceId: entry.conflictingOwner?.runtimeServiceId ?? null,
      },
    }).catch(() => undefined);
  }

  let reconciled = 0;
  let adopted = 0;
  let stopped = 0;
  let backfilled = 0;
  const driftedRuntimeServiceIds = new Set(exposureReservationDrift.map((entry) => entry.runtimeServiceId));
  for (const row of rows) {
    // PAP-17419: this row's reserved pair is live, or Serve-mapped, under an
    // identity that is not this row's. Every branch below is unsafe for such a
    // row — cleanup would remove a mapping that is now someone else's, adoption
    // would take over another execution workspace's service and re-attribute it
    // here, and the health branch would terminate it outright. None of that is
    // this sweep's call to make, so leave the row and the occupying service
    // exactly as they are. The drift is already reported above, and the ledger
    // keeps the pair reserved so no start can be handed it either.
    if (driftedRuntimeServiceIds.has(row.id)) {
      reconciled += 1;
      continue;
    }
    if (row.status === "stopped" && row.exposure && row.exposure.state !== "removed") {
      // This branch is a GLOBAL sweep: `rows` spans every execution workspace and
      // company on the host, at any age, and it runs on every server start. It
      // used to issue a broker removal for each stale row on the row's authority
      // alone — which is how a restart at 12:25:49 UTC deleted the preserved
      // `42000/52000` mappings from two rows that were 2 and 3 days old
      // (PAP-17285). Corroborate against the broker's live ownership view, which
      // this function has already fetched, instead of trusting the row.
      await cleanupPersistedExposureRows(
        db,
        [{ id: row.id, exposure: row.exposure, exposureHandle: row.exposureHandle }],
        { ownedListeners: ownedExposureListeners },
      );
      reconciled += 1;
      continue;
    }
    const rowExposureListeners = ownedExposureListeners?.filter((listener) => listener.runtimeId === row.id) ?? [];
    const exposureMappingMatches = !row.exposure || (
      row.exposure.state === "ready"
      && Boolean(row.exposureHandle)
      && rowExposureListeners.length === row.exposure.listeners.length
      && row.exposure.listeners.every((expected) => rowExposureListeners.some((actual) => (
        actual.port === expected.targetPort && actual.purpose === expected.purpose
      )))
    );
    const exposureHealthMatches = !row.exposure || (
      exposureMappingMatches
      && Boolean(row.exposure.publicUrl)
      && await workspaceRuntimeExposureDeps.probeHealth(
        new URL("/api/health", row.exposure.publicUrl!).toString(),
      )
    );
    // Pre-feature rows carry no exposure state at all. An eligible one that is
    // still serving plain HTTP must not be adopted as-is, or the deploy would
    // leave `http://paperclip-dev:<port>` as the canonical URL forever. Stopping
    // it here hands it to the desired-state restart below, which brings it back
    // through the normal fail-closed exposure lifecycle.
    const backfillDecision = decideManagedRuntimeExposureBackfill({
      mode: httpsMode,
      brokerAvailable,
      provider: row.provider,
      serviceName: row.serviceName,
      command: row.command,
      status: row.status,
      hasExposure: Boolean(row.exposure && row.exposure.state !== "removed"),
      declaredIntent: readDeclaredExposureIntent({
        serviceName: row.serviceName,
        projectWorkspaceId: row.projectWorkspaceId ?? null,
        executionWorkspaceId: row.executionWorkspaceId ?? null,
      }),
    });
    let adoptedRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (
      adoptedRecord
      && (
        adoptedRecord.command !== row.command
        || adoptedRecord.serviceName !== row.serviceName
        || adoptedRecord.envFingerprint !== (row.reuseKey ?? "")
        || adoptedRecord.port !== (row.port ?? null)
        || (row.cwd !== null && path.resolve(adoptedRecord.cwd) !== path.resolve(row.cwd))
      )
    ) {
      await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      adoptedRecord = null;
    }
    if (!adoptedRecord && row.command && row.cwd) {
      adoptedRecord = await findAdoptableLocalService({
        serviceKey: createLocalServiceKey({
          profileKind: "workspace-runtime",
          serviceName: row.serviceName,
          cwd: row.cwd,
          command: row.command,
          envFingerprint: row.reuseKey ?? "",
          port: null,
          scope: {
            scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
            scopeId: row.scopeId ?? null,
            executionWorkspaceId: row.executionWorkspaceId ?? null,
            reuseKey: row.reuseKey ?? null,
          },
        }),
        profileKind: "workspace-runtime",
        serviceName: row.serviceName,
        command: row.command,
        cwd: row.cwd,
        envFingerprint: row.reuseKey ?? "",
        port: row.port ?? null,
        url: row.backendUrl ?? row.url ?? null,
      });
    }
    if (adoptedRecord) {
      const adoptedUrl = adoptedRecord.url ?? row.backendUrl ?? row.url ?? null;
      const adoptedHealthInput = {
        db,
        serviceName: row.serviceName,
        command: row.command,
        provider: "local_process",
        port: adoptedRecord.port ?? row.port,
        cwd: row.cwd,
        executionWorkspaceId: row.executionWorkspaceId ?? null,
        companyId: row.companyId,
      };
      // A surviving service can be slow to answer one probe when the host is
      // busy at startup. One timeout is not enough evidence to terminate it.
      // Confirm an unhealthy verdict with a second probe after a short bounded
      // delay, the same way the reuse path protects a shared runtime.
      let adoptedHealthy = await isRuntimeServiceUrlHealthy(adoptedUrl, adoptedHealthInput);
      if (!adoptedHealthy) {
        await delay(250);
        adoptedHealthy = await isRuntimeServiceUrlHealthy(adoptedUrl, adoptedHealthInput);
      }
      if (
        backfillDecision.action === "reprovision"
        || !exposureHealthMatches
        || !adoptedHealthy
      ) {
        if (backfillDecision.action === "reprovision") backfilled += 1;
        await terminateLocalService(adoptedRecord);
        await removeLocalServiceRegistryRecord(adoptedRecord.serviceKey);
      } else {
        const record: RuntimeServiceRecord = {
          id: row.id,
          companyId: row.companyId,
          projectId: row.projectId ?? null,
          projectWorkspaceId: row.projectWorkspaceId ?? null,
          executionWorkspaceId: row.executionWorkspaceId ?? null,
          issueId: row.issueId ?? null,
          serviceName: row.serviceName,
          status: "running",
          lifecycle: row.lifecycle as RuntimeServiceRecord["lifecycle"],
          scopeType: row.scopeType as RuntimeServiceRecord["scopeType"],
          scopeId: row.scopeId ?? null,
          reuseKey: row.reuseKey ?? null,
          command: row.command ?? null,
          cwd: row.cwd ?? null,
          port: adoptedRecord.port ?? row.port ?? null,
          url: row.exposure?.publicUrl ?? adoptedRecord.url ?? row.url ?? null,
          provider: "local_process",
          providerRef: String(adoptedRecord.pid),
          ownerAgentId: row.ownerAgentId ?? null,
          startedByRunId: row.startedByRunId ?? null,
          lastUsedAt: new Date().toISOString(),
          startedAt: row.startedAt.toISOString(),
          stoppedAt: null,
          stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
          healthStatus: "healthy",
          exposure: row.exposure ?? null,
          reused: true,
          db,
          child: null,
          leaseRunIds: new Set(),
          idleTimer: null,
          envFingerprint: row.reuseKey ?? "",
          serviceKey: adoptedRecord.serviceKey,
          profileKind: "workspace-runtime",
          processGroupId: adoptedRecord.processGroupId ?? null,
          exposureHandle: row.exposureHandle ?? null,
          backendUrl: adoptedUrl,
          exposureConfig: null,
        };
        registerRuntimeService(db, record);
        await touchLocalServiceRegistryRecord(adoptedRecord.serviceKey, {
          runtimeServiceId: row.id,
          lastSeenAt: record.lastUsedAt,
        });
        await persistRuntimeServiceRecord(db, record);
        reconciled += 1;
        adopted += 1;
        continue;
      }
    }

    if (row.status === "stopped") {
      continue;
    }

    const now = new Date();
    let stoppedExposure = row.exposure ?? null;
    let stoppedExposureHandle = row.exposureHandle ?? null;
    if (stoppedExposure) {
      const cleanup = await deprovisionExposure(workspaceRuntimeExposureDeps, {
        runtimeId: row.id,
        handle: stoppedExposureHandle,
        ports: stoppedExposure.listeners.map((listener) => listener.targetPort),
      });
      for (const port of cleanup.quarantinedPorts) quarantinedRuntimeExposurePorts.add(port);
      stoppedExposure = {
        ...stoppedExposure,
        state: cleanup.status.state,
        publicUrl: null,
        lastError: cleanup.status.lastError,
        updatedAt: now.toISOString(),
      };
      if (cleanup.status.state === "removed") stoppedExposureHandle = null;
    }
    await db
      .update(workspaceRuntimeServices)
      .set({
        status: "stopped",
        healthStatus: "unknown",
        // A row queued for HTTPS backfill drops its HTTP URL now rather than
        // keeping it until the restart succeeds: if the restart fails, the
        // fail-closed contract says show no URL, not a working HTTP one.
        url: stoppedExposure || backfillDecision.action === "reprovision" ? null : row.url,
        exposure: stoppedExposure,
        exposureHandle: stoppedExposureHandle,
        stoppedAt: now,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(workspaceRuntimeServices.id, row.id));
    const registryRecord = await findLocalServiceRegistryRecordByRuntimeServiceId({
      runtimeServiceId: row.id,
      profileKind: "workspace-runtime",
    });
    if (registryRecord) {
      await removeLocalServiceRegistryRecord(registryRecord.serviceKey);
    }
    reconciled += 1;
    stopped += 1;
  }

  // Row reconciliation alone cannot repair the process-start crash window: the
  // local service registry may contain a healthy managed process whose DB row
  // was never committed. Re-applying persisted desired state adopts that
  // registry entry (or restarts a missing service) and makes it visible to
  // workspace cleanup through workspace_runtime_services again.
  //
  // It is also the second half of the HTTPS backfill: services stopped above as
  // HTTP-only come back here through the ordinary start path, which now applies
  // the `tailscale_https` default and only reports them healthy behind a
  // verified HTTPS URL.
  const desiredState = await restartDesiredRuntimeServicesOnStartup(db);

  return {
    reconciled,
    adopted,
    stopped,
    backfilled,
    restarted: desiredState.restarted,
    restartFailed: desiredState.failed,
    /** Stopped/removed rows whose reserved ports are live or mapped elsewhere. */
    exposureReservationDrift,
  };
}

export async function restartDesiredRuntimeServicesOnStartup(db: Db) {
  let restarted = 0;
  let failed = 0;

  const projectWorkspaceRows = await db
    .select()
    .from(projectWorkspaces);
  const projectWorkspaceRowsById = new Map(projectWorkspaceRows.map((row) => [row.id, row] as const));

  for (const row of projectWorkspaceRows) {
    const runtimeConfig = readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null);
    if (runtimeConfig?.desiredState !== "running" || !runtimeConfig.workspaceRuntime || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: null,
        workspace: {
          baseCwd: row.cwd,
          source: "project_primary",
          projectId: row.projectId,
          workspaceId: row.id,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.repoRef ?? null,
          strategy: "project_primary",
          cwd: row.cwd,
          branchName: row.defaultRef ?? row.repoRef ?? null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: runtimeConfig.workspaceRuntime,
          desiredState: runtimeConfig.desiredState,
          serviceStates: runtimeConfig.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  const executionWorkspaceRows = await db
    .select()
    .from(executionWorkspaces)
    .where(inArray(executionWorkspaces.status, ["active", "idle", "in_review", "cleanup_failed"]));

  for (const row of executionWorkspaceRows) {
    const config = readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null);
    const inheritedRuntimeConfig = row.projectWorkspaceId
      ? readProjectWorkspaceRuntimeConfig(
          (projectWorkspaceRowsById.get(row.projectWorkspaceId)?.metadata as Record<string, unknown> | null) ?? null,
        )?.workspaceRuntime ?? null
      : null;
    const effectiveRuntimeConfig = config?.workspaceRuntime ?? inheritedRuntimeConfig;
    if (config?.desiredState !== "running" || !effectiveRuntimeConfig || !row.cwd) continue;

    try {
      const refs = await startRuntimeServicesForWorkspaceControl({
        db,
        actor: { id: null, name: "Paperclip", companyId: row.companyId },
        issue: row.sourceIssueId
          ? {
              id: row.sourceIssueId,
              identifier: null,
              title: row.name,
            }
          : null,
        workspace: {
          baseCwd: row.cwd,
          source: row.mode === "shared_workspace" ? "project_primary" : "task_session",
          projectId: row.projectId,
          workspaceId: row.projectWorkspaceId ?? null,
          repoUrl: row.repoUrl ?? null,
          repoRef: row.baseRef ?? null,
          strategy: row.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
          cwd: row.cwd,
          branchName: row.branchName ?? null,
          worktreePath: row.strategyType === "git_worktree" ? row.cwd : null,
          warnings: [],
          created: false,
        },
        executionWorkspaceId: row.id,
        config: {
          workspaceRuntime: effectiveRuntimeConfig,
          runtimeProvisionCommand: config.runtimeProvisionCommand,
          desiredState: config.desiredState,
          serviceStates: config.serviceStates ?? null,
        },
        adapterEnv: {},
        respectDesiredStates: true,
      });
      if (refs.length > 0) restarted += refs.filter((ref) => !ref.reused).length;
    } catch {
      failed += 1;
    }
  }

  return { restarted, failed };
}

export async function persistAdapterManagedRuntimeServices(input: {
  db: Db;
  adapterType: string;
  runId: string;
  agent: ExecutionWorkspaceAgentRef;
  issue: ExecutionWorkspaceIssueRef | null;
  workspace: RealizedExecutionWorkspace;
  executionWorkspaceId?: string | null;
  reports: AdapterRuntimeServiceReport[];
}) {
  const refs = normalizeAdapterManagedRuntimeServices(input);
  if (refs.length === 0) return refs;

  const existingRows = await input.db
    .select()
    .from(workspaceRuntimeServices)
    .where(inArray(workspaceRuntimeServices.id, refs.map((ref) => ref.id)));
  const existingById = new Map(existingRows.map((row) => [row.id, row]));

  for (const ref of refs) {
    const existing = existingById.get(ref.id);
    const startedAt = existing?.startedAt ?? new Date(ref.startedAt);
    const createdAt = existing?.createdAt ?? new Date();
    await input.db
      .insert(workspaceRuntimeServices)
      .values({
        id: ref.id,
        companyId: ref.companyId,
        projectId: ref.projectId,
        projectWorkspaceId: ref.projectWorkspaceId,
        executionWorkspaceId: ref.executionWorkspaceId,
        issueId: ref.issueId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        serviceName: ref.serviceName,
        status: ref.status,
        lifecycle: ref.lifecycle,
        reuseKey: ref.reuseKey,
        command: ref.command,
        cwd: ref.cwd,
        port: ref.port,
        url: ref.url,
        provider: ref.provider,
        providerRef: ref.providerRef,
        ownerAgentId: ref.ownerAgentId,
        startedByRunId: ref.startedByRunId,
        lastUsedAt: new Date(ref.lastUsedAt),
        startedAt,
        stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
        stopPolicy: ref.stopPolicy,
        exposure: null,
        exposureHandle: null,
        backendUrl: null,
        healthStatus: ref.healthStatus,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: workspaceRuntimeServices.id,
        set: {
          projectId: ref.projectId,
          projectWorkspaceId: ref.projectWorkspaceId,
          executionWorkspaceId: ref.executionWorkspaceId,
          issueId: ref.issueId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId,
          serviceName: ref.serviceName,
          status: ref.status,
          lifecycle: ref.lifecycle,
          reuseKey: ref.reuseKey,
          command: ref.command,
          cwd: ref.cwd,
          port: ref.port,
          url: ref.url,
          provider: ref.provider,
          providerRef: ref.providerRef,
          ownerAgentId: ref.ownerAgentId,
          startedByRunId: ref.startedByRunId,
          lastUsedAt: new Date(ref.lastUsedAt),
          startedAt,
          stoppedAt: ref.stoppedAt ? new Date(ref.stoppedAt) : null,
          stopPolicy: ref.stopPolicy,
          exposure: null,
          exposureHandle: null,
          backendUrl: null,
          healthStatus: ref.healthStatus,
          updatedAt: new Date(),
        },
      });
  }

  return refs;
}

type WorkspaceReadyCommentInput = {
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
};

const COMMENT_METADATA_LABEL_MAX_LENGTH = 120;

function workspaceReadyServiceLabel(serviceName: string): string {
  const label = serviceName.trim() || "Service";
  return label.length > COMMENT_METADATA_LABEL_MAX_LENGTH
    ? `${label.slice(0, COMMENT_METADATA_LABEL_MAX_LENGTH - 1)}…`
    : label;
}

export function buildWorkspaceReadyPresentation(
  input: WorkspaceReadyCommentInput,
): IssueCommentPresentation {
  const workspaceLabel = input.workspace.branchName ?? input.workspace.strategy;
  const title = `Workspace ready · ${workspaceLabel}`;
  const hasWarnings = input.workspace.warnings.length > 0;

  return {
    kind: "system_notice",
    tone: hasWarnings ? "warning" : "info",
    title: title.length > 160 ? `${title.slice(0, 159)}…` : title,
    density: "compact",
    detailsDefaultOpen: hasWarnings,
  };
}

export function buildWorkspaceReadyMetadata(
  input: WorkspaceReadyCommentInput,
): IssueCommentMetadata {
  const workspaceRows: IssueCommentMetadata["sections"][number]["rows"] = [
    { type: "key_value", label: "Strategy", value: input.workspace.strategy },
    ...(input.workspace.branchName
      ? [{ type: "key_value" as const, label: "Branch", value: input.workspace.branchName }]
      : []),
    { type: "key_value", label: "CWD", value: input.workspace.cwd },
    ...(input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd
      ? [{ type: "key_value" as const, label: "Worktree", value: input.workspace.worktreePath }]
      : []),
  ];
  const serviceRows: IssueCommentMetadata["sections"][number]["rows"] = input.runtimeServices.map(
    (service) => ({
      type: "key_value",
      label: workspaceReadyServiceLabel(service.serviceName),
      value: `${service.url ?? "running"}${service.reused ? " (reused)" : ""}`,
    }),
  );

  return {
    version: 1,
    sections: [
      { title: "Workspace", rows: workspaceRows },
      ...(serviceRows.length > 0 ? [{ title: "Services", rows: serviceRows }] : []),
      ...(input.workspace.warnings.length > 0
        ? [{
            title: "Warnings",
            rows: input.workspace.warnings.map((warning) => ({ type: "text" as const, text: warning })),
          }]
        : []),
    ],
  };
}

export function buildWorkspaceReadyComment(input: WorkspaceReadyCommentInput) {
  const lines = ["## Workspace Ready", ""];
  lines.push(`- Strategy: \`${input.workspace.strategy}\``);
  if (input.workspace.branchName) lines.push(`- Branch: \`${input.workspace.branchName}\``);
  lines.push(`- CWD: \`${input.workspace.cwd}\``);
  if (input.workspace.worktreePath && input.workspace.worktreePath !== input.workspace.cwd) {
    lines.push(`- Worktree: \`${input.workspace.worktreePath}\``);
  }
  for (const warning of input.workspace.warnings) {
    lines.push(`- Warning: ${warning}`);
  }
  for (const service of input.runtimeServices) {
    const detail = service.url ? `${service.serviceName}: ${service.url}` : `${service.serviceName}: running`;
    const suffix = service.reused ? " (reused)" : "";
    lines.push(`- Service: ${detail}${suffix}`);
  }
  return lines.join("\n");
}
