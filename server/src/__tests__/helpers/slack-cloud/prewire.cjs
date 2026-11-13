const key = Symbol.for('paperclip.slack.fixture.prewire');
if (!process[key]) {
  const net = require('node:net');
  const tls = require('node:tls');
  const http = require('node:http');
  const https = require('node:https');
  const fs = require('node:fs');
  const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const listeners = new Set();
  const pgTargets = new Set();
  const pgPorts = new Set([5432, 55448]);
  for (const name of ['PAPERCLIP_SLACK_TEST_DATABASE_URL', 'SLACK_EVENT_TEST_DATABASE_URL']) {
    if (!process.env[name]) continue;
    let url;
    try { url = new URL(process.env[name]); } catch { throw new Error('Invalid Slack fixture database target'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopback.has(url.hostname)
      || !/^[a-zA-Z0-9_]+_test$/.test(decodeURIComponent(url.pathname.slice(1)))
      || ['options', 'database', 'dbname'].some(k => url.searchParams.has(k))) throw new Error('Invalid Slack fixture database target');
    const port = Number(url.port || 5432);
    pgPorts.add(port);
    pgTargets.add(`${url.hostname}:${port}`);
  }
  const sockets = new Set();
  const observed = new WeakSet();
  const attempts = [];
  let peakPgSockets = 0;
  const record = value => {
    if (process.env.SLACK_GATE_PROCESS_LOG) fs.appendFileSync(process.env.SLACK_GATE_PROCESS_LOG, JSON.stringify(value) + '\n');
  };
  const fail = (host, port) => {
    attempts.push({ host: String(host), port: Number(port) || null });
    process.exitCode = 98;
    throw new Error('Slack fixture blocked an unowned network target before transport');
  };
  const check = (host = 'localhost', port, protocol) => {
    host = String(host).toLowerCase();
    if (!loopback.has(host)) fail(host, port);
    if (protocol && !['http:', 'https:'].includes(protocol)) fail(host, port);
    if (port && pgPorts.has(Number(port)) && !pgTargets.has(`${host}:${Number(port)}`)) fail(host, port);
    if (port && !pgTargets.has(`${host}:${Number(port)}`) && !listeners.has(Number(port))) fail(host, port);
  };
  const checkArgs = args => {
    const first = args[0];
    if (first instanceof URL || typeof first === 'string' && /^https?:/.test(first)) {
      const url = first instanceof URL ? first : new URL(first);
      check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), url.protocol);
    } else if (first && typeof first === 'object') {
      if (first.path && !first.port && !first.host && !first.hostname) fail('unix-socket', 0);
      check(first.hostname || first.host, first.port, first.protocol);
    } else if (typeof first === 'number') check(typeof args[1] === 'string' ? args[1] : undefined, first);
    else fail('unknown-target', 0);
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    this.once('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object' && loopback.has(address.address)) {
        listeners.add(address.port);
        this.once('close', () => listeners.delete(address.port));
      }
    });
    return Reflect.apply(listen, this, args);
  };
  for (const module of [http, https]) for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function (...args) { checkArgs(args); return Reflect.apply(original, this, args); };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    checkArgs(normalized);
    const first = normalized[0];
    const port = typeof first === 'object' ? first.port : first;
    if (pgPorts.has(Number(port)) && !observed.has(this)) {
      observed.add(this);
      this.once('connect', () => { sockets.add(this); peakPgSockets = Math.max(peakPgSockets, sockets.size); });
      this.once('close', () => sockets.delete(this));
    }
    return Reflect.apply(connect, this, args);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) { checkArgs(args); return Reflect.apply(tlsConnect, this, args); };
  const fetch = globalThis.fetch;
  if (fetch) globalThis.fetch = function (input, init) {
    checkArgs([input instanceof Request ? input.url : input]);
    return fetch(input, init);
  };
  const stats = () => ({ pid: process.pid, peakPgSockets, remainingPgSockets: sockets.size, unexpectedAttempts: attempts.slice() });
  process[key] = Object.freeze({ pid: process.pid, stats });
  globalThis[key] = process[key];
  process.env.SLACK_GATE_GUARD_PID = String(process.pid);
  record({ phase: 'repository-preload', pid: process.pid });
  process.on('exit', () => record({ phase: 'exit', ...stats(), exitCode: process.exitCode || 0 }));
}
