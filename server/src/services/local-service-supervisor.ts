import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFileAsync = promisify(execFile);
const PAPERCLIP_RUNTIME_MARKER_KEYS = [
  "PAPERCLIP_MANAGED_RUNTIME",
  "PAPERCLIP_LOCAL_SERVICE_KEY",
  "PAPERCLIP_RUNTIME_SERVICE_ID",
  "PAPERCLIP_RUNTIME_SERVICE_NAME",
] as const;
const PAPERCLIP_RUNTIME_MARKER_KEY_SET = new Set<string>(PAPERCLIP_RUNTIME_MARKER_KEYS);
const PAPERCLIP_RUNTIME_ENTRYPOINTS = new Set([
  "scripts/dev-runner.ts",
  "server/scripts/dev-watch.ts",
  "server/src/index.ts",
]);

export type PaperclipRuntimeMarkers = Partial<Record<(typeof PAPERCLIP_RUNTIME_MARKER_KEYS)[number], string>>;

export interface LocalServiceRegistryRecord {
  version: 1;
  serviceKey: string;
  profileKind: string;
  serviceName: string;
  command: string;
  cwd: string;
  envFingerprint: string;
  port: number | null;
  url: string | null;
  pid: number;
  processGroupId: number | null;
  provider: "local_process";
  runtimeServiceId: string | null;
  reuseKey: string | null;
  startedAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown> | null;
}

export interface LocalServiceIdentityInput {
  profileKind: string;
  serviceName: string;
  cwd: string;
  command: string;
  envFingerprint: string;
  port: number | null;
  scope: Record<string, unknown> | null;
}

export interface LocalProcessSnapshot {
  pid: number;
  parentPid: number | null;
  processGroupId: number | null;
  commandName: string;
  commandLine: string;
  cwd: string | null;
  paperclipRuntimeMarkers?: PaperclipRuntimeMarkers | null;
}

export interface OrphanedPaperclipRuntimeProcess {
  pid: number;
  processGroupId: number | null;
  commandName: string;
  commandLine: string;
  cwd: string | null;
  matchedRoot: string;
  containmentEvidence: "cwd" | "command";
  ownershipEvidence: "paperclip_runtime_env" | "paperclip_entrypoint";
}

