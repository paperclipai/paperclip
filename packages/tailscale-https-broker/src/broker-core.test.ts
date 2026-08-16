import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "./audit.js";
import { BrokerCore, type CliResult, type ListenerOwnership } from "./broker-core.js";
import { defaultIsAllowedPort } from "./port-policy.js";
import type { BrokerRequest, PeerCredentials } from "./types.js";

const HOST = "paperclip-dev.tail29c1aa.ts.net";
const BIN = "/usr/bin/tailscale";
const RUNTIME_A = "2af79bb1-ecc5-4410-8438-091be135a921";
const RUNTIME_B = "3108ef8e-5ed0-41d9-b561-6b41c41b8545";
const PEER: PeerCredentials = { uid: 999, gid: 987, pid: 4242 };

/** In-memory tailscale serve fake driven by exact argv vectors. */
class FakeTailscale {
  ports = new Map<number, string>([[443, "http://127.0.0.1:3100"]]);
  failExposePort: number | null = null;
  failRemove = false;
  sideEffectOnExpose: number | null = null;
  retargetPrimaryOnExpose = false;
  exposeCalls = 0;
  removeCalls = 0;

  run = (argv: string[]): CliResult => {
    const [, sub, a2, a3] = argv;
    if (sub === "serve" && a2 === "status") {
      return { code: 0, stdout: this.statusJson(), stderr: "", timedOut: false };
    }
    if (sub === "serve" && a2 === "--bg") {
      this.exposeCalls += 1;
      const port = Number(a3.replace("--https=", ""));
      if (this.failExposePort === port) return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      this.ports.set(port, `http://127.0.0.1:${port}`);
      if (this.sideEffectOnExpose) this.ports.set(this.sideEffectOnExpose, `http://127.0.0.1:${this.sideEffectOnExpose}`);
      if (this.retargetPrimaryOnExpose) this.ports.set(443, "http://127.0.0.1:9999");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (sub === "serve" && a2.startsWith("--https=") && a3 === "off") {
      this.removeCalls += 1;
      if (this.failRemove) return { code: 1, stdout: "", stderr: "no", timedOut: false };
      this.ports.delete(Number(a2.replace("--https=", "")));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 2, stdout: "", stderr: "unknown", timedOut: false };
  };

  private statusJson(): string {
    const TCP: Record<string, unknown> = {};
    const Web: Record<string, unknown> = {};
    for (const [port, proxy] of this.ports) {
      TCP[String(port)] = { HTTPS: true };
      Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
    }
    return JSON.stringify({ TCP, Web });
  }
}

function makeCore(
  fake: FakeTailscale,
  registryPath: string,
  ownership: (port: number) => ListenerOwnership = () => ({
    present: true,
    loopbackOnly: true,
    ownerUidMatches: true,
  }),
  nowIso: () => string = () => "2026-08-11T00:00:00.000Z",
) {
  const audit = new MemoryAuditSink();
  const core = new BrokerCore({
    tailscaleBinPath: BIN,
    registryPath,
    auditSink: audit,
    peerPolicy: { allowedUids: new Set([999]), allowedGids: new Set([987]) },
    nodeIdentity: "node-1",
    isAllowedPort: defaultIsAllowedPort,
    deps: {
      runTailscale: fake.run,
      verifyListenerOwnership: ownership,
      nowIso,
    },
  });
  return { core, audit };
}

const reserveReq = (runtimeId = RUNTIME_A, port = 42010): BrokerRequest => ({
  op: "reserve",
  requestId: "req-e",
  runtimeId,
  listeners: [{ purpose: "app", port }],
});

async function reserveAndExpose(core: BrokerCore, runtimeId = RUNTIME_A, port = 42010, peer = PEER) {
  const reserved = await core.handle(reserveReq(runtimeId, port), peer);
  if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
  return await core.handle({
    op: "expose",
    requestId: "req-x",
    runtimeId,
    handle: reserved.handle,
  }, peer);
}

let dir: string;
let registryPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "broker-test-"));
  registryPath = join(dir, "registry.json");
});
afterEach(() => {
  // tmp dir is left for the OS to reap; tests use unique dirs.
});

