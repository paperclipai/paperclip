import { afterEach, describe, expect, it } from "vitest";
import { stripTypeScriptTypes } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readlink, mkdtemp, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeHealthResponse, processScalar, parseObserverDiagnostic, type ProcessScalar, type PeerObservation } from "../scripts/diagnostic-observer/diagnostic-target-observer.js";

/** Existing PR Runner Vitest source plus observed public-pr-x64 job metadata.
 * These context signals are not independent AWS qualification: the final CI
 * receipt must also bind the actual job/fleet identity and non-skipped counts. */
function remoteContext(env: NodeJS.ProcessEnv, platform: string, arch: string, version: string) {
  return platform === "linux" && arch === "x64" && /^v24\./.test(version)
    && env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "paperclipai/paperclip"
    && env.GITHUB_WORKFLOW === "PR" && env.GITHUB_EVENT_NAME === "pull_request"
    && /^Verify Paperclip Runner \(vitest [12]\/2\)$/.test(env.PAPERCLIP_CI_PROFILE_JOB ?? "")
    && /^runs-on--i-[a-f0-9]{17}--[a-f0-9]{8}-[a-z0-9]+$/.test(env.RUNNER_NAME ?? "");
}
const eligible = remoteContext(process.env, process.platform, process.arch, process.version);
const requireRemote = () => { if (!eligible) throw new Error("Observer real probes require the existing Node24 Linux AWS PR Runner lane"); };
const knownContext = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_WORKFLOW: "PR", GITHUB_EVENT_NAME: "pull_request",
  PAPERCLIP_CI_PROFILE_JOB: "Verify Paperclip Runner (vitest 2/2)", RUNNER_NAME: "runs-on--i-0835cd942d0d95657--6023f02a-e" };
it("pure context guard accepts only the source/metadata-bound remote lane, never a local override", () => {
  expect(remoteContext(knownContext, "linux", "x64", "v24.1.0")).toBe(true);
  for (const change of [{ GITHUB_ACTIONS: undefined }, { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_WORKFLOW: "Release" }, { GITHUB_EVENT_NAME: "workflow_call" },
    { PAPERCLIP_CI_PROFILE_JOB: "Verify Paperclip Runner (rust)" }, { RUNNER_NAME: "self-hosted" }, { RUNNER_NAME: "github-hosted" }])
    expect(remoteContext({ ...knownContext, ...change }, "linux", "x64", "v24.1.0")).toBe(false);
  expect(remoteContext(knownContext, "darwin", "arm64", "v24.1.0")).toBe(false);
  expect(remoteContext(knownContext, "linux", "x64", "v22.1.0")).toBe(false);
  expect(remoteContext({ PAPERCLIP_OBSERVER_FORCE_LOCAL: "true" }, "linux", "x64", "v24.1.0")).toBe(false);
});

// Fixture code is written/executed only inside the remote suite. The target
// returns 503 without an application delay. Synchronous observer work adds
// measured request-start overhead; no un-instrumented latency is claimed.
const serverProgram = `import http from 'node:http';
const server=http.createServer((_req,res)=>{res.statusCode=503;res.end('unavailable');});
server.listen(0,'127.0.0.1',()=>process.send({kind:'ready',pid:process.pid,port:server.address().port}));
process.on('message',m=>{if(m?.kind==='close'){server.close(()=>process.disconnect());server.closeAllConnections();}});
`;
const clientProgram = `import http from 'node:http';
const port=Number(process.argv[2]), keep=process.argv[3]==='keepalive';
const agent=keep?new http.Agent({keepAlive:true}):false;
const request=http.get({host:'127.0.0.1',port,path:'/api/health',agent},res=>{const status=res.statusCode;res.resume();res.on('end',()=>{if(keep)process.send({kind:'received',status});else process.exitCode=status===503?0:1;});});
request.setTimeout(5000,()=>request.destroy());request.on('error',()=>{process.exitCode=1;if(keep)process.disconnect();});
if(keep){const timer=setTimeout(()=>{agent.destroy();process.disconnect();},5000);process.on('message',m=>{if(m?.kind==='close'){clearTimeout(timer);agent.destroy();process.disconnect();}});}
`;
interface ProviderChild {
  pid?: number; connected?: boolean; exitCode: number | null; signalCode: string | null;
  send(value: { kind: "close" }): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
  once(event: "close" | "error", listener: () => void): unknown;
}
/** Exact direct ChildProcess ownership, independent of optional scalar capture.
 * Serialized into the fixture provider; pure tests inject only events/timers. */
