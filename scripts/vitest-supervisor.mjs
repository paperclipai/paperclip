import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deletedSuffix = " (deleted)";
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const guardianScript = path.join(scriptsDir, "vitest-cleanup-guardian.mjs");

export const DEFAULT_HOST_CAP = 2;
export const DEFAULT_PROCESS_BUDGET = 256;
export const DEFAULT_GRACE_MS = 5_000;
export const DEFAULT_HOST_SLOT_WAIT_MS = 30 * 60_000;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function underRoot(candidate, root) {
  const normalized = candidate.endsWith(deletedSuffix)
    ? candidate.slice(0, -deletedSuffix.length)
    : candidate;
  return normalized === root || normalized.startsWith(`${root}${path.sep}`);
}

async function ensurePrivateDirectory(candidate) {
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(candidate);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Test temp parent is not a real directory: ${candidate}`);
  }
  await fs.access(candidate, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  return path.resolve(candidate);
}

export async function resolveTestTempParent(env = process.env) {
  const candidates = [
    ["PAPERCLIP_TEST_TMPDIR", env.PAPERCLIP_TEST_TMPDIR],
    ["TMPDIR", env.TMPDIR],
    ["os.tmpdir()", os.tmpdir()],
  ];
  const errors = [];
  for (const [source, raw] of candidates) {
    if (!raw || !path.isAbsolute(raw)) {
      if (raw) errors.push(`${source} was not absolute`);
      continue;
    }
    try {
      return { parent: await ensurePrivateDirectory(raw), source };
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No safe test temp parent is available (${errors.join("; ")}).`);
}

export async function readLinuxProcessIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const comm = raw.slice(raw.indexOf("(") + 1, close);
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const state = fields[0];
    if (state === "Z" || state === "X") return null;
    return {
      pid,
      ppid: Number(fields[1]),
      processGroupId: Number(fields[2]),
      startTime: fields[19],
      comm,
    };
  } catch {
    return null;
  }
}

