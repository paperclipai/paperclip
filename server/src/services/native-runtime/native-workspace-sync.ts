import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentLeases, heartbeatRuns } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import {
  prepareAdapterExecutionTargetRuntime,
  type AdapterExecutionTarget,
  type PreparedAdapterExecutionTargetRuntime,
} from "@paperclipai/adapter-utils/execution-target";
import type { GitWorkspaceSnapshot } from "@paperclipai/adapter-utils/git-workspace-sync";
import {
  directorySnapshotSha256,
  parseDirectorySnapshot,
  serializeDirectorySnapshot,
  type DirectorySnapshot,
  type SerializedDirectorySnapshot,
} from "@paperclipai/adapter-utils/workspace-restore-merge";
import type {
  WorkspaceDurableSeedPaths,
  WorkspaceInboundMode,
} from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { parseObject } from "../../adapters/utils.js";
import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";

const DESCRIPTOR_SCHEMA = "paperclip.native-workspace-sync/v1";
const STAMP_SCHEMA = "paperclip.native-workspace-stamp/v1";
const STATE_ROOT_NAME = "native-workspace-sync";
const DESCRIPTOR_NAME = "descriptor";
const WORKSPACE_SEED_NAME = "workspace-seed.tar";
const GIT_SEED_NAME = "git-seed.tar";
const REMOTE_STAMP_NAME = "workspace-sync-v1.json";
const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

type NativeWorkspaceSyncState = "prepared" | "finalized";
export type NativeWorkspaceResourceDisposition =
  "keep_running" | "stop_and_retain" | "destroy";

interface NativeWorkspaceSyncDescriptor {
  schema: typeof DESCRIPTOR_SCHEMA;
  binding: {
    runId: string;
    companyId: string;
    workspaceId: string;
    leaseId: string;
    providerLeaseId: string;
    localCwd: string;
    remoteCwd: string;
  };
  state: NativeWorkspaceSyncState;
  baselineSha256: string;
  baseline: SerializedDirectorySnapshot;
  gitSnapshot: GitWorkspaceSnapshot | null;
  seed: {
    workspaceArchiveSha256: string;
    gitArchiveSha256: string | null;
  } | null;
  createdAt: string;
  finalizedAt: string | null;
  finalHostSha256: string | null;
  resourceDisposition: NativeWorkspaceResourceDisposition | null;
}

export interface NativeWorkspaceSyncReference {
  schema: typeof DESCRIPTOR_SCHEMA;
  state: NativeWorkspaceSyncState;
  descriptorSha256: string;
  baselineSha256: string;
  finalHostSha256: string | null;
  workspaceId: string;
  leaseId: string;
  providerLeaseId: string;
  remoteCwd: string;
  resourceDisposition: NativeWorkspaceResourceDisposition | null;
}

export interface PreparedNativeWorkspaceSync {
  mode: WorkspaceInboundMode;
  reference: NativeWorkspaceSyncReference;
  restoreWorkspace(): Promise<void>;
  cleanup(): Promise<void>;
}

export type NativeWorkspaceInboundEvidence =
  | {
      kind: "existing_run";
      restartRecovery: boolean;
      sameRunRecovery?: boolean;
      sameProviderLease: boolean;
    }
  | {
      kind: "new_run";
      acquisition: "created" | "resumed" | "replacement" | null;
      hasPriorStamp: boolean;
    };

export function classifyNativeWorkspaceInbound(
  evidence: NativeWorkspaceInboundEvidence,
): WorkspaceInboundMode {
  if (evidence.kind === "existing_run") {
    if (!evidence.restartRecovery && !evidence.sameRunRecovery) {
      throw new Error("native_workspace_sync_unexpected_existing_descriptor");
    }
    return evidence.sameProviderLease ? "adopt_remote" : "durable_seed";
  }
  return evidence.acquisition === "resumed" && evidence.hasPriorStamp
    ? "adopt_remote"
    : "host_current";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requireSafeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`native_workspace_sync_invalid_${label}`);
  }
  return value;
}