describe("expose", () => {
  it("reserves before bind, then exposes a same-number loopback listener and persists a lease", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const reserved = await core.handle(reserveReq(), PEER);
    expect(reserved.ok).toBe(true);
    expect(fake.ports.has(42010)).toBe(false);
    const beforeList = await core.handle({ op: "list", requestId: "before-list" }, PEER);
    expect(beforeList).toMatchObject({ ok: true, listeners: [] });
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("expected reserve ok");
    const res = await core.handle({ op: "expose", requestId: "req-x", runtimeId: RUNTIME_A, handle: reserved.handle }, PEER);
    expect(res.ok).toBe(true);
    if (!res.ok || res.op !== "expose") throw new Error("expected expose ok");
    expect(res.publicPorts).toEqual([42010]);
    expect(res.handle).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(fake.ports.get(42010)).toBe("http://127.0.0.1:42010");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.leases[0].ports).toEqual([42010]);
    expect(registry.leases[0].state).toBe("exposed");
    // Handle is persisted server-side but never appears in list output.
  });

  it("is idempotent: re-exposing the same port does not double-apply", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const firstReservation = await core.handle(reserveReq(), PEER);
    if (!firstReservation.ok || firstReservation.op !== "reserve") throw new Error("reserve failed");
    await core.handle({ op: "expose", requestId: "first", runtimeId: RUNTIME_A, handle: firstReservation.handle }, PEER);
    const before = fake.exposeCalls;
    const repeatedReservation = await core.handle(reserveReq(), PEER);
    expect(repeatedReservation).toMatchObject({ ok: true, handle: firstReservation.handle });
    const res = await core.handle({ op: "expose", requestId: "second", runtimeId: RUNTIME_A, handle: firstReservation.handle }, PEER);
    expect(res.ok).toBe(true);
    expect(fake.exposeCalls).toBe(before); // no additional CLI mutation
  });

  it("rejects and releases an expired reservation before any Serve mutation", async () => {
    const fake = new FakeTailscale();
    let now = "2026-08-11T00:00:00.000Z";
    const { core } = makeCore(fake, registryPath, undefined, () => now);
    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    now = "2026-08-11T00:06:00.000Z";
    const result = await core.handle({
      op: "expose",
      requestId: "expired",
      runtimeId: RUNTIME_A,
      handle: reserved.handle,
    }, PEER);
    expect(result).toMatchObject({ ok: false, code: "reservation_expired" });
    expect(fake.exposeCalls).toBe(0);
    expect(JSON.parse(readFileSync(registryPath, "utf8")).leases).toEqual([]);
  });

  it("rejects an unauthorized peer without mutating serve", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const res = await core.handle(reserveReq(), { uid: 1000, gid: 987, pid: 1 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.code).toBe("unauthorized_peer");
    expect(fake.ports.has(42010)).toBe(false);
  });

  it("rejects a port outside the dedicated allowlist", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const res = await core.handle(reserveReq(RUNTIME_A, 8080), PEER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("port_not_allowlisted");
  });

  it("rejects when the loopback listener is not owned / not loopback-only / absent (SSRF guard)", async () => {
    for (const bad of [
      { present: true, loopbackOnly: false, ownerUidMatches: true },
      { present: true, loopbackOnly: true, ownerUidMatches: false },
      { present: false, loopbackOnly: true, ownerUidMatches: true },
    ]) {
      const fake = new FakeTailscale();
      const { core } = makeCore(fake, registryPath, () => bad);
      const res = await reserveAndExpose(core);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("listener_ownership_mismatch");
      expect(fake.ports.has(42010)).toBe(false);
    }
  });

  it("never touches a pre-existing manual mapping on the target port", async () => {
    const fake = new FakeTailscale();
    fake.ports.set(42010, "http://127.0.0.1:5432"); // manual/unrelated service
    const { core } = makeCore(fake, registryPath);
    const res = await core.handle(reserveReq(), PEER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("manual_mapping_present");
    expect(fake.ports.get(42010)).toBe("http://127.0.0.1:5432"); // unchanged
  });

  it("fails closed and preserves :443 if a mutation retargets the primary route", async () => {
    const fake = new FakeTailscale();
    fake.retargetPrimaryOnExpose = true;
    const { core } = makeCore(fake, registryPath);
    const res = await reserveAndExpose(core);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("primary_route_violation");
  });

  it("compensates and quarantines on an unexpected serve diff", async () => {
    const fake = new FakeTailscale();
    fake.sideEffectOnExpose = 42011; // an unexpected extra entry appears
    fake.failRemove = true; // compensation cannot be proven -> quarantine
    const { core } = makeCore(fake, registryPath);
    const res = await reserveAndExpose(core);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unexpected_serve_diff");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.quarantinedPorts).toContain(42010);
    // A later expose of the quarantined port is refused.
    const fake2 = new FakeTailscale();
    const { core: core2 } = makeCore(fake2, registryPath);
    const res2 = await core2.handle(reserveReq(), PEER);
    expect(res2.ok).toBe(false);
    if (!res2.ok) expect(res2.code).toBe("quarantined");
  });
});