function providerChildren(io: { schedule(cb: () => void, ms: number): unknown; cancel(timer: unknown): void; empty(): void; unknown(): void }) {
  const children = new Set<ProviderChild>(), timers: unknown[] = []; let closing = false, emptied = false;
  const completed = () => {
    if (!closing || children.size || emptied) return;
    emptied = true; for (const timer of timers) io.cancel(timer); io.empty();
  };
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { child.kill(value); } catch { /* No close receipt: remain unknown. */ } }
  };
  return {
    track(child: ProviderChild) {
      if (closing) throw new Error("Provider cannot admit another client while draining");
      children.add(child);
      child.once("close", () => { children.delete(child); completed(); });
      child.once("error", () => { /* Error is not evidence that an owned process closed. */ });
    },
    drain() {
      if (closing) return;
      closing = true;
      if (!children.size) { completed(); return; }
      timers.push(io.schedule(() => signal("SIGTERM"), 500), io.schedule(() => signal("SIGKILL"), 1000),
        io.schedule(() => { if (children.size) io.unknown(); }, 1500));
      for (const child of children) {
        try { if (child.connected) child.send({ kind: "close" }); else if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
        catch { /* Phased exact-handle signals follow; only close proves drain. */ }
      }
    },
  };
}
function registerProviderClient(child: ProviderChild, owner: { track(child: ProviderChild): void }, identify: (pid: number | undefined) => unknown, emit: (value: unknown) => void) {
  owner.track(child);
  try { emit({ kind: "client", identity: identify(child.pid) }); }
  catch { emit({ kind: "client-identity-unavailable" }); }
}
function providerProgram(observerUrl: string) { return `import {spawn} from 'node:child_process';
import {readFileSync,readlinkSync} from 'node:fs';
import {processScalar} from ${JSON.stringify(observerUrl)};
const client=process.argv[2],hz=Number(process.argv[3]);let closing=false;
const lifecycle=(${providerChildren.toString()} )({schedule:(cb,ms)=>setTimeout(cb,ms),cancel:t=>clearTimeout(t),
empty:()=>{if(process.connected)process.send({kind:'children-empty'},()=>process.disconnect());},
unknown:()=>{if(process.connected)process.send({kind:'children-drain-unknown'});}});
function scalar(pid){return processScalar(pid,readFileSync('/proc/'+pid+'/stat','utf8'),readFileSync('/proc/'+pid+'/status','utf8'),readFileSync('/proc/stat','utf8'),hz,readlinkSync('/proc/'+pid+'/ns/net'));}
process.on('message',m=>{if(m?.kind==='close'){closing=true;lifecycle.drain();return;}
 if(closing||m?.kind!=='request'||!['node','curl','keepalive'].includes(m.mode)||!Number.isInteger(m.port)||m.port<1||m.port>65535)return;
 const keep=m.mode==='keepalive';
 const c=m.mode==='curl'?spawn('/usr/bin/curl',['--disable','--silent','--output','/dev/null','--max-time','5','--no-keepalive','http://127.0.0.1:'+m.port+'/api/health'],{env:{},stdio:'ignore'}):spawn(process.execPath,[client,String(m.port),keep?'keepalive':'short'],{env:{},stdio:keep?['ignore','ignore','ignore','ipc']:'ignore'});
 (${registerProviderClient.toString()})(c,lifecycle,scalar,m=>process.send(m));
 c.on('message',r=>{if(r?.kind==='received'&&Number.isInteger(r.status))process.send({kind:'received',status:r.status});});
 c.once('error',()=>process.send({kind:'client-error'}));
 c.once('exit',code=>{if(process.connected)process.send({kind:'done',code});});
});
process.send({kind:'ready',pid:process.pid});
`; }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface Owned { child: ChildProcess; identity: ProcessScalar; messages: unknown[] }
const directChildren = new Set<ChildProcess>();
const privateRoots = new Set<string>();
function cleanupCustody<T>() {
  const pendingProviders = new Map<T, string>(), retainedRoots = new Set<string>();
  return {
    pending(provider: T, root: string) { pendingProviders.set(provider, root); },
    drained(provider: T) { pendingProviders.delete(provider); },
    retain(root: string) { retainedRoots.add(root); },
    canStop(provider: T) { return !pendingProviders.has(provider); },
    canRemove(root: string) { return !retainedRoots.has(root) && ![...pendingProviders.values()].includes(root); },
    unresolved() { return pendingProviders.size > 0 || retainedRoots.size > 0; },
  };
}
const persistentCustody = cleanupCustody<ChildProcess>();
async function finishOwnedCleanup<T>(custody: ReturnType<typeof cleanupCustody<T>>, children: Set<T>, roots: Set<string>, stop: (child: T) => Promise<void>, remove: (root: string) => Promise<void>, unknown = false) {
  for (const child of [...children]) {
    if (!custody.canStop(child)) { unknown = true; continue; }
    try { await stop(child); } catch { unknown = true; }
  }
  if (unknown || custody.unresolved()) {
    for (const root of roots) custody.retain(root);
    throw new Error("Owned cleanup remains unknown; private calibration metadata retained");
  }
  for (const root of [...roots]) {
    if (!custody.canRemove(root)) throw new Error("Owned root remains protected by unresolved cleanup");
    try { await remove(root); roots.delete(root); } catch { custody.retain(root); throw new Error("Owned root cleanup remains unknown; metadata retained"); }
  }
}
async function stopHandle(child: ChildProcess) {
  requireRemote();
  if (!directChildren.has(child) || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 50; i++) { if (child.exitCode !== null || child.signalCode !== null) return; await delay(10); }
  child.kill("SIGKILL");
  for (let i = 0; i < 50; i++) { if (child.exitCode !== null || child.signalCode !== null) return; await delay(10); }
  throw new Error("Exact unreaped owned spawn handle did not close");
}
function rec(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
async function hz() {
  requireRemote();
  // Linux x64 AT_CLKTCK (17), read only that scalar; do not expose auxv contents.
  const bytes = await readFile("/proc/self/auxv");
  for (let i = 0; i + 16 <= bytes.length; i += 16) if (bytes.readBigUInt64LE(i) === 17n) {
    const value = Number(bytes.readBigUInt64LE(i + 8)); if (Number.isSafeInteger(value) && value > 0) return value;
  }
  throw new Error("Actual Linux clock tick scalar unavailable");
}
async function identity(pid: number, ticks: number) {
  requireRemote();
  return processScalar(pid, await readFile(`/proc/${pid}/stat`, "utf8"), await readFile(`/proc/${pid}/status`, "utf8"),
    await readFile("/proc/stat", "utf8"), ticks, await readlink(`/proc/${pid}/ns/net`));
}
async function message(owned: Owned, kind: string) {
  requireRemote(); const end = Date.now() + 5000;
  while (Date.now() < end) {
    const failures = kind === "children-empty" ? ["children-drain-unknown"] : ["client-error", "client-identity-unavailable"];
    const index = owned.messages.findIndex(m => rec(m).kind === kind || failures.includes(String(rec(m).kind)));
    if (index >= 0) { const m = rec(owned.messages.splice(index, 1)[0]); if (m.kind !== kind) throw new Error("Actual spawned client prerequisite failed"); return m; }
    if (owned.child.exitCode !== null) throw new Error("Owned process exited before required scalar receipt");
    await delay(5);
  }
  throw new Error("Owned scalar receipt timed out");
}
async function start(script: string, args: string[], ticks: number, observerConfig?: string, scriptArgs: string[] = []): Promise<Owned> {
  requireRemote();
  const env = observerConfig ? { PAPERCLIP_E2E_DIAGNOSTIC_OBSERVER: observerConfig } : {};
  const child = spawn(process.execPath, [...args, script, ...scriptArgs], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const messages: unknown[] = []; child.on("message", m => messages.push(m)); child.on("error", () => messages.push({ kind: "client-error" }));
  if (!child.pid) throw new Error("Owned fixture process did not start");
  directChildren.add(child); child.once("exit", () => directChildren.delete(child));
  try { return { child, messages, identity: await identity(child.pid, ticks) }; }
  catch {
    // The newly spawned, unreaped direct child is owned by this handle. It has
    // not been allowed to request anything; stop it if identity admission fails.
    await stopHandle(child);
    throw new Error("Owned fixture birth identity unavailable; no request admitted");
  }
}
function scalar(value: unknown): ProcessScalar {
  const r = rec(value), keys = Object.keys(r).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["born", "namespace", "parent", "pid", "ticks", "uid"]) || !Number.isSafeInteger(r.pid) || !Number.isSafeInteger(r.parent) || !Number.isSafeInteger(r.uid)
    || typeof r.born !== "string" || !Number.isFinite(Date.parse(r.born)) || typeof r.ticks !== "string" || !/^\d+$/.test(r.ticks) || typeof r.namespace !== "string" || !/^net:\[\d+\]$/.test(r.namespace)) throw new Error("Malformed process scalar receipt");
  return r as unknown as ProcessScalar;
}
async function observations(output: string): Promise<PeerObservation[]> {
  requireRemote(); const end = Date.now() + 2000;
  while (Date.now() < end) {
    try {
      const meta = await lstat(output);
      if (!meta.isFile() || meta.isSymbolicLink() || meta.uid !== process.getuid?.() || (meta.mode & 0o077) || meta.size > 65536) throw new Error("Observer output is not owned bounded private metadata");
      const bytes = await readFile(output); if (bytes.length !== meta.size || bytes.length > 65536) throw new Error("Observer scalar output bound exceeded");
      const rows: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(rows) || rows.length > 16) throw new Error("Observer scalar inventory invalid");
      return rows.map(value => { const r = rec(value);
        if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(["chain", "finished", "status", "target", "unknown"]) || !Array.isArray(r.chain) || r.chain.length > 64 || r.finished !== true || r.unknown !== false || r.status !== 503) throw new Error("Observer captured unexpected metadata");
        return { target: scalar(r.target), chain: r.chain.map(scalar), finished: true, unknown: false, status: 503 };
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("No real reverse-socket observation within unchanged capture budget");
}
async function diagnosticSnapshot(output: string) {
  try {
    const file = `${output}.diagnostic.json`, meta = await lstat(file);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.uid !== process.getuid?.() || (meta.mode & 0o077) || meta.size > 16384) return { state: "UNAVAILABLE" };
    const bytes = await readFile(file); if (bytes.length !== meta.size || bytes.length > 16384) return { state: "UNAVAILABLE" };
    const diagnostic = parseObserverDiagnostic(JSON.parse(bytes.toString("utf8")));
    return diagnostic ? { state: "PRESENT", diagnostic } : { state: "UNAVAILABLE" };
  } catch { return { state: "UNAVAILABLE" }; }
}
interface Fixture { root: string; ticks: number; runner: ProcessScalar; target: Owned; providers: Owned[]; clients: ProcessScalar[]; output: string; port: number }
const ownedFixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  requireRemote(); const ticks = await hz(), root = await mkdtemp(path.join(tmpdir(), "observer-linux-ci-"));
  privateRoots.add(root);
  const observer = new URL("../scripts/diagnostic-observer/diagnostic-target-observer.ts", import.meta.url);
  const preload = fileURLToPath(new URL("../scripts/diagnostic-observer/diagnostic-target-preload.mjs", import.meta.url));
  const output = path.join(root, "observations.json"), armed = path.join(root, "armed"), config = path.join(root, "config.json");
  await writeFile(armed, "armed", { mode: 0o600 }); await writeFile(config, JSON.stringify({ output, armed, hz: ticks }), { mode: 0o600 });
  const serverFile = path.join(root, "server.mjs"), providerFile = path.join(root, "provider.mjs"), clientFile = path.join(root, "client.mjs");
  await writeFile(serverFile, serverProgram, { mode: 0o600 }); await writeFile(providerFile, providerProgram(observer.href), { mode: 0o600 }); await writeFile(clientFile, clientProgram, { mode: 0o600 });
  const runner = await identity(process.pid, ticks), target = await start(serverFile, ["--import", preload], ticks, config);
  const f: Fixture = { root, ticks, runner, target, providers: [], clients: [], output, port: 0 }; ownedFixtures.push(f);
  const ready = await message(target, "ready"); if (ready.pid !== target.identity.pid || !Number.isInteger(ready.port)) throw new Error("Owned server scalar identity mismatch"); f.port = Number(ready.port);
  for (let i = 0; i < 2; i++) {
    // Provider role is an owned ordinary Node parent, not an actual model/agent.
    const p = await start(providerFile, [], ticks, undefined, [clientFile, String(ticks)]);
    f.providers.push(p); await message(p, "ready");
  }
  return f;
}
async function request(f: Fixture, provider: Owned, mode: "node" | "curl" | "keepalive") {
  requireRemote(); provider.child.send({ kind: "request", mode, port: f.port });
  const receipt = await message(provider, "client"), child = scalar(receipt.identity); f.clients.push(child);
  expect(child.parent).toBe(provider.identity.pid); expect(child.uid).toBe(f.runner.uid); expect(child.namespace).toBe(f.runner.namespace);
  if (mode === "keepalive") expect((await message(provider, "received")).status).toBe(503);
  else expect((await message(provider, "done")).code).toBe(0);
  const rows = await observations(f.output), row = rows.find(r => r.chain[0]?.pid === child.pid && r.chain[0].born === child.born);
  if (!row) throw new Error("Actual short-lived client was not captured; no missing-as-pass allowance");
  const snapshot = await diagnosticSnapshot(f.output);
  expect(snapshot.state).toBe("PRESENT");
  if (!("diagnostic" in snapshot) || !snapshot.diagnostic) throw new Error("Owned closed diagnostic snapshot unavailable");
  expect(snapshot.diagnostic.collectorMode).toBe("SYNC_REQUEST_START");
  expect(snapshot.diagnostic.maxElapsedMs).toBeLessThanOrEqual(100);
  expect(snapshot.diagnostic.maxOperations).toBeLessThanOrEqual(8192);
  expect(snapshot.diagnostic.maxRequestStartMs).toBeGreaterThanOrEqual(snapshot.diagnostic.maxElapsedMs);
  return row;
}
const binding = (f: Fixture, provider: Owned) => ({ runnerPid: f.runner.pid, runnerBorn: f.runner.born, providerPid: provider.identity.pid, providerBorn: provider.identity.born, currentRunBound: true });
async function confirmProviderDrain(io: { connected(): boolean; request(): void; receipt(): Promise<{ kind?: unknown }>; disconnect(): Promise<void> }) {
  if (!io.connected()) throw new Error("Provider closed without its children-empty receipt");
  io.request();
  if ((await io.receipt()).kind !== "children-empty") throw new Error("Provider child drain is unproved");
  await io.disconnect();
  if (io.connected()) throw new Error("Provider did not disconnect after child drain");
}
async function providerDisconnected(owned: Owned) {
  requireRemote(); const end = Date.now() + 1000;
  while (owned.child.connected && Date.now() < end) await delay(5);
  if (owned.child.connected) throw new Error("Provider did not disconnect after its children-empty receipt");
}
afterEach(async () => {
  if (!eligible) return;
  let unknownCleanup = false;
  for (const f of ownedFixtures.splice(0).reverse()) {
    // Closed counters only, before any removal, including failed capture/cleanup.
    console.info("OBSERVER_CALIBRATION_DIAGNOSTIC " + JSON.stringify(await diagnosticSnapshot(f.output)));
    for (const p of f.providers) {
      persistentCustody.pending(p.child, f.root);
      try {
        await confirmProviderDrain({ connected: () => p.child.connected, request: () => { p.child.send({ kind: "close" }); },
          receipt: () => message(p, "children-empty"), disconnect: () => providerDisconnected(p) });
        persistentCustody.drained(p.child);
      } catch { unknownCleanup = true; }
    }
    try { if (f.target.child.connected) f.target.child.send({ kind: "close" }); } catch { /* Exact target cleanup follows. */ }

  }
  await finishOwnedCleanup(persistentCustody, directChildren, privateRoots, stopHandle,
    root => rm(root, { recursive: true, force: true }), unknownCleanup);
});

