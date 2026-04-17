import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "./agent-auth-jwt.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const ADAPTER_TYPE = "claude_local";
const RUN_ID = "run-123";

// ---------------------------------------------------------------------------
// Setup: inject a test JWT secret via environment variable
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

function setJwtSecret(secret: string) {
  process.env.PAPERCLIP_AGENT_JWT_SECRET = secret;
}

function clearJwtSecret() {
  delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
}

beforeEach(() => {
  setJwtSecret("test-secret-for-unit-tests");
});

afterEach(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  clearJwtSecret();
  // Restore original env if keys were overridden
  if (ORIGINAL_ENV.PAPERCLIP_AGENT_JWT_SECRET) {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = ORIGINAL_ENV.PAPERCLIP_AGENT_JWT_SECRET;
  }
  if (ORIGINAL_ENV.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET = ORIGINAL_ENV.BETTER_AUTH_SECRET;
  }
});

// ---------------------------------------------------------------------------
// createLocalAgentJwt
// ---------------------------------------------------------------------------

describe("createLocalAgentJwt", () => {
  it("returns a non-null token when a JWT secret is set", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID);
    expect(token).not.toBeNull();
  });

  it("returns null when no JWT secret is configured", () => {
    clearJwtSecret();
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID);
    expect(token).toBeNull();
  });

  it("returns a string with three dot-separated parts (header.claims.sig)", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID);
    expect(token!.split(".")).toHaveLength(3);
  });

  it("produces different tokens for different agentIds", () => {
    const t1 = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID);
    const t2 = createLocalAgentJwt("cccccccc-cccc-4ccc-cccc-cccccccccccc", COMPANY_ID, ADAPTER_TYPE, RUN_ID);
    expect(t1).not.toBe(t2);
  });

  it("produces different tokens for different runIds", () => {
    const t1 = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, "run-1");
    const t2 = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, "run-2");
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// verifyLocalAgentJwt
// ---------------------------------------------------------------------------

describe("verifyLocalAgentJwt", () => {
  it("returns null for an empty string", () => {
    expect(verifyLocalAgentJwt("")).toBeNull();
  });

  it("returns null for a malformed token (wrong number of parts)", () => {
    expect(verifyLocalAgentJwt("header.claims")).toBeNull();
    expect(verifyLocalAgentJwt("only-one-part")).toBeNull();
  });

  it("returns null for a token with an invalid signature", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.invalidsignature`;
    expect(verifyLocalAgentJwt(tampered)).toBeNull();
  });

  it("returns claims for a valid token created by createLocalAgentJwt", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    const claims = verifyLocalAgentJwt(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(AGENT_ID);
    expect(claims!.company_id).toBe(COMPANY_ID);
    expect(claims!.adapter_type).toBe(ADAPTER_TYPE);
    expect(claims!.run_id).toBe(RUN_ID);
  });

  it("returns null when the JWT secret changes (signature mismatch)", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    // Change the secret to simulate a key rotation
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "different-secret";
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("returns null when no JWT secret is configured", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    clearJwtSecret();
    expect(verifyLocalAgentJwt(token)).toBeNull();
  });

  it("returns claims with exp and iat timestamps", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    const after = Math.floor(Date.now() / 1000);
    const claims = verifyLocalAgentJwt(token)!;
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("returns null for a token with tampered claims", () => {
    const token = createLocalAgentJwt(AGENT_ID, COMPANY_ID, ADAPTER_TYPE, RUN_ID)!;
    const parts = token.split(".");
    // Modify the claims section to tamper with the agentId
    const fakeClaims = Buffer.from(
      JSON.stringify({ sub: "hacker", company_id: COMPANY_ID, adapter_type: ADAPTER_TYPE, run_id: RUN_ID, iat: 0, exp: 9999999999 }),
    ).toString("base64url");
    const tampered = `${parts[0]}.${fakeClaims}.${parts[2]}`;
    expect(verifyLocalAgentJwt(tampered)).toBeNull();
  });
});
