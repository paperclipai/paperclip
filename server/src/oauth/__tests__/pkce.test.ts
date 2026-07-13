import { describe, it, expect } from "vitest";
import { generateCodeVerifier, deriveCodeChallenge } from "../pkce.js";

describe("PKCE", () => {
  it("generates a base64url verifier of at least 43 characters", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("derives the RFC 7636 sample challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(deriveCodeChallenge(verifier)).toBe(expected);
  });
});
