import { describe, expect, it } from "vitest";
import {
  ServeParseError,
  assertPrimaryIntact,
  changedPorts,
  isSameNumberLoopbackEntry,
  parseServeStatus,
  primaryDigest,
} from "./serve-config.js";

const HOST = "paperclip-dev.tail29c1aa.ts.net";

function serve(ports: Record<number, string | null>): unknown {
  const TCP: Record<string, unknown> = {};
  const Web: Record<string, unknown> = {};
  for (const [portStr, proxy] of Object.entries(ports)) {
    TCP[portStr] = { HTTPS: true };
    Web[`${HOST}:${portStr}`] = { Handlers: { "/": { Proxy: proxy } } };
  }
  return { TCP, Web };
}

const PRIMARY = { 443: "http://127.0.0.1:3100" };

describe("parseServeStatus", () => {
  it("normalizes TCP + Web into port entries", () => {
    const parsed = parseServeStatus(serve({ ...PRIMARY, 42010: "http://127.0.0.1:42010" }));
    expect(parsed.entries.get(42010)?.https).toBe(true);
    expect(isSameNumberLoopbackEntry(parsed.entries.get(42010), 42010)).toBe(true);
  });

  it("fails closed on malformed shapes", () => {
    expect(() => parseServeStatus(null)).toThrow(ServeParseError);
    expect(() => parseServeStatus({ TCP: [] })).toThrow(ServeParseError);
    expect(() => parseServeStatus({ Web: { "no-port": {} } })).toThrow(ServeParseError);
  });

  it("tolerates unknown top-level fields", () => {
    expect(() => parseServeStatus({ ...(serve(PRIMARY) as object), AllowFunnel: {} })).not.toThrow();
  });
});

describe(":443 invariant", () => {
  it("asserts the primary route intact", () => {
    const parsed = parseServeStatus(serve(PRIMARY));
    expect(() => assertPrimaryIntact(parsed)).not.toThrow();
  });

  it("throws when :443 is missing or retargeted", () => {
    expect(() => assertPrimaryIntact(parseServeStatus(serve({ 42010: "http://127.0.0.1:42010" })))).toThrow();
    expect(() => assertPrimaryIntact(parseServeStatus(serve({ 443: "http://127.0.0.1:9999" })))).toThrow();
  });

  it("produces a stable digest that changes only when :443 changes", () => {
    const a = primaryDigest(parseServeStatus(serve({ ...PRIMARY, 42010: "http://127.0.0.1:42010" })));
    const b = primaryDigest(parseServeStatus(serve({ ...PRIMARY, 42011: "http://127.0.0.1:42011" })));
    expect(a).toBe(b);
    const c = primaryDigest(parseServeStatus(serve({ 443: "http://127.0.0.1:9999" })));
    expect(c).not.toBe(a);
  });
});

describe("changedPorts", () => {
  it("detects only the ports whose entry differs", () => {
    const before = parseServeStatus(serve({ ...PRIMARY }));
    const after = parseServeStatus(serve({ ...PRIMARY, 42010: "http://127.0.0.1:42010" }));
    expect(changedPorts(before, after)).toEqual([42010]);
  });
});