async function readProcessEnvironment(pid) {
  if (process.platform !== "linux") return new Map();
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`);
    return new Map(
      raw
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const split = entry.indexOf("=");
          return split < 0 ? [entry, ""] : [entry.slice(0, split), entry.slice(split + 1)];
        }),
    );
  } catch {
    return new Map();
  }
}

async function readProcessCommandTokens(pid) {
  if (process.platform !== "linux") return [];
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function classifyFamily(identity, commandTokens) {
  const names = [identity.comm, ...commandTokens.slice(0, 3).map((token) => path.basename(token))]
    .join(" ")
    .toLowerCase();
  if (/postgres|postmaster/.test(names)) return "embedded-postgres";
  if (/(^|\s)sshd?(\s|$)/.test(names)) return "ssh";
  if (/acpx|acp-relay/.test(names)) return "acp-relay";
  if (/codex|claude|gemini|hermes|opencode|cursor/.test(names)) return "model-adapter";
  if (/vitest/.test(names)) return "vitest";
  if (/node/.test(names)) return "node";
  return identity.comm || "unknown";
}

export async function listTaggedProcesses(invocationId) {
  if (process.platform !== "linux") return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        const env = await readProcessEnvironment(pid);
        if (env.get("PAPERCLIP_TEST_INVOCATION_ID") !== invocationId) return;
        const identity = await readLinuxProcessIdentity(pid);
        if (!identity) return;
        const commandTokens = await readProcessCommandTokens(pid);
        matches.push({ ...identity, family: classifyFamily(identity, commandTokens) });
      }),
  );
  return matches.sort((a, b) => a.pid - b.pid);
}

export async function listRootScopedProcesses(root) {
  if (process.platform !== "linux" || !root) return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        const env = await readProcessEnvironment(pid);
        const scopedPaths = [env.get("PAPERCLIP_HOME"), env.get("TMPDIR")].filter(Boolean);
        if (!scopedPaths.some((candidate) => underRoot(candidate, root))) return;
        const identity = await readLinuxProcessIdentity(pid);
        if (!identity) return;
        const commandTokens = await readProcessCommandTokens(pid);
        matches.push({ ...identity, family: classifyFamily(identity, commandTokens) });
      }),
  );
  return matches.sort((a, b) => a.pid - b.pid);
}

export async function listInvocationProcesses(invocationId, root) {
  const [tagged, rootScoped] = await Promise.all([
    listTaggedProcesses(invocationId),
    listRootScopedProcesses(root),
  ]);
  const processes = new Map();
  for (const processInfo of [...tagged, ...rootScoped]) {
    processes.set(`${processInfo.pid}:${processInfo.startTime}`, processInfo);
  }
  return [...processes.values()].sort((a, b) => a.pid - b.pid);
}

async function listCgroupProcesses(cgroupPath) {
  if (!cgroupPath) return [];
  const raw = await fs.readFile(path.join(cgroupPath, "cgroup.procs"), "utf8").catch(() => "");
  const results = [];
  for (const value of raw.split(/\s+/).filter(Boolean)) {
    const identity = await readLinuxProcessIdentity(Number(value));
    if (!identity) continue;
    const commandTokens = await readProcessCommandTokens(identity.pid);
    results.push({ ...identity, family: classifyFamily(identity, commandTokens) });
  }
  return results;
}

async function listProcessGroupProcesses(processGroupId) {
  if (process.platform !== "linux" || !Number.isInteger(processGroupId) || processGroupId <= 0) return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const identity = await readLinuxProcessIdentity(Number(entry.name));
        if (!identity || identity.processGroupId !== processGroupId) return;
        const commandTokens = await readProcessCommandTokens(identity.pid);
        matches.push({ ...identity, family: classifyFamily(identity, commandTokens) });
      }),
  );
  return matches.sort((a, b) => a.pid - b.pid);
}

async function listProcessDescendants(ancestorPid) {
  if (process.platform !== "linux" || !Number.isInteger(ancestorPid) || ancestorPid <= 0) return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const identities = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => readLinuxProcessIdentity(Number(entry.name))),
    )
  ).filter(Boolean);
  const descendantPids = new Set([ancestorPid]);
  const descendants = [];
  let foundMore = true;
  while (foundMore) {
    foundMore = false;
    for (const identity of identities) {
      if (descendantPids.has(identity.pid) || !descendantPids.has(identity.ppid)) continue;
      descendantPids.add(identity.pid);
      descendants.push(identity);
      foundMore = true;
    }
  }
  return Promise.all(
    descendants.map(async (identity) => {
      const commandTokens = await readProcessCommandTokens(identity.pid);
      return { ...identity, family: classifyFamily(identity, commandTokens) };
    }),
  );
}

export async function findRootReferences(root, invocationId = null) {
  if (process.platform !== "linux") return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const references = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        const identity = await readLinuxProcessIdentity(pid);
        if (!identity) return;
        const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd && underRoot(cwd, root)) {
          references.push({
            pid,
            startTime: identity.startTime,
            kind: "cwd",
            deleted: cwd.endsWith(deletedSuffix),
            family: identity.comm,
          });
          return;
        }
        if (invocationId) {
          const env = await readProcessEnvironment(pid);
          if (env.get("PAPERCLIP_TEST_INVOCATION_ID") !== invocationId) return;
        }
        const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => []);
        for (const fd of fds) {
          const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
          if (target && underRoot(target, root)) {
            references.push({
              pid,
              startTime: identity.startTime,
              kind: "fd",
              deleted: target.endsWith(deletedSuffix),
              family: identity.comm,
            });
            return;
          }
        }
      }),
  );
  return references.sort((a, b) => a.pid - b.pid);
}

export async function signalProcessIdentity(identity, signal) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) return "gone";
  if (process.platform === "linux") {
    const current = await readLinuxProcessIdentity(identity.pid);
    if (!current) return "gone";
    if (current.startTime !== identity.startTime) return "identity_mismatch";
  }
  try {
    process.kill(identity.pid, signal);
    return "signaled";
  } catch (error) {
    if (error?.code === "ESRCH") return "gone";
    throw error;
  }
}

function controlDirectory(env = process.env) {
  const configured = env.PAPERCLIP_TEST_CONTROL_DIR;
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) return path.join(runtime, "paperclip-vitest");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `paperclip-vitest-${uid}`);
}

async function slotOwnerIsAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  if (process.platform === "linux") {
    const current = await readLinuxProcessIdentity(owner.pid);
    return Boolean(current && current.startTime === owner.startTime);
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireReaperLock(reaperLock) {
  const identity = await readLinuxProcessIdentity(process.pid);
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    startTime: identity?.startTime ?? null,
    acquiredAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(reaperLock, { mode: 0o700 });
      try {
        await fs.writeFile(path.join(reaperLock, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      } catch (error) {
        await fs.rm(reaperLock, { recursive: true, force: true });
        throw error;
      }
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const stored = JSON.parse(
      await fs.readFile(path.join(reaperLock, "owner.json"), "utf8").catch(() => "null"),
    );
    const stats = await fs.stat(reaperLock).catch(() => null);
    const ownerWriteMayBeInFlight = !stored && stats && Date.now() - stats.mtimeMs < 5_000;
    if (!stats || ownerWriteMayBeInFlight || (await slotOwnerIsAlive(stored))) return false;
    const generation = stored?.token ?? `${stats.dev}-${stats.ino}`;
    const abandoned = `${reaperLock}-abandoned-${generation}`;
    try {
      await fs.rename(reaperLock, abandoned);
      await fs.writeFile(path.join(abandoned, "tombstone"), `${generation}\n`, { mode: 0o600 });
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOENT"].includes(error?.code)) return false;
      throw error;
    }
  }
  return false;
}

async function reapStaleHostSlot(slot, reaperLock) {
  if (!(await acquireReaperLock(reaperLock))) return false;
  try {
    const stored = JSON.parse(await fs.readFile(path.join(slot, "owner.json"), "utf8").catch(() => "null"));
    const stats = stored ? null : await fs.stat(slot).catch(() => null);
    const ownerWriteMayBeInFlight = stats && Date.now() - stats.mtimeMs < 5_000;
    if (ownerWriteMayBeInFlight || (await slotOwnerIsAlive(stored))) return false;
    await fs.rm(slot, { recursive: true, force: true });
    return true;
  } finally {
    await fs.rm(reaperLock, { recursive: true, force: true });
  }
}

export async function acquireHostSlot({
  invocationId,
  env = process.env,
  cap = positiveInteger(env.PAPERCLIP_TEST_HOST_CAP, DEFAULT_HOST_CAP, "PAPERCLIP_TEST_HOST_CAP"),
  waitMs = positiveInteger(
    env.PAPERCLIP_TEST_HOST_WAIT_MS,
    DEFAULT_HOST_SLOT_WAIT_MS,
    "PAPERCLIP_TEST_HOST_WAIT_MS",
  ),
  signal,
} = {}) {
  const dir = await ensurePrivateDirectory(controlDirectory(env));
  const selfIdentity = await readLinuxProcessIdentity(process.pid);
  const owner = {
    invocationId,
    pid: process.pid,
    startTime: selfIdentity?.startTime ?? null,
    acquiredAt: new Date().toISOString(),
  };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error("Stable test invocation cancelled while waiting for a host slot.");
    for (let index = 0; index < cap; index += 1) {
      const slot = path.join(dir, `slot-${index}`);
      const reaperLock = path.join(dir, `.slot-${index}-reaper`);
      try {
        await fs.mkdir(slot, { mode: 0o700 });
        await fs.writeFile(path.join(slot, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        return {
          index,
          path: slot,
          async release() {
            const stored = JSON.parse(await fs.readFile(path.join(slot, "owner.json"), "utf8").catch(() => "null"));
            if (stored?.invocationId !== invocationId) {
              throw new Error(`Host slot ${index} ownership changed; refusing to remove it.`);
            }
            await fs.rm(slot, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await reapStaleHostSlot(slot, reaperLock);
      }
    }
    await delay(200);
  }
  throw new Error(`Timed out after ${waitMs}ms waiting for a stable-test host slot (cap=${cap}).`);
}

async function createDelegatedCgroup(invocationId) {
  if (process.platform !== "linux") return null;
  try {
    const membership = await fs.readFile("/proc/self/cgroup", "utf8");
    const unified = membership.split("\n").find((line) => line.startsWith("0::"));
    if (!unified) return null;
    const relative = unified.slice(3).replace(/^\/+/, "");
    const parent = path.join("/sys/fs/cgroup", relative);
    const candidate = path.join(parent, `pcvt-${invocationId.slice(0, 12)}`);
    await fs.mkdir(candidate);
    await fs.access(path.join(candidate, "cgroup.procs"), fsConstants.W_OK);
    return candidate;
  } catch {
    return null;
  }
}

function summarizeFamilies(processes) {
  const counts = new Map();
  for (const processInfo of processes) {
    counts.set(processInfo.family, (counts.get(processInfo.family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([family, count]) => ({ family, count }));
}

function structuredRecord(record) {
  console.log(`[test:run] ${JSON.stringify(record)}`);
}

async function writeJsonAtomically(destination, value) {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
      await fs.rm(destination, { force: true });
      await fs.rename(temporary, destination);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function retainWithinLimit(parent, limit) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const retained = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("pcvt-retained-")) continue;
    const absolute = path.join(parent, entry.name);
    const stats = await fs.stat(absolute).catch(() => null);
    if (stats) retained.push({ absolute, mtimeMs: stats.mtimeMs });
  }
  retained.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of retained.slice(limit)) {
    if ((await findRootReferences(stale.absolute)).length === 0) {
      await fs.rm(stale.absolute, { recursive: true, force: true });
    }
  }
}

export class VitestInvocationSupervisor {
  constructor({
    invocationId = randomUUID(),
    label,
    tempParent,
    tempSource = "explicit",
    env = process.env,
    graceMs = positiveInteger(env.PAPERCLIP_TEST_GRACE_MS, DEFAULT_GRACE_MS, "PAPERCLIP_TEST_GRACE_MS"),
    processBudget = positiveInteger(
      env.PAPERCLIP_TEST_PROCESS_BUDGET,
      DEFAULT_PROCESS_BUDGET,
      "PAPERCLIP_TEST_PROCESS_BUDGET",
    ),
    familyBudgets = {
      "embedded-postgres": positiveInteger(env.PAPERCLIP_TEST_MAX_POSTGRES, 128, "PAPERCLIP_TEST_MAX_POSTGRES"),
      ssh: positiveInteger(env.PAPERCLIP_TEST_MAX_SSH, 64, "PAPERCLIP_TEST_MAX_SSH"),
      "model-adapter": positiveInteger(
        env.PAPERCLIP_TEST_MAX_MODEL_ADAPTERS,
        64,
        "PAPERCLIP_TEST_MAX_MODEL_ADAPTERS",
      ),
    },
    timeoutMs = env.PAPERCLIP_TEST_TIMEOUT_MS
      ? positiveInteger(env.PAPERCLIP_TEST_TIMEOUT_MS, null, "PAPERCLIP_TEST_TIMEOUT_MS")
      : null,
    disableCgroup = false,
  }) {
    this.invocationId = invocationId;
    this.label = label;
    this.tempParent = tempParent;
    this.tempSource = tempSource;
    this.baseEnv = env;
    this.graceMs = graceMs;
    this.processBudget = processBudget;
    this.familyBudgets = familyBudgets;
    this.timeoutMs = timeoutMs;
    this.disableCgroup = disableCgroup;
    this.root = null;
    this.child = null;
    this.childIdentity = null;
    this.processGroupId = null;
    this.cgroupPath = null;
    this.containmentMode = process.platform === "win32" ? "windows-process-tree" : "posix-process-group+tagged-proc";
    this.stopReason = null;
    this.peakDescendants = 0;
    this.termCount = 0;
    this.killCount = 0;
    this.identityMismatches = [];
    this.observedProcesses = new Map();
    this.cleanupPromise = null;
    this.guardian = null;
    this.runnerIdentity = null;
    this.startedAt = Date.now();
  }

  async initialize() {
    if (this.root) return;
    this.root = await fs.mkdtemp(path.join(this.tempParent, `pcvt-${process.pid}-`));
    this.runnerIdentity = await readLinuxProcessIdentity(process.pid);
    await fs.mkdir(path.join(this.root, "h"), { recursive: true });
    await fs.mkdir(path.join(this.root, "t"), { recursive: true });
    if (!this.disableCgroup) {
      this.cgroupPath = await createDelegatedCgroup(this.invocationId);
      if (this.cgroupPath) this.containmentMode = "cgroup-v2";
    }
    await this.writeRegistry("starting");
    await this.startGuardian();
  }

  get childEnv() {
    if (!this.root) throw new Error("Supervisor is not initialized.");
    return {
      ...this.baseEnv,
      NODE_ENV: "test",
      PAPERCLIP_HOME: path.join(this.root, "h"),
      PAPERCLIP_INSTANCE_ID: `vt-${this.invocationId.replaceAll("-", "").slice(0, 16)}`,
      PAPERCLIP_TEST_INVOCATION_ID: this.invocationId,
      PAPERCLIP_TEST_FILE: this.label,
      TMPDIR: path.join(this.root, "t"),
    };
  }

  get registryPath() {
    return path.join(this.tempParent, ".pcvt-invocations", `${this.invocationId}.json`);
  }

  get guardianStopPath() {
    return path.join(path.dirname(this.registryPath), `${this.invocationId}.guardian-stop`);
  }

  async startGuardian() {
    if (process.platform !== "linux" || this.guardian) return;
    const ownerIdentity = this.runnerIdentity ?? await readLinuxProcessIdentity(process.pid);
    if (!ownerIdentity) return;
    this.guardian = spawn(
      process.execPath,
      [
        guardianScript,
        "--owner-pid", String(process.pid),
        "--owner-start-time", ownerIdentity.startTime,
        "--invocation-id", this.invocationId,
        "--root", this.root,
        "--registry", this.registryPath,
        "--stop-file", this.guardianStopPath,
        "--grace-ms", String(this.graceMs),
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
        },
      },
    );
    this.guardian.once("error", () => {
      this.guardian = null;
    });
    this.guardian.unref();
  }

  async stopGuardian() {
    if (!this.guardian) return;
    await fs.writeFile(this.guardianStopPath, "stop\n", { mode: 0o600 });
    if (this.guardian.exitCode === null && this.guardian.signalCode === null) {
      this.guardian.ref();
      await Promise.race([
        new Promise((resolve) => this.guardian.once("close", resolve)),
        delay(2_000),
      ]);
    }
    if (this.guardian.exitCode === null && this.guardian.signalCode === null) {
      this.guardian.kill("SIGKILL");
    }
    await fs.rm(this.guardianStopPath, { force: true });
    this.guardian = null;
  }

  async writeRegistry(status) {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const record = {
      invocationId: this.invocationId,
      label: this.label,
      runnerPid: process.pid,
      runnerStartTime: this.runnerIdentity?.startTime ?? null,
      childPid: this.child?.pid ?? null,
      childStartTime: this.childIdentity?.startTime ?? null,
      processGroupId: this.processGroupId,
      cgroupPath: this.cgroupPath,
      tempRoot: this.root,
      tempSource: this.tempSource,
      containmentMode: this.containmentMode,
      peakDescendants: this.peakDescendants,
      status,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomically(this.registryPath, record);
  }

  async ownedProcesses() {
    const [invocationProcesses, cgroup, processGroup, descendants] = await Promise.all([
      listInvocationProcesses(this.invocationId, this.root),
      listCgroupProcesses(this.cgroupPath),
      listProcessGroupProcesses(this.processGroupId),
      listProcessDescendants(this.child?.pid),
    ]);
    const byIdentity = new Map();
    for (const processInfo of [...invocationProcesses, ...cgroup, ...processGroup, ...descendants]) {
      const key = `${processInfo.pid}:${processInfo.startTime}`;
      byIdentity.set(key, processInfo);
      this.observedProcesses.set(key, processInfo);
    }
    for (const [key, processInfo] of this.observedProcesses) {
      if (byIdentity.has(key)) continue;
      const current = await readLinuxProcessIdentity(processInfo.pid);
      if (current?.startTime === processInfo.startTime) {
        byIdentity.set(key, { ...processInfo, ...current });
      } else {
        this.observedProcesses.delete(key);
      }
    }
    return [...byIdentity.values()].filter((processInfo) => processInfo.pid !== process.pid);
  }

  async observeDescendants() {
    const descendants = await listProcessDescendants(this.child?.pid);
    const childIdentity = await readLinuxProcessIdentity(this.child?.pid);
    if (childIdentity) {
      const commandTokens = await readProcessCommandTokens(childIdentity.pid);
      descendants.push({
        ...childIdentity,
        family: classifyFamily(childIdentity, commandTokens),
      });
    }
    for (const processInfo of descendants) {
      this.observedProcesses.set(`${processInfo.pid}:${processInfo.startTime}`, processInfo);
    }
    const observed = [];
    for (const [key, processInfo] of this.observedProcesses) {
      const current = await readLinuxProcessIdentity(processInfo.pid);
      if (current?.startTime === processInfo.startTime) {
        observed.push({ ...processInfo, ...current });
      } else {
        this.observedProcesses.delete(key);
      }
    }
    return observed;
  }

  async attachContainment() {
    if (!this.child?.pid) return;
    this.childIdentity = await readLinuxProcessIdentity(this.child.pid);
    this.processGroupId = process.platform === "win32" ? null : this.child.pid;
    if (this.cgroupPath) {
      try {
        await fs.writeFile(path.join(this.cgroupPath, "cgroup.procs"), `${this.child.pid}\n`);
      } catch {
        await fs.rmdir(this.cgroupPath).catch(() => undefined);
        this.cgroupPath = null;
        this.containmentMode = "posix-process-group+tagged-proc";
      }
    }
    await this.writeRegistry("running");
  }

  async run(command, args, { cwd = process.cwd(), timeoutMs = this.timeoutMs } = {}) {
    await this.initialize();
    const child = spawn(command, args, {
      cwd,
      env: this.childEnv,
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.attachContainment();
    structuredRecord({
      event: "vitest_invocation_start",
      invocationId: this.invocationId,
      label: this.label,
      tempRoot: this.root,
      childPid: child.pid ?? null,
      childStartTime: this.childIdentity?.startTime ?? null,
      processGroupId: this.processGroupId,
      containmentMode: this.containmentMode,
      processBudget: this.processBudget,
      familyBudgets: this.familyBudgets,
    });

    let monitorStopped = false;
    let budgetError = null;
    const monitor = (async () => {
      while (!monitorStopped) {
        const owned = process.platform === "linux"
          ? await this.observeDescendants()
          : await this.ownedProcesses();
        this.peakDescendants = Math.max(this.peakDescendants, owned.length);
        const families = summarizeFamilies(owned);
        const familyViolation = families.find(
          ({ family, count }) => this.familyBudgets[family] && count > this.familyBudgets[family],
        );
        if ((owned.length > this.processBudget || familyViolation) && !budgetError) {
          const violation = familyViolation
            ? `${familyViolation.family} ${familyViolation.count}/${this.familyBudgets[familyViolation.family]}`
            : `total ${owned.length}/${this.processBudget}`;
          budgetError = new Error(
            `Process budget exceeded for invocation ${this.invocationId} (${this.label}): ${violation}; ` +
              `total=${owned.length}/${this.processBudget}; largest families=${JSON.stringify(families)}.`,
          );
          this.requestStop("process_budget_exceeded");
        }
        await delay(200);
      }
    })();
    let timeout;
    if (timeoutMs) {
      timeout = setTimeout(() => this.requestStop(`timeout_after_${timeoutMs}ms`), timeoutMs);
      timeout.unref?.();
    }

    const result = await new Promise((resolve) => {
      let spawnError = null;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => resolve({ code, signal, error: spawnError }));
    });
    if (timeout) clearTimeout(timeout);
    monitorStopped = true;
    await monitor;
    if (budgetError) throw budgetError;
    return { ...result, stopReason: this.stopReason };
  }

  requestStop(reason) {
    this.stopReason ??= reason;
    void this.terminateBoundary();
  }

  async signalOwned(signal) {
    const owned = await this.ownedProcesses();
    let count = 0;
    let groupSignaled = false;
    if (
      process.platform !== "win32" &&
      this.processGroupId &&
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      let groupIdentityMatches = true;
      if (process.platform === "linux" && this.childIdentity) {
        const current = await readLinuxProcessIdentity(this.processGroupId);
        const groupStillOwned = owned.some(
          (processInfo) => processInfo.processGroupId === this.processGroupId,
        );
        groupIdentityMatches =
          current?.startTime === this.childIdentity.startTime ||
          (!current && groupStillOwned);
      }
      if (groupIdentityMatches) {
        try {
          process.kill(-this.processGroupId, signal);
          count += 1;
          groupSignaled = true;
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
      } else {
        this.identityMismatches.push(this.processGroupId);
      }
    }
    for (const identity of owned) {
      if (groupSignaled && identity.processGroupId === this.processGroupId) continue;
      const outcome = await signalProcessIdentity(identity, signal);
      if (outcome === "signaled") count += 1;
      if (outcome === "identity_mismatch") this.identityMismatches.push(identity.pid);
    }
    if (process.platform === "win32" && this.child?.pid) {
      spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    return count;
  }

  async waitForEmpty(waitMs) {
    const deadline = Date.now() + waitMs;
    let current = await this.ownedProcesses();
    while (current.length > 0 && Date.now() < deadline) {
      await delay(100);
      current = await this.ownedProcesses();
    }
    return current;
  }

  async waitForRootReferences(waitMs) {
    if (!this.root) return [];
    const deadline = Date.now() + waitMs;
    let current = await findRootReferences(this.root, this.invocationId);
    while (current.length > 0 && Date.now() < deadline) {
      await delay(100);
      current = await findRootReferences(this.root, this.invocationId);
    }
    return current;
  }

  async terminateBoundary() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      const before = await this.ownedProcesses();
      if (before.length > 0) {
        this.termCount += await this.signalOwned("SIGTERM");
      }
      let survivors = await this.waitForEmpty(this.graceMs);
      if (survivors.length > 0) {
        this.killCount += await this.signalOwned("SIGKILL");
        survivors = await this.waitForEmpty(Math.max(2_000, Math.floor(this.graceMs / 2)));
      }
      structuredRecord({
        event: "vitest_invocation_stop",
        invocationId: this.invocationId,
        label: this.label,
        reason: this.stopReason ?? "child_exited",
        containmentMode: this.containmentMode,
        peakDescendants: this.peakDescendants,
        termCount: this.termCount,
        killCount: this.killCount,
        survivorCount: survivors.length,
      });
      return survivors;
    })();
    return this.cleanupPromise;
  }

  async cleanup({ retainReason = null, retainedLimit = 3 } = {}) {
    const cleanupStarted = Date.now();
    const survivors = await this.terminateBoundary();
    const references = await this.waitForRootReferences(this.graceMs);
    let invariantFailureReason = null;
    let removed = false;
    if (this.identityMismatches.length > 0) {
      invariantFailureReason = `pid_identity_mismatch:${this.identityMismatches.join(",")}`;
    }
    if (survivors.length > 0) invariantFailureReason ??= "containment_not_empty";
    if (references.length > 0) invariantFailureReason ??= "active_root_reference";
    const retainedArtifactReason = invariantFailureReason ?? retainReason;
    const guardianArmed = Boolean(invariantFailureReason && this.guardian);
    if (!guardianArmed) await this.stopGuardian();

    if (this.root && retainReason && !invariantFailureReason) {
      const retained = path.join(
        this.tempParent,
        `pcvt-retained-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${this.invocationId.slice(0, 8)}`,
      );
      await fs.rename(this.root, retained);
      this.root = retained;
      await retainWithinLimit(this.tempParent, retainedLimit);
    } else if (this.root && !retainedArtifactReason) {
      await fs.rm(this.root, { recursive: true, force: true });
      removed = true;
    }

    if (this.cgroupPath) {
      await fs.rmdir(this.cgroupPath).catch(() => undefined);
    }
    if (!guardianArmed && !invariantFailureReason) {
      await fs.rm(this.registryPath, { force: true });
    }
    const cleanupDurationMs = Date.now() - cleanupStarted;
    structuredRecord({
      event: "vitest_invocation_cleanup",
      invocationId: this.invocationId,
      label: this.label,
      containmentMode: this.containmentMode,
      peakDescendants: this.peakDescendants,
      cleanupDurationMs,
      termCount: this.termCount,
      killCount: this.killCount,
      survivorCount: survivors.length,
      rootReferenceCount: references.length,
      rootRemoved: removed,
      retainedArtifactReason,
      guardianArmed,
    });
    if (invariantFailureReason) {
      throw new Error(
        `Post-suite invariants failed for ${this.invocationId}: ${invariantFailureReason}; ` +
          `survivors=${survivors.length}, rootReferences=${references.length}. Root was not deleted.`,
      );
    }
    return { survivors, references, removed, retainedArtifactReason, cleanupDurationMs };
  }
}

export async function diagnoseStableInvocations({ env = process.env } = {}) {
  const { parent, source } = await resolveTestTempParent(env);
  const registryDir = path.join(parent, ".pcvt-invocations");
  const entries = await fs.readdir(registryDir).catch(() => []);
  const invocations = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const raw = await fs.readFile(path.join(registryDir, entry), "utf8").catch(() => "null");
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch {
      // Ignore records created by older/non-atomic writers while they are incomplete.
      continue;
    }
    if (!record?.invocationId) continue;
    const processes = await listTaggedProcesses(record.invocationId);
    const rootReferences = record.tempRoot
      ? await findRootReferences(record.tempRoot, record.invocationId)
      : [];
    const runnerIdentity = await readLinuxProcessIdentity(record.runnerPid);
    const runnerAlive = process.platform === "linux"
      ? Boolean(runnerIdentity && runnerIdentity.startTime === record.runnerStartTime)
      : null;
    invocations.push({
      invocationId: record.invocationId,
      label: record.label,
      runnerPid: record.runnerPid,
      childPid: record.childPid,
      containmentMode: record.containmentMode,
      tempRoot: record.tempRoot,
      processCount: processes.length,
      processFamilies: summarizeFamilies(processes),
      rootReferenceCount: rootReferences.length,
      deletedCwdCount: rootReferences.filter((reference) => reference.kind === "cwd" && reference.deleted).length,
      runnerAlive,
      stale: runnerAlive === false && processes.length > 0,
      status: record.status,
      updatedAt: record.updatedAt,
    });
  }
  return { tempParent: parent, tempSource: source, invocationCount: invocations.length, invocations };
}

export async function reapStaleStableInvocations({ env = process.env } = {}) {
  const report = await diagnoseStableInvocations({ env });
  const reaped = [];
  const refused = [];
  for (const invocation of report.invocations) {
    if (invocation.runnerAlive !== false) continue;
    if (invocation.processCount > 0 || invocation.rootReferenceCount > 0) {
      refused.push({
        invocationId: invocation.invocationId,
        reason: "live_process_or_root_reference",
        processCount: invocation.processCount,
        rootReferenceCount: invocation.rootReferenceCount,
      });
      continue;
    }
    const resolvedRoot = path.resolve(invocation.tempRoot);
    if (
      path.dirname(resolvedRoot) !== report.tempParent ||
      !path.basename(resolvedRoot).startsWith("pcvt-")
    ) {
      refused.push({ invocationId: invocation.invocationId, reason: "unsafe_root_path" });
      continue;
    }
    await fs.rm(resolvedRoot, { recursive: true, force: true });
    await fs.rm(path.join(report.tempParent, ".pcvt-invocations", `${invocation.invocationId}.json`), {
      force: true,
    });
    reaped.push(invocation.invocationId);
  }
  return { ...report, reaped, refused };
}