describe.runIf(eligible)("remote-only Node24 Linux AWS observer qualification (helper calibration, not Product E2E)", () => {
  it.each(["node", "curl"] as const)("captures an ordinary short-lived %s client with measured request-start observation work", async mode => {
    const f = await fixture(), row = await request(f, f.providers[0]!, mode);
    expect(nativeHealthResponse(row, binding(f, f.providers[0]!), f.target.identity)).toBe(true);
  }, 20000);
  it("captures a normally completed response on a persistent keepalive connection", async () => {
    const f = await fixture(), row = await request(f, f.providers[0]!, "keepalive");
    expect(nativeHealthResponse(row, binding(f, f.providers[0]!), f.target.identity)).toBe(true);
  }, 20000);
  it("requires real capture before rejecting wrong caller and stale generation", async () => {
    const f = await fixture(), row = await request(f, f.providers[1]!, "keepalive"), actual = binding(f, f.providers[1]!);
    expect(nativeHealthResponse(row, actual, f.target.identity)).toBe(true);
    expect(nativeHealthResponse(row, binding(f, f.providers[0]!), f.target.identity)).toBe(false);
    expect(nativeHealthResponse(row, { ...actual, providerBorn: new Date(Date.parse(actual.providerBorn) + 1).toISOString() }, f.target.identity)).toBe(false);
    expect(nativeHealthResponse(row, actual, { ...f.target.identity, born: new Date(Date.parse(f.target.identity.born) + 1).toISOString() })).toBe(false);
  }, 20000);
});

