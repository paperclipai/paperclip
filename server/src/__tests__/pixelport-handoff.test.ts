import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PIXELPORT_HANDOFF_CONTRACT_VERSION,
  verifyPixelportHandoffToken,
} from "../auth/pixelport-handoff.js";

function signPayload(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function buildPayload(nowEpochSeconds: number) {
  return {
    v: PIXELPORT_HANDOFF_CONTRACT_VERSION,
    iss: "pixelport-launchpad",
    aud: "paperclip-runtime",
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + 300,
    jti: "jti-1",
    source: "onboarding-launch",
    user_id: "user-123",
    tenant_id: "tenant-123",
    tenant_slug: "acme",
    tenant_status: "active",
    tenant_plan: "pro",
  };
}

describe("pixelport handoff token verification", () => {
  const now = 1_760_000_000;
  const secret = "handoff-secret";

  it("accepts a valid token", () => {
    const token = signPayload(buildPayload(now), secret);
    const result = verifyPixelportHandoffToken(token, secret, now + 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.user_id).toBe("user-123");
  });

  it("rejects a token with an invalid signature", () => {
    const token = signPayload(buildPayload(now), secret);
    const tampered = `${token.slice(0, -1)}x`;
    const result = verifyPixelportHandoffToken(tampered, secret, now + 5);
    expect(result).toMatchObject({ ok: false, code: "invalid-signature" });
  });

  it("rejects an expired token", () => {
    const token = signPayload(buildPayload(now), secret);
    const result = verifyPixelportHandoffToken(token, secret, now + 301);
    expect(result).toMatchObject({ ok: false, code: "expired" });
  });

  it("rejects invalid contract claims", () => {
    const token = signPayload({ ...buildPayload(now), iss: "another-issuer" }, secret);
    const result = verifyPixelportHandoffToken(token, secret, now + 1);
    expect(result).toMatchObject({ ok: false, code: "invalid-claims" });
  });

  it("rejects when secret is missing", () => {
    const token = signPayload(buildPayload(now), secret);
    const result = verifyPixelportHandoffToken(token, "", now + 1);
    expect(result).toMatchObject({ ok: false, code: "missing-secret" });
  });

  it("rejects malformed token format", () => {
    const result = verifyPixelportHandoffToken("only-one-part", secret, now + 1);
    expect(result).toMatchObject({ ok: false, code: "invalid-format" });
  });

  it("rejects invalid payload JSON", () => {
    const encodedPayload = Buffer.from("not-json", "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
    const token = `${encodedPayload}.${signature}`;
    const result = verifyPixelportHandoffToken(token, secret, now + 1);
    expect(result).toMatchObject({ ok: false, code: "invalid-payload" });
  });

  it("rejects future iat beyond skew", () => {
    const token = signPayload(buildPayload(now + 120), secret);
    const result = verifyPixelportHandoffToken(token, secret, now);
    expect(result).toMatchObject({ ok: false, code: "invalid-claims" });
  });
});
