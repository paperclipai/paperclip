import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  ADMIN_OVERRIDE_CONSTANTS,
  createAdminOverrideJwt,
  verifyAdminOverrideJwt,
} from "../admin-override-jwt.js";

const VALID_KEY = "test-admin-override-key-long-enough-for-prod";

const sample = {
  subject: "user-nikolaj",
  issueId: "550e8400-e29b-41d4-a716-446655440000",
  oldStatus: "in_review",
  newStatus: "done",
  reason: "ceo-binding-board-approval-2026-04-22",
  jti: "0193b4c0-0000-7000-8000-000000000001",
};

function b64uEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(key: string, signingInput: string) {
  return createHmac("sha256", key).update(signingInput).digest("base64url");
}

function mintRaw(claims: Record<string, unknown>, header?: Record<string, unknown>, key = VALID_KEY) {
  const headerObj = header ?? { alg: "HS256", typ: "JWT" };
  const input = `${b64uEncode(JSON.stringify(headerObj))}.${b64uEncode(JSON.stringify(claims))}`;
  const signature = sign(key, input);
  return `${input}.${signature}`;
}

function freshClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "paperclip-ui",
    aud: "paperclip-admin-override",
    sub: sample.subject,
    jti: sample.jti,
    iat: now,
    exp: now + 60,
    issue_id: sample.issueId,
    old_status: sample.oldStatus,
    new_status: sample.newStatus,
    reason: sample.reason,
    ...overrides,
  };
}

describe("admin-override-jwt", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY = VALID_KEY;
  });

  describe("createAdminOverrideJwt", () => {
    it("returns null when the signing key is not configured", () => {
      delete process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY;
      expect(createAdminOverrideJwt({ ...sample, ttlSeconds: 60 })).toBeNull();
    });

    it("clamps ttl to <=300s", () => {
      const token = createAdminOverrideJwt({ ...sample, ttlSeconds: 9999 });
      expect(token).not.toBeNull();
      const result = verifyAdminOverrideJwt(token!);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.exp - result.claims.iat).toBeLessThanOrEqual(
          ADMIN_OVERRIDE_CONSTANTS.ttlMaxSeconds,
        );
      }
    });

    it("uses the primary (first) key when multiple are configured", () => {
      process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY = `${VALID_KEY}, previous-key-for-rotation`;
      const token = createAdminOverrideJwt({ ...sample, ttlSeconds: 60 });
      expect(token).not.toBeNull();
      const result = verifyAdminOverrideJwt(token!);
      expect(result.ok).toBe(true);
    });
  });

  describe("verifyAdminOverrideJwt rejection matrix", () => {
    it("rejects empty token", () => {
      const result = verifyAdminOverrideJwt("");
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_missing" });
    });

    it("rejects when signing key is not configured", () => {
      delete process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY;
      const result = verifyAdminOverrideJwt("a.b.c");
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_secret_missing" });
    });

    it("rejects malformed token", () => {
      expect(verifyAdminOverrideJwt("not-a-jwt").ok).toBe(false);
      expect(verifyAdminOverrideJwt("only.two").ok).toBe(false);
    });

    it("rejects wrong algorithm", () => {
      const token = mintRaw(freshClaims(), { alg: "none" });
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_alg_invalid" });
    });

    it("rejects forged signature", () => {
      const token = mintRaw(freshClaims(), undefined, "wrong-key");
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_signature_invalid" });
    });

    it("accepts a valid signature from any configured key (rotation)", () => {
      process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY = `${VALID_KEY}, previous-rotation-key`;
      const tokenFromOldKey = mintRaw(freshClaims(), undefined, "previous-rotation-key");
      const result = verifyAdminOverrideJwt(tokenFromOldKey);
      expect(result.ok).toBe(true);
    });

    it("rejects wrong issuer", () => {
      const token = mintRaw(freshClaims({ iss: "not-paperclip-ui" }));
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_issuer_invalid" });
    });

    it("rejects wrong audience", () => {
      const token = mintRaw(freshClaims({ aud: "different-audience" }));
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_audience_invalid" });
    });

    it("rejects expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = mintRaw(freshClaims({ iat: now - 120, exp: now - 10 }));
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_expired" });
    });

    it("rejects when TTL exceeds 300 seconds", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = mintRaw(freshClaims({ iat: now, exp: now + 3600 }));
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_ttl_exceeded" });
    });

    it("rejects reason shorter than 20 chars", () => {
      const token = mintRaw(freshClaims({ reason: "too short" }));
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_reason_invalid" });
    });

    it("rejects when claims are missing", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = mintRaw({
        iss: "paperclip-ui",
        aud: "paperclip-admin-override",
        iat: now,
        exp: now + 60,
      });
      const result = verifyAdminOverrideJwt(token);
      expect(result).toEqual({ ok: false, error: "admin_override_jwt_claims_missing" });
    });

    it("accepts a fully-valid token and returns strongly-typed claims", () => {
      const token = createAdminOverrideJwt({ ...sample, ttlSeconds: 60 });
      expect(token).not.toBeNull();
      const result = verifyAdminOverrideJwt(token!);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims).toMatchObject({
          iss: "paperclip-ui",
          aud: "paperclip-admin-override",
          sub: sample.subject,
          jti: sample.jti,
          issue_id: sample.issueId,
          old_status: sample.oldStatus,
          new_status: sample.newStatus,
          reason: sample.reason,
        });
      }
    });
  });
});
