import assert from "node:assert/strict";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RemoteRecoveryIdentity } from "./remote-runner-recovery.js";

type Authority = RemoteRecoveryIdentity & { turnId: string; itemId: string };
const object = (value: unknown): Record<string, unknown> => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};

// Only terminal, acknowledged work followed by NEVER DELIVERED shutdown
// controls is recoverable. Keep those controls in the archived host journal;
// do not mark them completed or replay them into the next authority epoch.
export function settledAcpxRecoveryRequest(input: {
  control: unknown;
  identity: Authority;
  providerIdentity: unknown;
  agent: string;
  model: string;
  permissionMode: string;
  stateDirectory: string;
}) {
  const control = object(input.control);
  assert.equal(
    control.schema,
    "paperclip.runner.durable.control-plane-state.v1",
  );
  assert.deepEqual(control.identity, input.identity);
  assert(
    Array.isArray(control.committedEvents) &&
      control.committedEvents.length > 0,
  );
  const last = object(control.committedEvents.at(-1));
  assert.equal(last.eventType, "run.terminal");
  for (const [key, value] of Object.entries(input.identity))
    assert.equal(object(last.envelope)[key], value);
  assert(Number.isSafeInteger(last.sourceSeq) && Number(last.sourceSeq) > 0);
  assert.equal(control.ackedSourceSeq, last.sourceSeq);
  assert(Array.isArray(control.commands) && control.commands.length > 0);
  const deliveryCounts = object(control.commandDeliveryCounts);
  let pending = false;
  const commands = control.commands.map((value, index) => {
    const command = object(value);
    assert.equal(command.controllerSeq, index + 1);
    assert(
      typeof command.commandId === "string" && command.commandId.length > 0,
    );
    assert(typeof command.type === "string");
    if (command.status === "completed") assert(!pending);
    else {
      pending = true;
      assert.equal(command.status, "pending");
      assert(["runner.drain", "runner.suspend"].includes(command.type));
      assert((deliveryCounts[command.commandId] ?? 0) === 0);
    }
    return {
      commandId: command.commandId,
      controllerSeq: index + 1,
      type: command.type,
      status: command.status,
    };
  });
  assert(
    new Set(commands.map((command) => command.commandId)).size ===
      commands.length,
  );
  const completed = commands.filter(
    (command) => command.status === "completed",
  );
  assert(completed.length > 0);
  const providerIdentity = object(input.providerIdentity);
  assert.equal(providerIdentity.kind, "acpx");
  assert.equal(
    providerIdentity.normalizedSessionId,
    input.identity.normalizedSessionId,
  );
  for (const key of ["acpxRecordId", "backendSessionId", "agentSessionId"])
    assert(typeof providerIdentity[key] === "string" && providerIdentity[key]);
  for (const key of ["profileDigest", "workspaceDigest"])
    assert(/^sha256:[0-9a-f]{64}$/.test(String(providerIdentity[key])));
  assert.equal(providerIdentity.requestedModel, input.model);
  assert.equal(providerIdentity.effectiveModel, input.model);
  assert.equal(providerIdentity.permissionMode, input.permissionMode);
  const ports = providerIdentity.providerLifetimeFenceCandidates;
  assert(
    Array.isArray(ports) && ports.length === 3 && new Set(ports).size === 3,
  );
  assert(
    ports.every(
      (port) => Number.isInteger(port) && port >= 49152 && port <= 65535,
    ),
  );
  return {
    identity: input.identity,
    providerIdentity,
    agent: input.agent,
    model: input.model,
    permissionMode: input.permissionMode,
    stateDirectory: input.stateDirectory,
    sourceSeq: last.sourceSeq as number,
    completed,
  };
}

export type SettledAcpxRecoveryProof = {
  runner: string;
  provider: string;
  marker: string;
};

