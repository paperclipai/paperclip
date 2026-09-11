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
  statusCalls = 0;

  run = (argv: string[]): CliResult => {
    const [, sub, a2, a3] = argv;
    if (sub === "serve" && a2 === "status") {
      this.statusCalls += 1;
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
    inodes: ["5001"],
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

  it("names which listener predicate failed, and every one of them still denies (SSRF guard)", async () => {
    // One code per predicate, so a denial is attributable from the client reply
    // alone: `safeMessage()` returns the bare code and the discriminating reason
    // reaches only the root-owned audit file, which the calling account cannot
    // read. Distinguishing them relaxes nothing — all three deny below.
    for (const { ownership, code } of [
      { ownership: { present: false, loopbackOnly: true, ownerUidMatches: true, inodes: [] }, code: "listener_absent" },
      { ownership: { present: true, loopbackOnly: false, ownerUidMatches: true, inodes: ["5001"] }, code: "listener_not_loopback" },
      { ownership: { present: true, loopbackOnly: true, ownerUidMatches: false, inodes: ["5001"] }, code: "listener_ownership_mismatch" },
    ]) {
      const fake = new FakeTailscale();
      const { core, audit } = makeCore(fake, registryPath, () => ownership);
      const res = await reserveAndExpose(core);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe(code);

      // Fail-closed: the denial precedes every Serve read and mutation, so the
      // requested port is never published and the primary route is untouched.
      expect(fake.exposeCalls).toBe(0);
      expect(fake.removeCalls).toBe(0);
      expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);

      // The discriminating detail must still reach the audit trail.
      const denial = audit.events.find((event) => event.decision === "deny");
      expect(denial?.reasonCode).toBe(code);
      expect(denial?.op).toBe("expose");
    }
  });

  it("denies a listener that is present and correctly owned but cannot be named", async () => {
    // Present-but-unattributable is not permission. Without a socket identity
    // the broker cannot prove the socket it publishes is the socket it verified,
    // so it must refuse rather than fall through to "the predicates passed".
    const fake = new FakeTailscale();
    const { core, audit } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [],
    }));
    const res = await reserveAndExpose(core);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("listener_unattributable");
    expect(fake.exposeCalls).toBe(0);
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
    expect(audit.events.find((event) => event.decision === "deny")?.reasonCode).toBe(
      "listener_unattributable",
    );
  });

  it("denies before publishing when the listener is substituted during the Serve status read", async () => {
    // The window Greptile found: pre-flight verifies the listener, then
    // `readServe()` runs a `tailscale` subprocess. A process under the same
    // managed-runtime UID can close the verified socket and take the port during
    // that subprocess. The three boolean predicates cannot see it — the new
    // process satisfies all of them — so only the socket identity changes.
    // Publishing then maps tailnet HTTPS at a service that was never authorized.
    const fake = new FakeTailscale();
    // Armed relative to the start of expose, because reserve already reads Serve
    // status once. The swap therefore lands on expose's own status subprocess —
    // after its pre-flight verification, before it publishes anything.
    let statusReadsBeforeExpose = 0;
    const { core, audit } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [fake.statusCalls > statusReadsBeforeExpose ? "9999" : "5001"],
    }));

    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    statusReadsBeforeExpose = fake.statusCalls;

    const res = await core.handle(
      { op: "expose", requestId: "req-sub", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("listener_substituted");

    // Fail closed *before* the mutation: the substituted service is never
    // published, so only the pre-existing primary route remains.
    expect(fake.exposeCalls).toBe(0);
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
    expect(audit.events.find((event) => event.decision === "deny")?.reasonCode).toBe(
      "listener_substituted",
    );
  });

  it("withdraws the mapping when substitution happens after the port is published", async () => {
    // If the swap lands after the mutation instead, the post-publication re-proof
    // denies inside the try, so compensation removes what was applied rather
    // than leaving a substituted service reachable over HTTPS.
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [fake.exposeCalls >= 1 ? "9999" : "5001"],
    }));

    const res = await reserveAndExpose(core);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("listener_substituted");

    // The port was published, then withdrawn by compensation.
    expect(fake.exposeCalls).toBeGreaterThan(0);
    expect(fake.removeCalls).toBeGreaterThan(0);
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
  });

  it("withdraws an idempotently-skipped mapping whose listener was substituted", async () => {
    // The gap a skipped mapping opens: on a re-expose the port already carries
    // our exact same-number entry, so the apply loop skips it and it never
    // enters `appliedPorts`. Denying alone would leave that pre-existing mapping
    // active and now pointing at the replacement service, so a rejected request
    // would still publish something unauthorized.
    const fake = new FakeTailscale();
    // Swap armed relative to the start of the *second* expose, so it lands after
    // that request's pre-flight verification — the same window as before, but on
    // a port the apply loop will skip instead of publish.
    let statusReadsBeforeReExpose = Number.POSITIVE_INFINITY;
    const { core } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [fake.statusCalls > statusReadsBeforeReExpose ? "9999" : "5001"],
    }));

    // First expose publishes the port for real.
    const first = await reserveAndExpose(core);
    expect(first.ok).toBe(true);
    expect(fake.ports.get(42010)).toBe("http://127.0.0.1:42010");
    const exposeCallsAfterFirst = fake.exposeCalls;

    // Re-expose the same port. The mapping already matches, so the apply loop
    // takes the idempotent path and publishes nothing.
    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    statusReadsBeforeReExpose = fake.statusCalls;

    const second = await core.handle(
      { op: "expose", requestId: "req-again", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("listener_substituted");
    expect(fake.exposeCalls).toBe(exposeCallsAfterFirst); // nothing re-published

    // The substituted mapping must not survive the rejected request.
    expect(fake.removeCalls).toBeGreaterThan(0);
    expect(fake.ports.has(42010)).toBe(false);
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
  });

  it("still withdraws a substituted idempotent mapping when a reserved lease published nothing", async () => {
    // A `reserved` lease has published nothing, so a substitution detected on it
    // must deny without withdrawing anything: there is no mapping of ours to
    // remove, and removing by port number would delete someone else's.
    const fake = new FakeTailscale();
    let statusReadsBeforeExpose = Number.POSITIVE_INFINITY;
    const { core } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [fake.statusCalls > statusReadsBeforeExpose ? "9999" : "5001"],
    }));

    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    statusReadsBeforeExpose = fake.statusCalls;

    const res = await core.handle(
      { op: "expose", requestId: "req-res", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("listener_substituted");
    // Nothing of ours was published, so nothing is published now.
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
  });

  it("withdraws a substituted idempotent mapping without depending on a readable Serve status", async () => {
    // The withdrawal decision must not hinge on a live status read. If it did, a
    // status read that fails at exactly the wrong moment would make the broker
    // return `listener_substituted` while leaving the replacement service
    // exposed. Provenance comes from the `exposed` lease instead, so the remove
    // is still issued.
    const fake = new FakeTailscale();
    let statusReadsBeforeReExpose = Number.POSITIVE_INFINITY;
    const { core } = makeCore(fake, registryPath, () => ({
      present: true,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: [fake.statusCalls > statusReadsBeforeReExpose ? "9999" : "5001"],
    }));

    const first = await reserveAndExpose(core);
    expect(first.ok).toBe(true);
    const removeCallsAfterFirst = fake.removeCalls;

    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");
    statusReadsBeforeReExpose = fake.statusCalls;

    const second = await core.handle(
      { op: "expose", requestId: "req-noread", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("listener_substituted");

    // The remove was issued for the substituted port even though this request
    // published nothing itself.
    expect(fake.removeCalls).toBeGreaterThan(removeCallsAfterFirst);
    expect(fake.ports.has(42010)).toBe(false);
  });

  it("withdraws a published mapping when the listener disappears entirely", async () => {
    // Absent is not "unchanged". A closed listener leaves the mapping pointing at
    // nothing, which a later process on that port would inherit, so it must be
    // withdrawn like any other substitution.
    const fake = new FakeTailscale();
    const { core } = makeCore(fake, registryPath, () => ({
      present: fake.exposeCalls === 0,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: fake.exposeCalls === 0 ? ["5001"] : [],
    }));

    const res = await reserveAndExpose(core);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("listener_substituted");
    expect(fake.removeCalls).toBeGreaterThan(0);
    expect([...fake.ports]).toEqual([[443, "http://127.0.0.1:3100"]]);
  });

  it("denies an absent listener without consuming the reservation or touching Serve", async () => {
    // A denial is pure: it neither publishes a mapping nor burns the lease. No
    // production caller retries an exposure today (deliberately — a retry needs
    // its own reproduced requirement and wiring); this pins the broker-side
    // state purity that any such caller, or a plain operator re-run, relies on.
    const fake = new FakeTailscale();
    let bound = false;
    const { core } = makeCore(fake, registryPath, () => ({
      present: bound,
      loopbackOnly: true,
      ownerUidMatches: true,
      inodes: bound ? ["5001"] : [],
    }));
    const reserved = await core.handle(reserveReq(), PEER);
    if (!reserved.ok || reserved.op !== "reserve") throw new Error("reserve failed");

    const denied = await core.handle(
      { op: "expose", requestId: "req-x1", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("listener_absent");
    expect(fake.exposeCalls).toBe(0);
    expect(fake.ports.has(42010)).toBe(false);

    // Once the child is actually bound, the very same reservation still exposes.
    bound = true;
    const exposed = await core.handle(
      { op: "expose", requestId: "req-x2", runtimeId: RUNTIME_A, handle: reserved.handle },
      PEER,
    );
    expect(exposed.ok).toBe(true);
    expect(fake.ports.get(42010)).toBe("http://127.0.0.1:42010");
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
        verifyListenerOwnership: () => ({ present: true, loopbackOnly: true, ownerUidMatches: true, inodes: ["5001"] }),
        nowIso: () => "2026-08-11T00:00:00.000Z",
      },
    });
    const res = await core2.handle(reserveReq(RUNTIME_B, 42011), PEER);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("quarantined");
  });
});