function descriptorDirectory(runId: string): string {
  return path.join(
    resolvePaperclipInstanceRoot(),
    STATE_ROOT_NAME,
    requireSafeSegment(runId, "run_id"),
  );
}

function descriptorPath(runId: string, descriptorSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(descriptorSha256)) {
    throw new Error("native_workspace_sync_descriptor_digest_invalid");
  }
  return path.join(
    descriptorDirectory(runId),
    `${DESCRIPTOR_NAME}.${descriptorSha256}.json`,
  );
}

function legacyDescriptorPath(runId: string): string {
  return path.join(descriptorDirectory(runId), `${DESCRIPTOR_NAME}.json`);
}

function durableSeedPaths(runId: string): {
  workspaceArchivePath: string;
  gitArchivePath: string;
} {
  const directory = descriptorDirectory(runId);
  return {
    workspaceArchivePath: path.join(directory, WORKSPACE_SEED_NAME),
    gitArchivePath: path.join(directory, GIT_SEED_NAME),
  };
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolveDigest, rejectDigest) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", rejectDigest);
    stream.on("end", () => resolveDigest(digest.digest("hex")));
  });
}

async function verifiedDurableSeed(input: {
  runId: string;
  seed: NonNullable<NativeWorkspaceSyncDescriptor["seed"]>;
  gitSnapshot: GitWorkspaceSnapshot | null;
}): Promise<WorkspaceDurableSeedPaths> {
  try {
    const paths = durableSeedPaths(input.runId);
    const workspaceStat = await fs.lstat(paths.workspaceArchivePath);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isFile()) {
      throw new Error("workspace_sync_out_unrecoverable");
    }
    if (
      (await sha256File(paths.workspaceArchivePath)) !==
      input.seed.workspaceArchiveSha256
    ) {
      throw new Error("workspace_sync_out_unrecoverable");
    }
    if (input.gitSnapshot) {
      const gitStat = await fs.lstat(paths.gitArchivePath);
      if (
        gitStat.isSymbolicLink() ||
        !gitStat.isFile() ||
        !input.seed.gitArchiveSha256 ||
        (await sha256File(paths.gitArchivePath)) !== input.seed.gitArchiveSha256
      ) {
        throw new Error("workspace_sync_out_unrecoverable");
      }
    } else if (input.seed.gitArchiveSha256 !== null) {
      throw new Error("workspace_sync_out_unrecoverable");
    }
    return {
      workspaceArchivePath: paths.workspaceArchivePath,
      workspaceArchiveSha256: input.seed.workspaceArchiveSha256,
      gitArchivePath: input.gitSnapshot ? paths.gitArchivePath : null,
      gitArchiveSha256: input.seed.gitArchiveSha256,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "workspace_sync_out_unrecoverable"
    ) {
      throw error;
    }
    throw new Error("workspace_sync_out_unrecoverable", { cause: error });
  }
}

async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("native_workspace_sync_state_root_invalid");
  }
}

