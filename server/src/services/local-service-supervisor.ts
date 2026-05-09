import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execFileAsync = promisify(execFile);

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
  command?: string | null;
  cwd?: string | null;
  envFingerprint?: string | null;
  port?: number | null;
}) {
  const record = await readLocalServiceRegistryRecord(input.serviceKey);
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
    const { stdout } = await execFileAsync("lsof", ["-nPiTCP", `:${port}`, "-sTCP:LISTEN", "-t"]);
    const firstPid = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .find((value) => Number.isInteger(value) && value > 0);
    return firstPid ?? null;
  } catch {
    return null;
  }
}
