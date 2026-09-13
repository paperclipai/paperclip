import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

export type RemoteRecoveryIdentity = {
  runId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
};

type RemoteProcess = {
  nonce: string;
  pid: number;
  startedAt: string;
  startTicks: string | null;
};

export type RemoteRunnerRecovery = {
  identity: RemoteRecoveryIdentity;
  stateDirectory: string;
  lifecycle: string;
  process: RemoteProcess;
  alive: boolean;
};

// The sandbox already needs Node for work-folder transfers. Return only the
// binding and process fingerprint, never the PRP journal or provider output.
// Every read is bounded, rejects symlinks, and pins an opened regular file.
export const REMOTE_RECOVERY_PROBE = String.raw`
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const request = JSON.parse(process.argv[1]);
const dir = request.stateDirectory;
assert(path.isAbsolute(dir) && path.normalize(dir) === dir && fs.realpathSync(dir) === dir);
function read(file, limit) {
  assert(fs.realpathSync(path.dirname(file)) === path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.size <= limit);
    const data = Buffer.alloc(limit + 1); let length = 0, count;
    do { count = fs.readSync(fd, data, length, data.length - length, null); length += count; } while (count && length < data.length);
    assert(length <= limit); return data.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
const marker = read(path.join(dir, 'runner-process.identity'), 4096).trim().split('\n');
assert(marker.length === 4);
const [nonce, rawPid, startedAt, runnerId] = marker;
const pid = Number(rawPid);
assert(/^[0-9a-f-]{36}$/.test(nonce) && Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(Date.parse(startedAt)));
assert.equal(runnerId, request.identity.runnerInstanceId);
let alive = false, startTicks = null;
try {
  process.kill(pid, 0);
  const stat = read('/proc/' + pid + '/stat', 65536);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  startTicks = fields[19]; assert(/^\d+$/.test(startTicks));
  alive = fields[0] !== 'Z' && fields[0] !== 'X';
  if (alive) {
    const args = read('/proc/' + pid + '/cmdline', 65536).split('\0');
    function flag(name, expected) { const index = args.indexOf(name); assert(index >= 0 && args[index + 1] === expected); }
    flag('--runner-id', runnerId); flag('--state-dir', dir);
    // run.attach rotates the durable run binding on a warm process. Its
    // original --run-id is not the current authority; runner-state proves it.
    flag('--session-id', request.identity.normalizedSessionId);
    flag('--environment-lease-id', request.identity.environmentLeaseId);
  }
} catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; alive = false; }
const fingerprint = { nonce, pid, startedAt, startTicks };
if (request.process) {
  for (const key of ['nonce', 'pid', 'startedAt']) assert.equal(fingerprint[key], request.process[key]);
  if (alive) assert.equal(startTicks, request.process.startTicks);
}
let lifecycle;
if (request.mode === 'state') {
  const state = JSON.parse(read(path.join(dir, 'runner-state.json'), 16 * 1024 * 1024));
  assert.equal(state.schema, 'paperclip.runner.durable.state.v1');
  for (const [key, value] of Object.entries(request.identity)) assert.equal(state[key], value);
  lifecycle = state.lifecycle;
}
if (request.signal && alive) {
  assert(['SIGTERM', 'SIGINT', 'SIGKILL'].includes(request.signal));
  process.kill(pid, request.signal);
}
console.log(JSON.stringify({ identity: request.identity, stateDirectory: dir, lifecycle, process: fingerprint, alive }));
`;

async function probe(
  runner: CommandManagedRuntimeRunner,
  request: {
    identity: RemoteRecoveryIdentity;
    stateDirectory: string;
    mode: "state" | "process";
    process?: RemoteProcess;
    signal?: NodeJS.Signals;
  },
): Promise<RemoteRunnerRecovery> {
  const result = await runner.execute({
    command: "node",
    args: ["-e", REMOTE_RECOVERY_PROBE, JSON.stringify(request)],
    bypassSession: true,
    timeoutMs: 10_000,
  }).catch((cause: unknown) => {
    throw new Error("runner_remote_recovery_unavailable", { cause });
  });
  if (result.timedOut) throw new Error("runner_remote_recovery_unavailable");
  if (result.exitCode !== 0 || result.stdout.length > 8192) {
    throw new Error("runner_remote_recovery_unverified");
  }
  let value: RemoteRunnerRecovery;
  try { value = JSON.parse(result.stdout); } catch {
    throw new Error("runner_remote_recovery_unverified");
  }
  if (value.stateDirectory !== request.stateDirectory ||
    !value.identity || Object.entries(request.identity).some(([k, v]) => value.identity[k as keyof RemoteRecoveryIdentity] !== v) ||
    typeof value.alive !== "boolean" || !value.process ||
    !Number.isSafeInteger(value.process.pid) || value.process.pid <= 0 ||
    typeof value.process.nonce !== "string" ||
    !Number.isFinite(Date.parse(value.process.startedAt))) {
    throw new Error("runner_remote_recovery_unverified");
  }
  return value;
}

export async function verifyRemoteRunnerRecovery(input: {
  runner: CommandManagedRuntimeRunner;
  identity: RemoteRecoveryIdentity;
  stateDirectory: string;
}): Promise<RemoteRunnerRecovery> {
  const result = await probe(input.runner, {
    identity: input.identity, stateDirectory: input.stateDirectory, mode: "state",
  });
  // An unconfirmed dead executor can leave provider children alive. Only a
  // durably suspended executor authorizes a fresh process; a live executor
  // must be adopted and prove its existing PRP credentials before any work.
  if ((!result.alive && result.lifecycle !== "suspended") ||
    !["connecting", "ready", "backpressure", "recoverable_failure", "suspended"].includes(result.lifecycle)) {
    throw new Error("runner_remote_recovery_unverified");
  }
  return result;
}

export function adoptVerifiedRemoteRunner(
  runner: CommandManagedRuntimeRunner,
  evidence: RemoteRunnerRecovery,
) {
  if (!evidence.alive) throw new Error("runner_remote_recovery_unverified");
  let pending: Promise<boolean> | undefined;
  let lastAliveAt = 0;
  return {
    pid: evidence.process.pid,
    processGroupId: null,
    startedAt: evidence.process.startedAt,
    isAlive: () => {
      // Both startup and the process monitor ask for liveness. Coalesce them
      // and cap remote probes at one per second, with one RPC in flight.
      if (Date.now() - lastAliveAt < 1000) return Promise.resolve(true);
      pending ??= probe(runner, { ...evidence, mode: "process" })
        .then((result) => { if (result.alive) lastAliveAt = Date.now(); return result.alive; })
        .finally(() => { pending = undefined; });
      return pending;
    },
    signal: async (signal: NodeJS.Signals) => {
      const result = await probe(runner, { ...evidence, mode: "process", signal });
      lastAliveAt = 0;
      return result.alive;
    },
  };
}
