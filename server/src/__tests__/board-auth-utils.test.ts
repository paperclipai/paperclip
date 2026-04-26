import { describe, it, expect } from "vitest";
import {
  BOARD_API_KEY_TTL_MS,
  CLI_AUTH_CHALLENGE_TTL_MS,
  hashBearerToken,
  tokenHashesMatch,
  createBoardApiToken,
  createCliAuthSecret,
  boardApiKeyExpiresAt,
  cliAuthChallengeExpiresAt,
} from "../services/board-auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("board-auth constants", () => {
  it("BOARD_API_KEY_TTL_MS is 30 days in milliseconds", () => {
    expect(BOARD_API_KEY_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("CLI_AUTH_CHALLENGE_TTL_MS is 10 minutes in milliseconds", () => {
    expect(CLI_AUTH_CHALLENGE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// hashBearerToken
// ---------------------------------------------------------------------------

describe("hashBearerToken", () => {
  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = hashBearerToken("my-secret-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(hashBearerToken("abc")).toBe(hashBearerToken("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashBearerToken("token-a")).not.toBe(hashBearerToken("token-b"));
  });

  it("handles empty string input", () => {
    const hash = hashBearerToken("");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// tokenHashesMatch
// ---------------------------------------------------------------------------

describe("tokenHashesMatch", () => {
  it("returns true for identical strings", () => {
    const h = hashBearerToken("token");
    expect(tokenHashesMatch(h, h)).toBe(true);
  });

  it("returns false for strings that differ by one character", () => {
    const h1 = hashBearerToken("token-a");
    const h2 = hashBearerToken("token-b");
    expect(tokenHashesMatch(h1, h2)).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(tokenHashesMatch("short", "a-much-longer-string")).toBe(false);
  });

  it("is symmetric", () => {
    const h1 = hashBearerToken("x");
    const h2 = hashBearerToken("y");
    expect(tokenHashesMatch(h1, h2)).toBe(tokenHashesMatch(h2, h1));
  });
});

// ---------------------------------------------------------------------------
// createBoardApiToken
// ---------------------------------------------------------------------------

describe("createBoardApiToken", () => {
  it("starts with the pcp_board_ prefix", () => {
    expect(createBoardApiToken()).toMatch(/^pcp_board_/);
  });

  it("contains 48 hex characters after the prefix (24 random bytes)", () => {
    const token = createBoardApiToken();
    const hex = token.slice("pcp_board_".length);
    expect(hex).toMatch(/^[0-9a-f]{48}$/);
  });

  it("generates unique tokens on each call", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => createBoardApiToken()));
    expect(tokens.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// createCliAuthSecret
// ---------------------------------------------------------------------------

describe("createCliAuthSecret", () => {
  it("starts with the pcp_cli_auth_ prefix", () => {
    expect(createCliAuthSecret()).toMatch(/^pcp_cli_auth_/);
  });

  it("contains 48 hex characters after the prefix", () => {
    const secret = createCliAuthSecret();
    const hex = secret.slice("pcp_cli_auth_".length);
    expect(hex).toMatch(/^[0-9a-f]{48}$/);
  });

  it("generates unique secrets on each call", () => {
    const secrets = new Set(Array.from({ length: 10 }, () => createCliAuthSecret()));
    expect(secrets.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// boardApiKeyExpiresAt
// ---------------------------------------------------------------------------

describe("boardApiKeyExpiresAt", () => {
  it("returns a Date 30 days after the given timestamp", () => {
    const nowMs = 1_700_000_000_000;
    const result = boardApiKeyExpiresAt(nowMs);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(nowMs + BOARD_API_KEY_TTL_MS);
  });

  it("defaults to approximately now when no argument is given", () => {
    const before = Date.now();
    const result = boardApiKeyExpiresAt();
    const after = Date.now();
    const expectedMin = before + BOARD_API_KEY_TTL_MS;
    const expectedMax = after + BOARD_API_KEY_TTL_MS;
    expect(result.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});

// ---------------------------------------------------------------------------
// cliAuthChallengeExpiresAt
// ---------------------------------------------------------------------------

describe("cliAuthChallengeExpiresAt", () => {
  it("returns a Date 10 minutes after the given timestamp", () => {
    const nowMs = 1_700_000_000_000;
    const result = cliAuthChallengeExpiresAt(nowMs);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(nowMs + CLI_AUTH_CHALLENGE_TTL_MS);
  });

  it("defaults to approximately now when no argument is given", () => {
    const before = Date.now();
    const result = cliAuthChallengeExpiresAt();
    const after = Date.now();
    const expectedMin = before + CLI_AUTH_CHALLENGE_TTL_MS;
    const expectedMax = after + CLI_AUTH_CHALLENGE_TTL_MS;
    expect(result.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});
