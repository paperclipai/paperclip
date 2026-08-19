import { beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, type BrokerConfig, type BrokerDeps, type PeerIdentity } from "../tailscale-broker/broker.js";
import type { TailscaleCli } from "../tailscale-broker/cli.js";
import type { ListenerBinding, ListenerInspector } from "../tailscale-broker/listener-ownership.js";
import type { AuditEvent } from "../tailscale-broker/audit.js";
import type { RegistryFile } from "../tailscale-broker/registry.js";

const HOST = "paperclip-dev.tailnet.ts.net";

/** In-memory tailscale serve state that mirrors the documented config subset. */
class FakeServeState {
  web: Record<string, unknown> = {
    [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } },
  };
  tcp: Record<string, unknown> = { "443": { HTTPS: true } };
  /** Optional hook to simulate a concurrent manual mutation between add and re-read. */
  afterAddHook: (() => void) | null = null;

  json(): string {
    return JSON.stringify({ Web: this.web, TCP: this.tcp });
  }
  add(port: number, target: string): void {
    this.web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: target } } };
    this.tcp[String(port)] = { HTTPS: true };
  }
  remove(port: number): void {
    delete this.web[`${HOST}:${port}`];
    delete this.tcp[String(port)];
  }
}

function makeCli(state: FakeServeState, overrides: Partial<TailscaleCli> = {}): TailscaleCli {
  return {
    serveStatusJson: async () => state.json(),
    serveAddHttps: async (port, target) => {
      state.add(port, target);
      if (state.afterAddHook) {
        const hook = state.afterAddHook;
        state.afterAddHook = null;
        hook();
      }
    },
    serveRemoveHttps: async (port) => {
      state.remove(port);
    },
    ...overrides,
  };
}

function loopbackInspector(uid = 1000): ListenerInspector {
  return {
    listBindingsForPort: async (port): Promise<ListenerBinding[]> => [
      { host: "127.0.0.1", port, uid, inode: "1" },
    ],
  };
}

function makeBroker(
  state: FakeServeState,
  opts: {
    cli?: TailscaleCli;
    inspector?: ListenerInspector;
    config?: Partial<BrokerConfig>;
    registry?: RegistryFile;
    audit?: AuditEvent[];
    handles?: string[];
    saveRegistry?: (file: RegistryFile) => void;
  } = {},
) {
  const audit = opts.audit ?? [];
  let saved: RegistryFile = opts.registry ?? { version: 1, generation: 0, leases: [] };
  let handleSeq = 0;
  const handles = opts.handles ?? [];
  const config: BrokerConfig = {
    allowedUids: [1000],
    allowedGids: [2000],
    expectedRuntimeUid: 1000,
    ...opts.config,
  };
  const deps: BrokerDeps = {
    cli: opts.cli ?? makeCli(state),
    inspector: opts.inspector ?? loopbackInspector(),
    audit: { write: (e) => audit.push(e) },
    loadRegistry: () => saved,
    saveRegistry: opts.saveRegistry ?? ((f) => {
      saved = f;
    }),
    now: () => 1_700_000_000_000,
    newHandle: () => handles[handleSeq++] ?? `handle-${handleSeq}`,
    correlationId: () => "corr",
  };
  const broker = new Broker(config, deps);
  return { broker, audit, getSaved: () => saved };
}

const PEER_A: PeerIdentity = { uid: 1000, gid: 2000, pid: 111 };
const PEER_B: PeerIdentity = { uid: 1001, gid: 2000, pid: 222 };

function exposeReq(port: number, runtimeId = "r1") {
  return { v: 1 as const, op: "expose" as const, runtimeId, port, target: `http://127.0.0.1:${port}`, reservation: "res" };
}

