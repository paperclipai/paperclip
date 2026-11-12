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
  let peer;
  if (process.env.SLACK_FORM_FIXTURE_PEER_ORIGIN) {
    const value = new URL(process.env.SLACK_FORM_FIXTURE_PEER_ORIGIN);
    if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || !value.port
      || value.pathname !== '/' || value.search || value.hash || value.username || value.password
      || pgPorts.has(Number(value.port))) throw new Error('Invalid exact Slack form fixture peer');
    peer = `127.0.0.1:${Number(value.port)}`;
  }
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
  // Passive scalar counters only: no packet contents or authority changes.
  let pgConnectAttempts = 0, pgConnects = 0, pgCloses = 0, pgWriteCalls = 0;
  let outboundRequests = 0, nonPgConnectAttempts = 0;
  let activeWindow = null;
  const closedWaiters = new Set();
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
    if (port && !pgTargets.has(`${host}:${Number(port)}`) && !listeners.has(Number(port)) && `${host}:${Number(port)}` !== peer) fail(host, port);
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
    module[name] = function (...args) { checkArgs(args); outboundRequests += 1; return Reflect.apply(original, this, args); };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    checkArgs(normalized);
    const first = normalized[0];
    const port = typeof first === 'object' ? first.port : first;
    if (pgPorts.has(Number(port))) pgConnectAttempts += 1;
    if (pgPorts.has(Number(port)) && !observed.has(this)) {
      observed.add(this);
      this.once('connect', () => {
        sockets.add(this); pgConnects += 1;
        peakPgSockets = Math.max(peakPgSockets, sockets.size);
        if (activeWindow) activeWindow.peakPgSockets = Math.max(activeWindow.peakPgSockets, sockets.size);
      });
      this.once('close', () => {
        if (sockets.delete(this)) pgCloses += 1;
        if (!sockets.size) for (const settled of [...closedWaiters]) settled();
      });
    }
    if (!pgPorts.has(Number(port))) nonPgConnectAttempts += 1;
    return Reflect.apply(connect, this, args);
  };
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (...args) {
    if (observed.has(this)) pgWriteCalls += 1;
    return Reflect.apply(write, this, args);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) {
    const first = args[0];
    const host = first && typeof first === 'object' ? first.hostname || first.host || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
    const port = first && typeof first === 'object' ? first.port : first;
    if (`${host}:${Number(port)}` === peer) fail(host, port);
    checkArgs(args); return Reflect.apply(tlsConnect, this, args);
  };
  const fetch = globalThis.fetch;
  if (fetch) globalThis.fetch = function (input, init) {
    checkArgs([input instanceof Request ? input.url : input]);
    outboundRequests += 1;
    return fetch(input, init);
  };
  const wireSnapshot = () => ({ pid: process.pid, observedAt: Date.now(), pgConnectAttempts, pgConnects, pgCloses,
    pgWriteCalls, outboundRequests, nonPgConnectAttempts, livePgSockets: sockets.size });
  const waitForPgSocketsClosed = timeoutMs => new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error('Original settlement budget exhausted')); return; }
    if (!sockets.size) { resolve(); return; }
    let timer;
    const settled = () => { if (sockets.size) return; clearTimeout(timer); closedWaiters.delete(settled); resolve(); };
    closedWaiters.add(settled);
    timer = setTimeout(() => { closedWaiters.delete(settled); reject(new Error('Used PG sockets did not close within original settlement budget')); }, timeoutMs);
  });
  const beginWireWindow = () => {
    if (activeWindow || sockets.size) throw new Error('Quiet wire window requires actual PG closure');
    activeWindow = { before: wireSnapshot(), peakPgSockets: sockets.size };
    return activeWindow.before;
  };
  const endWireWindow = () => {
    if (!activeWindow) throw new Error('Missing quiet wire window');
    const after = wireSnapshot(), before = activeWindow.before;
    const result = { before, after, peakPgSockets: activeWindow.peakPgSockets,
      pgWriteCalls: after.pgWriteCalls - before.pgWriteCalls, pgConnectAttempts: after.pgConnectAttempts - before.pgConnectAttempts,
      pgConnects: after.pgConnects - before.pgConnects, pgCloses: after.pgCloses - before.pgCloses,
      outboundRequests: after.outboundRequests - before.outboundRequests, nonPgConnectAttempts: after.nonPgConnectAttempts - before.nonPgConnectAttempts };
    activeWindow = null;
    return result;
  };
  const stats = () => ({ pid: process.pid, peakPgSockets, remainingPgSockets: sockets.size, unexpectedAttempts: attempts.slice(), wire: wireSnapshot() });
  process[key] = Object.freeze({ pid: process.pid, stats, wireSnapshot, waitForPgSocketsClosed, beginWireWindow, endWireWindow });
  globalThis[key] = process[key];
  process.env.SLACK_GATE_GUARD_PID = String(process.pid);
  record({ phase: 'repository-preload', pid: process.pid });
  process.on('exit', () => record({ phase: 'exit', ...stats(), exitCode: process.exitCode || 0 }));
}
