import { runtimeServiceLocalHostSource } from "./runtime-service-host.js";

/** Fixed control program. Request data, including credentials, arrives in env. */
export const runtimeServiceRemoteControlSource = `const HOST_SOURCE = ${JSON.stringify(runtimeServiceLocalHostSource)};\n` + String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const input = JSON.parse(process.env.PAPERCLIP_SERVICE_CONTROL);
delete process.env.PAPERCLIP_SERVICE_CONTROL;
const uuid = /^[a-f0-9-]{36}$/i;
if (![input.companyId, input.serviceId, input.generation].every(value => typeof value === 'string' && uuid.test(value))) process.exit(64);
const root = input.testRoot || '/tmp/paperclip-managed-services-v2';
const directory = path.join(root, input.companyId, input.serviceId);
const receiptPath = path.join(directory, input.generation + '.json');
const logPath = path.join(directory, 'output.log');
async function identity(pid) {
  try {
    if (!Number.isInteger(pid) || pid < 2) return null;
    if (process.platform === 'linux') {
      const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
      const init = await fs.readFile('/proc/1/stat', 'utf8');
      return init.slice(init.lastIndexOf(')') + 2).split(' ')[19] + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch { return null; }
}
async function matches(pid, value) { return value != null && await identity(pid) === value; }
async function read() {
  try { return JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (input.processRef && input.processRef.started) throw Object.assign(new Error(), { code: 'IDENTITY_LOST' });
    return null;
  }
}
async function claim(receipt) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = receiptPath + '.' + randomUUID() + '.claim';
  await fs.writeFile(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  try { await fs.link(temp, receiptPath); return true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return false; }
  finally { await fs.unlink(temp); }
}
async function ownsPort(port, childPid) {
  if (process.platform !== 'linux') {
    try {
      const owners = execFileSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/);
      return owners.some(pid => Number(execFileSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8', timeout: 3000 }).trim()) === childPid);
    } catch { return false; }
  }
  const inodes = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const content = await fs.readFile(file, 'utf8').catch(() => '');
    for (const line of content.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && parseInt((fields[1] || '').split(':')[1], 16) === port) inodes.add(fields[9]);
    }
  }
  if (!inodes.size) return false;
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
      // After comm, fields are state, ppid, pgrp. Match the whole managed group.
      const processGroupId = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      if (processGroupId !== childPid) continue;
      for (const fd of await fs.readdir('/proc/' + pid + '/fd')) {
        const link = await fs.readlink('/proc/' + pid + '/fd/' + fd).catch(() => '');
        if (inodes.has(link.replace(/^socket:\[|\]$/g, ''))) return true;
      }
    } catch {}
  }
  return false;
}
async function inspect() {
  const receipt = await read();
  if (!receipt) return { state: 'missing', endpoints: [] };
  if (receipt.state === 'exited' || !await matches(receipt.pid, receipt.identity)) return { state: 'exited', processRef: { generation: input.generation, ports: receipt.ports, started: true }, exitCode: receipt.exitCode, endpoints: [] };
  const endpoints = await Promise.all((input.launch?.endpoints || []).map(async endpoint => {
    const port = receipt.ports[endpoint.name];
    let healthy = false;
    if (port && receipt.childPid && await ownsPort(port, receipt.childPid)) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + endpoint.healthPath, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        healthy = response.status >= 200 && response.status < 400;
        await response.body?.cancel();
      } catch {}
    }
    return { name: endpoint.name, port: port || 0, healthy };
  }));
  return { state: 'running', processRef: { generation: input.generation, ports: receipt.ports, started: true }, endpoints };
}
async function start() {
  const prior = await read();
  if (prior) return inspect();
  if (!input.launch) throw new Error('Missing launch');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const sockets = [];
  const ports = {};
  try {
    for (const endpoint of input.launch.endpoints) {
      const socket = net.createServer();
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(endpoint.port || 0, '0.0.0.0', resolve); });
      sockets.push(socket);
      ports[endpoint.name] = socket.address().port;
    }
  } finally { await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve)))); }
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: input.launch.cwd, HOST: '0.0.0.0', ...input.launch.env };
  for (const endpoint of input.launch.endpoints) env[endpoint.portEnv] = String(ports[endpoint.name]);
  // Execute trusted source directly. Reusable filesystem helpers can be substituted.
  const child = spawn(process.execPath, ['-e', HOST_SOURCE, 'paperclip-service-host', receiptPath, logPath], { cwd: input.launch.cwd, env: { PATH: env.PATH }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ generation: input.generation, ports, command: input.launch.command, cwd: input.launch.cwd, env, secrets: input.launch.secretKeys.map(key => env[key]).filter(Boolean) }));
  await spawned;
  child.unref();
  for (let n = 0; n < 100; n++) {
    const receipt = await read();
    if (receipt) return inspect();
    if (child.exitCode !== null) throw new Error('Supervisor failed');
    await sleep(25);
  }
  child.kill('SIGTERM');
  throw new Error('Supervisor deadline');
}
async function stop() {
  let receipt = await read();
  if (!receipt) {
    if (await claim({ generation: input.generation, ports: {}, pid: 0, identity: 'cancelled', childPid: null, childIdentity: null, state: 'exited', exitCode: null })) return { state: 'exited' };
    receipt = await read();
  }
  if (await matches(receipt.pid, receipt.identity)) {
    try { process.kill(receipt.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let n = 0; n < 100; n++) {
    if (!await matches(receipt.pid, receipt.identity) && !await matches(receipt.childPid, receipt.childIdentity)) return { state: 'exited' };
    await sleep(50);
  }
  if (await matches(receipt.childPid, receipt.childIdentity)) process.kill(-receipt.childPid, 'SIGKILL');
  if (await matches(receipt.pid, receipt.identity)) process.kill(receipt.pid, 'SIGKILL');
  await sleep(100);
  if (await matches(receipt.pid, receipt.identity) || await matches(receipt.childPid, receipt.childIdentity)) throw new Error('Termination unverified');
  return { state: 'exited' };
}
async function logs() {
  const limit = Math.max(1, Math.min(Number(input.limitBytes) || 65536, 131072));
  let handle;
  try {
    handle = await fs.open(logPath, 'r');
    const size = (await handle.stat()).size;
    const data = Buffer.alloc(Math.min(size, limit));
    const result = await handle.read(data, 0, data.length, Math.max(0, size - limit));
    return { state: 'exited', logs: data.subarray(0, result.bytesRead).toString('utf8') };
  } catch (error) { if (error.code === 'ENOENT') return { state: 'exited', logs: '' }; throw error; }
  finally { await handle?.close(); }
}
async function main() {
  if (input.action === 'start') return start();
  if (input.action === 'inspect' || input.action === 'endpoint') return inspect();
  if (input.action === 'stop') return stop();
  if (input.action === 'logs') return logs();
  throw new Error('Unsupported operation');
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(error => {
  process.stdout.write(JSON.stringify({ error: ['EADDRINUSE', 'ENOENT', 'IDENTITY_LOST'].includes(error.code) ? error.code : 'SERVICE_OPERATION_FAILED' }));
  process.exitCode = 1;
});
`;
