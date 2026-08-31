import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resourceStatus } from "./managed-resource-drift.js";
import type { ManagedResourceStockStatus } from "./managed-resource-drift.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
const STOCK_HASH_KEY = "instructionsStockHash";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);
const MANAGED_BUNDLE_LOCK_SUFFIX = ".paperclip-materialize.lock";
const MANAGED_BUNDLE_LOCK_TIMEOUT_MS = 30_000;
const MANAGED_BUNDLE_LOCK_HEARTBEAT_MS = 1_000;
const MANAGED_BUNDLE_LOCK_STALE_MS = 10_000;
const MANAGED_BUNDLE_LOCK_PROBE_CACHE_MS = 1_000;
const MANAGED_BUNDLE_LOCK_PROBE_ATTEMPTS = 3;
const MANAGED_BUNDLE_LOCK_PROBE_RETRY_MS = 25;
const MANAGED_BUNDLE_LOCK_PROBE_TIMEOUT_MS = 250;
const managedBundleProbeConfirmedAt = new Map<string, number>();

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

export type ManagedBundleMaterialization = {
  stockStatus: ManagedResourceStockStatus;
  action: "added" | "updated" | "unchanged" | "skipped" | "reset";
  stockHash: string;
  previousHash: string | null;
  recordedStockHash: string | null;
  added: string[];
  removed: string[];
  updated: string[];
  skipped: string[];
  backedUp: string[];
  backupPath: string | null;
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type ProcessStartMarkerScheme = "linux" | "ps";

function processStartMarkerScheme(marker: string): ProcessStartMarkerScheme | null {
  if (marker.startsWith("linux:")) return "linux";
  if (marker.startsWith("ps:")) return "ps";
  return null;
}

async function processStartMarker(
  pid: number,
  preferredScheme?: ProcessStartMarkerScheme,
): Promise<string | null> {
  if (!isProcessAlive(pid)) return null;
  if (process.platform === "linux" && preferredScheme !== "ps") {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      const fieldsAfterCommand = commandEnd >= 0
        ? stat.slice(commandEnd + 1).trim().split(/\s+/)
        : [];
      const startTime = fieldsAfterCommand[19];
      if (startTime) return `linux:${startTime}`;
    } catch {
      // Fall through to ps for non-standard procfs environments.
    }
    if (preferredScheme === "linux") return null;
  }

  if (preferredScheme === "linux") return null;

  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 1_000 },
      (error, stdout) => {
        const startedAt = error ? "" : stdout.trim();
        resolve(startedAt ? `ps:${startedAt}` : null);
      },
    );
  });
}

async function managedBundleLockAgeMs(targetPath: string): Promise<number> {
  const stat = await statIfExists(targetPath);
  return stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
}

