import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { runJwtService } from "./run-jwt.js";

const secret = "0".repeat(32);

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(header: unknown, claims: unknown): string {
  const headerEncoded = b64url(JSON.stringify(header));
  const claimsEncoded = b64url(JSON.stringify(claims));
  const signing = `${headerEncoded}.${claimsEncoded}`;
  const sig = createHmac("sha256", Buffer.from(secret)).update(signing).digest();
  return `${signing}.${b64url(sig)}`;
}

describe("runJwtService", () => {
  it("mints and verifies a token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const v = svc.verify(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.runId).toBe("r-1");
      expect(v.claims.jobUid).toBe("j-1");
    }
  });

  it("rejects a tampered token", () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 60 });
    const tampered = t.slice(0, -2) + "AA";
    const v = svc.verify(tampered);
    expect(v.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const svc = runJwtService(secret);
    const t = svc.mint({ runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", ttlSeconds: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("rejects a correctly signed token with an unsupported alg header", () => {
    const svc = runJwtService(secret);
    const t = sign(
      { alg: "none", typ: "JWT" },
      { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", exp: Math.floor(Date.now() / 1000) + 60 },
    );
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });
});
