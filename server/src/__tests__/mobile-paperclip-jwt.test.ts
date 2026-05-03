import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMobilePaperclipJwtConfigured, verifyMobilePaperclipJwt } from "../mobile-paperclip-jwt.js";

const SECRET_ENV = "MOBILE_PAPERCLIP_JWT_SECRET";
const ISSUER_ENV = "MOBILE_PAPERCLIP_JWT_ISSUER";
const AUDIENCE_ENV = "MOBILE_PAPERCLIP_JWT_AUDIENCE";

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

interface SignOpts {
  secret: string;
  alg?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
  email?: string;
}

function signJwt(opts: SignOpts) {
  const header = { alg: opts.alg ?? "HS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "user-1",
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 300,
    iss: opts.iss ?? "mobile-paperclip",
    aud: opts.aud ?? "paperclip-server",
  };
  if (opts.email !== undefined) claims.email = opts.email;
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", opts.secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("verifyMobilePaperclipJwt", () => {
  const originalEnv = {
    secret: process.env[SECRET_ENV],
    issuer: process.env[ISSUER_ENV],
    audience: process.env[AUDIENCE_ENV],
  };

  beforeEach(() => {
    process.env[SECRET_ENV] = "test-mobile-secret";
    delete process.env[ISSUER_ENV];
    delete process.env[AUDIENCE_ENV];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = originalEnv.secret;
    if (originalEnv.issuer === undefined) delete process.env[ISSUER_ENV];
    else process.env[ISSUER_ENV] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[AUDIENCE_ENV];
    else process.env[AUDIENCE_ENV] = originalEnv.audience;
  });

  it("verifies a token signed with the configured secret + iss/aud", () => {
    const token = signJwt({ secret: "test-mobile-secret", sub: "rchen", email: "rchen@example.com" });
    const claims = verifyMobilePaperclipJwt(token);
    expect(claims).toMatchObject({
      sub: "rchen",
      email: "rchen@example.com",
      iss: "mobile-paperclip",
      aud: "paperclip-server",
    });
  });

  it("returns null when the secret is not configured", () => {
    delete process.env[SECRET_ENV];
    expect(isMobilePaperclipJwtConfigured()).toBe(false);
    const token = signJwt({ secret: "anything" });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("rejects a token signed with the wrong secret", () => {
    const token = signJwt({ secret: "WRONG" });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("rejects a token with the wrong issuer", () => {
    const token = signJwt({ secret: "test-mobile-secret", iss: "evil-issuer" });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("rejects a token with the wrong audience", () => {
    const token = signJwt({ secret: "test-mobile-secret", aud: "evil-audience" });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ secret: "test-mobile-secret", iat: now - 600, exp: now - 60 });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyMobilePaperclipJwt("not-a-token")).toBeNull();
    expect(verifyMobilePaperclipJwt("")).toBeNull();
    expect(verifyMobilePaperclipJwt("a.b")).toBeNull();
  });

  it("rejects a token with an unsupported algorithm", () => {
    const token = signJwt({ secret: "test-mobile-secret", alg: "none" });
    expect(verifyMobilePaperclipJwt(token)).toBeNull();
  });

  it("honors custom issuer/audience env overrides", () => {
    process.env[ISSUER_ENV] = "custom-issuer";
    process.env[AUDIENCE_ENV] = "custom-audience";
    const token = signJwt({
      secret: "test-mobile-secret",
      iss: "custom-issuer",
      aud: "custom-audience",
    });
    expect(verifyMobilePaperclipJwt(token)).toMatchObject({
      iss: "custom-issuer",
      aud: "custom-audience",
    });
  });
});