it("pure fixture programs parse without executing their HTTP/process bodies", () => {
  for (const source of [serverProgram, clientProgram, providerProgram("file:///owned/diagnostic-target-observer.ts")]) {
    expect(() => stripTypeScriptTypes(source, { mode: "strip" })).not.toThrow();
  }
});

function injectedDrain() {
  const callbacks = new Map<string, () => void>(), scheduled = new Map<number, () => void>(), signals: string[] = [];
  let empty = 0, unknown = 0;
  const child: ProviderChild = { connected: false, exitCode: null, signalCode: null,
    send: () => {}, kill: signal => signals.push(signal), once: (event, cb) => callbacks.set(event, cb) };
  const owner = providerChildren({ schedule: (cb, ms) => { scheduled.set(ms, cb); return ms; }, cancel: timer => { scheduled.delete(Number(timer)); },
    empty: () => { empty++; }, unknown: () => { unknown++; } });
  return { owner, child, callbacks, scheduled, signals, counts: () => ({ empty, unknown }) };
}
it("pure drain retains a child whose scalar capture failed until actual close", () => {
  const f = injectedDrain(), emitted: unknown[] = [];
  registerProviderClient(f.child, f.owner, () => { throw new Error("withheld identity details"); }, value => emitted.push(value));
  expect(emitted).toEqual([{ kind: "client-identity-unavailable" }]);
  f.owner.drain(); expect(f.counts()).toEqual({ empty: 0, unknown: 0 });
  f.callbacks.get("error")!(); expect(f.counts().empty).toBe(0);
  f.callbacks.get("close")!(); expect(f.counts()).toEqual({ empty: 1, unknown: 0 }); expect(f.scheduled.size).toBe(0);
});
it("pure missing child close reports unknown and never emits children-empty", () => {
  const f = injectedDrain(); f.owner.track(f.child); f.owner.drain();
  f.scheduled.get(500)!(); f.scheduled.get(1000)!(); f.scheduled.get(1500)!();
  expect(f.signals).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]); expect(f.counts()).toEqual({ empty: 0, unknown: 1 });
  expect(() => f.owner.track(f.child)).toThrow();
});
it("pure drain requires every child close and admits no duplicate close command", () => {
  const f = injectedDrain(), second = injectedDrain(); f.owner.track(f.child); f.owner.track(second.child);
  f.owner.drain(); f.owner.drain(); f.callbacks.get("close")!(); expect(f.counts().empty).toBe(0);
  second.callbacks.get("close")!(); expect(f.counts().empty).toBe(1);
});