function managedBundleLockProbePath(token: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\paperclip-managed-bundle-${token}`;
  }
  if (process.platform === "linux") {
    return `\0paperclip-managed-bundle-${token}`;
  }
  return path.join("/tmp", `.paperclip-managed-bundle-${token}.sock`);
}

function managedBundleLockProbeHasFilesystemPath(): boolean {
  return process.platform !== "win32" && process.platform !== "linux";
}

async function startManagedBundleLockProbe(token: string): Promise<{
  path: string;
  server: net.Server;
}> {
  const probePath = managedBundleLockProbePath(token);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(probePath, () => {
      server.off("error", onError);
      server.on("error", () => undefined);
      server.unref();
      resolve();
    });
  });
  return { path: probePath, server };
}

async function stopManagedBundleLockProbe(probe: {
  path: string;
  server: net.Server;
}): Promise<void> {
  await new Promise<void>((resolve) => probe.server.close(() => resolve()));
  managedBundleProbeConfirmedAt.delete(probe.path);
  if (managedBundleLockProbeHasFilesystemPath()) {
    await fs.rm(probe.path, { force: true }).catch(() => undefined);
  }
}

type ManagedBundleLockProbeStatus = "alive" | "absent" | "indeterminate";

function managedBundleLockProbeErrorStatus(error: Error): ManagedBundleLockProbeStatus {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "ENOENT"
    ? "absent"
    : "indeterminate";
}

async function probeManagedBundleLockOnce(
  probePath: string,
): Promise<ManagedBundleLockProbeStatus> {
  return new Promise<ManagedBundleLockProbeStatus>((resolve) => {
    const socket = net.createConnection(probePath);
    let settled = false;
    const finish = (result: ManagedBundleLockProbeStatus) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.unref();
    socket.once("connect", () => finish("alive"));
    socket.once("error", (error) => finish(managedBundleLockProbeErrorStatus(error)));
    // A timeout does not prove the listener is absent. Under load, evicting on
    // this ambiguous result could let two processes displace the live tree.
    socket.setTimeout(MANAGED_BUNDLE_LOCK_PROBE_TIMEOUT_MS, () => finish("indeterminate"));
  });
}

async function managedBundleLockProbeStatus(
  probePath: string,
): Promise<ManagedBundleLockProbeStatus> {
  const confirmedAt = managedBundleProbeConfirmedAt.get(probePath);
  if (confirmedAt !== undefined && Date.now() - confirmedAt < MANAGED_BUNDLE_LOCK_PROBE_CACHE_MS) {
    return "alive";
  }

  let sawIndeterminateResult = false;
  for (let attempt = 0; attempt < MANAGED_BUNDLE_LOCK_PROBE_ATTEMPTS; attempt += 1) {
    const status = await probeManagedBundleLockOnce(probePath);
    if (status === "alive") {
      managedBundleProbeConfirmedAt.set(probePath, Date.now());
      return status;
    }
    if (status === "indeterminate") sawIndeterminateResult = true;
    if (attempt + 1 < MANAGED_BUNDLE_LOCK_PROBE_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, MANAGED_BUNDLE_LOCK_PROBE_RETRY_MS));
    }
  }

  managedBundleProbeConfirmedAt.delete(probePath);
  // Reap only after every attempt definitively reports no listener. Any
  // transient socket error or timeout keeps the lock, preferring a bounded
  // acquisition timeout over concurrent materialization of the same tree.
  return sawIndeterminateResult ? "indeterminate" : "absent";
}

async function restoreManagedBundleLockOwner(ownerPath: string, claimedOwnerPath: string): Promise<void> {
  await fs.rename(claimedOwnerPath, ownerPath).catch(() => undefined);
}

async function claimManagedBundleLockOwner(
  lockPath: string,
  expectedOwner: string,
  purpose: "release" | "reap",
): Promise<string | null> {
  const ownerPath = path.join(lockPath, "owner.json");
  const claimedOwnerPath = path.join(lockPath, `owner.${purpose}-${randomUUID()}.json`);
  try {
    await fs.rename(ownerPath, claimedOwnerPath);
  } catch {
    return null;
  }

  const claimedOwner = await fs.readFile(claimedOwnerPath, "utf8").catch(() => null);
  if (claimedOwner !== expectedOwner) {
    await restoreManagedBundleLockOwner(ownerPath, claimedOwnerPath);
    return null;
  }
  return claimedOwnerPath;
}

async function claimOwnerlessManagedBundleLock(lockPath: string): Promise<string | null> {
  const ownerPath = path.join(lockPath, "owner.json");
  const claimPath = path.join(lockPath, "owner.reaping");
  try {
    await fs.writeFile(claimPath, randomUUID(), { encoding: "utf8", flag: "wx" });
  } catch {
    return null;
  }
  if (await statIfExists(ownerPath)) {
    await fs.rm(claimPath, { force: true }).catch(() => undefined);
    return null;
  }
  return claimPath;
}

function processStartMarkersComparable(left: string, right: string): boolean {
  const leftSeparator = left.indexOf(":");
  const rightSeparator = right.indexOf(":");
  return leftSeparator > 0
    && rightSeparator > 0
    && left.slice(0, leftSeparator) === right.slice(0, rightSeparator);
}

function processStartMarkerTimestamp(marker: string | null): number | null {
  if (!marker?.startsWith("ps:")) return null;
  const timestamp = Date.parse(marker.slice("ps:".length));
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function processStartedAfterLockCreation(pid: number, createdAt: unknown): Promise<boolean> {
  if (typeof createdAt !== "string") return false;
  const lockCreatedAt = Date.parse(createdAt);
  if (!Number.isFinite(lockCreatedAt)) return false;
  const processStartedAt = processStartMarkerTimestamp(await processStartMarker(pid, "ps"));
  return processStartedAt !== null && processStartedAt > lockCreatedAt;
}

async function removeStaleManagedBundleLock(lockPath: string): Promise<boolean> {
  let shouldRemove = false;
  let ownerSnapshot: string | null = null;
  let staleProbePath: string | null = null;
  try {
    ownerSnapshot = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    const owner = JSON.parse(ownerSnapshot) as {
      pid?: unknown;
      token?: unknown;
      probePath?: unknown;
      processStartMarker?: unknown;
      createdAt?: unknown;
    };
    const pid = typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
      ? owner.pid
      : null;
    const token = typeof owner.token === "string" && /^[0-9a-f-]{36}$/i.test(owner.token)
      ? owner.token
      : null;
    const probePath = token !== null
      && owner.probePath === managedBundleLockProbePath(token)
      ? owner.probePath
      : null;
    if (probePath !== null) {
      shouldRemove = await managedBundleLockProbeStatus(probePath) === "absent";
      if (shouldRemove) staleProbePath = probePath;
    } else if (pid !== null && isProcessAlive(pid)) {
      const recordedStart = typeof owner.processStartMarker === "string"
        ? owner.processStartMarker
        : null;
      const recordedScheme = recordedStart ? processStartMarkerScheme(recordedStart) : null;
      const currentStart = await processStartMarker(pid, recordedScheme ?? undefined);
      if (
        recordedStart
        && currentStart
        && processStartMarkersComparable(recordedStart, currentStart)
      ) {
        shouldRemove = recordedStart !== currentStart;
      } else {
        // Probe-less legacy locks still record when they were created. A live
        // process that started later cannot be the original owner, which lets
        // us recover a reused PID without ever evicting an owner merely because
        // its heartbeat was delayed.
        shouldRemove = await processStartedAfterLockCreation(pid, owner.createdAt);
      }
    } else if (pid !== null) {
      shouldRemove = true;
    } else {
      shouldRemove = await managedBundleLockAgeMs(lockPath) > MANAGED_BUNDLE_LOCK_STALE_MS;
    }
  } catch {
    shouldRemove = await managedBundleLockAgeMs(lockPath) > MANAGED_BUNDLE_LOCK_STALE_MS;
  }
  if (!shouldRemove) return false;
  const claimPath = ownerSnapshot === null
    ? await claimOwnerlessManagedBundleLock(lockPath)
    : await claimManagedBundleLockOwner(lockPath, ownerSnapshot, "reap");
  if (!claimPath) return false;
  return fs.rm(lockPath, { recursive: true, force: true })
    .then(async () => {
      if (staleProbePath !== null) {
        managedBundleProbeConfirmedAt.delete(staleProbePath);
        if (managedBundleLockProbeHasFilesystemPath()) {
          await fs.rm(staleProbePath, { force: true }).catch(() => undefined);
        }
      }
      return true;
    })
    .catch(async () => {
      if (ownerSnapshot !== null) {
        await restoreManagedBundleLockOwner(path.join(lockPath, "owner.json"), claimPath);
      } else {
        await fs.rm(claimPath, { force: true }).catch(() => undefined);
      }
      return false;
    });
}

async function withManagedBundleMaterializationLock<T>(
  rootPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${rootPath}${MANAGED_BUNDLE_LOCK_SUFFIX}`;
  const ownerPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  const heartbeatPath = path.join(lockPath, `heartbeat-${token}`);
  const pendingLockPath = `${lockPath}.pending-${token}`;
  const ownerProcessStartMarker = await processStartMarker(process.pid);
  const deadline = Date.now() + MANAGED_BUNDLE_LOCK_TIMEOUT_MS;
  const probe = await startManagedBundleLockProbe(token);
  await fs.mkdir(path.dirname(rootPath), { recursive: true });
  try {
    await fs.mkdir(pendingLockPath);
    await fs.writeFile(
      path.join(pendingLockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token,
        probePath: probe.path,
        processStartMarker: ownerProcessStartMarker,
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(pendingLockPath, `heartbeat-${token}`), "", "utf8");
    while (true) {
      try {
        await fs.rename(pendingLockPath, lockPath);
        break;
      } catch (error) {
        if (!(await statIfExists(lockPath))) throw error;
        if (await removeStaleManagedBundleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for managed instructions lock at ${lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch (error) {
    await fs.rm(pendingLockPath, { recursive: true, force: true }).catch(() => undefined);
    await stopManagedBundleLockProbe(probe);
    throw error;
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(heartbeatPath, now, now).catch(() => undefined);
  }, MANAGED_BUNDLE_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    const ownerSnapshot = await fs.readFile(ownerPath, "utf8").catch(() => null);
    const owner = ownerSnapshot === null
      ? null
      : (() => {
          try {
            return JSON.parse(ownerSnapshot) as { token?: unknown };
          } catch {
            return null;
          }
        })();
    if (owner?.token === token && ownerSnapshot !== null) {
      const claimPath = await claimManagedBundleLockOwner(lockPath, ownerSnapshot, "release");
      if (claimPath) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(async () => {
          await restoreManagedBundleLockOwner(ownerPath, claimPath);
        });
      }
    }
    await stopManagedBundleLockProbe(probe);
  }
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort(compareInstructionPaths);
}

function canonicalizeInstructionsContent(content: string) {
  return content.replace(/\r\n?/g, "\n");
}

function compareInstructionPaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function managedInstructionsTreeHash(files: Record<string, string>) {
  const canonicalEntries = Object.entries(files)
    .map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      canonicalizeInstructionsContent(content),
    ] as const)
    .sort(([left], [right]) => compareInstructionPaths(left, right));
  const canonicalJson = `{${canonicalEntries
    .map(([relativePath, content]) => `${JSON.stringify(relativePath)}:${JSON.stringify(content)}`)
    .join(",")}}`;
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

async function readInstructionsTree(rootPath: string): Promise<Record<string, string> | null> {
  const rootStat = await statIfExists(rootPath);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) return {};
  const relativePaths = await listFilesRecursive(rootPath);
  return Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => [
    relativePath,
    await fs.readFile(resolvePathWithinRoot(rootPath, relativePath), "utf8"),
  ] as const)));
}

