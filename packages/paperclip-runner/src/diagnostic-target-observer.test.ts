import { describe, expect, it } from "vitest";
import { attachTargetObserver, healthRequest, observeSocket, observeSocketSync, peerInode, nativeHealthResponse, parseObserverDiagnostic, directoryCursor, type SocketDiagnostic, type KernelSyncPort, type KernelPort, type PeerObservation } from "../scripts/diagnostic-observer/diagnostic-target-observer.js";
function kernel() {
  const data = new Map<string, string>(), dirs = new Map<string, string[]>(), links = new Map<string, string>(); let now = 0;
  data.set("/proc/stat", "btime 1000000000\n"); dirs.set("/proc", ["90", "200", "205", "210", "220"]);
  for (const [pid, parent] of [[90, 1], [200, 1], [205, 200], [210, 205], [220, 210]]) {
    const fields = Array(20).fill("0"); fields[0] = "S"; fields[1] = String(parent); fields[19] = String(pid * 100);
    data.set(`/proc/${pid}/stat`, `${pid} (synthetic worker) ${fields.join(" ")}`); data.set(`/proc/${pid}/status`, "Uid:\t501\t501\t501\t501\n");
    links.set(`/proc/${pid}/ns/net`, "net:[123]"); dirs.set(`/proc/${pid}/fd`, pid === 220 ? ["4"] : []);
  }
  const table = "sl local_address rem_address st tx rx tr tm retr uid timeout inode\n0: 0100007F:9C40 0100007F:7979 01 0:0 0:0 0 501 0 555";
  data.set("/proc/90/net/tcp", table); data.set("/proc/90/net/tcp6", "sl local_address rem_address st\n"); links.set("/proc/220/fd/4", "socket:[555]");
  const reads: string[] = [];
  const port: KernelPort = { now: () => now, read: async p => { reads.push(p); if (!data.has(p)) throw Error("missing"); return data.get(p)!; }, list: async p => { if (!dirs.has(p)) throw Error("missing"); return dirs.get(p)!; }, link: async p => { if (!links.has(p)) throw Error("missing"); return links.get(p)!; } };
  const sync: KernelSyncPort = { now: () => now,
    read: p => { reads.push(p); if (!data.has(p)) throw Error("missing"); return data.get(p)!; },
    list: p => { if (!dirs.has(p)) throw Error("missing"); return dirs.get(p)!; },
    link: p => { if (!links.has(p)) throw Error("missing"); return links.get(p)!; } };
  return { port, sync, data, dirs, links, reads, expire: () => { now = 1000; } };
}
const socket = { localAddress: "127.0.0.1", remoteAddress: "127.0.0.1", localPort: 31097, remotePort: 40000 };
const born = (pid: number) => new Date((1000000000 + pid) * 1000).toISOString();
const binding = { runnerPid: 200, runnerBorn: born(200), providerPid: 205, providerBorn: born(205), currentRunBound: true };
async function proof() { const k = kernel(); const p = await observeSocket(k.port, socket, 90, 100); expect(p).toBeDefined(); return { k, p: { ...p!, finished: true, status: 503, unknown: false } }; }
describe("target-only diagnostic observer", () => {
  it("binds a genuine socket ancestry to current native ownership and actual response", async () => {
    const { k, p } = await proof(); expect(nativeHealthResponse(p, binding, { pid: 90, born: born(90) })).toBe(true);
    expect(k.reads.every(p => !/cmdline|environ|stack|mem|log/.test(p))).toBe(true);
    for (const change of [{ currentRunBound: false }, { providerPid: 210, providerBorn: born(205) }, { runnerBorn: born(201) }]) expect(nativeHealthResponse(p, { ...binding, ...change }, { pid: 90, born: born(90) })).toBe(false);
  });
  it.each([{ method: "GET", url: "/api/health?token=never-persist" }, { method: "GET", url: "/api/health" }])("recognizes health pathname while discarding query", v => { expect(healthRequest(v.method, v.url)).toBe(true); });
  it.each([["POST", "/api/health"], ["GET", "/api/healthz"], ["GET", "//foreign/api/health"], ["GET", "/api/health/other"]])("does not admit unsupported request %s %s", (m, u) => expect(healthRequest(m, u)).toBe(false));
  it("rejects fixture/operator and other provider callers despite identical target/time/status", async () => {
    const { p } = await proof(); expect(nativeHealthResponse({ ...p, chain: p.chain.filter(r => r.pid !== 205) }, binding, { pid: 90, born: born(90) })).toBe(false);
    expect(nativeHealthResponse(p, { ...binding, runnerPid: 90, runnerBorn: born(90) }, { pid: 90, born: born(90) })).toBe(false);
    expect(nativeHealthResponse({ ...p, finished: false }, binding, { pid: 90, born: born(90) })).toBe(false);
    expect(nativeHealthResponse({ ...p, status: 200 }, binding, { pid: 90, born: born(90) })).toBe(false);
  });
  it("treats reused PID generation during resolution as unknown", async () => {
    const k = kernel(), read = k.port.read; let n = 0;
    k.port.read = async p => { const result = await read(p); return p === "/proc/220/stat" && ++n > 1 ? result.replace(/22000$/, "99999") : result; };
    expect(await observeSocket(k.port, socket, 90, 100)).toBeUndefined();
  });
  it.each(["namespace", "multiple-owner", "duplicate-tuple", "missing", "expired"])("fails unknown for %s without escalation", async kind => {
    const k = kernel();
    if (kind === "namespace") k.links.set("/proc/220/ns/net", "net:[456]");
    if (kind === "multiple-owner") { k.dirs.set("/proc/210/fd", ["7"]); k.links.set("/proc/210/fd/7", "socket:[555]"); }
    if (kind === "duplicate-tuple") k.data.set("/proc/90/net/tcp", k.data.get("/proc/90/net/tcp")! + "\n0: 0100007F:9C40 0100007F:7979 01 0:0 0:0 0 501 0 556");
    if (kind === "missing") k.data.delete("/proc/90/net/tcp");
    if (kind === "expired") { let n = 0; k.port.now = () => ++n * 100; }
    expect(await observeSocket(k.port, socket, 90, 100)).toBeUndefined();
  });
  it("uses actual matched channel messages and never reads headers/bodies/query into evidence", async () => {
    const k = kernel(), callbacks = new Map<string, (m: any) => void>(), saved: PeerObservation[][] = []; let armed = false;
    const close = attachTargetObserver({ pid: 90, hz: 100, version: "v24.10.0", kernel: k.port, armed: () => armed, on: (n, c) => callbacks.set(n, c), off: n => { callbacks.delete(n); }, save: async rows => { saved.push(rows); } });
    const request = { method: "GET", url: "/api/health?secret=PRIVATE", get headers() { throw Error("forbidden"); }, get body() { throw Error("forbidden"); } };
    const response = { statusCode: 503, get body() { throw Error("forbidden"); } }, m = { request, response, socket };
    for (let i = 0; i < 32; i++) callbacks.get("http.server.request.start")!(m as any);
    armed = true;
    callbacks.get("http.server.request.start")!(m as any); callbacks.get("http.server.response.finish")!({ ...m, request: {} } as any); expect(saved).toEqual([]);
    callbacks.get("http.server.response.finish")!(m as any); await close(); expect(saved.at(-1)).toHaveLength(1);
    expect(nativeHealthResponse(saved.at(-1)![0]!, binding, { pid: 90, born: born(90) })).toBe(true); expect(JSON.stringify(saved)).not.toMatch(/PRIVATE|secret|headers|body|api\/health/);
  });
  it("does not make request-only, unsupported channel/runtime, or observer errors into app exceptions", async () => {
    const k = kernel(), callbacks = new Map<string, (m: any) => void>(), saved: unknown[] = [];
    const close = attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, armed: () => true, on: (n, c) => callbacks.set(n, c), off: n => { callbacks.delete(n); }, save: async r => { saved.push(r); } });
    callbacks.get("http.server.request.start")!({ request: { method: "GET", url: "/api/health" }, response: {}, socket } as any); await close(); expect(saved).toEqual([]);
    await attachTargetObserver({ pid: 90, hz: 100, version: "v20.1.0", kernel: k.port, armed: () => true, on: () => { throw Error("no channel"); }, off: () => {}, save: async () => {} })();
    expect(() => attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, armed: () => true, on: () => { throw Error("no channel"); }, off: () => {}, save: async () => {} })).not.toThrow();
  });
});

