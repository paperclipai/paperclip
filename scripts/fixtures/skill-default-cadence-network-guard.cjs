// Test preload: follows the qualified Slack prewire and MCP canonical guard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), tls = require('node:tls'), http = require('node:http'), https = require('node:https'), dns = require('node:dns');
const { createHash } = require('node:crypto');
const { threadId, isMainThread } = require('node:worker_threads');
const key = Symbol.for('paperclip.skill.default-cadence.prewire');
const log = process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_LOG;
if (!log) throw new Error('Default cadence preload requires an explicit guard log');
if (globalThis[key]) { if (globalThis[key].log !== log) throw new Error('Default cadence guard log changed'); return; }
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const listeners = new Set(), endpoints = new Set(), pgEndpoints = new Set(), attempts = [], active = new Set();
const tracked = new WeakSet(); let peak = 0;
const identity = 'skill-default-cadence-guard-v1';
const sourceHash = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const record = (event, value = {}) => fs.appendFileSync(log, JSON.stringify({ event, identity, sourceHash, pid: process.pid, ppid: process.ppid, threadId, isMainThread, uid: process.getuid?.(), at: Date.now(), ...value }) + '\n');
const deny = reason => { attempts.push(reason); process.exitCode = 98; record('blocked', { reason }); throw new Error(`Default cadence guard blocked ${reason} before transport`); };
const local = host => { if (!loopback.has(String(host).toLowerCase())) deny(`offhost ${host}`); };
function allowOrigin(value) {
  const url = new URL(value); local(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') deny('invalid owned HTTP origin');
  endpoints.add(`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`);
}
function allowDatabase(value) {
  const url = new URL(value); local(url.hostname);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1)))
    || ['options', 'database', 'dbname'].some(k => url.searchParams.has(k))) deny('invalid dedicated database');
  const endpoint = `${url.hostname}:${url.port || 5432}`; endpoints.add(endpoint); pgEndpoints.add(endpoint);
}
for (const name of ['PAPERCLIP_SKILL_DEFAULT_CADENCE_TEST_DATABASE_URL', 'PAPERCLIP_SKILL_DEFAULT_CADENCE_CLOUD_TEST_DATABASE_URL', 'DATABASE_URL']) if (process.env[name]) allowDatabase(process.env[name]);
for (const value of JSON.parse(process.env.PAPERCLIP_SKILL_DEFAULT_CADENCE_GUARD_ORIGINS || '[]')) allowOrigin(value);
function check(host = 'localhost', port, protocol) {
  local(host);
  if (protocol && !['http:', 'https:'].includes(protocol)) deny(`protocol ${protocol}`);
  if (!port || !endpoints.has(`${host}:${port}`) && !listeners.has(Number(port))) deny(`unowned loopback ${host}:${port}`);
}
function checkArgs(args) {
  if (Array.isArray(args[0])) return checkArgs(args[0]);
  const first = args[0];
  if (first instanceof URL || typeof first === 'string' && /^https?:/.test(first)) {
    const url = first instanceof URL ? first : new URL(first); check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), url.protocol);
    if (args[1] && typeof args[1] === 'object') {
      const override = args[1]; if (override.hostname || override.host) check(override.hostname || override.host, override.port || url.port || (url.protocol === 'https:' ? 443 : 80), override.protocol || url.protocol);
    }
  } else if (first && typeof first === 'object') {
    if (first.path && !first.port) deny('unowned Unix socket');
    check(first.hostname || first.host, first.port, first.protocol);
  } else if (typeof first === 'number') check(typeof args[1] === 'string' ? args[1] : undefined, first);
  else deny('unknown connection arguments');
}
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  this.once('listening', () => { const address = this.address(); if (address && typeof address === 'object' && loopback.has(address.address)) {
    listeners.add(address.port); this.once('close', () => listeners.delete(address.port));
  } });
  return Reflect.apply(listen, this, args);
};
for (const module of [http, https]) for (const name of ['request', 'get']) {
  const original = module[name]; module[name] = function(...args) { checkArgs(args); return Reflect.apply(original, this, args); };
}
for (const module of [dns, dns.promises]) for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) if (typeof module[name] === 'function') {
  const original = module[name]; module[name] = function(...args) { local(args[0]); if (name !== 'lookup') deny(`unowned DNS ${name}`); return Reflect.apply(original, this, args); };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0]; const socketPath = typeof first === 'string' ? first : first?.port ? undefined : first?.path;
  if (socketPath) {
    const expected = path.join(os.tmpdir(), `tsx-${process.getuid?.()}`, `${process.ppid}.pipe`);
    let live = false; try { process.kill(process.ppid, 0); live = true; } catch {}
    if (!live || path.resolve(socketPath) !== path.resolve(expected) || fs.existsSync(expected)) deny('unowned or existing Unix socket');
    record('current-parent-pipe-probe', { path: expected, parent: process.ppid });
    this.once('connect', () => { attempts.push('unexpected parent pipe connection'); process.exitCode = 98; record('blocked', { reason: 'unexpected parent pipe connection' }); this.destroy(); });
    this.once('error', error => {
      if (error.code !== 'ENOENT') { attempts.push(`parent pipe ${error.code}`); process.exitCode = 98; record('blocked', { reason: `parent pipe ${error.code}` }); }
      else record('current-parent-pipe-ENOENT', { path: expected, parent: process.ppid });
    });
    return Reflect.apply(connect, this, args);
  }
  checkArgs(normalized);
  const host = first && typeof first === 'object' ? first.host || first.hostname || 'localhost' : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
  const port = first && typeof first === 'object' ? first.port : first;
  if (pgEndpoints.has(`${host}:${port}`) && !tracked.has(this)) {
    tracked.add(this); this.once('connect', () => { active.add(this); peak = Math.max(peak, active.size); }); this.once('close', () => active.delete(this));
  }
  return Reflect.apply(connect, this, args);
};
const tlsConnect = tls.connect; tls.connect = function(...args) { checkArgs(args); return Reflect.apply(tlsConnect, this, args); };
const fetch = globalThis.fetch; if (fetch) globalThis.fetch = function(input, init) { checkArgs([input instanceof Request ? input.url : input]); return fetch(input, init); };
const exit = process.exit;
process.exit = function(code) { return exit.call(process, attempts.length ? 98 : code); };
const stats = () => ({ loaded: true, identity, sourceHash, pid: process.pid, ppid: process.ppid, threadId, isMainThread, uid: process.getuid?.(), preload: __filename,
  peakPgSockets: peak, remainingPgSockets: active.size, unexpectedAttempts: attempts.slice() });
const state = Object.freeze({ log, stats, allowOrigin, allowDatabase });
globalThis[key] = state; process[key] = state;
record('preloaded', { node: process.version, execPath: process.execPath, preload: __filename });
process.on('exit', () => record('exit', { ...stats(), exitCode: process.exitCode || 0 }));