export interface OrphanedPaperclipRuntimeCleanupResult {
  scanned: number;
  matched: number;
  terminated: number;
  dryRun: boolean;
  candidates: OrphanedPaperclipRuntimeProcess[];
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

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeProcessPath(value: string) {
  return path.resolve(value);
}

function isUsableContainmentRoot(root: string) {
  const parsed = path.parse(root);
  if (root === parsed.root) return false;
  if (root === os.homedir()) return false;
  return root.length >= parsed.root.length + 6;
}

function isPathContainedByRoot(candidatePath: string | null | undefined, root: string) {
  if (!candidatePath) return false;
  const relative = path.relative(root, normalizeProcessPath(candidatePath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function tokenizeCommandLine(commandLine: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of commandLine) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function cleanCommandLinePathToken(token: string) {
  return token.replace(/[,;]+$/g, "");
}

function commandLineHasContainedPath(commandLine: string, root: string) {
  if (!commandLine || !root) return false;
  for (const token of tokenizeCommandLine(commandLine)) {
    const candidates = [token];
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) candidates.push(token.slice(equalsIndex + 1));

    for (const candidate of candidates) {
      const cleaned = cleanCommandLinePathToken(candidate);
      if (!path.isAbsolute(cleaned)) continue;
      if (isPathContainedByRoot(cleaned, root)) return true;
    }
  }
  return false;
}

function looksLikeNodeRuntimeProcess(snapshot: LocalProcessSnapshot) {
  const commandName = path.basename(snapshot.commandName || "").toLowerCase();
  const commandLine = normalizeWhitespace(snapshot.commandLine).toLowerCase();

  return (
    commandName === "node" ||
    commandName === "tsx" ||
    commandName === "esbuild" ||
    commandName === "vite" ||
    commandName === "next" ||
    commandName === "astro" ||
    commandName === "webpack" ||
    commandName === "turbo" ||
    commandName === "pnpm" ||
    commandName === "npm" ||
    commandName === "yarn" ||
    commandName === "bun" ||
    /(^|[/\s])(?:node|tsx|esbuild|vite|next|astro|webpack|turbo|pnpm|npm|yarn|bun)(?:$|[\s/'"])/.test(commandLine)
  );
}

function hasPaperclipRuntimeEnvMarker(snapshot: LocalProcessSnapshot) {
  const markers = snapshot.paperclipRuntimeMarkers;
  if (!markers) return false;
  return PAPERCLIP_RUNTIME_MARKER_KEYS.some((key) => typeof markers[key] === "string" && markers[key]!.trim().length > 0);
}

function resolveCommandLinePathToken(token: string, cwd: string | null | undefined) {
  const cleaned = cleanCommandLinePathToken(token);
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return normalizeProcessPath(cleaned);
  if (!cwd || !/[\\/]/.test(cleaned)) return null;
  return normalizeProcessPath(path.resolve(cwd, cleaned));
}

function commandLineHasPaperclipEntrypoint(commandLine: string, root: string, cwd: string | null | undefined) {
  if (!commandLine || !root) return false;
  for (const token of tokenizeCommandLine(commandLine)) {
    const candidates = [token];
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) candidates.push(token.slice(equalsIndex + 1));

    for (const candidate of candidates) {
      const resolved = resolveCommandLinePathToken(candidate, cwd);
      if (!resolved || !isPathContainedByRoot(resolved, root)) continue;
      const relative = path.relative(root, resolved).split(path.sep).join("/");
      if (PAPERCLIP_RUNTIME_ENTRYPOINTS.has(relative)) return true;
    }
  }
  return false;
}

function getPaperclipOwnershipEvidence(snapshot: LocalProcessSnapshot, root: string) {
  if (hasPaperclipRuntimeEnvMarker(snapshot)) return "paperclip_runtime_env" as const;
  if (commandLineHasPaperclipEntrypoint(snapshot.commandLine, root, snapshot.cwd)) return "paperclip_entrypoint" as const;
  return null;
}

function normalizeManagedProcessIds(input?: Iterable<number | null | undefined>) {
  const ids = new Set<number>();
  for (const value of input ?? []) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      ids.add(value);
    }
  }
  return ids;
}

function collectManagedProcessIdsFromRegistry(records: LocalServiceRegistryRecord[]) {
  const ids = new Set<number>();
  for (const record of records) {
    ids.add(record.pid);
    if (record.processGroupId) ids.add(record.processGroupId);
    const childPid = record.metadata?.childPid;
    if (typeof childPid === "number" && Number.isInteger(childPid) && childPid > 0) {
      ids.add(childPid);
    }
  }
  return ids;
}

export function selectOrphanedPaperclipRuntimeProcesses(input: {
  processes: LocalProcessSnapshot[];
  containmentRoots: string[];
  managedProcessIds?: Iterable<number | null | undefined>;
  currentProcessId?: number;
  currentProcessGroupId?: number | null;
}): OrphanedPaperclipRuntimeProcess[] {
  const roots = Array.from(
    new Set(
      input.containmentRoots
        .map((root) => normalizeProcessPath(root))
        .filter(isUsableContainmentRoot),
    ),
  ).sort((left, right) => right.length - left.length);
  if (roots.length === 0) return [];

  const managedProcessIds = normalizeManagedProcessIds(input.managedProcessIds);
  const currentProcessId = input.currentProcessId ?? process.pid;
  const currentProcessGroupId = input.currentProcessGroupId ?? null;
  const selected: OrphanedPaperclipRuntimeProcess[] = [];

  for (const processSnapshot of input.processes) {
    if (!Number.isInteger(processSnapshot.pid) || processSnapshot.pid <= 0) continue;
    if (processSnapshot.pid === currentProcessId) continue;
    if (managedProcessIds.has(processSnapshot.pid)) continue;
    if (processSnapshot.processGroupId && managedProcessIds.has(processSnapshot.processGroupId)) continue;
    if (currentProcessGroupId && processSnapshot.processGroupId === currentProcessGroupId) continue;
    if (!looksLikeNodeRuntimeProcess(processSnapshot)) continue;

    let matchedRoot: string | null = null;
    let containmentEvidence: "cwd" | "command" | null = null;
    let ownershipEvidence: OrphanedPaperclipRuntimeProcess["ownershipEvidence"] | null = null;
    for (const root of roots) {
      const evidence = getPaperclipOwnershipEvidence(processSnapshot, root);
      if (!evidence) continue;
      if (isPathContainedByRoot(processSnapshot.cwd, root)) {
        matchedRoot = root;
        containmentEvidence = "cwd";
        ownershipEvidence = evidence;
        break;
      }
      if (commandLineHasContainedPath(processSnapshot.commandLine, root)) {
        matchedRoot = root;
        containmentEvidence = "command";
        ownershipEvidence = evidence;
        break;
      }
    }
    if (!matchedRoot || !containmentEvidence || !ownershipEvidence) continue;

    selected.push({
      pid: processSnapshot.pid,
      processGroupId: processSnapshot.processGroupId,
      commandName: processSnapshot.commandName,
      commandLine: normalizeWhitespace(processSnapshot.commandLine),
      cwd: processSnapshot.cwd,
      matchedRoot,
      containmentEvidence,
      ownershipEvidence,
    });
  }

  return selected.sort((left, right) => left.pid - right.pid);
}

function sanitizeServiceKeySegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function getRuntimeServicesDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "runtime-services");
}

