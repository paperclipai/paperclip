import { describe, expect, it } from "vitest";
import express from "express";
import { applyTrustProxy, parseTrustProxyEnv } from "../middleware/trust-proxy.js";

function appWithEnv(raw: string | undefined): express.Express {
  const app = express();
  applyTrustProxy(app, parseTrustProxyEnv(raw));
  return app;
}

describe("parseTrustProxyEnv", () => {
  it("unset leaves Express at its safe default (trust nothing)", () => {
    // Express's default trust-proxy setting is `false`. We verify the
    // setting is unchanged by comparing against a vanilla express()
    // instance that never had `applyTrustProxy` called on it.
    const baseline = express().get("trust proxy");
    const app = appWithEnv(undefined);
    expect(parseTrustProxyEnv(undefined)).toBeUndefined();
    expect(app.get("trust proxy")).toBe(baseline);
  });

  it("empty / false / 0 are treated as unset", () => {
    expect(parseTrustProxyEnv("")).toBeUndefined();
    expect(parseTrustProxyEnv("false")).toBeUndefined();
    expect(parseTrustProxyEnv("0")).toBeUndefined();
    const baseline = express().get("trust proxy");
    expect(appWithEnv("0").get("trust proxy")).toBe(baseline);
  });

  it("'true' yields boolean true and sets app accordingly", () => {
    expect(parseTrustProxyEnv("true")).toBe(true);
    expect(appWithEnv("true").get("trust proxy")).toBe(true);
  });

  it("positive integer is parsed as a number", () => {
    expect(parseTrustProxyEnv("2")).toBe(2);
    expect(appWithEnv("2").get("trust proxy")).toBe(2);
  });

  it("'01' throws (strict integer, no leading zeros)", () => {
    expect(() => parseTrustProxyEnv("01")).toThrow(/invalid integer/);
  });

  it("integer with internal whitespace throws", () => {
    // A value like "1 2" (digits + whitespace + digits) is clearly not
    // a single int and not a subnet list either — must be rejected.
    // This is distinct from " 2 " (surrounding whitespace), which the
    // outer `raw.trim()` accepts; see the next test for that contract.
    // The parser happens to reach the subnet-token path for "1 2"
    // (the inner-whitespace integer guard only fires when the whole
    // string is `^\s*\d+\s*$`), so we match the unrecognized-token
    // error rather than the "invalid integer" branch.
    expect(() => parseTrustProxyEnv("1 2")).toThrow(/unrecognized token "1 2"/);
  });

  it("integer with surrounding whitespace is accepted (trimmed)", () => {
    // The parser intentionally trims the *outer* value before matching,
    // so " 2 " is equivalent to "2". Locking this in so the contract
    // doesn't drift relative to the "internal whitespace throws" case.
    expect(parseTrustProxyEnv(" 2 ")).toBe(2);
    expect(appWithEnv(" 2 ").get("trust proxy")).toBe(2);
  });

  it("'loopback' yields a single-element array", () => {
    const v = parseTrustProxyEnv("loopback");
    expect(v).toEqual(["loopback"]);
    const app = appWithEnv("loopback");
    expect(app.get("trust proxy")).toEqual(["loopback"]);
  });

  it("'loopback,uniquelocal' yields a 2-element array", () => {
    expect(parseTrustProxyEnv("loopback,uniquelocal")).toEqual([
      "loopback",
      "uniquelocal",
    ]);
  });

  it("IPv4 CIDR is accepted", () => {
    expect(parseTrustProxyEnv("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
  });

  it("mixed IPv4 + IPv6 CIDR list is accepted with whitespace tolerance", () => {
    expect(parseTrustProxyEnv(" 10.0.0.0/8 , fd00::/8 ")).toEqual([
      "10.0.0.0/8",
      "fd00::/8",
    ]);
  });

  it("'bogus' throws with a helpful message naming the bad token", () => {
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/bogus/);
    expect(() => parseTrustProxyEnv("bogus")).toThrow(/loopback/);
  });

  it("partial-garbage list throws on the bad token, not silently dropped", () => {
    expect(() => parseTrustProxyEnv("loopback,not-a-cidr")).toThrow(
      /not-a-cidr/,
    );
  });
});