function normalizeMaterializedFiles(files: Record<string, string>, entryFile: string) {
  const normalized = new Map<string, string>();
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalized.has(normalizedPath)) {
      throw unprocessable(`Duplicate instructions file path after normalization: ${normalizedPath}`);
    }
    normalized.set(normalizedPath, content);
  }
  if (!normalized.has(entryFile)) normalized.set(entryFile, "");
  return Object.fromEntries(
    [...normalized.entries()].sort(([left], [right]) => compareInstructionPaths(left, right)),
  );
}

function changedInstructionFiles(current: Record<string, string>, prospective: Record<string, string>) {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const paths = [...new Set([...Object.keys(current), ...Object.keys(prospective)])]
    .sort(compareInstructionPaths);
  for (const relativePath of paths) {
    const hasCurrent = Object.prototype.hasOwnProperty.call(current, relativePath);
    const hasProspective = Object.prototype.hasOwnProperty.call(prospective, relativePath);
    if (!hasCurrent && hasProspective) added.push(relativePath);
    else if (hasCurrent && !hasProspective) removed.push(relativePath);
    else if (
      canonicalizeInstructionsContent(current[relativePath]!)
      !== canonicalizeInstructionsContent(prospective[relativePath]!)
    ) updated.push(relativePath);
  }
  return { added, removed, updated };
}