function getRuntimeServiceRegistryPath(serviceKey: string) {
  return path.resolve(getRuntimeServicesDir(), `${serviceKey}.json`);
}

function normalizeRegistryRecord(raw: unknown): LocalServiceRegistryRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (
    rec.version !== 1 ||
    typeof rec.serviceKey !== "string" ||
    typeof rec.profileKind !== "string" ||
    typeof rec.serviceName !== "string" ||
    typeof rec.command !== "string" ||
    typeof rec.cwd !== "string" ||
    typeof rec.envFingerprint !== "string" ||
    typeof rec.pid !== "number"
  ) {
    return null;
  }

  return {
    version: 1,
    serviceKey: rec.serviceKey,
    profileKind: rec.profileKind,
    serviceName: rec.serviceName,
    command: rec.command,
    cwd: rec.cwd,
    envFingerprint: rec.envFingerprint,
    port: typeof rec.port === "number" ? rec.port : null,
    url: typeof rec.url === "string" ? rec.url : null,
    pid: rec.pid,
    processGroupId: typeof rec.processGroupId === "number" ? rec.processGroupId : null,
    provider: "local_process",
    runtimeServiceId: typeof rec.runtimeServiceId === "string" ? rec.runtimeServiceId : null,
    reuseKey: typeof rec.reuseKey === "string" ? rec.reuseKey : null,
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : new Date().toISOString(),
    lastSeenAt: typeof rec.lastSeenAt === "string" ? rec.lastSeenAt : new Date().toISOString(),
    metadata:
      rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)
        ? (rec.metadata as Record<string, unknown>)
        : null,
  };
}

async function safeReadRegistryRecord(filePath: string) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeRegistryRecord(raw);
  } catch {
    return null;
  }
}