it("requires the full reverse tuple including normalized loopback address families", () => {
  const header = "sl local_address rem_address st\n", row = "0: 00000000000000000000000001000000:9C40 00000000000000000000000001000000:7979 01 0:0 0:0 0 501 0 555";
  expect(peerInode([header + row], socket)).toBeUndefined();
  expect(peerInode([header + row], { ...socket, localAddress: "::1", remoteAddress: "::1" })).toBe("555");
  const mapped = row.replaceAll("00000000000000000000000001000000", "0000000000000000FFFF00000100007F");
  expect(peerInode([header + mapped], { ...socket, localAddress: "::ffff:127.0.0.1", remoteAddress: "::ffff:127.0.0.1" })).toBe("555");
  expect(peerInode([header + mapped], socket)).toBe("555");
  expect(peerInode([header + mapped], { ...socket, remotePort: 40001 })).toBeUndefined();
});

describe("content-free observer failure diagnostics", () => {
  it.each(["PEER_INODE_MISSING", "PROC_DENIED", "DEADLINE_OR_OP_LIMIT", "AMBIGUOUS_OWNER", "GENERATION_CHANGED"] as const)("reports %s without turning unknown into proof", async expected => {
    const k = kernel(), reports: SocketDiagnostic[] = [];
    if (expected === "PEER_INODE_MISSING") k.data.set("/proc/90/net/tcp", "sl local_address rem_address st\n");
    if (expected === "PROC_DENIED") k.port.read = async () => { throw Object.assign(new Error("WITHHELD/path/body"), { code: "EACCES" }); };
    if (expected === "DEADLINE_OR_OP_LIMIT") { let n = 0; k.port.now = () => ++n * 100; }
    if (expected === "AMBIGUOUS_OWNER") { k.dirs.set("/proc/210/fd", ["7"]); k.links.set("/proc/210/fd/7", "socket:[555]"); }
    if (expected === "GENERATION_CHANGED") { const read = k.port.read; let n = 0; k.port.read = async p => { const v = await read(p); return p === "/proc/220/stat" && ++n > 1 ? v.replace(/22000$/, "99999") : v; }; }
    expect(await observeSocket(k.port, socket, 90, 100, d => reports.push(d))).toBeUndefined();
    expect(reports).toHaveLength(1); expect(reports[0]!.outcome).toBe(expected);
    expect(Object.keys(reports[0]!).sort()).toEqual(["elapsedMs", "errno", "failureStage", "operations", "outcome", "procDeniedCount", "subject"]);
    expect(JSON.stringify(reports)).not.toMatch(/WITHHELD|path|body|stack/);
  });
  it("persists channel and matched-finish counters when ownership is unknown, without reading content", async () => {
    const k = kernel(), callbacks = new Map<string, (m: unknown) => void>(), saved: unknown[] = [], diagnostics: unknown[] = [];
    k.data.set("/proc/90/net/tcp", "sl local_address rem_address st\n");
    const close = attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, armed: () => true, on: (n, cb) => callbacks.set(n, cb), off: n => { callbacks.delete(n); }, save: async rows => { saved.push(rows); }, saveDiagnostic: async d => { diagnostics.push(d); } });
    const forbidden = () => { throw new Error("WITHHELD"); };
    const m = { request: { method: "GET", url: "/api/health?token=WITHHELD", get headers() { return forbidden(); }, get body() { return forbidden(); } }, response: { statusCode: 503, get body() { return forbidden(); } }, socket };
    callbacks.get("http.server.request.start")!(m); callbacks.get("http.server.response.finish")!(m);
    const d = await close(); expect(d.requestStart).toBe(1); expect(d.matchedFinish).toBe(1); expect(d.outcomes.PEER_INODE_MISSING).toBe(1); expect(saved).toEqual([]);
    expect(parseObserverDiagnostic(diagnostics.at(-1))).toEqual(d); expect(JSON.stringify(diagnostics)).not.toMatch(/WITHHELD|token|headers|body|api\/health/);
  });
  it("distinguishes no channel, malformed payload and output failure without throwing into the app", async () => {
    const k = kernel(), callbacks = new Map<string, (m: unknown) => void>();
    const open = (save = async () => {}) => attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, armed: () => true, on: (n, cb) => callbacks.set(n, cb), off: n => { callbacks.delete(n); }, save, saveDiagnostic: async () => {} });
    expect((await open()()).outcomes.NO_CHANNEL_OBSERVED).toBe(1);
    const malformed = open(); expect(() => callbacks.get("http.server.request.start")!({ get request() { throw new Error("WITHHELD"); } })).not.toThrow();
    expect((await malformed()).outcomes.PAYLOAD_SHAPE_MISMATCH).toBe(1);
    const failed = open(async () => { throw new Error("WITHHELD write target"); });
    const m = { request: { method: "GET", url: "/api/health" }, response: { statusCode: 503 }, socket };
    callbacks.get("http.server.request.start")!(m); callbacks.get("http.server.response.finish")!(m);
    const d = await failed(); expect(d.outcomes.OWNERSHIP_PROVEN).toBe(1); expect(d.outputWriteFailures).toBe(1); expect(d.outcomes.OUTPUT_WRITE_FAILED).toBe(1);
    expect(JSON.stringify(d)).not.toContain("WITHHELD");
  });
  it("refuses arbitrary diagnostic keys, values and unbounded counters", async () => {
    const k = kernel(); const d = await attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, armed: () => true, on: () => {}, off: () => {}, save: async () => {} })();
    for (const v of [{ ...d, body: "WITHHELD" }, { ...d, requestStart: Infinity }, { ...d, requestStart: 65536 }, { ...d, channelState: "WITHHELD" }, { ...d, outcomes: { ...d.outcomes, WITHHELD: 1 } }]) expect(parseObserverDiagnostic(v)).toBeUndefined();
  });
});