async function nextInstructionsBackupPath(rootPath: string) {
  for (let index = 1; ; index += 1) {
    const candidate = `${rootPath}.backup-${index}`;
    if (!(await statIfExists(candidate))) return candidate;
  }
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(storedEntryRaw);
    } catch {
      warnings.push(`Ignored invalid instructions entry file "${storedEntryRaw}".`);
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      rootPath = path.dirname(resolvedLegacyPath);
      entryFile = path.basename(resolvedLegacyPath);
      mode = resolvedLegacyPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
        || resolvedLegacyPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
        ? "managed"
        : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

async function recoverManagedBundleState(agent: AgentLike, state: BundleState): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return state;

  const recoveredEntryFile = files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => compareInstructionPaths(left.path, right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  if (input.mode === "external") delete next[STOCK_HASH_KEY];
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    const existingStat = await statIfExists(absolutePath);
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    delete next[STOCK_HASH_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const rootPath = path.dirname(resolvedPath);
  const entryFile = path.basename(resolvedPath);
  const mode: BundleMode = resolvedPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
    || resolvedPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
    ? "managed"
    : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService() {
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    const files = await listFilesRecursive(state.rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readFileSummary(state.rootPath!, relativePath, state.entryFile)));
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Instructions file not found");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === state.entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
      content,
    };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived);
    if (current.rootPath && current.mode) {
      const adapterConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        adapterConfig,
        state: deriveBundleState({ ...agent, adapterConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await fs.mkdir(managedRoot, { recursive: true });

    const entryPath = resolvePathWithinRoot(managedRoot, entryFile);
    const entryStat = await statIfExists(entryPath);
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      if (legacyInstructions.trim().length > 0) {
        await fs.mkdir(path.dirname(entryPath), { recursive: true });
        await fs.writeFile(entryPath, legacyInstructions, "utf8");
      }
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      if (!path.isAbsolute(resolvedRoot)) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      nextRootPath = resolvedRoot;
    }

    await fs.mkdir(nextRootPath, { recursive: true });

    const existingFiles = await listFilesRecursive(nextRootPath);
    const exported = await exportFiles(agent);
    if (existingFiles.length === 0) {
      await writeBundleFiles(nextRootPath, exported.files);
    }
    const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
    if (!refreshedFiles.includes(nextEntryFile)) {
      const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
      await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent });
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, adapterConfig: nextConfig });
    return { bundle: nextBundle, adapterConfig: nextConfig };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const prepared = await ensureWritableBundle(agent, options);
    const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFile(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const absolutePath = resolvePathWithinRoot(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function exportFiles(agent: AgentLike): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (state.rootPath) {
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        const relativePaths = await listFilesRecursive(state.rootPath);
        const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
          const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
          const content = await fs.readFile(absolutePath, "utf8");
          return [relativePath, content] as const;
        })));
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundleInternal(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      entryFile?: string;
      recordedStockHash?: string | null;
      forceReset?: boolean;
    },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
    materialization: ManagedBundleMaterialization;
  }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;
    await fs.mkdir(path.dirname(rootPath), { recursive: true });

    const prospectiveFiles = normalizeMaterializedFiles(files, entryFile);
    const stockHash = managedInstructionsTreeHash(prospectiveFiles);
    const configuredStockHash = asString(asRecord(agent.adapterConfig)[STOCK_HASH_KEY]);
    const recordedStockHash = options?.recordedStockHash ?? configuredStockHash;
    const initialFiles = await readInstructionsTree(rootPath);
    const initialHash = initialFiles === null ? null : managedInstructionsTreeHash(initialFiles);
    const initialStatus = resourceStatus({
      resourceId: initialFiles === null ? null : agent.id,
      currentHash: initialHash,
      bindingStockHash: recordedStockHash,
      latestStockHash: stockHash,
    });
    const configuredEntryFile = deriveBundleState(agent).entryFile;
    const preservedEntryFile = (currentFiles: Record<string, string>) => {
      if (Object.prototype.hasOwnProperty.call(currentFiles, entryFile)) return entryFile;
      if (Object.prototype.hasOwnProperty.call(currentFiles, configuredEntryFile)) return configuredEntryFile;
      if (Object.prototype.hasOwnProperty.call(currentFiles, ENTRY_FILE_DEFAULT)) return ENTRY_FILE_DEFAULT;
      return Object.keys(currentFiles).sort(compareInstructionPaths)[0] ?? entryFile;
    };
    const configFor = (advanceStockHash: boolean, currentFiles: Record<string, string>) => {
      const next = applyBundleConfig(asRecord(agent.adapterConfig), {
        mode: "managed",
        rootPath,
        entryFile: advanceStockHash ? entryFile : preservedEntryFile(currentFiles),
        clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
      });
      if (advanceStockHash) next[STOCK_HASH_KEY] = stockHash;
      return next;
    };

    const finish = async (
      action: ManagedBundleMaterialization["action"],
      stockStatus: ManagedResourceStockStatus,
      currentFiles: Record<string, string>,
      currentHash: string | null,
      input: { advanceStockHash: boolean; backupPath?: string | null },
    ) => {
      const changes = changedInstructionFiles(currentFiles, prospectiveFiles);
      const backupPath = input.backupPath ?? null;
      const adapterConfig = configFor(input.advanceStockHash, currentFiles);
      const bundle = await getBundle({ ...agent, adapterConfig });
      const changedPaths = [...changes.added, ...changes.removed, ...changes.updated]
        .sort(compareInstructionPaths);
      return {
        bundle,
        adapterConfig,
        materialization: {
          stockStatus,
          action,
          stockHash,
          previousHash: currentHash,
          recordedStockHash,
          ...changes,
          skipped: action === "skipped" ? changedPaths : [],
          backedUp: backupPath ? Object.keys(currentFiles).sort(compareInstructionPaths) : [],
          backupPath,
        },
      };
    };

    if (!options?.forceReset && initialStatus === "operator_modified") {
      return finish("skipped", initialStatus, initialFiles ?? {}, initialHash, { advanceStockHash: false });
    }
    if (!options?.forceReset && initialStatus === "stock_current") {
      return finish("unchanged", initialStatus, initialFiles ?? {}, initialHash, { advanceStockHash: true });
    }

    const stagingRoot = await fs.mkdtemp(path.join(path.dirname(rootPath), ".instructions-materialize-"));
    const stagedPath = path.join(stagingRoot, "staged");
    await fs.mkdir(stagedPath, { recursive: true });
    try {
      await writeBundleFiles(stagedPath, prospectiveFiles, { overwriteExisting: true });
      const stagedFiles = await readInstructionsTree(stagedPath);
      if (!stagedFiles || managedInstructionsTreeHash(stagedFiles) !== stockHash) {
        throw new Error("Staged instructions bundle hash did not match the prospective stock hash");
      }

      const recheckedFiles = await readInstructionsTree(rootPath);
      const recheckedHash = recheckedFiles === null ? null : managedInstructionsTreeHash(recheckedFiles);
      const recheckedStatus = resourceStatus({
        resourceId: recheckedFiles === null ? null : agent.id,
        currentHash: recheckedHash,
        bindingStockHash: recordedStockHash,
        latestStockHash: stockHash,
      });
      if (!options?.forceReset && recheckedStatus === "operator_modified") {
        return finish("skipped", recheckedStatus, recheckedFiles ?? {}, recheckedHash, { advanceStockHash: false });
      }
      if (!options?.forceReset && recheckedStatus === "stock_current") {
        return finish("unchanged", recheckedStatus, recheckedFiles ?? {}, recheckedHash, { advanceStockHash: true });
      }

      const backupPath = options?.forceReset && recheckedFiles !== null
        ? await nextInstructionsBackupPath(rootPath)
        : null;
      const displacedPath = recheckedFiles === null
        ? null
        : backupPath ?? path.join(stagingRoot, "previous");
      if (displacedPath) {
        await fs.rename(rootPath, displacedPath);
        if (!options?.forceReset) {
          const displacedFiles = await readInstructionsTree(displacedPath);
          const displacedHash = displacedFiles === null ? null : managedInstructionsTreeHash(displacedFiles);
          if (displacedHash !== recheckedHash) {
            await fs.rename(displacedPath, rootPath);
            return finish("skipped", "operator_modified", displacedFiles ?? {}, displacedHash, {
              advanceStockHash: false,
            });
          }
        }
      }

      try {
        await fs.rename(stagedPath, rootPath);
      } catch (error) {
        if (displacedPath && !(await statIfExists(rootPath))) {
          await fs.rename(displacedPath, rootPath).catch(() => undefined);
        }
        throw error;
      }

      const action: ManagedBundleMaterialization["action"] = options?.forceReset
        ? "reset"
        : recheckedStatus === "missing"
          ? "added"
          : "updated";
      return finish(action, recheckedStatus, recheckedFiles ?? {}, recheckedHash, {
        advanceStockHash: true,
        backupPath,
      });
    } finally {
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      entryFile?: string;
      recordedStockHash?: string | null;
    },
  ) {
    const rootPath = resolveManagedInstructionsRoot(agent);
    return withManagedBundleMaterializationLock(rootPath, () =>
      materializeManagedBundleInternal(agent, files, options),
    );
  }

  async function forceResetManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      entryFile?: string;
      recordedStockHash?: string | null;
    },
  ) {
    const rootPath = resolveManagedInstructionsRoot(agent);
    return withManagedBundleMaterializationLock(rootPath, () =>
      materializeManagedBundleInternal(agent, files, { ...options, forceReset: true }),
    );
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
    forceResetManagedBundle,
  };
}