async function writeDescriptor(
  descriptor: NativeWorkspaceSyncDescriptor,
): Promise<NativeWorkspaceSyncReference> {
  const dir = descriptorDirectory(descriptor.binding.runId);
  await ensurePrivateDirectory(dir);
  const body = `${canonicalJson(descriptor)}\n`;
  const descriptorSha256 = createHash("sha256").update(body).digest("hex");
  const finalPath = descriptorPath(descriptor.binding.runId, descriptorSha256);
  const existingBody = await fs.readFile(finalPath, "utf8").catch(() => null);
  if (existingBody !== null && existingBody !== body) {
    throw new Error("native_workspace_sync_descriptor_digest_collision");
  }
  const tempPath = path.join(dir, `${DESCRIPTOR_NAME}.${randomUUID()}.tmp`);
  try {
    if (existingBody === null) {
      await fs.writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempPath, finalPath);
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  return {
    schema: DESCRIPTOR_SCHEMA,
    state: descriptor.state,
    descriptorSha256,
    baselineSha256: descriptor.baselineSha256,
    finalHostSha256: descriptor.finalHostSha256,
    workspaceId: descriptor.binding.workspaceId,
    leaseId: descriptor.binding.leaseId,
    providerLeaseId: descriptor.binding.providerLeaseId,
    remoteCwd: descriptor.binding.remoteCwd,
    resourceDisposition: descriptor.resourceDisposition,
  };
}

export function readNativeWorkspaceSyncReference(
  value: unknown,
): NativeWorkspaceSyncReference | null {
  const candidate = parseObject(value);
  if (
    candidate.schema !== DESCRIPTOR_SCHEMA ||
    (candidate.state !== "prepared" && candidate.state !== "finalized") ||
    typeof candidate.descriptorSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.descriptorSha256) ||
    typeof candidate.baselineSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.baselineSha256) ||
    (candidate.finalHostSha256 !== null &&
      candidate.finalHostSha256 !== undefined &&
      (typeof candidate.finalHostSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate.finalHostSha256))) ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.leaseId !== "string" ||
    typeof candidate.providerLeaseId !== "string" ||
    typeof candidate.remoteCwd !== "string" ||
    (candidate.resourceDisposition !== null &&
      candidate.resourceDisposition !== undefined &&
      candidate.resourceDisposition !== "keep_running" &&
      candidate.resourceDisposition !== "stop_and_retain" &&
      candidate.resourceDisposition !== "destroy")
  ) {
    return null;
  }
  return {
    schema: DESCRIPTOR_SCHEMA,
    state: candidate.state,
    descriptorSha256: candidate.descriptorSha256,
    baselineSha256: candidate.baselineSha256,
    finalHostSha256:
      typeof candidate.finalHostSha256 === "string"
        ? candidate.finalHostSha256
        : null,
    workspaceId: candidate.workspaceId,
    leaseId: candidate.leaseId,
    providerLeaseId: candidate.providerLeaseId,
    remoteCwd: candidate.remoteCwd,
    resourceDisposition:
      candidate.resourceDisposition === "keep_running" ||
      candidate.resourceDisposition === "stop_and_retain" ||
      candidate.resourceDisposition === "destroy"
        ? candidate.resourceDisposition
        : null,
  };
}

function parseGitSnapshot(
  value: unknown,
): GitWorkspaceSnapshot | null | undefined {
  if (value === null) return null;
  const candidate = parseObject(value);
  const paths = [
    candidate.overlayPaths,
    candidate.deletedPaths,
    candidate.ignoredPaths,
  ];
  if (
    typeof candidate.headCommit !== "string" ||
    (candidate.branchName !== null &&
      typeof candidate.branchName !== "string") ||
    !paths.every(
      (entries) =>
        Array.isArray(entries) &&
        entries.every(
          (entry) =>
            typeof entry === "string" &&
            !path.posix.isAbsolute(entry) &&
            !path.win32.isAbsolute(entry) &&
            !entry.split(/[\\/]/).some((segment) => segment === ".."),
        ),
    )
  ) {
    return undefined;
  }
  return {
    headCommit: candidate.headCommit,
    branchName: candidate.branchName as string | null,
    overlayPaths: [...(candidate.overlayPaths as string[])],
    deletedPaths: [...(candidate.deletedPaths as string[])],
    ignoredPaths: [...(candidate.ignoredPaths as string[])],
  };
}

