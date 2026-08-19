import { describe, expect, it } from "vitest";
import { InvalidIntegerError, parseCanonicalUint, parsePort } from "../tailscale-broker/integers.js";
import {
  PolicyError,
  assertExposablePort,
  assertLoopbackBindAddress,
  assertLoopbackTarget,
} from "../tailscale-broker/policy.js";
import {
  ProtocolError,
  decodeRequestFrame,
  parseJsonNoDuplicateKeys,
  validateRequest,
} from "../tailscale-broker/protocol.js";

// Verdict #4 — canonical integer parsing / injection resistance.
describe("canonical integer parsing", () => {
  it("accepts plain non-negative integers", () => {
    expect(parseCanonicalUint(0)).toBe(0);
    expect(parseCanonicalUint(39001)).toBe(39001);
    expect(parseCanonicalUint("39001")).toBe(39001);
  });

  it.each([
    "+8443",
    "-8443",
    " 8443",
    "8443 ",
    "8443\n",
    "08443",
    "0x2103",
    "1e4",
    "8443.0",
    "٤٤", // arabic-indic digits
    "８４４３", // fullwidth digits
    "",
    "abc",
  ])("rejects non-canonical string %j", (value) => {
    expect(() => parseCanonicalUint(value)).toThrow(InvalidIntegerError);
  });

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects non-integer number %j", (value) => {
    expect(() => parseCanonicalUint(value)).toThrow(InvalidIntegerError);
  });

  it("rejects objects/arrays/booleans/null", () => {
    for (const v of [{}, [], true, null, undefined]) {
      expect(() => parseCanonicalUint(v)).toThrow(InvalidIntegerError);
    }
  });

  it("enforces the 1-65535 port range", () => {
    expect(parsePort(39001)).toBe(39001);
    expect(() => parsePort(0)).toThrow(InvalidIntegerError);
    expect(() => parsePort(70000)).toThrow(InvalidIntegerError);
  });
});

// Verdict #2 + invariants — port / target policy.
describe("port and target policy", () => {
  it("accepts a same-number loopback exposure in range", () => {
    expect(assertExposablePort(39001, 39001)).toBe(39001);
    assertLoopbackTarget("http://127.0.0.1:39001", 39001);
  });

  it("rejects mismatched public/target ports", () => {
    expect(() => assertExposablePort(39001, 39002)).toThrow(PolicyError);
  });

  it.each([443, 22, 3100, 5432, 6379])("rejects always-denied port %i", (port) => {
    expect(() => assertExposablePort(port, port)).toThrow(/reserved|privileged|out of range/);
  });

  it("rejects privileged and out-of-range ports", () => {
    expect(() => assertExposablePort(80, 80)).toThrow(PolicyError);
    expect(() => assertExposablePort(8080, 8080)).toThrow(/outside the dedicated/);
    expect(() => assertExposablePort(60000, 60000)).toThrow(/outside the dedicated/);
  });

  it.each([
    "https://127.0.0.1:39001",
    "http://0.0.0.0:39001",
    "http://example.com:39001",
    "http://127.0.0.1:39001/admin",
    "http://127.0.0.1:39001/?x=1",
    "http://user:pass@127.0.0.1:39001",
    "http://127.0.0.1:39002",
  ])("rejects unsafe target %j", (target) => {
    expect(() => assertLoopbackTarget(target, 39001)).toThrow(PolicyError);
  });

  it("rejects wildcard / non-loopback bind addresses", () => {
    expect(() => assertLoopbackBindAddress("0.0.0.0")).toThrow(/wildcard/);
    expect(() => assertLoopbackBindAddress("::")).toThrow(/wildcard/);
    expect(() => assertLoopbackBindAddress("10.0.0.5")).toThrow(/not loopback/);
    assertLoopbackBindAddress("127.0.0.1");
    assertLoopbackBindAddress("::1");
  });
});

// Verdict #4 + #5 — protocol strictness.
describe("wire protocol", () => {
  it("rejects duplicate JSON keys", () => {
    expect(() => parseJsonNoDuplicateKeys('{"op":"list","op":"expose"}')).toThrow(ProtocolError);
  });

  it("accepts a well-formed nested object without duplicates", () => {
    expect(parseJsonNoDuplicateKeys('{"v":1,"op":"expose","runtimeId":"r"}')).toEqual({
      v: 1,
      op: "expose",
      runtimeId: "r",
    });
  });

  it("validates a list request", () => {
    expect(validateRequest({ v: 1, op: "list" })).toEqual({ v: 1, op: "list" });
  });

  it("rejects unknown fields", () => {
    expect(() => validateRequest({ v: 1, op: "list", extra: 1 })).toThrow(/unknown field/);
  });

  it("rejects unsupported versions and operations", () => {
    expect(() => validateRequest({ v: 2, op: "list" })).toThrow(/unsupported protocol version/);
    expect(() => validateRequest({ v: 1, op: "reset" })).toThrow(/unknown operation/);
  });

  it("rejects oversized frames", () => {
    const huge = `${JSON.stringify({ v: 1, op: "list" })}${" ".repeat(9000)}`;
    expect(() => decodeRequestFrame(huge)).toThrow(/exceeds/);
  });

  it("rejects frames with embedded newlines", () => {
    expect(() => decodeRequestFrame('{"v":1,\n"op":"list"}')).toThrow(/bad_frame|frame/);
  });

  it("decodes a valid expose frame (port left for policy layer)", () => {
    const req = decodeRequestFrame(
      `${JSON.stringify({ v: 1, op: "expose", runtimeId: "r1", port: 39001, target: "http://127.0.0.1:39001", reservation: "res" })}\n`,
    );
    expect(req).toMatchObject({ op: "expose", runtimeId: "r1", port: 39001 });
  });
});
