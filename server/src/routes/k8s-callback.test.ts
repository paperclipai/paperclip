import { describe, expect, it, vi } from "vitest";
import { runEventsRateLimitKey } from "./k8s-callback.js";
import type { RunJwtService } from "../services/run-jwt.js";

function runJwt(overrides?: Partial<RunJwtService>): RunJwtService {
  return {
    mint: vi.fn(),
    verify: vi.fn(() => ({
      ok: true as const,
      claims: {
        iss: "paperclip" as const,
        aud: "paperclip-run" as const,
        runId: "verified-run",
        agentId: "agent-1",
        companyId: "company-1",
        jobUid: "job-1",
        exp: 9_999_999_999,
      },
    })),
    ...overrides,
  };
}

describe("runEventsRateLimitKey", () => {
  it("keys authenticated event requests by verified JWT run id", () => {
    expect(runEventsRateLimitKey({
      authorization: "Bearer fake.jwt",
      clientIp: "203.0.113.1",
      runJwt: runJwt(),
    })).toBe("run:verified-run");
  });

  it("falls back to client IP when authorization is missing", () => {
    expect(runEventsRateLimitKey({
      clientIp: "203.0.113.2",
      runJwt: runJwt(),
    })).toBe("ip:203.0.113.2");
  });

  it("falls back to client IP when the JWT is invalid", () => {
    expect(runEventsRateLimitKey({
      authorization: "Bearer bad.jwt",
      clientIp: "203.0.113.3",
      runJwt: runJwt({
        verify: vi.fn(() => ({ ok: false as const, reason: "bad_signature" as const })),
      }),
    })).toBe("ip:203.0.113.3");
  });
});
