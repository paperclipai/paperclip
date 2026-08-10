import { describe, expect, it } from "vitest";
import {
  decideBoardTokenException,
  decideTokenLedgerWarning,
  HIGH_INPUT_TOKEN_RUN_THRESHOLD,
  TOKEN_LEDGER_WARN_THRESHOLD,
} from "../services/heartbeat.js";

describe("token-ledger soft warning", () => {
  it("does not warn below the 250k total threshold", () => {
    expect(decideTokenLedgerWarning({
      totalTokens: TOKEN_LEDGER_WARN_THRESHOLD - 1,
      totalInputTokens: 10_000,
    })).toBe("none");
  });

  it("warns at the 250k total threshold", () => {
    expect(decideTokenLedgerWarning({
      totalTokens: TOKEN_LEDGER_WARN_THRESHOLD,
      totalInputTokens: 200_000,
    })).toBe("warn");
  });

  it("counts output tokens toward the total (input+cache below, total above)", () => {
    // 200k input+cache + 60k output = 260k total => warn even though input alone is under.
    expect(decideTokenLedgerWarning({
      totalTokens: 260_000,
      totalInputTokens: 200_000,
    })).toBe("warn");
  });

  it("defers to the hard >=1M guard: no soft warning once input crosses 1M", () => {
    expect(decideTokenLedgerWarning({
      totalTokens: 2_000_000,
      totalInputTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD,
    })).toBe("none");
  });
});

describe("board token exception gate", () => {
  const now = new Date("2026-08-10T12:00:00.000Z");
  const future = new Date("2026-08-11T12:00:00.000Z");
  const past = new Date("2026-08-09T12:00:00.000Z");
  const over = HIGH_INPUT_TOKEN_RUN_THRESHOLD + 500_000; // 1.5M

  it("returns none when there is no exception on record", () => {
    expect(decideBoardTokenException({
      exception: null,
      totalInputTokens: over,
      now,
    })).toBe("none");
  });

  it("allows a run whose input is within an unrevoked, unexpired cap", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: 2_000_000, expiresAt: future, revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("allow");
  });

  it("blocks (expired) when the exception has lapsed", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: 2_000_000, expiresAt: past, revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("expired");
  });

  it("treats the exact expiry instant as expired (strict > comparison)", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: 2_000_000, expiresAt: now, revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("expired");
  });

  it("blocks (revoked) when the exception was revoked", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: 2_000_000, expiresAt: future, revokedAt: past },
      totalInputTokens: over,
      now,
    })).toBe("revoked");
  });

  it("blocks (cap_exceeded) when the run's input exceeds the authorized cap", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: HIGH_INPUT_TOKEN_RUN_THRESHOLD + 100_000, expiresAt: future, revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("cap_exceeded");
  });

  it("allows a run exactly at the cap boundary", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: over, expiresAt: future, revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("allow");
  });

  it("parses ISO-string expiry timestamps (raw SQL boundary)", () => {
    expect(decideBoardTokenException({
      exception: { capTokens: 2_000_000, expiresAt: future.toISOString(), revokedAt: null },
      totalInputTokens: over,
      now,
    })).toBe("allow");
  });
});