export function createLocalServiceKey(input: LocalServiceIdentityInput) {
  const digest = createHash("sha256")
    .update(
      stableStringify({
        profileKind: input.profileKind,
        serviceName: input.serviceName,
        cwd: path.resolve(input.cwd),
        command: input.command,
        envFingerprint: input.envFingerprint,
        port: input.port,
        scope: input.scope ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  return `${sanitizeServiceKeySegment(input.profileKind, "service")}-${sanitizeServiceKeySegment(input.serviceName, "service")}-${digest}`;
}

export async function writeLocalServiceRegistryRecord(record: LocalServiceRegistryRecord) {
  await fs.mkdir(getRuntimeServicesDir(), { recursive: true });
  await fs.writeFile(
    getRuntimeServiceRegistryPath(record.serviceKey),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

export async function removeLocalServiceRegistryRecord(serviceKey: string) {
  await fs.rm(getRuntimeServiceRegistryPath(serviceKey), { force: true });
}

export async function readLocalServiceRegistryRecord(serviceKey: string) {
  return await safeReadRegistryRecord(getRuntimeServiceRegistryPath(serviceKey));
}

export async function listLocalServiceRegistryRecords(filter?: {
  profileKind?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const entries = await fs.readdir(getRuntimeServicesDir(), { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => safeReadRegistryRecord(path.resolve(getRuntimeServicesDir(), entry.name))),
    );

    return records
      .filter((record): record is LocalServiceRegistryRecord => record !== null)
      .filter((record) => {
        if (filter?.profileKind && record.profileKind !== filter.profileKind) return false;
        if (!filter?.metadata) return true;
        return Object.entries(filter.metadata).every(([key, value]) => record.metadata?.[key] === value);
      })
      .sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  } catch {
    return [];
  }
}

async function readProcessCwd(pid: number) {
  if (process.platform !== "linux") return null;
  try {
    return await fs.realpath(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function readProcessPaperclipRuntimeMarkers(pid: number): Promise<PaperclipRuntimeMarkers | null> {
  if (process.platform !== "linux") return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    const markers: PaperclipRuntimeMarkers = {};
    for (const entry of raw.split("\0")) {
      const equalsIndex = entry.indexOf("=");
      if (equalsIndex <= 0) continue;
      const key = entry.slice(0, equalsIndex);
      if (!PAPERCLIP_RUNTIME_MARKER_KEY_SET.has(key)) continue;
      const value = entry.slice(equalsIndex + 1);
      if (value.trim().length > 0) {
        markers[key as keyof PaperclipRuntimeMarkers] = value;
      }
    }
    return Object.keys(markers).length > 0 ? markers : null;
  } catch {
    return null;
  }
}

function parsePsProcessLine(line: string): LocalProcessSnapshot | null {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  const parentPid = Number.parseInt(match[2]!, 10);
  const processGroupId = Number.parseInt(match[3]!, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
    processGroupId: Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : null,
    commandName: match[4] ?? "",
    commandLine: match[5]?.trim() || match[4] || "",
    cwd: null,
  };
}

export async function listLocalProcessSnapshots(): Promise<LocalProcessSnapshot[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,comm=,args="]);
    const parsed = stdout
      .split(/\r?\n/)
      .map(parsePsProcessLine)
      .filter((entry): entry is LocalProcessSnapshot => entry !== null);
    return await Promise.all(
      parsed.map(async (entry) => ({
        ...entry,
        cwd: await readProcessCwd(entry.pid),
        paperclipRuntimeMarkers: await readProcessPaperclipRuntimeMarkers(entry.pid),
      })),
    );
  } catch {
    return [];
  }
}

async function readCurrentProcessGroupId() {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(process.pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function cleanupOrphanedPaperclipRuntimeProcesses(input: {
  containmentRoots: string[];
  dryRun?: boolean;
  additionalManagedProcessIds?: Iterable<number | null | undefined>;
  processSnapshots?: LocalProcessSnapshot[];
  registryRecords?: LocalServiceRegistryRecord[];
  currentProcessId?: number;
  currentProcessGroupId?: number | null;
  terminate?: (record: Pick<LocalServiceRegistryRecord, "pid" | "processGroupId">) => Promise<void>;
}): Promise<OrphanedPaperclipRuntimeCleanupResult> {
  const processSnapshots = input.processSnapshots ?? await listLocalProcessSnapshots();
  const registryRecords = input.registryRecords ?? await listLocalServiceRegistryRecords();
  const managedProcessIds = collectManagedProcessIdsFromRegistry(registryRecords);
  for (const id of input.additionalManagedProcessIds ?? []) {
    if (typeof id === "number" && Number.isInteger(id) && id > 0) {
      managedProcessIds.add(id);
    }
  }
  const currentProcessGroupId = input.currentProcessGroupId ?? await readCurrentProcessGroupId();
  const candidates = selectOrphanedPaperclipRuntimeProcesses({
    processes: processSnapshots,
    containmentRoots: input.containmentRoots,
    managedProcessIds,
    currentProcessId: input.currentProcessId,
    currentProcessGroupId,
  });

  if (input.dryRun) {
    return {
      scanned: processSnapshots.length,
      matched: candidates.length,
      terminated: 0,
      dryRun: true,
      candidates,
    };
  }

  const terminate = input.terminate ?? ((record) => terminateLocalService(record));
  const seenTargets = new Set<string>();
  let terminated = 0;
  for (const candidate of candidates) {
    const targetKey = candidate.processGroupId ? `pgid:${candidate.processGroupId}` : `pid:${candidate.pid}`;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    await terminate({
      pid: candidate.pid,
      processGroupId: candidate.processGroupId,
    });
    terminated += 1;
  }

  return {
    scanned: processSnapshots.length,
    matched: candidates.length,
    terminated,
    dryRun: false,
    candidates,
  };
}

export async function findLocalServiceRegistryRecordByRuntimeServiceId(input: {
  runtimeServiceId: string;
  profileKind?: string;
}) {
  const records = await listLocalServiceRegistryRecords(
    input.profileKind ? { profileKind: input.profileKind } : undefined,
  );
  const record = records.find((entry) => entry.runtimeServiceId === input.runtimeServiceId) ?? null;
  if (!record) return null;

  let candidate = record;
  if (!isPidAlive(candidate.pid)) {
    const ownerPid = candidate.port ? await readLocalServicePortOwner(candidate.port) : null;
    if (!ownerPid) {
      await removeLocalServiceRegistryRecord(candidate.serviceKey);
      return null;
    }
    candidate = {
      ...candidate,
      pid: ownerPid,
      processGroupId: candidate.processGroupId && isPidAlive(candidate.processGroupId) ? candidate.processGroupId : ownerPid,
      lastSeenAt: new Date().toISOString(),
    };
    await writeLocalServiceRegistryRecord(candidate);
  }

  if (!(await isLikelyMatchingCommand(candidate))) {
    await removeLocalServiceRegistryRecord(record.serviceKey);
    return null;
  }

  return candidate;
}

export function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function isLikelyMatchingCommand(record: LocalServiceRegistryRecord) {
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(record.pid)]);
    const commandLine = stdout.trim();
    if (!commandLine) return false;
    const normalize = (value: string) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
    const normalizedCommandLine = normalize(commandLine);
    const normalizedRecordedCommand = normalize(record.command);
    return normalizedCommandLine.includes(normalizedRecordedCommand) || normalizedCommandLine.includes(record.serviceName);
  } catch {
    return true;
  }
}

export async function findAdoptableLocalService(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
}) {
  const record =
    await readLocalServiceRegistryRecord(input.serviceKey)
    ?? await adoptLocalServiceFromPortOwner(input);
  if (!record) return null;

  if (!isPidAlive(record.pid)) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (!(await isLikelyMatchingCommand(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (input.command && record.command !== input.command) return null;
  if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
  if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
  if (input.port !== undefined && input.port !== null && record.port !== input.port) return null;
  return record;
}

async function readProcessGroupId(pid: number) {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function adoptLocalServiceFromPortOwner(input: {
  serviceKey: string;
  profileKind?: string | null;
  serviceName?: string | null;
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
  url?: string | null;
}) {
  if (!input.port) return null;
  const ownerPid = await readLocalServicePortOwner(input.port);
  if (!ownerPid) return null;

  const processGroupId = await readProcessGroupId(ownerPid);
  const pid = processGroupId && isPidAlive(processGroupId) ? processGroupId : ownerPid;
  const now = new Date().toISOString();
  const record: LocalServiceRegistryRecord = {
    version: 1,
    serviceKey: input.serviceKey,
    profileKind: input.profileKind ?? "workspace-runtime",
    serviceName: input.serviceName ?? "service",
    command: input.command ?? input.serviceName ?? "service",
    cwd: input.cwd ?? process.cwd(),
    envFingerprint: input.envFingerprint ?? "",
    port: input.port,
    url: input.url ?? null,
    pid,
    processGroupId: processGroupId ?? pid,
    provider: "local_process",
    runtimeServiceId: null,
    reuseKey: input.envFingerprint ?? null,
    startedAt: now,
    lastSeenAt: now,
    metadata: null,
  };

  if (!(await isLikelyMatchingCommand(record))) return null;
  await writeLocalServiceRegistryRecord(record);
  return record;
}

export async function touchLocalServiceRegistryRecord(
  serviceKey: string,
  patch?: Partial<Omit<LocalServiceRegistryRecord, "serviceKey" | "version">>,
) {
  const existing = await readLocalServiceRegistryRecord(serviceKey);
  if (!existing) return null;
  const next: LocalServiceRegistryRecord = {
    ...existing,
    ...patch,
    version: 1,
    serviceKey,
    lastSeenAt: patch?.lastSeenAt ?? new Date().toISOString(),
  };
  await writeLocalServiceRegistryRecord(next);
  return next;
}

export async function terminateLocalService(
  record: Pick<LocalServiceRegistryRecord, "pid" | "processGroupId">,
  opts?: { signal?: NodeJS.Signals; forceAfterMs?: number },
) {
  const signal = opts?.signal ?? "SIGTERM";
  const targetProcessGroup = process.platform !== "win32" && record.processGroupId && record.processGroupId > 0;
  try {
    if (targetProcessGroup) {
      process.kill(-record.processGroupId!, signal);
    } else {
      process.kill(record.pid, signal);
    }
  } catch {
    return;
  }

  const deadline = Date.now() + (opts?.forceAfterMs ?? 2_000);
  while (Date.now() < deadline) {
    const targetAlive = targetProcessGroup
      ? isProcessGroupAlive(record.processGroupId)
      : isPidAlive(record.pid);
    if (!targetAlive) {
      return;
    }
    await delay(100);
  }

  const stillAlive = targetProcessGroup
    ? isProcessGroupAlive(record.processGroupId)
    : isPidAlive(record.pid);
  if (!stillAlive) return;
  try {
    if (targetProcessGroup) {
      process.kill(-record.processGroupId!, "SIGKILL");
    } else {
      process.kill(record.pid, "SIGKILL");
    }
  } catch {
    // Ignore cleanup races.
  }
}

export async function readLocalServicePortOwner(port: number) {
  if (!Number.isInteger(port) || port <= 0 || process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const firstPid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value > 0);
    return firstPid ?? null;
  } catch {
    return null;
  }
}