describe("remove", () => {
  async function exposeAndGetHandle(core: BrokerCore, port = 42010, runtime = RUNTIME_A) {
    const res = await reserveAndExpose(core, runtime, port);
    if (!res.ok || res.op !== "expose") throw new Error("expose failed");
    return res.handle;
  }

  it("removes only the owned listener with an exact lease match", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const handle = await exposeAndGetHandle(core);
    const res = await core.handle(
      { op: "remove", requestId: "req-r", runtimeId: RUNTIME_A, handle },
      PEER,
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.op === "remove") expect(res.removedPorts).toEqual([42010]);
    expect(fake.ports.has(42010)).toBe(false);
    expect(fake.ports.get(443)).toBe("http://127.0.0.1:3100"); // primary intact
  });

  it("rejects a random handle and a cross-runtime removal", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const handle = await exposeAndGetHandle(core);
    const bad = await core.handle(
      { op: "remove", requestId: "r", runtimeId: RUNTIME_A, handle: "random-handle-not-real-xxxx" },
      PEER,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_handle");
    const cross = await core.handle(
      { op: "remove", requestId: "r", runtimeId: RUNTIME_B, handle },
      PEER,
    );
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("listener_ownership_mismatch");
    expect(fake.ports.has(42010)).toBe(true); // still there
  });

  it("releases an unexposed reservation without mutating Serve", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    const res = await core.handle(
      { op: "remove", requestId: "req-r", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(res).toMatchObject({ ok: true, removedPorts: [] });
    expect(fake.exposeCalls).toBe(0);
    expect(fake.removeCalls).toBe(0);
  });
});

describe("list", () => {
  it("returns caller-owned ports and never lease handles", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    await reserveAndExpose(core);
    const res = await core.handle({ op: "list", requestId: "req-l" }, PEER);
    expect(res.ok).toBe(true);
    if (res.ok && res.op === "list") {
      expect(res.listeners).toEqual([{ runtimeId: RUNTIME_A, port: 42010, purpose: "app" }]);
      expect(JSON.stringify(res)).not.toMatch(/handle/);
    }
  });
});

describe("node identity", () => {
  it("quarantines when the persisted node identity no longer matches", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    await reserveAndExpose(core);
    // Rebuild a core with a different node identity against the same registry.
    const audit = new MemoryAuditSink();
    const core2 = new BrokerCore({
      tailscaleBinPath: BIN,
      registryPath,
      auditSink: audit,
      peerPolicy: { allowedUids: new Set([999]), allowedGids: new Set([987]) },
      nodeIdentity: "node-CHANGED",
      isAllowedPort: defaultIsAllowedPort,
      deps: {
        runTailscale: fake.run,
        verifyListenerOwnership: () => ({ present: true, loopbackOnly: true, ownerUidMatches: true }),
        nowIso: () => "2026-08-11T00:00:00.000Z",
      },
    });
    const res = await core2.handle(reserveReq(RUNTIME_B, 42011), PEER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("quarantined");
  });
});
