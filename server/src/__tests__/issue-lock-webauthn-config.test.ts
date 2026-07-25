import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import { resolveCookieSecure, resolveRp } from "../routes/issue-lock-webauthn.js";

// MAT-131 — superagent-security findings on PR #10240:
//  - RP ID / origin must not be derived from the client-controlled Host header.
//  - The unlock cookie `Secure` flag must not depend on the unreliable req.protocol.
// These are pure config resolvers, so they can be unit-tested without a DB.

const WEBAUTHN_ENV_KEYS = [
  "WEBAUTHN_RP_ID",
  "WEBAUTHN_ORIGIN",
  "WEBAUTHN_COOKIE_SECURE",
  "COOKIE_SECURE",
  "NODE_ENV",
] as const;

function fakeReq(host: string, protocol: "http" | "https"): Request {
  return {
    protocol,
    get: (name: string) => (name.toLowerCase() === "host" ? host : undefined),
  } as unknown as Request;
}

describe("issue-lock WebAuthn config resolvers", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of WEBAUTHN_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of WEBAUTHN_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("resolveRp", () => {
    it("prefers statically configured RP ID and origin over the request host", () => {
      process.env.WEBAUTHN_RP_ID = "app.example.com";
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com";
      // Attacker-controlled Host header must be ignored.
      const rp = resolveRp(fakeReq("evil.attacker.test", "http"));
      expect(rp).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
    });

    it("derives rpID from a configured origin when only the origin is set", () => {
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com:8443";
      const rp = resolveRp(fakeReq("evil.attacker.test", "http"));
      expect(rp).toEqual({ rpID: "app.example.com", origin: "https://app.example.com:8443" });
    });

    it("normalises WEBAUTHN_ORIGIN to a bare origin, stripping path/query/fragment", () => {
      // A browser WebAuthn response carries only the origin; a configured URL with
      // a path would never match expectedOrigin and silently break verification.
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com/paperclip?x=1#frag";
      const rp = resolveRp(fakeReq("evil.attacker.test", "http"));
      expect(rp).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
    });

    it("fails closed when WEBAUTHN_ORIGIN is malformed or scheme-less", () => {
      process.env.WEBAUTHN_ORIGIN = "app.example.com"; // no scheme -> not a valid URL
      expect(() => resolveRp(fakeReq("localhost:3000", "http"))).toThrow(/WEBAUTHN_ORIGIN/);
    });

    it("fails closed when WEBAUTHN_ORIGIN is an opaque / non-http(s) origin", () => {
      process.env.WEBAUTHN_ORIGIN = "foo:bar"; // parses but origin === "null"
      expect(() => resolveRp(fakeReq("localhost:3000", "http"))).toThrow(/http\(s\) origin/);
    });

    it("fails closed for a non-loopback http origin (WebAuthn requires https)", () => {
      process.env.WEBAUTHN_ORIGIN = "http://app.example.com";
      expect(() => resolveRp(fakeReq("localhost:3000", "http"))).toThrow(/https for non-loopback/);
    });

    it("allows an http origin on loopback", () => {
      process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
      const rp = resolveRp(fakeReq("evil.attacker.test", "http"));
      expect(rp).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
    });

    it("fails closed when WEBAUTHN_RP_ID is not the origin host or a parent domain", () => {
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com";
      process.env.WEBAUTHN_RP_ID = "other.test";
      expect(() => resolveRp(fakeReq("evil.attacker.test", "http"))).toThrow(/must equal the WEBAUTHN_ORIGIN host/);
    });

    it("accepts an RP ID that is a registrable parent domain of the origin host", () => {
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com";
      process.env.WEBAUTHN_RP_ID = "example.com";
      const rp = resolveRp(fakeReq("evil.attacker.test", "http"));
      expect(rp).toEqual({ rpID: "example.com", origin: "https://app.example.com" });
    });

    it("fails closed for a public-suffix / bare-TLD RP ID", () => {
      process.env.WEBAUTHN_ORIGIN = "https://app.example.com";
      process.env.WEBAUTHN_RP_ID = "com";
      expect(() => resolveRp(fakeReq("evil.attacker.test", "http"))).toThrow(/public suffix/);
    });

    it("fails closed when only the RP ID is configured (origin cannot be reconstructed safely)", () => {
      // `https://<rpID>` is wrong for subdomains / non-default ports, and WebAuthn
      // requires an exact origin match — require WEBAUTHN_ORIGIN instead of guessing.
      process.env.WEBAUTHN_RP_ID = "app.example.com";
      expect(() => resolveRp(fakeReq("evil.attacker.test", "http"))).toThrow(/WEBAUTHN_ORIGIN/);
    });

    it("falls back to the request host only for local development", () => {
      const rp = resolveRp(fakeReq("localhost:3000", "http"));
      expect(rp).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
    });

    it("fails closed for a non-loopback host when nothing is configured", () => {
      // A supplied Host must never pick the RP ID / origin: require explicit config.
      expect(() => resolveRp(fakeReq("evil.attacker.test", "http"))).toThrow(/not configured/i);
    });

    it("accepts an IPv6 loopback host (bracketed) for local development", () => {
      const rp = resolveRp(fakeReq("[::1]:51506", "http"));
      expect(rp).toEqual({ rpID: "::1", origin: "http://[::1]:51506" });
    });
  });

  describe("resolveCookieSecure", () => {
    it("honours an explicit WEBAUTHN_COOKIE_SECURE override", () => {
      process.env.NODE_ENV = "development";
      process.env.WEBAUTHN_COOKIE_SECURE = "true";
      expect(resolveCookieSecure()).toBe(true);
    });

    it("honours an explicit COOKIE_SECURE=false override in production", () => {
      process.env.NODE_ENV = "production";
      process.env.COOKIE_SECURE = "false";
      expect(resolveCookieSecure()).toBe(false);
    });

    it("defaults to secure in production", () => {
      process.env.NODE_ENV = "production";
      expect(resolveCookieSecure()).toBe(true);
    });

    it("defaults to not-secure in development", () => {
      process.env.NODE_ENV = "development";
      expect(resolveCookieSecure()).toBe(false);
    });
  });
});
