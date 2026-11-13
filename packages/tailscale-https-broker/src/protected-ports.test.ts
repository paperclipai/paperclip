/**
 * PAP-17285 regression coverage.
 *
 * Two Serve mappings on `42000/52000` that operators had declared must-preserve
 * were destroyed by a fully authorized managed removal. Reconstructed cause: the
 * broker had itself created those mappings for a since-retired canary lane, so
 * its registry still held an `exposed` lease for them. Every existing guard
 * therefore passed — the peer was authorized, the handle matched, the entries
 * were shape-valid same-number loopback listeners, `:443` was untouched, and the
 * before/after diff saw changes only on the lease's own ports. The pre-existing
 * "unknown/manual entries are never modified" invariant never applied, because
 * the entries were never unknown *to the broker*.
 *
 * These tests pin both halves of the repair:
 *   - a genuinely unrelated unknown/manual pair survives every lifecycle path,
 *     including the failed/compensated ones (the pre-existing guarantee), and
 *   - an operator-protected pair survives even when a valid lease names it (the
 *     new guarantee), with a negative control proving the guard is what does it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "./audit.js";
import { BrokerCore, type CliResult, type ListenerOwnership } from "./broker-core.js";
import { buildExposeArgv, buildRemoveArgv } from "./argv.js";
import { defaultIsAllowedPort, parseProtectedPorts } from "./port-policy.js";
import { changedProtectedPorts, parseServeStatus } from "./serve-config.js";
import { saveRegistry } from "./registry.js";
import type { BrokerRequest, PeerCredentials } from "./types.js";

const HOST = "paperclip-dev.tail29c1aa.ts.net";
const BIN = "/usr/bin/tailscale";
const RUNTIME_A = "2af79bb1-ecc5-4410-8438-091be135a921";
const PEER: PeerCredentials = { uid: 999, gid: 987, pid: 4242 };

/** The pair the incident lost. Same-number loopback, so shape-indistinguishable. */
const PROTECTED_APP = 42000;
const PROTECTED_HMR = 52000;

/**
 * An unrelated unknown/manual pair the broker never created. Deliberately NOT
 * same-number (`42500 -> 5432`) so it is genuinely unknown by shape, which is
 * the population the original invariant protects.
 */
const MANUAL_APP = 42500;
const MANUAL_HMR = 52500;
const MANUAL_APP_TARGET = "http://127.0.0.1:5432";
const MANUAL_HMR_TARGET = "http://127.0.0.1:5433";

class FakeTailscale {
  ports = new Map<number, string>([
    [443, "http://127.0.0.1:3100"],
    [MANUAL_APP, MANUAL_APP_TARGET],
    [MANUAL_HMR, MANUAL_HMR_TARGET],
    [PROTECTED_APP, `http://127.0.0.1:${PROTECTED_APP}`],
    [PROTECTED_HMR, `http://127.0.0.1:${PROTECTED_HMR}`],
  ]);
  /** Funnel stays null for the whole suite; the broker has no Funnel verb. */
  funnel: unknown = null;
  failExposePort: number | null = null;
  /** Simulate a CLI that clobbers an unrelated port as a side effect. */
  strayOnRemove: number | null = null;
  exposeCalls = 0;
  removeCalls = 0;
  removedPorts: number[] = [];

