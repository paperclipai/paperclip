import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  isMobilePaperclipPublicHostname,
  mobilePaperclipAuthGuard,
} from "../middleware/mobile-paperclip-auth.js";

const SECRET_ENV = "MOBILE_PAPERCLIP_JWT_SECRET";

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signJwt(opts: {
  secret: string;
  sub?: string;
  iss?: string;
  aud?: string;
  exp?: number;
}) {
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: opts.sub ?? "rchen",
    iat: Math.floor(Date.now() / 1000),
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 300,
    iss: opts.iss ?? "mobile-paperclip",
    aud: opts.aud ?? "paperclip-server",
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", opts.secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

function makeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    headers: lower,
    header(name: string) {
      return lower[name.toLowerCase()];
    },
    actor: { type: "board", source: "local_implicit" },
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("isMobilePaperclipPublicHostname", () => {
  it("returns false for loopback even when in the allowlist", () => {
    expect(
      isMobilePaperclipPublicHostname("localhost", new Set(["localhost", "paperclip-rchen.api.example.com"])),
    ).toBe(false);
    expect(
      isMobilePaperclipPublicHostname("127.0.0.1", new Set(["127.0.0.1"])),
    ).toBe(false);
  });

  it("returns true only for hostnames present in the public set", () => {
    const set = new Set(["paperclip-rchen.api.example.com"]);
    expect(isMobilePaperclipPublicHostname("paperclip-rchen.api.example.com", set)).toBe(true);
    expect(isMobilePaperclipPublicHostname("evil.example.com", set)).toBe(false);
    expect(isMobilePaperclipPublicHostname(null, set)).toBe(false);
  });
});

describe("mobilePaperclipAuthGuard", () => {
  const originalEnv = process.env[SECRET_ENV];

  beforeEach(() => {
    process.env[SECRET_ENV] = "test-mobile-secret";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = originalEnv;
  });

  it("is a no-op when disabled", () => {
    const guard = mobilePaperclipAuthGuard({ enabled: false, publicHostnames: new Set(["paperclip-rchen.api.example.com"]) });
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(true);
  });

  it("is a no-op when public-hostname set is empty", () => {
    const guard = mobilePaperclipAuthGuard({ enabled: true, publicHostnames: new Set() });
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(true);
  });

  it("passes loopback requests through without requiring a JWT", () => {
    const guard = mobilePaperclipAuthGuard({
      enabled: true,
      publicHostnames: new Set(["paperclip-rchen.api.example.com"]),
    });
    const req = makeReq({ host: "localhost:3100" });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(true);
    expect(req.actor.source).toBe("local_implicit");
  });

  it("rejects public-hostname requests without a bearer token", () => {
    const guard = mobilePaperclipAuthGuard({
      enabled: true,
      publicHostnames: new Set(["paperclip-rchen.api.example.com"]),
    });
    const req = makeReq({ host: "paperclip-rchen.api.example.com" });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(false);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
  });

  it("rejects public-hostname requests with a bogus bearer token", () => {
    const guard = mobilePaperclipAuthGuard({
      enabled: true,
      publicHostnames: new Set(["paperclip-rchen.api.example.com"]),
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: "Bearer not-a-valid-jwt",
    });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(false);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
  });

  it("accepts public-hostname requests with a valid JWT and sets a board actor", () => {
    const token = signJwt({ secret: "test-mobile-secret", sub: "rchen" });
    const guard = mobilePaperclipAuthGuard({
      enabled: true,
      publicHostnames: new Set(["paperclip-rchen.api.example.com"]),
    });
    const req = makeReq({
      host: "paperclip-rchen.api.example.com",
      authorization: `Bearer ${token}`,
    });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    expect(calledNext).toBe(true);
    expect(req.actor).toMatchObject({
      type: "board",
      userId: "mobile-paperclip:rchen",
      source: "mobile_paperclip_jwt",
      isInstanceAdmin: true,
    });
    expect(req.mobilePaperclipClaims?.sub).toBe("rchen");
  });

  it("respects x-forwarded-host over host", () => {
    const guard = mobilePaperclipAuthGuard({
      enabled: true,
      publicHostnames: new Set(["paperclip-rchen.api.example.com"]),
    });
    const req = makeReq({
      host: "localhost:3100",
      "x-forwarded-host": "paperclip-rchen.api.example.com",
    });
    const res = makeRes();
    let calledNext = false;
    guard(req, res, (() => {
      calledNext = true;
    }) as NextFunction);
    // Without auth, public-hostname enforcement should reject even though host header is loopback.
    expect(calledNext).toBe(false);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(401);
  });
});
