import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { runJwtService } from "./run-jwt.js";

const secret = "0".repeat(32);

function b64url(input: unknown): string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function sign(header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const encoded = `${b64url(header)}.${b64url(claims)}`;
  const sig = createHmac("sha256", Buffer.from(secret)).update(encoded).digest().toString("base64url");
  return `${encoded}.${sig}`;
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
      expect(v.claims.iss).toBe("paperclip");
      expect(v.claims.aud).toBe("paperclip-run");
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

  it("rejects a validly signed token with the wrong header alg", () => {
    const svc = runJwtService(secret);
    const t = sign(
      { alg: "none", typ: "JWT" },
      { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", iss: "paperclip", aud: "paperclip-run", exp: 9_999_999_999 },
    );
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });

  it("rejects a validly signed token with the wrong audience", () => {
    const svc = runJwtService(secret);
    const t = sign(
      { alg: "HS256", typ: "JWT" },
      { runId: "r-1", agentId: "a-1", companyId: "c-1", jobUid: "j-1", iss: "paperclip", aud: "other", exp: 9_999_999_999 },
    );
    const v = svc.verify(t);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("malformed");
  });
});