async function readDescriptor(input: {
  runId: string;
  reference: NativeWorkspaceSyncReference;
}): Promise<{
  descriptor: NativeWorkspaceSyncDescriptor;
  baseline: DirectorySnapshot;
}> {
  const contentAddressedPath = descriptorPath(
    input.runId,
    input.reference.descriptorSha256,
  );
  // Early v1 writers used descriptor.json. Prefer the immutable,
  // content-addressed name, but keep the digest-verified legacy path readable
  // so an interrupted upgrade can still finish its already-proposed result.
  const filePath = await fs
    .lstat(contentAddressedPath)
    .then(() => contentAddressedPath)
    .catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      const legacyPath = legacyDescriptorPath(input.runId);
      await fs.lstat(legacyPath);
      return legacyPath;
    });
  const stat = await fs.lstat(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAX_DESCRIPTOR_BYTES
  ) {
    throw new Error("native_workspace_sync_descriptor_invalid");
  }
  const body = await fs.readFile(filePath, "utf8");
  if (
    createHash("sha256").update(body).digest("hex") !==
    input.reference.descriptorSha256
  ) {
    throw new Error("native_workspace_sync_descriptor_digest_mismatch");
  }
  const parsed = JSON.parse(body) as unknown;
  const candidate = parseObject(parsed);
  const binding = parseObject(candidate.binding);
  const baseline = parseDirectorySnapshot(candidate.baseline);
  const gitSnapshot = parseGitSnapshot(candidate.gitSnapshot);
  const rawSeed =
    candidate.seed === null || candidate.seed === undefined
      ? null
      : parseObject(candidate.seed);
  const seed =
    rawSeed === null
      ? null
      : typeof rawSeed.workspaceArchiveSha256 === "string" &&
          /^[0-9a-f]{64}$/.test(rawSeed.workspaceArchiveSha256) &&
          (rawSeed.gitArchiveSha256 === null ||
            (typeof rawSeed.gitArchiveSha256 === "string" &&
              /^[0-9a-f]{64}$/.test(rawSeed.gitArchiveSha256)))
        ? {
            workspaceArchiveSha256: rawSeed.workspaceArchiveSha256,
            gitArchiveSha256: rawSeed.gitArchiveSha256 as string | null,
          }
        : undefined;
  const finalHostSha256 =
    typeof candidate.finalHostSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.finalHostSha256)
      ? candidate.finalHostSha256
      : candidate.finalHostSha256 === null
        ? null
        : undefined;
  const resourceDisposition =
    candidate.resourceDisposition === "keep_running" ||
    candidate.resourceDisposition === "stop_and_retain" ||
    candidate.resourceDisposition === "destroy"
      ? candidate.resourceDisposition
      : candidate.resourceDisposition === null
        ? null
        : undefined;
  if (
    candidate.schema !== DESCRIPTOR_SCHEMA ||
    (candidate.state !== "prepared" && candidate.state !== "finalized") ||
    !baseline ||
    gitSnapshot === undefined ||
    seed === undefined ||
    binding.runId !== input.runId ||
    binding.workspaceId !== input.reference.workspaceId ||
    binding.leaseId !== input.reference.leaseId ||
    binding.providerLeaseId !== input.reference.providerLeaseId ||
    binding.remoteCwd !== input.reference.remoteCwd ||
    typeof binding.companyId !== "string" ||
    typeof binding.localCwd !== "string" ||
    !path.isAbsolute(binding.localCwd) ||
    typeof binding.remoteCwd !== "string" ||
    !path.posix.isAbsolute(binding.remoteCwd) ||
    typeof candidate.baselineSha256 !== "string" ||
    candidate.baselineSha256 !== input.reference.baselineSha256 ||
    directorySnapshotSha256(baseline) !== candidate.baselineSha256 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    candidate.state !== input.reference.state ||
    finalHostSha256 === undefined ||
    finalHostSha256 !== input.reference.finalHostSha256 ||
    resourceDisposition === undefined ||
    resourceDisposition !== input.reference.resourceDisposition ||
    (candidate.state === "prepared" &&
      (candidate.finalizedAt !== null || finalHostSha256 !== null)) ||
    (candidate.state === "finalized" &&
      (typeof candidate.finalizedAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.finalizedAt)) ||
        finalHostSha256 === null))
  ) {
    throw new Error("native_workspace_sync_descriptor_binding_mismatch");
  }
  return {
    descriptor: {
      schema: DESCRIPTOR_SCHEMA,
      binding: {
        runId: binding.runId as string,
        companyId: binding.companyId,
        workspaceId: binding.workspaceId as string,
        leaseId: binding.leaseId as string,
        providerLeaseId: binding.providerLeaseId as string,
        localCwd: binding.localCwd,
        remoteCwd: binding.remoteCwd as string,
      },
      state: candidate.state,
      baselineSha256: candidate.baselineSha256,
      baseline: candidate.baseline as SerializedDirectorySnapshot,
      gitSnapshot,
      seed,
      createdAt: candidate.createdAt,
      finalizedAt:
        typeof candidate.finalizedAt === "string"
          ? candidate.finalizedAt
          : null,
      finalHostSha256,
      resourceDisposition,
    },
    baseline,
  };
}