// The provider lifetime fence consists of three TCP PORTS, not PIDs. Holding
// two proves no original provider tree holds its quorum. Keep that quorum
// until both lifecycle records have been rechecked and sealed. Never kill a
// PID or change provider identity or conversation contents to pass this proof.
export const SETTLED_ACPX_RECOVERY_SCRIPT = String.raw`
(async () => {
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const r = JSON.parse(process.argv[1]), dir = r.stateDirectory;
assert(path.isAbsolute(dir) && path.normalize(dir) === dir && fs.realpathSync(dir) === dir);
function read(name, limit) {
  const file = path.join(dir, name);
  assert(fs.realpathSync(path.dirname(file)) === path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.size <= limit);
    const b = Buffer.alloc(limit + 1); let n = 0, count;
    do { count = fs.readSync(fd, b, n, b.length - n, null); n += count; } while (count && n < b.length);
    assert(n <= limit); return b.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
const bytes = { runner: read('runner-state.json', 16*1024*1024), provider: read('acpx-provider-state.json', 16*1024*1024), marker: read('runner-process.identity', 4096) };
const state = JSON.parse(bytes.runner), provider = JSON.parse(bytes.provider);
assert.equal(state.schema, 'paperclip.runner.durable.state.v1');
for (const [key, value] of Object.entries(r.identity)) assert.equal(state[key], value);
assert(['ready', 'suspended'].includes(state.lifecycle));
assert.deepEqual(state.outbox, []); assert.equal(state.pendingTerminalDelivery, null);
assert.equal(state.ackedSourceSeq, r.sourceSeq); assert.equal(state.nextSourceSeq, r.sourceSeq + 1);
assert.equal(state.lastControllerCommandSeq, r.completed.length);
assert.equal(state.compactedThroughControllerSeq, 0);
assert.deepEqual(Object.keys(state.processedCommands).sort(), r.completed.map(c => c.commandId).sort());
for (const command of r.completed) {
  const result = state.processedCommands[command.commandId];
  assert.equal(result.commandId, command.commandId); assert.equal(result.controllerSeq, command.controllerSeq);
  assert.equal(result.commandType, command.type); assert.equal(result.status, 'completed');
}
assert.equal(provider.schema, 'paperclip.runner.acpx-provider-state.v3');
assert(['session_open', 'suspended'].includes(provider.lifecycle));
assert.equal(provider.activeTurnId, null); assert.equal(provider.providerExitUnconfirmed, false);
assert.deepEqual(provider.pendingEvents, []); assert.deepEqual(provider.identity, r.providerIdentity);
for (const [key, value] of Object.entries({ kind:'acpx', provider:'acpx', driver:'acpx_runtime', agent:r.agent, model:r.model, runId:r.identity.runId, normalizedSessionId:r.identity.normalizedSessionId, commandDigest:r.providerIdentity.profileDigest, permissionMode:r.permissionMode })) assert.equal(provider.descriptor[key], value);
const marker = bytes.marker.toString('utf8').trim().split('\n');
assert.equal(marker.length, 4); assert(/^[0-9a-f-]{36}$/.test(marker[0]));
assert(Number.isFinite(Date.parse(marker[2]))); assert.equal(marker[3], r.identity.runnerInstanceId);
const pid = Number(marker[1]); assert(Number.isSafeInteger(pid) && pid > 1);
function gone() {
  let absent = false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; absent = true; }
  assert(absent, 'original runner remains alive');
}
gone();
const listeners = [];
try {
  const ports = r.providerIdentity.providerLifetimeFenceCandidates;
  assert(Array.isArray(ports) && ports.length === 3 && new Set(ports).size === 3);
  for (const port of ports) {
    assert(Number.isInteger(port) && port >= 49152 && port <= 65535);
    const listener = net.createServer();
    const bound = await new Promise((resolve, reject) => {
      listener.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
    });
    if (bound) listeners.push(listener);
    if (listeners.length === 2) break;
  }
  assert.equal(listeners.length, 2, 'original provider lifetime remains active');
  const proof = Object.fromEntries(Object.entries(bytes).map(([key, b]) => [key, crypto.createHash('sha256').update(b).digest('hex')]));
  if (r.seal) assert.deepEqual(proof, r.seal);
  for (const [key, name, limit] of [['runner','runner-state.json',16*1024*1024], ['provider','acpx-provider-state.json',16*1024*1024], ['marker','runner-process.identity',4096]]) assert(read(name, limit).equals(bytes[key]));
  gone();
  function suspend(name, record) {
    if (record.lifecycle === 'suspended') return;
    const temporary = path.join(dir, name + '.' + crypto.randomUUID() + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ ...record, lifecycle:'suspended' })); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, path.join(dir, name));
      const directory = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  if (r.seal) {
    // Seal the inner provider first. A crash between these atomic writes
    // leaves the outer runner unsealed, so normal harness admission still
    // rejects it. A subsequent recovery must obtain fresh proof and quorum.
    // Also finish a prior partial seal with a suspended outer runner.
    suspend('acpx-provider-state.json', provider);
    suspend('runner-state.json', state);
  }
  console.log(JSON.stringify(proof));
} finally { for (const listener of listeners) listener.close(); }
})()
`;

export async function verifyOrSealSettledRemoteAcpx(
  runner: CommandManagedRuntimeRunner,
  request: ReturnType<typeof settledAcpxRecoveryRequest>,
  seal?: SettledAcpxRecoveryProof,
): Promise<SettledAcpxRecoveryProof> {
  const result = await runner.execute({
    command: "node",
    args: [
      "-e",
      SETTLED_ACPX_RECOVERY_SCRIPT,
      JSON.stringify({ ...request, ...(seal ? { seal } : {}) }),
    ],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  // Do not forward remote assertion output: it can contain private state.
  if (result.exitCode !== 0 || result.timedOut || result.stdout.length > 1024)
    throw new Error("runner_settled_remote_recovery_unverified");
  try {
    const proof = JSON.parse(result.stdout) as SettledAcpxRecoveryProof;
    assert.deepEqual(Object.keys(proof).sort(), [
      "marker",
      "provider",
      "runner",
    ]);
    for (const hash of Object.values(proof))
      assert(/^[0-9a-f]{64}$/.test(hash));
    return proof;
  } catch {
    throw new Error("runner_settled_remote_recovery_unverified");
  }
}
