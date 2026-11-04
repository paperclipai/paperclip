#!/opt/paperclip-runner/provider-pack/node_modules/node/bin/node
// Deterministic Codex protocol fixture; actual process execution/containment is real.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.115.0 (cloud-stop fixture)'); process.exit(0); }
const root = process.cwd();
const statePath = join(root, '.cloud-stop-fixture.json');
const effectPath = join(root, '.cloud-stop-forbidden-effect');
const releasePath = join(root, '.cloud-stop-observer-release');
let threadId = `cloud-stop-${randomUUID()}`, turnId, child, interrupted = false;
const turns = new Map();
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const save = extra => writeFileSync(statePath, JSON.stringify({ providerPid: process.pid, threadId, turnId, cwd: root, effectPath, releasePath, ...extra }), { mode: 0o600 });
const completed = status => { turns.set(turnId, status); send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } }); };
async function run() {
  save({ phase: 'awaiting-observer', effectPresent: existsSync(effectPath) });
  const deadline = Date.now() + 60000;
  while (!existsSync(join(root, '.cloud-stop-start')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (!existsSync(join(root, '.cloud-stop-start'))) throw new Error('cloud_stop_observer_not_armed');
  const itemId = `progress-${turnId}`;
  send({ method: 'item/started', params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', phase: 'commentary', text: '' } } });
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: 'CLOUD-STOP-STREAM: real sandbox process is starting. ' } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: itemId, type: 'agentMessage', phase: 'commentary', text: 'CLOUD-STOP-STREAM: real sandbox process is starting.' } } });
  child = spawn('/bin/sh', ['-c', 'sleep 60; printf forbidden > "$1"', 'cloud-stop-owned-child', effectPath], { cwd: root, stdio: 'ignore', detached: true });
  const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  const identity = { pid: child.pid, ppid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19], bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  save({ phase: 'sleeping', startedAtMs: Date.now(), child: identity, interrupted: false });
  send({ method: 'item/started', params: { threadId, turnId, item: { id: `command-${turnId}`, type: 'commandExecution', command: 'sleep 60', status: 'inProgress', cwd: root } } });
  child.on('exit', () => {
    if (interrupted) return;
    save({ phase: 'natural-completion', child: identity, effectPresent: existsSync(effectPath) });
    send({ method: 'item/completed', params: { threadId, turnId, item: { id: `command-${turnId}`, type: 'commandExecution', command: 'sleep 60', status: 'completed', exitCode: 0 } } });
    completed('completed');
  });
}
async function interrupt(id) {
  interrupted = true;
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  save({ ...state, phase: 'interrupted-child-retired', interrupted: true, interruptedAtMs: Date.now(), effectPresent: existsSync(effectPath) });
  // Bound observer synchronization in this simulated provider's cleanup only.
  // The real controller/Stop/lease lifecycle receives no special hooks.
  const deadline = Date.now() + 5000;
  while (!existsSync(releasePath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  send({ id, result: {} });
  send({ method: 'item/completed', params: { threadId, turnId, item: { id: `command-${turnId}`, type: 'commandExecution', command: 'sleep 60', status: 'interrupted', exitCode: null } } });
  completed('interrupted');
}
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: { user: { sessionId: threadId } } });
  else if (['thread/start', 'thread/resume', 'thread/read'].includes(method)) {
    if (params.threadId) threadId = params.threadId;
    send({ id, result: { model: params.model ?? 'gpt-5.4', modelProvider: 'fixture', thread: { id: threadId, sessionId: threadId, status: { type: [...turns.values()].includes('inProgress') ? 'active' : 'idle' }, turns: [...turns].map(([id, status]) => ({ id, status })) } } });
  } else if (method === 'thread/turns/list') send({ id, result: { data: [...turns].map(([id, status]) => ({ id, status, items: [], itemsView: 'notLoaded' })), nextCursor: null } });
  else if (method === 'turn/start') {
    turnId = randomUUID(); turns.set(turnId, 'inProgress');
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    const hello = JSON.stringify(params.input).includes('Respond only with hello. Do not use tools or inspect files.');
    setTimeout(() => {
      if (hello) { send({ method: 'item/completed', params: { threadId, turnId, item: { id: `hello-${turnId}`, type: 'agentMessage', text: 'hello' } } }); completed('completed'); }
      else void run().catch(() => { process.stderr.write('cloud_stop_fixture_start_failed\n'); process.exitCode = 1; completed('failed'); });
    }, 50);
  } else if (method === 'turn/interrupt') void interrupt(id).catch(() => { process.stderr.write('cloud_stop_fixture_interrupt_failed\n'); process.exitCode = 1; });
  else send({ id, result: {} });
});