async function persistRunReference(
  db: Db,
  runId: string,
  reference: NativeWorkspaceSyncReference,
): Promise<void> {
  await db.transaction(async (tx) => {
    const run = await tx
      .select({ runnerProfileJson: heartbeatRuns.runnerProfileJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run) throw new Error("native_workspace_sync_run_missing");
    await tx
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: {
          ...parseObject(run.runnerProfileJson),
          nativeWorkspaceSync: reference,
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));
  });
}

async function persistLeaseStamp(input: {
  db: Db;
  leaseId: string;
  stamp: Record<string, unknown>;
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    const lease = await tx
      .select({ metadata: environmentLeases.metadata })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, input.leaseId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!lease) throw new Error("native_workspace_sync_lease_missing");
    await tx
      .update(environmentLeases)
      .set({
        metadata: {
          ...parseObject(lease.metadata),
          nativeWorkspaceSync: input.stamp,
        },
        updatedAt: new Date(),
      })
      .where(eq(environmentLeases.id, input.leaseId));
  });
}

function providerLeaseIdFor(input: {
  target: Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
  lease: EnvironmentLease;
}): string {
  const providerLeaseId =
    input.target.sandboxLeaseAcquisition?.providerLeaseId ??
    input.lease.providerLeaseId;
  if (!providerLeaseId) {
    throw new Error("native_workspace_sync_provider_lease_missing");
  }
  return providerLeaseId;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeRemoteStamp(input: {
  target: Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
  stamp: Record<string, unknown>;
}): Promise<void> {
  if (!input.target.runner) {
    throw new Error("native_workspace_sync_runner_missing");
  }
  const runtimeDir = path.posix.join(
    input.target.remoteCwd,
    ".paperclip-runtime",
    "paperclip-runner",
  );
  const stampPath = path.posix.join(runtimeDir, REMOTE_STAMP_NAME);
  const tempPath = `${stampPath}.tmp`;
  const encoded = Buffer.from(
    `${canonicalJson(input.stamp)}\n`,
    "utf8",
  ).toString("base64");
  const result = await input.target.runner.execute({
    command: input.target.shellCommand ?? "sh",
    args: [
      "-c",
      `umask 077; mkdir -p ${shellQuote(runtimeDir)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(tempPath)} && mv ${shellQuote(tempPath)} ${shellQuote(stampPath)}`,
    ],
    cwd: "/",
    timeoutMs: 15_000,
    bypassSession: true,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error("native_workspace_sync_remote_stamp_failed");
  }
}

async function remoteStampMatches(input: {
  target: Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
  expected: Record<string, unknown>;
}): Promise<boolean> {
  if (!input.target.runner) return false;
  const stampPath = path.posix.join(
    input.target.remoteCwd,
    ".paperclip-runtime",
    "paperclip-runner",
    REMOTE_STAMP_NAME,
  );
  const result = await input.target.runner.execute({
    command: input.target.shellCommand ?? "sh",
    args: [
      "-c",
      `test -f ${shellQuote(stampPath)} && cat ${shellQuote(stampPath)}`,
    ],
    cwd: "/",
    timeoutMs: 15_000,
    bypassSession: true,
  });
  if (result.timedOut || result.exitCode !== 0) return false;
  try {
    return (
      canonicalJson(JSON.parse(result.stdout)) === canonicalJson(input.expected)
    );
  } catch {
    return false;
  }
}

function leaseStamp(input: {
  lease: EnvironmentLease;
  workspaceId: string;
  providerLeaseId: string;
  remoteCwd: string;
}): Record<string, unknown> | null {
  const stamp = parseObject(
    parseObject(input.lease.metadata).nativeWorkspaceSync,
  );
  if (
    stamp.schema !== STAMP_SCHEMA ||
    stamp.workspaceId !== input.workspaceId ||
    stamp.providerLeaseId !== input.providerLeaseId ||
    stamp.remoteCwd !== input.remoteCwd ||
    typeof stamp.hostSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(stamp.hostSha256)
  ) {
    return null;
  }
  return stamp;
}

function finalizedWorkspaceStamp(input: {
  descriptor: NativeWorkspaceSyncDescriptor;
  hostSha256: string;
}): Record<string, unknown> {
  return {
    schema: STAMP_SCHEMA,
    workspaceId: input.descriptor.binding.workspaceId,
    providerLeaseId: input.descriptor.binding.providerLeaseId,
    remoteCwd: input.descriptor.binding.remoteCwd,
    hostSha256: input.hostSha256,
    finalizedRunId: input.descriptor.binding.runId,
  };
}

async function prepareRuntime(input: {
  runId: string;
  target: Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
  workspaceLocalDir: string;
  mode: WorkspaceInboundMode;
  baseline?: DirectorySnapshot;
  gitSnapshot?: GitWorkspaceSnapshot | null;
  durableSeed?: WorkspaceDurableSeedPaths;
}): Promise<PreparedAdapterExecutionTargetRuntime> {
  return prepareAdapterExecutionTargetRuntime({
    runId: input.runId,
    target: input.target,
    adapterKey: "paperclip-runner",
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir: input.target.remoteCwd,
    workspaceInboundMode: input.mode,
    workspaceDurableSeed: input.durableSeed,
    workspaceBaseline: input.baseline,
    workspaceGitSnapshot: input.gitSnapshot,
  });
}

async function finalizePreparedRuntime(input: {
  db: Db;
  runId: string;
  target: Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
  runtime: PreparedAdapterExecutionTargetRuntime;
  descriptor: NativeWorkspaceSyncDescriptor;
}): Promise<NativeWorkspaceSyncReference> {
  await input.runtime.restoreWorkspace();
  const finalSnapshot =
    await import("@paperclipai/adapter-utils/workspace-restore-merge").then(
      ({ captureDirectorySnapshot }) =>
        captureDirectorySnapshot(input.descriptor.binding.localCwd, {
          exclude: input.runtime.workspaceSyncSnapshot?.baseline.exclude ?? [],
        }),
    );
  const finalHostSha256 = directorySnapshotSha256(finalSnapshot);
  const stamp = finalizedWorkspaceStamp({
    descriptor: input.descriptor,
    hostSha256: finalHostSha256,
  });
  await writeRemoteStamp({ target: input.target, stamp });
  const finalizedDescriptor: NativeWorkspaceSyncDescriptor = {
    ...input.descriptor,
    state: "finalized",
    finalizedAt: new Date().toISOString(),
    finalHostSha256,
  };
  const reference = await writeDescriptor(finalizedDescriptor);
  await persistRunReference(input.db, input.runId, reference);
  await persistLeaseStamp({
    db: input.db,
    leaseId: input.descriptor.binding.leaseId,
    stamp,
  });
  return reference;
}

export async function prepareNativeWorkspaceSync(input: {
  db: Db;
  runId: string;
  companyId: string;
  workspaceId: string;
  workspaceLocalDir: string;
  target: AdapterExecutionTarget | null;
  lease: EnvironmentLease;
  restartRecovery?: NativeRestartRecoveryClaim;
  sameRunRecovery?: boolean;
  resourceDisposition?: NativeWorkspaceResourceDisposition;
}): Promise<PreparedNativeWorkspaceSync | null> {
  if (input.target?.kind !== "remote" || input.target.transport !== "sandbox") {
    return null;
  }
  const target = input.target;
  const providerLeaseId = providerLeaseIdFor({ target, lease: input.lease });
  const run = await input.db
    .select({ runnerProfileJson: heartbeatRuns.runnerProfileJson })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) throw new Error("native_workspace_sync_run_missing");
  const existingReference = readNativeWorkspaceSyncReference(
    parseObject(run.runnerProfileJson).nativeWorkspaceSync,
  );

  let runtime: PreparedAdapterExecutionTargetRuntime;
  let descriptor: NativeWorkspaceSyncDescriptor;
  let mode: WorkspaceInboundMode = "host_current";
  const seedPaths = durableSeedPaths(input.runId);
  await ensurePrivateDirectory(descriptorDirectory(input.runId));

  if (existingReference) {
    const existing = await readDescriptor({
      runId: input.runId,
      reference: existingReference,
    });
    if (
      existing.descriptor.binding.companyId !== input.companyId ||
      existing.descriptor.binding.workspaceId !== input.workspaceId ||
      path.resolve(existing.descriptor.binding.localCwd) !==
        path.resolve(input.workspaceLocalDir) ||
      existing.descriptor.binding.remoteCwd !== target.remoteCwd
    ) {
      throw new Error("native_workspace_sync_descriptor_binding_mismatch");
    }
    const sameProviderLease =
      existing.descriptor.binding.providerLeaseId === providerLeaseId;
    mode = classifyNativeWorkspaceInbound({
      kind: "existing_run",
      restartRecovery: Boolean(input.restartRecovery),
      sameRunRecovery: input.sameRunRecovery,
      sameProviderLease,
    });
    const durableSeed =
      mode === "durable_seed"
        ? existing.descriptor.seed
          ? await verifiedDurableSeed({
              runId: input.runId,
              seed: existing.descriptor.seed,
              gitSnapshot: existing.descriptor.gitSnapshot,
            })
          : (() => {
              throw new Error("workspace_sync_out_unrecoverable");
            })()
        : undefined;
    runtime = await prepareRuntime({
      runId: input.runId,
      target,
      workspaceLocalDir: input.workspaceLocalDir,
      mode,
      baseline: existing.baseline,
      gitSnapshot: existing.descriptor.gitSnapshot,
      durableSeed,
    });
    descriptor = {
      ...existing.descriptor,
      binding: {
        ...existing.descriptor.binding,
        leaseId: target.leaseId ?? input.lease.id,
        providerLeaseId,
      },
    };
  } else {
    const acquisition = target.sandboxLeaseAcquisition?.outcome ?? null;
    const priorStamp = leaseStamp({
      lease: input.lease,
      workspaceId: input.workspaceId,
      providerLeaseId,
      remoteCwd: target.remoteCwd,
    });
    mode = classifyNativeWorkspaceInbound({
      kind: "new_run",
      acquisition,
      hasPriorStamp: priorStamp !== null,
    });
    runtime = await prepareRuntime({
      runId: input.runId,
      target,
      workspaceLocalDir: input.workspaceLocalDir,
      mode,
      durableSeed: {
        workspaceArchivePath: seedPaths.workspaceArchivePath,
        gitArchivePath: seedPaths.gitArchivePath,
      },
    });
    const currentSnapshot = runtime.workspaceSyncSnapshot;
    if (!currentSnapshot) {
      throw new Error("native_workspace_sync_snapshot_missing");
    }
    if (acquisition === "resumed" && priorStamp) {
      const currentHostSha256 = directorySnapshotSha256(
        currentSnapshot.baseline,
      );
      const verifiedWarmAdoption =
        priorStamp.hostSha256 === currentHostSha256 &&
        (await remoteStampMatches({ target, expected: priorStamp }));
      if (verifiedWarmAdoption) {
        mode = "adopt_remote";
      } else {
        mode = "host_current";
        runtime = await prepareRuntime({
          runId: input.runId,
          target,
          workspaceLocalDir: input.workspaceLocalDir,
          mode,
          baseline: currentSnapshot.baseline,
          gitSnapshot: currentSnapshot.gitSnapshot,
          durableSeed: {
            workspaceArchivePath: seedPaths.workspaceArchivePath,
            gitArchivePath: seedPaths.gitArchivePath,
          },
        });
      }
    }
    const snapshot = runtime.workspaceSyncSnapshot;
    if (!snapshot) throw new Error("native_workspace_sync_snapshot_missing");
    const now = new Date().toISOString();
    const workspaceArchiveSha256 = await sha256File(
      seedPaths.workspaceArchivePath,
    );
    const gitArchiveSha256 = snapshot.gitSnapshot
      ? await sha256File(seedPaths.gitArchivePath)
      : null;
    descriptor = {
      schema: DESCRIPTOR_SCHEMA,
      binding: {
        runId: input.runId,
        companyId: input.companyId,
        workspaceId: input.workspaceId,
        leaseId: target.leaseId ?? input.lease.id,
        providerLeaseId,
        localCwd: path.resolve(input.workspaceLocalDir),
        remoteCwd: target.remoteCwd,
      },
      state: "prepared",
      baselineSha256: directorySnapshotSha256(snapshot.baseline),
      baseline: serializeDirectorySnapshot(snapshot.baseline),
      gitSnapshot: snapshot.gitSnapshot,
      seed: { workspaceArchiveSha256, gitArchiveSha256 },
      createdAt: now,
      finalizedAt: null,
      finalHostSha256: null,
      resourceDisposition: input.resourceDisposition ?? null,
    };
  }

  let reference = await writeDescriptor(descriptor);
  await persistRunReference(input.db, input.runId, reference);
  let restorePromise: Promise<void> | null = null;
  return {
    mode,
    get reference() {
      return reference;
    },
    restoreWorkspace: async () => {
      if (!restorePromise) {
        restorePromise = finalizePreparedRuntime({
          db: input.db,
          runId: input.runId,
          target,
          runtime,
          descriptor,
        })
          .then((finalizedReference) => {
            reference = finalizedReference;
          })
          .catch((error) => {
            restorePromise = null;
            throw error;
          });
      }
      await restorePromise;
    },
    cleanup: () => cleanupNativeWorkspaceSync(input.runId),
  };
}

export async function resumeNativeWorkspaceSync(input: {
  db: Db;
  runId: string;
  target: AdapterExecutionTarget;
}): Promise<boolean> {
  if (input.target.kind !== "remote" || input.target.transport !== "sandbox") {
    throw new Error("workspace_sync_out_unrecoverable");
  }
  const run = await input.db
    .select({ runnerProfileJson: heartbeatRuns.runnerProfileJson })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const reference = readNativeWorkspaceSyncReference(
    parseObject(run?.runnerProfileJson).nativeWorkspaceSync,
  );
  if (!reference) return false;
  const existing = await readDescriptor({ runId: input.runId, reference });
  const providerLeaseId =
    input.target.sandboxLeaseAcquisition?.providerLeaseId ??
    reference.providerLeaseId;
  if (
    providerLeaseId !== reference.providerLeaseId ||
    input.target.remoteCwd !== reference.remoteCwd
  ) {
    throw new Error("workspace_sync_out_unrecoverable");
  }
  if (
    existing.descriptor.state === "finalized" &&
    existing.descriptor.finalHostSha256
  ) {
    const stamp = finalizedWorkspaceStamp({
      descriptor: existing.descriptor,
      hostSha256: existing.descriptor.finalHostSha256,
    });
    if (
      !(await remoteStampMatches({ target: input.target, expected: stamp }))
    ) {
      await writeRemoteStamp({ target: input.target, stamp });
    }
    await persistLeaseStamp({
      db: input.db,
      leaseId: existing.descriptor.binding.leaseId,
      stamp,
    });
    return true;
  }
  const runtime = await prepareRuntime({
    runId: input.runId,
    target: input.target,
    workspaceLocalDir: existing.descriptor.binding.localCwd,
    mode: "adopt_remote",
    baseline: existing.baseline,
    gitSnapshot: existing.descriptor.gitSnapshot,
  });
  await finalizePreparedRuntime({
    db: input.db,
    runId: input.runId,
    target: input.target,
    runtime,
    descriptor: existing.descriptor,
  });
  return true;
}

export async function cleanupNativeWorkspaceSync(runId: string): Promise<void> {
  await fs.rm(descriptorDirectory(runId), { recursive: true, force: true });
}

export const nativeWorkspaceSyncInternals = {
  descriptorPath,
  legacyDescriptorPath,
  durableSeedPaths,
  writeDescriptor,
  readDescriptor,
  readReference: readNativeWorkspaceSyncReference,
  sha256,
};
