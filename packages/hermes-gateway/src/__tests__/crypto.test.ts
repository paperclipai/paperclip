import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "../crypto.js";

describe("crypto", () => {
  const secret = "test-secret-key";

  it("signs and verifies a payload", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signPayload(secret, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("rejects tampered payload", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signPayload(secret, body);
    const tampered = JSON.stringify({ hello: "tampered" });
    expect(verifySignature(secret, tampered, sig)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = signPayload("wrong-secret", body);
    expect(verifySignature(secret, body, sig)).toBe(false);
  });
});