describe("bounded synchronous request-start collector", () => {
  it("uses the same full proof algorithm synchronously before returning from the real channel hook", async () => {
    const k = kernel(), callbacks = new Map<string, (m: unknown) => void>(), saved: PeerObservation[][] = [];
    const close = attachTargetObserver({ pid: 90, hz: 100, version: "v24.1.0", kernel: k.port, kernelSync: k.sync, armed: () => true, on: (n, cb) => callbacks.set(n, cb), off: n => { callbacks.delete(n); }, save: async rows => { saved.push(rows); } });
    const m = { request: { method: "GET", url: "/api/health" }, response: { statusCode: 503 }, socket };
    callbacks.get("http.server.request.start")!(m);
    expect(k.reads.filter(v => v === "/proc/220/stat")).toHaveLength(3);
    callbacks.get("http.server.response.finish")!(m);
    const d = await close(); expect(d.collectorMode).toBe("SYNC_REQUEST_START"); expect(d.outcomes.OWNERSHIP_PROVEN).toBe(1);
    expect(nativeHealthResponse(saved[0]![0]!, binding, { pid: 90, born: born(90) })).toBe(true);
    expect(observeSocketSync(kernel().sync, socket, 90, 100)).toEqual(await observeSocket(kernel().port, socket, 90, 100));
  });
  it("filters known foreign UID before namespace and descriptor reads without skipping an unknown owner", () => {
    const k = kernel(); k.dirs.get("/proc")!.unshift("999"); k.data.set("/proc/999/status", "Uid: 0 0 0 0\n");
    const link = k.sync.link, list = k.sync.list;
    k.sync.link = name => { if (name.includes("/999/")) throw Error("foreign namespace must not be read"); return link(name); };
    k.sync.list = name => { if (name.includes("/999/")) throw Error("foreign descriptors must not be read"); return list(name); };
    expect(observeSocketSync(k.sync, socket, 90, 100)).toBeDefined();
    k.data.delete("/proc/999/status"); expect(observeSocketSync(k.sync, socket, 90, 100)).toBeUndefined();
  });
  it("examines a possible owner beyond1024descriptors under the unchanged global caps", () => {
    const k = kernel(), fds = Array.from({ length: 1026 }, (_, i) => String(i + 10)); k.dirs.set("/proc/220/fd", fds);
    for (const fd of fds) k.links.set(`/proc/220/fd/${fd}`, "socket:[999]"); k.links.set(`/proc/220/fd/${fds.at(-1)}`, "socket:[555]");
    const reports: SocketDiagnostic[] = []; expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeDefined(); expect(reports[0]!.operations).toBeLessThanOrEqual(8192);
    const many = Array.from({ length: 8200 }, (_, i) => String(i + 10)); k.dirs.set("/proc/220/fd", many);
    for (const fd of many) k.links.set(`/proc/220/fd/${fd}`, "socket:[999]");
    reports.length = 0; expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined(); expect(reports[0]!.outcome).toBe("DEADLINE_OR_OP_LIMIT");
  });
  it("refuses a same-UID denied descriptor instead of skipping a possible owner", () => {
    const k = kernel(), link = k.sync.link, reports: SocketDiagnostic[] = [];
    k.sync.link = name => { if (name === "/proc/220/fd/4") throw Object.assign(Error("WITHHELD"), { code: "EPERM" }); return link(name); };
    expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined(); expect(reports[0]!.outcome).toBe("PROC_DENIED"); expect(JSON.stringify(reports)).not.toContain("WITHHELD");
  });
  it("keeps final reverse tuple and generation checks and rejects IO that crosses100ms", () => {
    for (const kind of ["generation", "tuple", "deadline"]) {
      const k = kernel(), read = k.sync.read, reports: SocketDiagnostic[] = []; let reads = 0;
      k.sync.read = name => { const value = read(name);
        if (kind === "generation" && name === "/proc/220/stat" && ++reads > 1) return value.replace(/22000$/, "99999");
        if (kind === "tuple" && name === "/proc/90/net/tcp" && ++reads > 1) return "sl local_address rem_address st\n";
        if (kind === "deadline" && name === "/proc/90/net/tcp") k.expire();
        return value; };
      expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined(); expect(reports[0]!.outcome).toBe(kind === "deadline" ? "DEADLINE_OR_OP_LIMIT" : "GENERATION_CHANGED");
    }
  });
  it.each(["/api/x/../health", "/api/./health", String.raw`/api\health`, String.raw`/\foreign/api/health`, "//foreign/api/health"])("does not normalize a foreign raw path %s into health", raw => {
    expect(healthRequest("GET", raw)).toBe(false); expect(healthRequest("GET", "/api/health?token=not-recorded")).toBe(true);
  });
});

