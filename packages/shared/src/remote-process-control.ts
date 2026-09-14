export type RemoteProcessControlOperation =
  | { action: "inspect" }
  | { action: "signal"; signal: "SIGINT" | "SIGTERM" | "SIGKILL" }
  | { action: "stop_group" };
export type RemoteProcessControlState = "running" | "exited" | "mismatch" | "signalled" | "stopped" | "unverified";

/** Runs through the original provider connection. A sandbox file or command
 * line is never an identity authority. stop_group covers only this process
 * group, not provider children that created another group or session. */
export const remoteProcessControlSource = String.raw`
const fs = require('node:fs/promises');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = value => value && value.state !== 'Z' && value.state !== 'X';
const fail = () => { throw new Error('unverified'); };
async function read(pid) {
  try {
    const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const status = await fs.readFile('/proc/' + pid + '/status', 'utf8');
    const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    if (!match || !/^[1-9][0-9]{0,19}$/.test(fields[19] || '')) fail();
    return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
      session: Number(fields[3]), start: fields[19], uids: match.slice(1).map(Number) };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
async function execute(input) {
  const owner = input.owner;
  if (process.platform !== 'linux' || !owner || owner.version !== 1
    || Object.keys(owner).sort().join(',') !== 'bootId,pid,processGroupId,startTicks,uid,version'
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 1 || owner.pid === process.pid
    || !Number.isSafeInteger(owner.processGroupId) || owner.processGroupId <= 1
    || !Number.isSafeInteger(owner.uid) || owner.uid < 0 || owner.uid !== process.getuid()
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner.bootId)
    || !/^[1-9][0-9]{0,19}$/.test(owner.startTicks)) fail();
  async function sameBoot() {
    return (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() === owner.bootId;
  }
  async function inspect() {
    if (!await sameBoot()) return 'mismatch';
    const current = await read(owner.pid);
    if (!live(current)) return 'exited';
    return current.start === owner.startTicks && current.group === owner.processGroupId
      && current.uids.every(uid => uid === owner.uid) ? 'running' : 'mismatch';
  }
  const operation = input.operation;
  if (!operation || !['inspect', 'signal', 'stop_group'].includes(operation.action)) fail();
  const observed = await inspect();
  if (operation.action === 'inspect') return observed;
  if (operation.action === 'signal') {
    if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(operation.signal)) fail();
    if (observed !== 'running') return observed;
    // Re-read kernel identity directly before signalling. Never follow a
    // marker to another PID and never signal a group for ordinary cancellation.
    const checked = await inspect();
    if (checked !== 'running') return checked;
    try { process.kill(owner.pid, operation.signal); }
    catch (error) { if (error.code === 'ESRCH') return 'exited'; throw error; }
    return 'signalled';
  }
  if (owner.processGroupId !== owner.pid || observed === 'mismatch') fail();
  const known = new Map();
  async function remaining() {
    if (!await sameBoot()) fail();
    const pids = (await fs.readdir('/proc')).filter(value => /^[1-9][0-9]*$/.test(value));
    if (pids.length > 16384) fail();
    const rows = new Map();
    for (let offset = 0; offset < pids.length; offset += 32) {
      for (const row of await Promise.all(pids.slice(offset, offset + 32).map(value => read(Number(value))))) {
        if (row) rows.set(row.pid, row);
      }
    }
    for (const [pid, identity] of known) {
      const row = rows.get(pid);
      if (live(row) && row.start === identity && row.group !== owner.processGroupId) fail();
    }
    const members = [...rows.values()].filter(row => live(row) && row.group === owner.processGroupId);
    if (members.length > 512) fail();
    const root = rows.get(owner.pid);
    const sameRoot = live(root) && root.start === owner.startTicks && root.session === owner.pid;
    function descendant(row) {
      for (let depth = 0; depth < 256; depth++) {
        if (row.pid === owner.pid) return true;
        row = rows.get(row.parent);
        if (!row) return false;
      }
      return false;
    }
    for (const member of members) {
      if (!member.uids.every(uid => uid === owner.uid) || member.session !== owner.pid
        || (known.get(member.pid) !== member.start && !(sameRoot && descendant(member)))) fail();
      known.set(member.pid, member.start);
    }
    return members.length > 0;
  }
  async function signalGroup(signal) {
    if (!await remaining()) return;
    try { process.kill(-owner.processGroupId, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (!await remaining()) return 'stopped';
  await signalGroup('SIGTERM');
  for (let attempt = 0; attempt < 60; attempt++) { if (!await remaining()) return 'stopped'; await sleep(50); }
  await signalGroup('SIGKILL');
  for (let attempt = 0; attempt < 40; attempt++) { if (!await remaining()) return 'stopped'; await sleep(50); }
  fail();
}
(async () => {
  try {
    const encoded = process.env.PAPERCLIP_REMOTE_PROCESS_CONTROL;
    delete process.env.PAPERCLIP_REMOTE_PROCESS_CONTROL;
    if (!encoded || encoded.length > 2048) fail();
    process.stdout.write(JSON.stringify({ state: await execute(JSON.parse(encoded)) }));
  } catch { process.stdout.write(JSON.stringify({ state: 'unverified' })); process.exitCode = 1; }
})();
`;

/** Only the bounded response for this specific operation grants its result. */
export function parseRemoteProcessControlResponse(stdout: string, operation: RemoteProcessControlOperation): RemoteProcessControlState {
  if (stdout.length > 128) return "unverified";
  try {
    const response = JSON.parse(stdout) as { state?: unknown };
    const allowed = operation.action === "inspect" ? ["running", "exited", "mismatch"]
      : operation.action === "signal" ? ["signalled", "exited", "mismatch"] : ["stopped"];
    return response && Object.keys(response).join(",") === "state" && allowed.includes(String(response.state))
      ? response.state as RemoteProcessControlState : "unverified";
  } catch { return "unverified"; }
}
