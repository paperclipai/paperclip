import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { readProcessStartedAt } from "./hot-restart.js";

const execFileAsync = promisify(execFile);

type ProcessCommandRunner = (command: string, args: string[]) => Promise<string>;

function runProcessCommand(command: string, args: string[]) {
  return execFileAsync(command, args).then(({ stdout }) => stdout);
}

async function runPowerShell(script: string, runCommand: ProcessCommandRunner) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  try {
    return await runCommand("powershell.exe", args);
  } catch {
    return await runCommand("pwsh.exe", args);
  }
}

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
  processStartedAt?: string | null;
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
    processStartedAt: typeof rec.processStartedAt === "string" ? rec.processStartedAt : null,
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
  requireExactProcessIdentity?: boolean;
}) {
  const records = await listLocalServiceRegistryRecords(
    input.profileKind ? { profileKind: input.profileKind } : undefined,
  );
  const record = records.find((entry) => entry.runtimeServiceId === input.runtimeServiceId) ?? null;
  if (!record) return null;

  if (input.requireExactProcessIdentity) {
    return (await hasExactLocalServiceProcessIdentity(record)) ? record : null;
  }

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
  if (!(await doesLocalServiceRecordMatchCwd(candidate))) {
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

export function isProcessGroupAlive(processGroupId: number | null | undefined) {
  if (process.platform === "win32") return false;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
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
  if (!(await doesLocalServiceRecordMatchCwd(record))) {
    await removeLocalServiceRegistryRecord(input.serviceKey);
    return null;
  }
  if (input.command && record.command !== input.command) return null;
  if (input.cwd && path.resolve(record.cwd) !== path.resolve(input.cwd)) return null;
  if (input.envFingerprint && record.envFingerprint !== input.envFingerprint) return null;
  if (input.port !== undefined && input.port !== null && record.port !== input.port) return null;
  return record;
}

export async function readLocalServiceProcessGroupId(pid: number) {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function readProcessGroupId(pid: number) {
  if (process.platform === "win32") return isPidAlive(pid) ? pid : null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]);
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function isLocalServiceProcessOwnedBy(pid: number, ownerProcessId: number) {
  if (pid === ownerProcessId) return true;
  if (process.platform !== "win32") {
    return (await readLocalServiceProcessGroupId(pid)) === ownerProcessId;
  }

  try {
    const script = [
      `$currentProcessId = ${pid}`,
      "while ($currentProcessId -gt 0) {",
      "  $process = Get-CimInstance Win32_Process -Filter \"ProcessId = $currentProcessId\" -ErrorAction SilentlyContinue",
      "  if ($null -eq $process) { break }",
      "  $parentProcessId = [int]$process.ParentProcessId",
      "  Write-Output $parentProcessId",
      "  if ($parentProcessId -eq $currentProcessId) { break }",
      "  $currentProcessId = $parentProcessId",
      "}",
    ].join("\n");
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .some((ancestorPid) => ancestorPid === ownerProcessId);
  } catch {
    return false;
  }
}

export async function readLocalServiceProcessCommand(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    runCommand?: ProcessCommandRunner;
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runProcessCommand;
  try {
    const stdout = platform === "win32"
      ? await runPowerShell(
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CommandLine`,
        runCommand,
      )
      : await runCommand("ps", ["-o", "command=", "-p", String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function hasExactLocalServiceProcessIdentity(
  record: LocalServiceRegistryRecord,
  options: {
    isAlive?: (pid: number) => boolean;
    readCommand?: (pid: number) => Promise<string | null>;
    readCwd?: (pid: number) => Promise<string | null>;
    readStartedAt?: (pid: number) => Promise<string | null>;
    readGroupId?: (pid: number) => Promise<number | null>;
    isInWorkspace?: (processCwd: string, workspaceCwd: string) => Promise<boolean>;
  } = {},
) {
  const isAlive = options.isAlive ?? isPidAlive;
  if (!isAlive(record.pid)) return false;

  const [commandLine, processCwd, observedStartedAt, observedGroupId] = await Promise.all([
    (options.readCommand ?? readLocalServiceProcessCommand)(record.pid),
    (options.readCwd ?? readLocalServiceProcessCwd)(record.pid),
    (options.readStartedAt ?? readProcessStartedAt)(record.pid).catch(() => null),
    (options.readGroupId ?? readProcessGroupId)(record.pid),
  ]);
  if (!commandLine || !processCwd || !observedStartedAt) return false;

  const normalize = (value: string) => value.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (!normalize(commandLine).includes(normalize(record.command))) return false;
  if (!(await (options.isInWorkspace ?? isLocalServiceProcessInWorkspace)(processCwd, record.cwd))) {
    return false;
  }

  if (!record.processStartedAt) return false;
  const recordedStartMs = Date.parse(record.processStartedAt);
  const observedStartMs = Date.parse(observedStartedAt);
  if (
    !Number.isFinite(recordedStartMs)
    || !Number.isFinite(observedStartMs)
    || recordedStartMs !== observedStartMs
  ) {
    return false;
  }

  return record.processGroupId === null || observedGroupId === record.processGroupId;
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

  if (input.cwd) {
    const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
    if (!ownerCwd || !(await isLocalServiceProcessInWorkspace(ownerCwd, input.cwd))) {
      return null;
    }
  }

  const processGroupId = await readLocalServiceProcessGroupId(ownerPid);
  const pid = processGroupId && isPidAlive(processGroupId) ? processGroupId : ownerPid;
  const now = new Date().toISOString();
  const processStartedAt = await readProcessStartedAt(pid).catch(() => null);
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
    processStartedAt,
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
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"]);
      for (const line of stdout.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") continue;
        const localAddress = columns[1] ?? "";
        const separatorIndex = localAddress.lastIndexOf(":");
        const localPort = Number.parseInt(localAddress.slice(separatorIndex + 1), 10);
        const state = columns.at(-2)?.toUpperCase();
        const pid = Number.parseInt(columns.at(-1) ?? "", 10);
        if (localPort === port && state === "LISTENING" && Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      }
      return null;
    }
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

export async function readLocalServiceProcessCwd(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    readLink?: (target: string) => Promise<string>;
    runCommand?: ProcessCommandRunner;
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const readLink = options.readLink ?? fs.readlink;
  const runCommand = options.runCommand ?? runProcessCommand;
  try {
    if (platform === "linux") return await readLink(`/proc/${pid}/cwd`);
    if (platform === "darwin") {
      const stdout = await runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      return stdout
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1)
        .trim() || null;
    }
    if (platform === "win32") {
      const script = [
        "$source = @'",
        "using System;",
        "using System.ComponentModel;",
        "using System.Runtime.InteropServices;",
        "using System.Text;",
        "public static class PaperclipProcessCwd {",
        "  [StructLayout(LayoutKind.Sequential)]",
        "  private struct ProcessBasicInformation {",
        "    public IntPtr Reserved1; public IntPtr PebBaseAddress;",
        "    public IntPtr Reserved2_0; public IntPtr Reserved2_1;",
        "    public IntPtr UniqueProcessId; public IntPtr Reserved3;",
        "  }",
        "  [DllImport(\"ntdll.dll\")] private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, ref ProcessBasicInformation info, int size, out int returned);",
        "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern IntPtr OpenProcess(int access, bool inherit, int processId);",
        "  [DllImport(\"kernel32.dll\", SetLastError = true)] private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);",
        "  [DllImport(\"kernel32.dll\")] private static extern bool CloseHandle(IntPtr handle);",
        "  private static byte[] Read(IntPtr process, IntPtr address, int count) {",
        "    var buffer = new byte[count]; IntPtr read;",
        "    if (!ReadProcessMemory(process, address, buffer, count, out read) || read.ToInt64() != count) throw new Win32Exception(Marshal.GetLastWin32Error());",
        "    return buffer;",
        "  }",
        "  public static string Get(int processId) {",
        "    const int QueryInformation = 0x0400; const int VmRead = 0x0010;",
        "    var process = OpenProcess(QueryInformation | VmRead, false, processId);",
        "    if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());",
        "    try {",
        "      var info = new ProcessBasicInformation(); int returned;",
        "      var status = NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(info), out returned);",
        "      if (status != 0) throw new InvalidOperationException(\"NtQueryInformationProcess failed: \" + status);",
        "      var is64 = IntPtr.Size == 8;",
        "      var parametersOffset = is64 ? 0x20 : 0x10;",
        "      var currentDirectoryOffset = is64 ? 0x38 : 0x24;",
        "      var pointerOffset = is64 ? 8 : 4;",
        "      var pointerBytes = Read(process, IntPtr.Add(info.PebBaseAddress, parametersOffset), IntPtr.Size);",
        "      var parameters = is64 ? new IntPtr(BitConverter.ToInt64(pointerBytes, 0)) : new IntPtr(BitConverter.ToInt32(pointerBytes, 0));",
        "      if (parameters == IntPtr.Zero) throw new InvalidOperationException(\"Process parameters unavailable\");",
        "      var unicode = Read(process, IntPtr.Add(parameters, currentDirectoryOffset), pointerOffset + IntPtr.Size);",
        "      var length = BitConverter.ToUInt16(unicode, 0);",
        "      var buffer = is64 ? new IntPtr(BitConverter.ToInt64(unicode, pointerOffset)) : new IntPtr(BitConverter.ToInt32(unicode, pointerOffset));",
        "      if (length == 0 || buffer == IntPtr.Zero) throw new InvalidOperationException(\"Current directory unavailable\");",
        "      return Encoding.Unicode.GetString(Read(process, buffer, length));",
        "    } finally { CloseHandle(process); }",
        "  }",
        "}",
        "'@",
        "Add-Type -TypeDefinition $source -ErrorAction Stop",
        `[PaperclipProcessCwd]::Get(${pid})`,
      ].join("\n");
      const stdout = await runPowerShell(script, runCommand);
      return stdout.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function isLocalServiceProcessInWorkspace(processCwd: string, workspaceCwd: string) {
  try {
    const [resolvedProcessCwd, resolvedWorkspaceCwd] = await Promise.all([
      fs.realpath(processCwd),
      fs.realpath(workspaceCwd),
    ]);
    const relativePath = path.relative(resolvedWorkspaceCwd, resolvedProcessCwd);
    return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
  } catch {
    return false;
  }
}

export async function isLocalServiceRegistryCwdCompatible(processCwd: string | null, workspaceCwd: string) {
  if (!processCwd) return process.platform !== "linux";
  return isLocalServiceProcessInWorkspace(processCwd, workspaceCwd);
}

async function doesLocalServiceRecordMatchCwd(record: LocalServiceRegistryRecord) {
  if (!record.port) return true;
  const ownerPid = await readLocalServicePortOwner(record.port);
  if (!ownerPid) return false;
  const ownerCwd = await readLocalServiceProcessCwd(ownerPid);
  return isLocalServiceRegistryCwdCompatible(ownerCwd, record.cwd);
}
