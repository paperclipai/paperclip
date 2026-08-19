import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRegistry, persistRegistry, type RegistryFile } from "../tailscale-broker/registry.js";
import { parseServeState, assertPrimaryPresent, assertOnlyPortChanged } from "../tailscale-broker/serve-state.js";
import { sanitizeEvent, createJsonlAuditSink, type AuditEvent } from "../tailscale-broker/audit.js";

const HOST = "paperclip-dev.tailnet.ts.net";

function serveJson(extra: Record<string, unknown> = {}, extraTcp: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } }, ...extra },
    TCP: { "443": { HTTPS: true }, ...extraTcp },
  });
}

// Verdict #3 — atomic ownership registry.
describe("registry persistence", () => {
  it("round-trips atomically with 0600 mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "broker-reg-"));
    const file = path.join(dir, "registry.json");
    const data: RegistryFile = {
      version: 1,
      generation: 3,
      leases: [
        { handle: "h", runtimeId: "r", port: 39001, target: "http://127.0.0.1:39001", peerUid: 1000, peerGid: 2000, generation: 3, entryDigest: "d", createdAt: 1 },
      ],
    };
    persistRegistry(file, data);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadRegistry(file)).toEqual(data);
  });

  it("returns an empty registry when the file is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "broker-reg-"));
    expect(loadRegistry(path.join(dir, "missing.json"))).toEqual({ version: 1, generation: 0, leases: [] });
  });

  it("fails closed on a corrupt registry", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "broker-reg-"));
    const file = path.join(dir, "registry.json");
    writeFileSync(file, "{not json");
    expect(() => loadRegistry(file)).toThrow(/corrupt/);
  });

  it("fails closed on a malformed lease", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "broker-reg-"));
    const file = path.join(dir, "registry.json");
    writeFileSync(file, JSON.stringify({ version: 1, generation: 0, leases: [{ handle: 1 }] }));
    expect(() => loadRegistry(file)).toThrow(/malformed/);
  });
});

// Verdict #3 + invariants — serve-state protection.
describe("serve-state invariants", () => {
  it("accepts the primary :443 mapping", () => {
    assertPrimaryPresent(parseServeState(serveJson()));
  });

  it("rejects a missing or altered :443 mapping (fail closed)", () => {
    expect(() => assertPrimaryPresent(parseServeState(JSON.stringify({ Web: {}, TCP: {} })))).toThrow(/primary_missing|absent/);
    const altered = JSON.stringify({
      Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } },
      TCP: { "443": { HTTPS: true } },
    });
    expect(() => assertPrimaryPresent(parseServeState(altered))).toThrow(/primary_altered|not http/);
  });

  it("allows exactly the intended port to change", () => {
    const before = parseServeState(serveJson());
    const after = parseServeState(serveJson({ [`${HOST}:39001`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:39001" } } } }, { "39001": { HTTPS: true } }));
    assertOnlyPortChanged(before, after, 39001);
  });

  it("throws when :443 drifts during a mutation", () => {
    const before = parseServeState(serveJson());
    const afterBad = JSON.stringify({
      Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" } } }, [`${HOST}:39001`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:39001" } } } },
      TCP: { "443": { HTTPS: false }, "39001": { HTTPS: true } },
    });
    expect(() => assertOnlyPortChanged(before, parseServeState(afterBad), 39001)).toThrow(/changed during mutation/);
  });

  it("throws when an unrelated entry changes during a mutation", () => {
    const before = parseServeState(serveJson({ [`${HOST}:45000`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:45000" } } } }, { "45000": { HTTPS: true } }));
    const after = parseServeState(serveJson(
      {
        [`${HOST}:45000`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1234" } } },
        [`${HOST}:39001`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:39001" } } },
      },
      { "45000": { HTTPS: true }, "39001": { HTTPS: true } },
    ));
    expect(() => assertOnlyPortChanged(before, after, 39001)).toThrow(/unexpected_diff|unexpected/);
  });
});

// Verdict #6 — audit redaction.
describe("audit redaction", () => {
  const base: AuditEvent = {
    ts: 1, correlationId: "c", op: "expose", decision: "allow", reason: "ok",
    peerUid: 1000, peerGid: 2000, peerPid: 5, runtimeId: "r", port: 39001,
    beforeDigest: "b", afterDigest: "a", cliOutcome: "add_ok", recovery: null,
  };

  it("strips control characters / newlines to prevent log forging", () => {
    const forged = sanitizeEvent({ ...base, reason: "line1\nFAKE decision=deny\rmore\tx" });
    expect(forged.reason).not.toMatch(/[\r\n\t]/);
  });

  it("bounds field length", () => {
    const long = sanitizeEvent({ ...base, reason: "x".repeat(5000) });
    expect(long.reason.length).toBeLessThanOrEqual(201);
  });

  it("never emits a lease handle (handles are not part of the event shape)", () => {
    const lines: string[] = [];
    createJsonlAuditSink((l) => lines.push(l)).write(base);
    expect(lines[0]).not.toContain("handle");
  });
});
