/** Fixed Linux program. No argv/env/command text is inspected from other processes. */
export const runtimeServiceProcessHandoffSource = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ticks = /^[1-9][0-9]{0,19}$/;
const positivePid = value => Number.isSafeInteger(value) && value > 1;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameBoot = (a, b) => a.bootId === b.bootId && a.initStartTicks === b.initStartTicks && a.uid === b.uid;
const fail = action => { throw Object.assign(new Error(), { code: action === 'capture' ? 'PROCESS_OWNERSHIP_UNVERIFIED' : 'PROCESS_HANDOFF_UNVERIFIED' }); };
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
async function row(pid) {
  try {
    const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const status = await fs.readFile('/proc/' + pid + '/status', 'utf8');
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
    if (!uid || !ticks.test(fields[19] || '')) fail('stop');
    const ids = uid.slice(1).map(Number);
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), state: fields[0], identity: fields[19], uid: ids[0], sameUid: ids.every(id => id === ids[0]) };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
const live = process => process && process.state !== 'Z' && process.state !== 'X';
async function table() {
  const pids = (await fs.readdir('/proc')).filter(value => /^[1-9][0-9]*$/.test(value));
  if (pids.length > 16384) fail('stop');
  const rows = new Map();
  // Bound concurrent proc reads rather than exhausting descriptors and then
  // mistaking failed observations for absent processes.
  for (let offset = 0; offset < pids.length; offset += 32) {
    for (const process of await Promise.all(pids.slice(offset, offset + 32).map(value => row(Number(value))))) {
      if (process) rows.set(process.pid, process);
    }
  }
  return rows;
}
function descendant(rows, pid, ancestor) {
  for (let depth = 0; depth < 256; depth++) {
    const process = rows.get(pid);
    if (!process || process.parent <= 1 || process.parent === pid) return false;
    if (process.parent === ancestor) return true;
    pid = process.parent;
  }
  return false;
}
function inside(root, cwd) {
  const relative = path.relative(root, cwd);
  return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
}
async function boot() {
  const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const init = await row(1);
  if (!uuid.test(bootId) || !init) fail('stop');
  return { bootId, initStartTicks: init.identity, uid: process.getuid() };
}
function validOwner(owner) {
  return exact(owner, ['version', 'pid', 'uid', 'processGroupId', 'bootId', 'startTicks'])
    && owner.version === 1 && positivePid(owner.pid) && positivePid(owner.processGroupId)
    && Number.isSafeInteger(owner.uid) && owner.uid >= 0
    && typeof owner.bootId === 'string' && uuid.test(owner.bootId)
    && typeof owner.startTicks === 'string' && ticks.test(owner.startTicks);
}
function validReceipt(receipt, scope) {
  return exact(receipt, ['version', 'scope', 'boot', 'groupId', 'leaderIdentity', 'members'])
    && receipt.version === 1 && exact(receipt.scope, ['companyId', 'environmentId', 'providerLeaseId'])
    && Object.keys(scope).every(key => receipt.scope[key] === scope[key])
    && exact(receipt.boot, ['bootId', 'initStartTicks', 'uid'])
    && typeof receipt.boot.bootId === 'string' && uuid.test(receipt.boot.bootId)
    && typeof receipt.boot.initStartTicks === 'string' && ticks.test(receipt.boot.initStartTicks)
    && Number.isSafeInteger(receipt.boot.uid) && receipt.boot.uid >= 0
    && positivePid(receipt.groupId) && typeof receipt.leaderIdentity === 'string' && ticks.test(receipt.leaderIdentity)
    && Array.isArray(receipt.members) && receipt.members.length > 0 && receipt.members.length <= 512
    && receipt.members.every(member => exact(member, ['pid', 'identity']) && positivePid(member.pid) && typeof member.identity === 'string' && ticks.test(member.identity))
    && new Set(receipt.members.map(member => member.pid)).size === receipt.members.length
    && receipt.members.some(member => member.pid === receipt.groupId && member.identity === receipt.leaderIdentity);
}
async function capture(input, scope) {
  const owner = input.owner;
  if (!validOwner(owner) || !positivePid(input.sourcePid) || typeof input.cwd !== 'string' || typeof input.workspaceRoot !== 'string'
    || !path.isAbsolute(input.cwd) || !path.isAbsolute(input.workspaceRoot) || input.workspaceRoot === '/') fail('capture');
  const kernel = await boot();
  if (owner.bootId !== kernel.bootId || owner.uid !== kernel.uid) fail('capture');
  const before = await table();
  function check(rows) {
    const root = rows.get(owner.pid), command = rows.get(input.sourcePid);
    if (!live(root) || !live(command) || root.identity !== owner.startTicks || root.uid !== owner.uid || !root.sameUid
      || root.group !== owner.processGroupId || command.uid !== owner.uid || !command.sameUid
      || command.pid === root.pid || command.group !== command.pid || command.group === root.group
      || !descendant(rows, command.pid, root.pid)) fail('capture');
    const members = [...rows.values()].filter(process => live(process) && process.group === command.group);
    if (!members.length || members.length > 512 || members.some(process => process.uid !== owner.uid || !process.sameUid
      || (process.pid !== command.pid && !descendant(rows, process.pid, command.pid)))) fail('capture');
    return { command, members };
  }
  const original = check(before);
  const [cwd, workspaceRoot, actual] = await Promise.all([fs.realpath(input.cwd), fs.realpath(input.workspaceRoot), fs.readlink('/proc/' + input.sourcePid + '/cwd')]);
  if (!inside(workspaceRoot, cwd) || actual !== cwd) fail('capture');
  const final = check(await table());
  if (original.members.length !== final.members.length || original.members.some(member => !final.members.some(current =>
    current.pid === member.pid && current.identity === member.identity && current.parent === member.parent))) fail('capture');
  if (await fs.readlink('/proc/' + input.sourcePid + '/cwd') !== cwd || !sameBoot(await boot(), kernel)) fail('capture');
  const receipt = { version: 1, scope, boot: kernel, groupId: final.command.pid, leaderIdentity: final.command.identity,
    members: final.members.map(process => ({ pid: process.pid, identity: process.identity })).sort((a, b) => a.pid - b.pid) };
  return { state: 'captured', key: digest({ scope, boot: kernel, groupId: receipt.groupId, leaderIdentity: receipt.leaderIdentity }), receipt };
}
async function stop(input, scope) {
  const receipt = input.receipt;
  if (!validReceipt(receipt, scope) || !sameBoot(receipt.boot, await boot())) fail('stop');
  async function remaining() {
    const rows = await table();
    for (const member of receipt.members) {
      const current = rows.get(member.pid);
      if (live(current) && current.identity === member.identity && current.group !== receipt.groupId) fail('stop');
    }
    const members = [...rows.values()].filter(process => live(process) && process.group === receipt.groupId);
    if (!members.length) return false;
    const leader = rows.get(receipt.groupId);
    const sameLeader = live(leader) && leader.identity === receipt.leaderIdentity;
    for (const member of members) {
      if (member.uid !== receipt.boot.uid || !member.sameUid) fail('stop');
      const known = receipt.members.find(original => original.pid === member.pid && original.identity === member.identity);
      if (!known && !(sameLeader && descendant(rows, member.pid, receipt.groupId))) fail('stop');
    }
    return true;
  }
  async function signal(name) {
    // Sample again immediately before signalling the numeric process group.
    if (!await remaining()) return;
    try { process.kill(-receipt.groupId, name); } catch (error) { if (error.code !== 'ESRCH') fail('stop'); }
  }
  if (!await remaining()) return { state: 'stopped' };
  await signal('SIGTERM');
  for (let attempt = 0; attempt < 60; attempt++) { if (!await remaining()) return { state: 'stopped' }; await sleep(50); }
  await signal('SIGKILL');
  for (let attempt = 0; attempt < 40; attempt++) { if (!await remaining()) return { state: 'stopped' }; await sleep(50); }
  fail('stop');
}
(async () => {
  let input;
  try {
    const encoded = process.env.PAPERCLIP_PROCESS_HANDOFF;
    delete process.env.PAPERCLIP_PROCESS_HANDOFF;
    if (!encoded || encoded.length > 128 * 1024) fail('capture');
    input = JSON.parse(encoded);
    if (process.platform !== 'linux') throw Object.assign(new Error(), { code: 'PROCESS_HANDOFF_UNAVAILABLE' });
    const scope = input.scope;
    if (!exact(scope, ['companyId', 'environmentId', 'providerLeaseId']) || !Object.values(scope).every(value => typeof value === 'string' && uuid.test(value))) fail('capture');
    if (input.action !== 'capture' && input.action !== 'stop') fail('capture');
    process.stdout.write(JSON.stringify(await (input.action === 'capture' ? capture(input, scope) : stop(input, scope))));
  } catch (error) {
    const allowed = ['PROCESS_OWNERSHIP_UNVERIFIED', 'PROCESS_HANDOFF_UNVERIFIED', 'PROCESS_HANDOFF_UNAVAILABLE'];
    const errorCode = allowed.includes(error.code) ? error.code : input && input.action === 'stop' ? 'PROCESS_HANDOFF_UNVERIFIED' : 'PROCESS_OWNERSHIP_UNVERIFIED';
    process.stdout.write(JSON.stringify({ state: 'failed', errorCode }));
    process.exitCode = 1;
  }
})();
`;