  run = (argv: string[]): CliResult => {
    const [, sub, a2, a3] = argv;
    if (sub === "serve" && a2 === "status") {
      return { code: 0, stdout: this.statusJson(), stderr: "", timedOut: false };
    }
    if (sub === "serve" && a2 === "--bg") {
      this.exposeCalls += 1;
      const port = Number(a3.replace("--https=", ""));
      if (this.failExposePort === port) {
        return { code: 1, stdout: "", stderr: "boom", timedOut: false };
      }
      this.ports.set(port, `http://127.0.0.1:${port}`);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (sub === "serve" && a2.startsWith("--https=") && a3 === "off") {
      this.removeCalls += 1;
      const port = Number(a2.replace("--https=", ""));
      this.removedPorts.push(port);
      this.ports.delete(port);
      if (this.strayOnRemove !== null) this.ports.delete(this.strayOnRemove);
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
    return JSON.stringify({ TCP, Web, AllowFunnel: this.funnel });
  }

  /** Exactly the entries that must never move, as a comparable snapshot. */
  preservedSnapshot() {
    return {
      manualApp: this.ports.get(MANUAL_APP),
      manualHmr: this.ports.get(MANUAL_HMR),
      protectedApp: this.ports.get(PROTECTED_APP),
      protectedHmr: this.ports.get(PROTECTED_HMR),
      primary: this.ports.get(443),
      funnel: this.funnel,
    };
  }
}

const PRESERVED_INTACT = {
  manualApp: MANUAL_APP_TARGET,
  manualHmr: MANUAL_HMR_TARGET,
  protectedApp: `http://127.0.0.1:${PROTECTED_APP}`,
  protectedHmr: `http://127.0.0.1:${PROTECTED_HMR}`,
  primary: "http://127.0.0.1:3100",
  funnel: null,
};

function makeCore(
  fake: FakeTailscale,
  registryPath: string,
  protectedPorts: readonly number[] = [PROTECTED_APP, PROTECTED_HMR],
  ownership: (port: number) => ListenerOwnership = () => ({
    present: true,
    loopbackOnly: true,
    ownerUidMatches: true,
    inodes: ["5001"],
  }),
) {
  const audit = new MemoryAuditSink();
  const core = new BrokerCore({
    tailscaleBinPath: BIN,
    registryPath,
    auditSink: audit,
    peerPolicy: { allowedUids: new Set([999]), allowedGids: new Set([987]) },
    nodeIdentity: "node-1",
    isAllowedPort: (port) => defaultIsAllowedPort(port) && !protectedPorts.includes(port),
    protectedPorts,
    deps: {
      runTailscale: fake.run,
      verifyListenerOwnership: ownership,
      nowIso: () => "2026-08-14T00:00:00.000Z",
    },
  });
  return { core, audit };
}

/**
 * Plant the exact registry state that caused the incident: a live `exposed`
 * lease the broker itself issued for the now-retired lane, still naming the
 * ports operators later declared must-preserve.
 */
function plantRetiredLaneLease(registryPath: string, ports: number[]) {
  const handle = "retired-lane-handle-000000000000";
  saveRegistry(registryPath, {
    version: 1,
    nodeIdentity: "node-1",
    generationCounter: 7,
    leases: [{
      handle,
      runtimeId: RUNTIME_A,
      peerUid: PEER.uid,
      peerGid: PEER.gid,
      ports,
      purposes: ports.map((_, index) => (index === 0 ? "app" : "vite_hmr")),
      state: "exposed",
      generation: 7,
      createdAtIso: "2026-08-11T12:07:18.000Z",
      expiresAtIso: null,
    }],
    quarantinedPorts: [],
  });
  return handle;
}

const reserveReq = (ports: number[], runtimeId = RUNTIME_A): BrokerRequest => ({
  op: "reserve",
  requestId: "req-r",
  runtimeId,
  listeners: ports.map((port, index) => ({
    purpose: index === 0 ? "app" : "vite_hmr",
    port,
  })),
});

let registryPath: string;
beforeEach(() => {
  registryPath = join(mkdtempSync(join(tmpdir(), "broker-protected-")), "registry.json");
});

describe("operator-protected ports (PAP-17285)", () => {
  it("refuses to remove a protected pair even when a valid broker lease names it", async () => {
    // The incident, reproduced: the lease is real, the handle matches, the peer
    // is authorized, and the entries are shape-valid same-number listeners. The
    // ONLY thing that can save them is the operator declaration.
    const fake = new FakeTailscale();
    const handle = plantRetiredLaneLease(registryPath, [PROTECTED_APP, PROTECTED_HMR]);
    const { core, audit } = makeCore(fake, registryPath);

    const res = await core.handle(
      { op: "remove", requestId: "req-d", runtimeId: RUNTIME_A, handle },
      PEER,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("protected_port");
    // Fail-closed: denial precedes every Serve read and mutation.
    expect(fake.removeCalls).toBe(0);
    expect(fake.preservedSnapshot()).toEqual(PRESERVED_INTACT);
    const denial = audit.events.find((event) => event.decision === "deny");
    expect(denial?.reasonCode).toBe("protected_port");
    expect(denial?.op).toBe("remove");
  });

  it("NEGATIVE CONTROL: the identical removal succeeds when the ports are not protected", async () => {
    // Proves the assertion above is carried by the new guard and not by some
    // unrelated precondition — without this, that test could pass vacuously.
    const fake = new FakeTailscale();
    const handle = plantRetiredLaneLease(registryPath, [PROTECTED_APP, PROTECTED_HMR]);
    const { core } = makeCore(fake, registryPath, []); // no protected ports

    const res = await core.handle(
      { op: "remove", requestId: "req-d", runtimeId: RUNTIME_A, handle },
      PEER,
    );

    expect(res.ok).toBe(true);
    if (res.ok && res.op === "remove") {
      expect(res.removedPorts).toEqual([PROTECTED_APP, PROTECTED_HMR]);
    }
    // This is precisely the production loss, reproduced on demand.
    expect(fake.ports.has(PROTECTED_APP)).toBe(false);
    expect(fake.ports.has(PROTECTED_HMR)).toBe(false);
    // Even here the unrelated unknown/manual pair and the primary are untouched.
    expect(fake.ports.get(MANUAL_APP)).toBe(MANUAL_APP_TARGET);
    expect(fake.ports.get(MANUAL_HMR)).toBe(MANUAL_HMR_TARGET);
    expect(fake.ports.get(443)).toBe("http://127.0.0.1:3100");
    expect(fake.funnel).toBeNull();
  });

  it("refuses to reserve or expose a protected port, so no lane can acquire one", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);

    const reserved = await core.handle(reserveReq([PROTECTED_APP, PROTECTED_HMR]), PEER);
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.code).toBe("protected_port");

    // Also unreachable via a lease forged straight into the registry.
    const handle = plantRetiredLaneLease(registryPath, [PROTECTED_APP]);
    const exposed = await core.handle(
      { op: "expose", requestId: "req-x", runtimeId: RUNTIME_A, handle },
      PEER,
    );
    expect(exposed.ok).toBe(false);
    if (!exposed.ok) expect(exposed.code).toBe("protected_port");

    expect(fake.exposeCalls).toBe(0);
    expect(fake.removeCalls).toBe(0);
    expect(fake.preservedSnapshot()).toEqual(PRESERVED_INTACT);
  });

  it("preserves both pairs across a full healthy reserve/expose/remove lifecycle", async () => {
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath);
    const lanePorts = [42010, 52010];

    const reserved = await core.handle(reserveReq(lanePorts), PEER);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");

    const exposed = await core.handle(
      { op: "expose", requestId: "req-x", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(exposed.ok).toBe(true);
    expect(fake.ports.get(42010)).toBe("http://127.0.0.1:42010");
    expect(fake.preservedSnapshot()).toEqual(PRESERVED_INTACT);

    const removed = await core.handle(
      { op: "remove", requestId: "req-d", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(removed.ok).toBe(true);
    expect(fake.ports.has(42010)).toBe(false);
    expect(fake.ports.has(52010)).toBe(false);
    // The whole point: only the lane's own ports moved.
    expect(fake.preservedSnapshot()).toEqual(PRESERVED_INTACT);
  });

  it("preserves both pairs when expose fails midway and is compensated", async () => {
    const fake = new FakeTailscale();
    fake.failExposePort = 52010; // second port fails, first is already applied
    const { core, audit } = makeCore(fake, registryPath);

    const reserved = await core.handle(reserveReq([42010, 52010]), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    const exposed = await core.handle(
      { op: "expose", requestId: "req-x", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );

    expect(exposed.ok).toBe(false);
    if (!exposed.ok) expect(exposed.code).toBe("cli_error");
    // Compensation rolled back the partial application...
    expect(fake.ports.has(42010)).toBe(false);
    // ...and touched nothing it did not apply.
    expect(fake.removedPorts).toEqual([42010]);
    expect(fake.preservedSnapshot()).toEqual(PRESERVED_INTACT);

    // Compensation is a Serve mutation, so it must leave a durable record
    // (req #6). Before this change it emitted none at all.
    const compensation = audit.events.find((event) => event.recovery === "cleanup" && event.op === "expose");
    expect(compensation?.reason).toBe("expose compensated");
  });

  it("detects and quarantines when compensation collaterally changes an unrelated entry", async () => {
    // Requirement #3: any unrelated Serve change must be DETECTED. This path
    // previously trusted the rollback exit code and re-read nothing.
    const fake = new FakeTailscale();
    fake.failExposePort = 52010;
    fake.strayOnRemove = MANUAL_APP; // rollback clobbers an unknown/manual entry
    const { core, audit } = makeCore(fake, registryPath);

    const reserved = await core.handle(reserveReq([42010, 52010]), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    const exposed = await core.handle(
      { op: "expose", requestId: "req-x", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );

    // The original failure is still the reported error — never masked.
    expect(exposed.ok).toBe(false);
    if (!exposed.ok) expect(exposed.code).toBe("cli_error");

    // The collateral damage is detected, recorded, and the port quarantined so
    // it is never silently reused. Recoverability preserved, loss surfaced.
    const denial = audit.events.find((event) => event.reason.startsWith("expose compensation unverified"));
    expect(denial).toBeDefined();
    expect(denial?.reason).toContain(`unexpected_serve_diff:${MANUAL_APP}`);
    expect(denial?.recovery).toBe("quarantine");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(registry.quarantinedPorts).toContain(42010);
  });

  it("detects a protected entry that DISAPPEARS, not just one that is retargeted", () => {
    // The incident was a deletion. `entryDigest(undefined)` is the `"absent"`
    // sentinel precisely so removal is as loud as retargeting.
    const withBoth = parseServeStatus(JSON.parse(new FakeTailscale().run([BIN, "serve", "status", "--json"]).stdout));
    const missing = new FakeTailscale();
    missing.ports.delete(PROTECTED_APP);
    const withoutOne = parseServeStatus(JSON.parse(missing.run([BIN, "serve", "status", "--json"]).stdout));

    expect(changedProtectedPorts(withBoth, withoutOne, [PROTECTED_APP, PROTECTED_HMR])).toEqual([PROTECTED_APP]);
    expect(changedProtectedPorts(withBoth, withBoth, [PROTECTED_APP, PROTECTED_HMR])).toEqual([]);
  });

  it("refuses to build a mutating argv for a protected port", () => {
    const guarded = [PROTECTED_APP, PROTECTED_HMR];
    expect(() => buildExposeArgv(BIN, PROTECTED_APP, guarded)).toThrow(/operator-protected/);
    expect(() => buildRemoveArgv(BIN, PROTECTED_HMR, guarded)).toThrow(/operator-protected/);
    // Unprotected ports in the dedicated range still build exactly as before.
    expect(buildRemoveArgv(BIN, 42010, guarded)).toEqual([BIN, "serve", "--https=42010", "off"]);
    expect(buildExposeArgv(BIN, 42010, guarded)).toEqual([
      BIN, "serve", "--bg", "--https=42010", "http://127.0.0.1:42010",
    ]);
  });

  it("parses BROKER_PROTECTED_PORTS fail-closed", () => {
    expect(parseProtectedPorts(undefined)).toEqual([]);
    expect(parseProtectedPorts("")).toEqual([]);
    expect(parseProtectedPorts("52000,42000")).toEqual([42000, 52000]);
    expect(parseProtectedPorts("42000 52000")).toEqual([42000, 52000]);
    expect(parseProtectedPorts("42000,42000")).toEqual([42000]);
    // A malformed list must stop the broker, not silently protect nothing.
    expect(() => parseProtectedPorts("42000,abc")).toThrow(/non-numeric/);
    expect(() => parseProtectedPorts("70000")).toThrow(/out-of-range/);
    expect(() => parseProtectedPorts("443")).toThrow(/must not list 443/);
  });
});