describe("Broker.expose", () => {
  let state: FakeServeState;
  beforeEach(() => {
    state = new FakeServeState();
  });

  it("exposes a valid loopback port and persists a lease", async () => {
    const { broker, getSaved } = makeBroker(state, { handles: ["H1"] });
    const res = await broker.handle(exposeReq(39001), PEER_A);
    expect(res).toEqual({ ok: true, result: { handle: "H1", port: 39001, target: "http://127.0.0.1:39001", idempotent: false } });
    expect(getSaved().leases).toHaveLength(1);
    expect(getSaved().leases[0]).toMatchObject({ handle: "H1", port: 39001, peerUid: 1000 });
    // primary :443 untouched
    expect(state.tcp["443"]).toEqual({ HTTPS: true });
  });

  it("is idempotent for the same runtime+target", async () => {
    const { broker } = makeBroker(state, { handles: ["H1", "H2"] });
    await broker.handle(exposeReq(39001), PEER_A);
    const res2 = await broker.handle(exposeReq(39001), PEER_A);
    expect(res2).toMatchObject({ ok: true, result: { handle: "H1", idempotent: true } });
  });

  it("denies a port already owned by a manual serve entry", async () => {
    state.add(39002, "http://127.0.0.1:39002"); // pre-existing manual mapping
    const { broker, getSaved } = makeBroker(state);
    const res = await broker.handle(exposeReq(39002), PEER_A);
    expect(res).toMatchObject({ ok: false, code: "port_in_use" });
    expect(getSaved().leases).toHaveLength(0);
  });

  it("rejects a non-loopback (wildcard) backend listener (SSRF, verdict #2)", async () => {
    const inspector: ListenerInspector = {
      listBindingsForPort: async (port) => [{ host: "0.0.0.0", port, uid: 1000, inode: "1" }],
    };
    const addSpy = vi.fn(async () => {});
    const cli = makeCli(state, { serveAddHttps: addSpy });
    const { broker } = makeBroker(state, { inspector, cli });
    const res = await broker.handle(exposeReq(39001), PEER_A);
    expect(res).toMatchObject({ ok: false, code: "wildcard_listener" });
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("rejects a listener owned by the wrong uid (verdict #2)", async () => {
    const { broker } = makeBroker(state, { inspector: loopbackInspector(4242) });
    const res = await broker.handle(exposeReq(39001), PEER_A);
    expect(res).toMatchObject({ ok: false, code: "owner_mismatch" });
  });

  it("rejects when no listener is bound", async () => {
    const inspector: ListenerInspector = { listBindingsForPort: async () => [] };
    const { broker } = makeBroker(state, { inspector });
    expect(await broker.handle(exposeReq(39001), PEER_A)).toMatchObject({ ok: false, code: "no_listener" });
  });

  it("quarantines and fails closed when a concurrent manual mutation appears mid-transaction (verdict #3)", async () => {
    // Between add and the re-read, an unrelated manual entry appears.
    state.afterAddHook = () => state.add(45000, "http://127.0.0.1:45000");
    const { broker, getSaved } = makeBroker(state);
    const res = await broker.handle(exposeReq(39001), PEER_A);
    expect(res).toMatchObject({ ok: false, code: "unexpected_diff" });
    // Our port's entry was compensated (removed); no lease persisted for it.
    expect(getSaved().leases.filter((l) => l.port === 39001 && !l.quarantined)).toHaveLength(0);
    // primary :443 remains intact.
    expect(state.tcp["443"]).toEqual({ HTTPS: true });
  });

  it("removes and verifies a new mapping when registry persistence fails", async () => {
    const removeSpy = vi.fn(async (port: number) => state.remove(port));
    const { broker, getSaved } = makeBroker(state, {
      cli: makeCli(state, { serveRemoveHttps: removeSpy }),
      saveRegistry: () => {
        throw new Error("disk full");
      },
    });

    const res = await broker.handle(exposeReq(39001), PEER_A);

    expect(res).toMatchObject({ ok: false, code: "registry_persist_failed" });
    expect(removeSpy).toHaveBeenCalledWith(39001);
    expect(state.web[`${HOST}:39001`]).toBeUndefined();
    expect(state.tcp["39001"]).toBeUndefined();
    expect(getSaved().leases).toHaveLength(0);
    expect(broker.snapshotRegistry().leases).toHaveLength(0);
    expect(state.tcp["443"]).toEqual({ HTTPS: true });
  });

  it("stops all later requests when registry persistence and mapping rollback both fail", async () => {
    const { broker } = makeBroker(state, {
      cli: makeCli(state, {
        serveRemoveHttps: async () => {
          throw new Error("tailscale unavailable");
        },
      }),
      saveRegistry: () => {
        throw new Error("disk full");
      },
    });

    const res = await broker.handle(exposeReq(39001), PEER_A);
    expect(res).toMatchObject({ ok: false, code: "registry_rollback_failed" });
    expect(state.web[`${HOST}:39001`]).toBeDefined();

    const later = await broker.handle({ v: 1, op: "list" }, PEER_A);
    expect(later).toMatchObject({ ok: false, code: "broker_failed_closed" });
  });

  it("stops a mutation that queued before a failed rollback completed", async () => {
    let markRollbackStarted!: () => void;
    const rollbackStarted = new Promise<void>((resolve) => {
      markRollbackStarted = resolve;
    });
    let releaseRollback!: () => void;
    const rollbackRelease = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    const addSpy = vi.fn(async (port: number, target: string) => state.add(port, target));
    const { broker } = makeBroker(state, {
      cli: makeCli(state, {
        serveAddHttps: addSpy,
        serveRemoveHttps: async () => {
          markRollbackStarted();
          await rollbackRelease;
          throw new Error("tailscale unavailable");
        },
      }),
      saveRegistry: () => {
        throw new Error("disk full");
      },
    });

    const first = broker.handle(exposeReq(39001, "first"), PEER_A);
    await rollbackStarted;
    const queued = broker.handle(exposeReq(39002, "queued"), PEER_A);
    releaseRollback();

    await expect(first).resolves.toMatchObject({ ok: false, code: "registry_rollback_failed" });
    await expect(queued).resolves.toMatchObject({ ok: false, code: "broker_failed_closed" });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(state.web[`${HOST}:39002`]).toBeUndefined();
  });

  it("denies a caller outside the uid allowlist", async () => {
    const { broker } = makeBroker(state);
    expect(await broker.handle(exposeReq(39001), PEER_B)).toMatchObject({ ok: false, code: "peer_uid_denied" });
  });

  it("rejects reserved / out-of-range ports before any CLI call", async () => {
    const addSpy = vi.fn(async () => {});
    const cli = makeCli(state, { serveAddHttps: addSpy });
    const { broker } = makeBroker(state, { cli });
    expect(await broker.handle(exposeReq(443), PEER_A)).toMatchObject({ ok: false });
    expect(await broker.handle(exposeReq(8080), PEER_A)).toMatchObject({ ok: false });
    expect(addSpy).not.toHaveBeenCalled();
  });
});

describe("Broker.remove", () => {
  let state: FakeServeState;
  beforeEach(() => {
    state = new FakeServeState();
  });

  it("removes an owned mapping and drops the lease", async () => {
    const { broker, getSaved } = makeBroker(state, { handles: ["H1"] });
    await broker.handle(exposeReq(39001), PEER_A);
    const res = await broker.handle({ v: 1, op: "remove", handle: "H1" }, PEER_A);
    expect(res).toMatchObject({ ok: true, result: { removed: true, idempotent: false } });
    expect(getSaved().leases).toHaveLength(0);
    expect(state.web[`${HOST}:39001`]).toBeUndefined();
    expect(state.tcp["443"]).toEqual({ HTTPS: true });
  });

  it("refuses when peer B tries to remove peer A's lease (verdict #1)", async () => {
    const { broker, getSaved } = makeBroker(state, { config: { allowedUids: [1000, 1001] }, handles: ["H1"] });
    await broker.handle(exposeReq(39001), PEER_A);
    const res = await broker.handle({ v: 1, op: "remove", handle: "H1" }, PEER_B);
    expect(res).toMatchObject({ ok: false, code: "owner_mismatch" });
    expect(getSaved().leases).toHaveLength(1);
    expect(state.web[`${HOST}:39001`]).toBeDefined();
  });

  it("rejects unknown / random / replayed handles with no state change (verdict #1)", async () => {
    const { broker, getSaved } = makeBroker(state, { handles: ["H1"] });
    await broker.handle(exposeReq(39001), PEER_A);
    const res = await broker.handle({ v: 1, op: "remove", handle: "not-a-real-handle" }, PEER_A);
    expect(res).toMatchObject({ ok: false, code: "unknown_handle" });
    expect(getSaved().leases).toHaveLength(1);
  });

  it("is idempotent when the entry is already gone", async () => {
    const { broker, getSaved } = makeBroker(state, { handles: ["H1"] });
    await broker.handle(exposeReq(39001), PEER_A);
    state.remove(39001); // external cleanup
    const res = await broker.handle({ v: 1, op: "remove", handle: "H1" }, PEER_A);
    expect(res).toMatchObject({ ok: true, result: { removed: true, idempotent: true } });
    expect(getSaved().leases).toHaveLength(0);
  });

  it("quarantines on ABA (live entry no longer matches the lease)", async () => {
    const { broker, getSaved } = makeBroker(state, { handles: ["H1"] });
    await broker.handle(exposeReq(39001), PEER_A);
    // Manual mutation swaps the target under the same port.
    state.add(39001, "http://127.0.0.1:39001"); // same target — still matches
    state.web[`${HOST}:39001`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
    const res = await broker.handle({ v: 1, op: "remove", handle: "H1" }, PEER_A);
    expect(res).toMatchObject({ ok: false, code: "entry_mismatch" });
    expect(getSaved().leases[0]?.quarantined).toBe(true);
  });
});

describe("Broker.list", () => {
  it("returns only the caller's leases and never discloses handles (verdict #1/#5)", async () => {
    const state = new FakeServeState();
    const { broker } = makeBroker(state, { config: { allowedUids: [1000, 1001] }, handles: ["HA", "HB"] });
    await broker.handle(exposeReq(39001, "rA"), PEER_A);
    await broker.handle(exposeReq(39002, "rB"), PEER_B);
    const res = (await broker.handle({ v: 1, op: "list" }, PEER_A)) as { ok: true; result: { leases: unknown[] } };
    expect(res.ok).toBe(true);
    expect(res.result.leases).toHaveLength(1);
    expect(JSON.stringify(res.result.leases)).not.toContain("HA");
    expect(res.result.leases[0]).toMatchObject({ runtimeId: "rA", port: 39001 });
  });
});
