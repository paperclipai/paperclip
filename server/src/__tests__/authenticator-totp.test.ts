import { describe, expect, it } from "vitest";
import { currentTotp } from "../routes/authenticators.js";

describe("company authenticator TOTP", () => {
  it("generates the RFC 6238 SHA-1 code without exposing the seed", () => {
    const result = currentTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000);
    expect(result.code).toBe("287082");
    expect(result.expiresAt).toBe("1970-01-01T00:01:00.000Z");
    expect(result).not.toHaveProperty("secret");
  });
});