describe("retained FD-directory iterator lifecycle", () => {
  function adapter() {
    const k = kernel(), open = new Set<string>(), closed: string[] = []; let reads = 0;
    const openDirectory = (name: string) => {
      if (open.has(name)) throw Error("duplicate directory"); open.add(name);
      const names = [...k.dirs.get(name)!]; if (name === "/proc/90/fd") names.push("99"); let i = 0;
      return directoryCursor({ readSync: () => { reads++; return i < names.length ? { name: names[i++]! } : null; }, closeSync: () => { if (!open.delete(name)) throw Error("double close"); closed.push(name); } });
    };
    const link = k.sync.link;
    k.sync.link = name => {
      if (name === "/proc/90/fd/99") { if (!open.has("/proc/90/fd")) throw Object.assign(Error("WITHHELD"), { code: "ENOENT" }); return "/proc/90/fd"; }
      return link(name);
    };
    return { k, open, closed, openDirectory, reads: () => reads };
  }
  it("reproduces the closed-name-list failure and proves the real retained-cursor adapter", () => {
    const old = adapter(), previousList = old.k.sync.list, oldReports: SocketDiagnostic[] = [];
    old.k.sync.list = name => {
      if (!/^\/proc\/\d+\/fd$/.test(name)) return previousList(name);
      const cursor = old.openDirectory(name), names: string[] = [];
      try { for (let value = cursor.read(); value !== null; value = cursor.read()) names.push(value); } finally { cursor.close(); }
      return names;
    };
    expect(observeSocketSync(old.k.sync, socket, 90, 100, d => oldReports.push(d))).toBeUndefined();
    expect(oldReports[0]).toMatchObject({ outcome: "PROCESS_METADATA_UNAVAILABLE", failureStage: "FD_LINK", errno: "ENOENT", subject: "SELF" });
    const retained = adapter(), reports: SocketDiagnostic[] = []; retained.k.sync.openDirectory = retained.openDirectory;
    expect(observeSocketSync(retained.k.sync, socket, 90, 100, d => reports.push(d))).toBeDefined();
    expect(reports[0]!.outcome).toBe("OWNERSHIP_PROVEN"); expect(retained.open.size).toBe(0);
    expect(new Set(retained.closed).size).toBe(retained.closed.length); expect(retained.reads()).toBeGreaterThan(0);
  });
  it("closes the retained cursor in finally on link error and never treats an unknown owner as absent", () => {
    const f = adapter(), link = f.k.sync.link, reports: SocketDiagnostic[] = []; f.k.sync.openDirectory = f.openDirectory;
    f.k.sync.link = name => { if (name === "/proc/90/fd/99") throw Object.assign(Error("WITHHELD raw body"), { code: "EACCES" }); return link(name); };
    expect(observeSocketSync(f.k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined(); expect(f.open.size).toBe(0); expect(f.closed).toEqual(["/proc/90/fd"]);
    expect(reports[0]).toMatchObject({ outcome: "PROC_DENIED", failureStage: "FD_LINK", errno: "EACCES", subject: "SELF" }); expect(JSON.stringify(reports)).not.toMatch(/WITHHELD|raw body|\/proc/);
    const reading = adapter(), openDirectory = reading.openDirectory, readReports: SocketDiagnostic[] = [];
    reading.k.sync.openDirectory = name => { const cursor = openDirectory(name); return { read() { throw Object.assign(Error("WITHHELD"), { code: "EIO" }); }, close: () => cursor.close() }; };
    expect(observeSocketSync(reading.k.sync, socket, 90, 100, d => readReports.push(d))).toBeUndefined(); expect(reading.open.size).toBe(0);
    expect(readReports[0]).toMatchObject({ failureStage: "FD_READ", errno: "EIO", subject: "SELF" });
  });
  it("closes the retained cursor after deadline crossing and rejects disappearing PID status", () => {
    const f = adapter(), link = f.k.sync.link, reports: SocketDiagnostic[] = []; f.k.sync.openDirectory = f.openDirectory;
    f.k.sync.link = name => { const v = link(name); if (name === "/proc/90/fd/99") f.k.expire(); return v; };
    expect(observeSocketSync(f.k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined(); expect(f.open.size).toBe(0); expect(f.closed).toEqual(["/proc/90/fd"]); expect(reports[0]!.outcome).toBe("DEADLINE_OR_OP_LIMIT");
    const opening = adapter(), open = opening.openDirectory, openReports: SocketDiagnostic[] = [];
    opening.k.sync.openDirectory = name => { const cursor = open(name); opening.k.expire(); return cursor; };
    expect(observeSocketSync(opening.k.sync, socket, 90, 100, d => openReports.push(d))).toBeUndefined(); expect(opening.open.size).toBe(0); expect(opening.closed).toEqual(["/proc/90/fd"]); expect(openReports[0]!.outcome).toBe("DEADLINE_OR_OP_LIMIT");
    const gone = kernel(), read = gone.sync.read, missing: SocketDiagnostic[] = []; gone.sync.read = name => { if (name === "/proc/200/status") throw Object.assign(Error("WITHHELD"), { code: "ENOENT" }); return read(name); };
    expect(observeSocketSync(gone.sync, socket, 90, 100, d => missing.push(d))).toBeUndefined(); expect(missing[0]).toMatchObject({ failureStage: "OWNER_STATUS", errno: "ENOENT", subject: "OTHER" });
  });
});


describe("ancestor UID trust boundary", () => {
  function ancestor(uid: string) {
    const k = kernel();
    k.data.set("/proc/200/stat", k.data.get("/proc/200/stat")!.replace(" S 1 ", " S 999 "));
    k.data.set("/proc/999/stat", k.data.get("/proc/200/stat")!.replace(/^200 /, "999 ").replace(" S 999 ", " S 1 "));
    k.data.set("/proc/999/status", uid);
    return k;
  }
  it.each(["sync", "async"])("%s stops at a known foreign UID before namespace access", async mode => {
    const k = ancestor("Uid: 0 0 0 0\n"), namespaceReads: string[] = [], reports: SocketDiagnostic[] = [];
    const link = k.sync.link;
    k.sync.link = name => { namespaceReads.push(name); if (name === "/proc/999/ns/net") throw Object.assign(Error("WITHHELD"), { code: "EACCES" }); return link(name); };
    k.port.link = async name => k.sync.link(name);
    const p = mode === "sync" ? observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d)) : await observeSocket(k.port, socket, 90, 100, d => reports.push(d));
    expect(p).toBeDefined(); expect(namespaceReads).not.toContain("/proc/999/ns/net"); expect(k.reads).not.toContain("/proc/999/stat");
    expect(p!.chain.map(v => v.pid)).toEqual([220, 210, 205, 200]); expect(reports[0]!.outcome).toBe("OWNERSHIP_PROVEN");
    const response = { ...p!, finished: true, status: 503, unknown: false }, target = { pid: 90, born: born(90) };
    expect(nativeHealthResponse(response, binding, target)).toBe(true);
    expect(nativeHealthResponse(response, { ...binding, runnerPid: 999, runnerBorn: born(999) }, target)).toBe(false);
    expect(nativeHealthResponse(response, { ...binding, providerPid: 999, providerBorn: born(999) }, target)).toBe(false);
  });
  it.each(["sync", "async"])("%s keeps a same-UID denied ancestor namespace unknown", async mode => {
    const k = ancestor("Uid: 501 501 501 501\n"), link = k.sync.link, reports: SocketDiagnostic[] = [];
    k.sync.link = name => { if (name === "/proc/999/ns/net") throw Object.assign(Error("WITHHELD"), { code: "EACCES" }); return link(name); };
    k.port.link = async name => k.sync.link(name);
    const p = mode === "sync" ? observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d)) : await observeSocket(k.port, socket, 90, 100, d => reports.push(d));
    expect(p).toBeUndefined(); expect(reports[0]).toMatchObject({ outcome: "PROC_DENIED", failureStage: "ANCESTRY_NAMESPACE", errno: "EACCES" });
  });
  it("keeps a changed same-UID ancestor identity unknown", () => {
    const k = ancestor("Uid: 501 501 501 501\n"), read = k.sync.read, reports: SocketDiagnostic[] = []; let count = 0;
    k.sync.read = name => name === "/proc/999/status" && ++count > 1 ? "Uid: 0 0 0 0\n" : read(name);
    k.links.set("/proc/999/ns/net", "net:[123]");
    expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined();
    expect(reports[0]!.outcome).toBe("GENERATION_CHANGED");
  });
  it.each(["malformed", "missing", "denied", "disappeared"])("keeps %s ancestor UID unknown without reading its namespace", kind => {
    const k = ancestor(kind === "malformed" ? "Uid: invalid\n" : "Name: worker\n"), read = k.sync.read, link = k.sync.link, namespaceReads: string[] = [], reports: SocketDiagnostic[] = [];
    if (kind === "denied" || kind === "disappeared") k.sync.read = name => { if (name === "/proc/999/status") throw Object.assign(Error("WITHHELD"), { code: kind === "denied" ? "EACCES" : "ENOENT" }); return read(name); };
    k.sync.link = name => { namespaceReads.push(name); return link(name); };
    expect(observeSocketSync(k.sync, socket, 90, 100, d => reports.push(d))).toBeUndefined();
    expect(namespaceReads).not.toContain("/proc/999/ns/net"); expect(reports[0]!.failureStage).toBe("ANCESTRY_STATUS"); expect(reports[0]!.outcome).not.toBe("OWNERSHIP_PROVEN");
  });
});
