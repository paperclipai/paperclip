import { describe, it, expect, vi } from "vitest";
import { createAgentAuthExchangeRoute, type AgentAuthExchangeDeps } from "./agent-auth-exchange.js";

function deps(overrides?: Partial<AgentAuthExchangeDeps>): AgentAuthExchangeDeps {
  return {
    bootstrapTokens: {
      validateAndConsume: vi.fn(async () => ({
        ok: true as const,
        binding: { agentId: "a-1", companyId: "c-1", runId: "r-1", jobUid: "j-1" },
      })),
      mint: vi.fn(),
      purgeExpired: vi.fn(async () => 0),
    },
    runJwt: {
      mint: vi.fn(() => "fake.jwt.value"),
      verify: vi.fn(),
    },
    runJwtTtlSeconds: 3600,
    ...overrides,
  };
}

describe("POST /api/agent-auth/exchange", () => {
  it("returns runJwt + expiresAt on success", async () => {
    const handler = createAgentAuthExchangeRoute(deps());
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runJwt: "fake.jwt.value", expiresAt: expect.any(String) });
  });

  it("returns 400 token_already_consumed on replay", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "already_consumed" as const }),
        mint: vi.fn(),
        purgeExpired: vi.fn(async () => 0),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "token_already_consumed" });
  });

  it("returns 400 token_expired", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "expired" as const }),
        mint: vi.fn(),
        purgeExpired: vi.fn(async () => 0),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_abc" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "token_expired" });
  });

  it("returns 400 invalid_token for unknown tokens", async () => {
    const handler = createAgentAuthExchangeRoute(deps({
      bootstrapTokens: {
        validateAndConsume: async () => ({ ok: false as const, reason: "not_found" as const }),
        mint: vi.fn(),
        purgeExpired: vi.fn(async () => 0),
      },
    }));
    const res = await handler({ bootstrapToken: "bst_xyz" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_token" });
  });

  it("returns 400 missing_token when body lacks bootstrapToken", async () => {
    const handler = createAgentAuthExchangeRoute(deps());
    const res = await handler({} as never);
    expect(res.status).toBe(400);
  });
});