it("pure parent drain gate cannot admit termination on missing/unknown receipt or missing disconnect", async () => {
  for (const kind of [undefined, "children-drain-unknown"]) {
    let admitted = false, disconnects = 0;
    await expect(confirmProviderDrain({ connected: () => true, request: () => {}, receipt: async () => ({ kind }), disconnect: async () => { disconnects++; } }).then(() => { admitted = true; })).rejects.toThrow();
    expect(admitted).toBe(false); expect(disconnects).toBe(0);
  }
  await expect(confirmProviderDrain({ connected: () => true, request: () => {}, receipt: async () => ({ kind: "children-empty" }), disconnect: async () => {} })).rejects.toThrow();
  let connected = true, requests = 0;
  await confirmProviderDrain({ connected: () => connected, request: () => { requests++; }, receipt: async () => ({ kind: "children-empty" }), disconnect: async () => { connected = false; } });
  expect(requests).toBe(1);
});

it("pure two-hook custody never kills an earlier unconfirmed provider or removes its retained root", async () => {
  const custody = cleanupCustody<object>(), old = {}, next = {}, children = new Set([old]), roots = new Set(["owned-first"]);
  const stopped: object[] = [], removed: string[] = [];
  const stop = async (child: object) => { stopped.push(child); children.delete(child); }, remove = async (root: string) => { removed.push(root); };
  custody.pending(old, "owned-first");
  await expect(finishOwnedCleanup(custody, children, roots, stop, remove)).rejects.toThrow("Owned cleanup remains unknown");
  expect(stopped).toEqual([]); expect(removed).toEqual([]);
  // A later hook has a new fixture; the old fixture is no longer in its local list.
  children.add(next); roots.add("owned-next"); custody.pending(next, "owned-next"); custody.drained(next);
  await expect(finishOwnedCleanup(custody, children, roots, stop, remove)).rejects.toThrow("Owned cleanup remains unknown");
  expect(stopped).toEqual([next]); expect(children.has(old)).toBe(true); expect(removed).toEqual([]);
  expect(roots.has("owned-first")).toBe(true); expect(custody.canStop(old)).toBe(false); expect(custody.canRemove("owned-first")).toBe(false);
});
it("pure fully drained custody permits only its known handles and owned root cleanup", async () => {
  const custody = cleanupCustody<object>(), child = {}, children = new Set([child]), roots = new Set(["owned"]), removed: string[] = [];
  custody.pending(child, "owned"); custody.drained(child);
  await finishOwnedCleanup(custody, children, roots, async c => { children.delete(c); }, async root => { removed.push(root); });
  expect(children.size).toBe(0); expect(roots.size).toBe(0); expect(removed).toEqual(["owned"]);
});
