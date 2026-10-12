import { describe, expect, it, vi } from "vitest";
import { probeAiConnectionUsage } from "./ai-connection-usage.js";

const auth = JSON.stringify({ tokens: { access_token: "selected-access-secret", account_id: "selected-account" } });
function fixture(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("connection usage probes", () => {
  it("reads every Codex window, preserves percentages and separates model restrictions", async () => {
    const request = fixture({ plan_type: "pro", rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 0.4, limit_window_seconds: 14400, reset_at: 1800000000 },
      secondary_window: { used_percent: 99.99, limit_window_seconds: 604800 },
    }, additional_rate_limits: [{ limit_name: "Spark", metered_feature: "spark", rate_limit: {
      allowed: false, limit_reached: true, primary_window: { used_percent: 101.2, limit_window_seconds: 7200 },
    } }], credits: { has_credits: true, unlimited: false, balance: "25.5" } });
    const result = await probeAiConnectionUsage({ provider: "openai", method: "subscription" }, auth, { request });
    expect(result.status).toBe("ok");
    expect(result.limits).toHaveLength(3);
    expect(result.limits[0]).toMatchObject({ scope: null, usedPercent: 0.4, remainingPercent: 99.6, windowDurationSeconds: 14400, resetsAt: new Date(1800000000000).toISOString() });
    expect(result.limits[1]).toMatchObject({ usedPercent: 99.99, limitReached: false, resetsAt: null });
    expect(result.limits[2]).toMatchObject({ scope: "spark", usedPercent: 101.2, remainingPercent: 0, limitReached: true, allowed: false });
    expect(result.overage).toMatchObject({ enabled: null, available: true, balance: 25.5, unit: "credits" });
    expect(request).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer selected-access-secret", "ChatGPT-Account-Id": "selected-account" },
    }));
    expect(JSON.stringify(result)).not.toContain("selected-access-secret");
  });

  it("keeps group denial without pretending every Codex window is exhausted", async () => {
    const result = await probeAiConnectionUsage({ provider: "openai", method: "subscription" }, auth, { request: fixture({
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 }, secondary_window: { used_percent: 25 } },
      code_review_rate_limit: { allowed: false, limit_reached: true },
      spend_control: { reached: true }, credits: { has_credits: false, unlimited: false, balance: "0" },
    }) });
    expect(result.limits).toHaveLength(4);
    expect(result.limits[1]).toMatchObject({ limitReached: false, allowed: false });
    expect(result.limits[2]).toMatchObject({ scope: "code_review", limitReached: true });
    expect(result.overage?.available).toBe(false);
  });

  it("reports all Claude scopes and distinguishes extra-usage settings from availability", async () => {
    const request = fixture({ five_hour: { utilization: 100, resets_at: "2026-10-03T01:00:00Z" },
      seven_day: { utilization: 0.5 }, seven_day_opus: { utilization: null },
      seven_day_oauth_apps: { utilization: 33 }, future_window: { utilization: 10, resets_at: null },
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000, utilization: 20 },
    });
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "claude-selected-secret", { request });
    expect(result.status).toBe("ok");
    expect(result.limits).toHaveLength(6);
    expect(result.limits[0]).toMatchObject({ usedPercent: 100, limitReached: true, windowDurationSeconds: 18000 });
    expect(result.limits[1]).toMatchObject({ usedPercent: 0.5, remainingPercent: 99.5, windowDurationSeconds: 604800 });
    expect(result.limits[2]).toMatchObject({ usedPercent: null, limitReached: null });
    expect(result.limits[3].scope).toBe("seven_day_oauth_apps");
    expect(result.overage).toMatchObject({ enabled: true, available: null, remaining: 4000, unit: "cents" });
    expect(request).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({
      headers: { Authorization: "Bearer claude-selected-secret", "anthropic-beta": "oauth-2025-04-20" },
    }));
  });

  it.each([
    { is_enabled: false, available: false },
    { is_enabled: true, monthly_limit: 100, used_credits: 100, available: false },
  ])("reports unavailable Claude overage without inventing remaining allowance", async ({ available, ...extra_usage }) => {
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ five_hour: { utilization: 100 }, extra_usage }),
    });
    expect(result.overage?.available).toBe(available);
  });

  it("reads Claude's structured limits, merges legacy aliases, and keeps every scoped window", async () => {
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ five_hour: { utilization: 15 }, seven_day: { utilization: 25 }, seven_day_sonnet: { utilization: 50 },
        limits: [
          { kind: "session", percent: 16, scope: null, is_active: false },
          { kind: "weekly_all", percent: 26, scope: null, is_active: true },
          { kind: "weekly_scoped", percent: 100, scope: { model: { id: "sonnet", display_name: "Sonnet" }, surface: null }, is_active: false },
          { kind: "weekly_scoped", percent: 40, scope: { model: { id: "sonnet" }, surface: "code" } },
          { kind: "weekly_scoped", percent: 0, scope: { model: { id: null, display_name: null }, surface: null }, resets_at: "2026-10-05T04:00:00Z" },
          { kind: "session", group: "other", percent: 12, scope: null },
          { kind: "future", percent: 0.5, scope: { surface: "chat" } },
        ],
      }),
    });
    expect(result.status).toBe("ok");
    expect(result.limits).toHaveLength(7);
    expect(result.limits[0]).toMatchObject({ id: "five_hour", usedPercent: 16, scope: null, allowed: null });
    expect(result.limits[1]).toMatchObject({ id: "seven_day", usedPercent: 26, allowed: null });
    expect(result.limits[2]).toMatchObject({ id: "seven_day_sonnet", usedPercent: 100, scope: "model:sonnet", limitReached: true });
    expect(result.limits[3]).toMatchObject({ usedPercent: 40, scope: "model:sonnet · surface:code", windowDurationSeconds: 604800 });
    expect(result.limits[4]).toMatchObject({ scope: "weekly_scoped.4", usedPercent: 0, resetsAt: "2026-10-05T04:00:00.000Z" });
    expect(new Set(result.limits.map((entry) => entry.id)).size).toBe(7);
    expect(result.limits[6]).toMatchObject({ scope: "surface:chat", usedPercent: 0.5, windowDurationSeconds: null });
  });

  it("reads structured Claude spend when legacy extra_usage is absent, with its currency and exponent", async () => {
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ limits: [{ kind: "session", percent: 30 }], spend: {
        enabled: true, percent: 25,
        used: { amount_minor: 1250, currency: "USD", exponent: 2 },
        limit: { amount_minor: 5000, currency: "USD", exponent: 2 },
        balance: { amount_minor: 2000, currency: "USD", exponent: 2 },
      } }),
    });
    expect(result.overage).toMatchObject({ enabled: true, available: null, used: 12.5, limit: 50, remaining: 37.5, balance: 20, unit: "USD" });
    expect(result.limits[1]).toMatchObject({ usedPercent: 25, used: 12.5, limit: 50, unit: "USD" });
  });

  it("keeps exhausted Claude groups separate from account-wide limits and preserves group identity across ordering", async () => {
    const structured = [
      { kind: "session", group: "chat", percent: 100, scope: null },
      { kind: "session", group: "code", percent: 25, scope: null },
      { kind: "weekly_all", group: "chat", percent: 105, scope: null },
      { kind: "weekly_all", group: "code", percent: 50, scope: null },
      { kind: "weekly_scoped", group: "code", percent: 60, scope: { model: { id: "sonnet" } } },
    ];
    const probe = (limits: unknown[]) => probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, seven_day_sonnet: { utilization: 30 }, limits }),
    });
    const result = await probe(structured);
    expect(result.status).toBe("ok");
    expect(result.limits).toHaveLength(8);
    expect(result.limits[0]).toMatchObject({ id: "five_hour", scope: null, usedPercent: 10, limitReached: false });
    expect(result.limits[1]).toMatchObject({ id: "seven_day", scope: null, usedPercent: 20, limitReached: false });
    expect(result.limits[2]).toMatchObject({ id: "seven_day_sonnet", scope: "seven_day_sonnet", usedPercent: 30 });
    expect(result.limits[3]).toMatchObject({ scope: "group:chat", usedPercent: 100, limitReached: true });
    expect(result.limits[4]).toMatchObject({ scope: "group:code", usedPercent: 25, limitReached: false });
    expect(result.limits[7]).toMatchObject({ scope: "group:code · model:sonnet", usedPercent: 60 });
    expect(result.limits[3].label).toContain("chat");
    expect(new Set(result.limits.map((entry) => entry.id)).size).toBe(8);
    const reversed = await probe([...structured].reverse());
    expect(Object.fromEntries(reversed.limits.map((entry) => [entry.id, entry.scope])))
      .toEqual(Object.fromEntries(result.limits.map((entry) => [entry.id, entry.scope])));
  });

  it("reports a zero extra-usage cap as exhausted without dividing by zero", async () => {
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ five_hour: { utilization: 10 }, extra_usage: { is_enabled: true, monthly_limit: 0, used_credits: 0 } }),
    });
    expect(result.limits[1]).toMatchObject({ usedPercent: null, remaining: 0, limitReached: true });
    expect(result.overage).toMatchObject({ enabled: true, available: false });
  });

  const grokAuth = JSON.stringify({ "https://auth.x.ai::00000000-0000-4000-8000-000000000001": { key: "grok-selected-secret", refresh_token: "never-exchange" } });
  it("uses Grok subscription billing and keeps plan credits separate from on-demand credits", async () => {
    const request = fixture({ onDemandEnabled: true, config: {
      creditUsagePercent: 35.5, currentPeriod: { start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" },
      onDemandCap: { val: 200 }, onDemandUsed: { val: 150 }, prepaidBalance: { val: 100 },
    } });
    const result = await probeAiConnectionUsage({ provider: "xai", method: "subscription" }, grokAuth, { request });
    expect(result.status).toBe("ok");
    expect(result.limits[0]).toMatchObject({ usedPercent: 35.5, limit: null, windowDurationSeconds: 604800, unit: "cents" });
    expect(result.limits[1]).toMatchObject({ scope: "overage", usedPercent: 75 });
    expect(result.overage).toMatchObject({ enabled: true, available: null, remaining: 50, balance: 100 });
    expect(request).toHaveBeenCalledWith("https://cli-chat-proxy.grok.com/v1/billing?format=credits", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer grok-selected-secret", "x-xai-token-auth": "xai-grok-cli" }),
    }));
  });
  it("preserves the live Grok shape's omitted included usage instead of assuming zero", async () => {
    const result = await probeAiConnectionUsage({ provider: "xai", method: "subscription" }, grokAuth, {
      request: fixture({ config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" },
        isUnifiedBillingUser: true, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 },
      } }),
    });
    expect(result.status).toBe("ok");
    expect(result.limits[0]).toMatchObject({ usedPercent: null, used: null, limit: null, limitReached: null, allowed: null, windowDurationSeconds: 604800 });
    expect(result.overage).toMatchObject({ enabled: null, available: false, balance: 0, unit: "cents" });
  });

  it("uses Grok's legacy used field, proto3 zero messages, and remote settings without conflating prepaid balance", async () => {
    const result = await probeAiConnectionUsage({ provider: "xai", method: "subscription" }, grokAuth, {
      request: fixture({ on_demand_enabled: true, subscription_tier: "SuperGrok", config: {
        monthlyLimit: { val: 2000 }, used: { val: 500 }, onDemandCap: {}, onDemandUsed: {}, prepaidBalance: { val: 100 },
        billingPeriodStart: "2026-10-01T00:00:00Z", billingPeriodEnd: "2026-11-01T00:00:00Z",
      } }),
    });
    expect(result.planType).toBe("SuperGrok");
    expect(result.limits[0]).toMatchObject({ used: 500, limit: 2000, usedPercent: 25, remaining: 1500, unit: "cents" });
    expect(result.overage).toMatchObject({ enabled: true, used: 0, limit: 0, remaining: 0, balance: 100, available: null });
  });
  it("does not infer Grok cadence or zero usage from just a reset timestamp", async () => {
    const result = await probeAiConnectionUsage({ provider: "xai", method: "subscription" }, grokAuth, {
      request: fixture({ config: { currentPeriod: { end: "2026-10-08T00:00:00Z" } } }),
    });
    expect(result).toMatchObject({ status: "error", errorCode: "invalid_response", limits: [] });
  });

  it("reads OpenRouter's key cap without dividing all-time usage by a resettable cap", async () => {
    const result = await probeAiConnectionUsage({ provider: "openrouter", method: "api_key" }, "key", {
      request: fixture({ data: { limit: 10, limit_remaining: 2, usage: 500, limit_reset: "weekly",
        free_model_daily_requests: { used: 50, limit: 50, remaining: 0 },
      } }),
    });
    expect(result.limits[0]).toMatchObject({ used: 8, usedPercent: 80, limitReached: false, resetInterval: "weekly", windowDurationSeconds: 604800 });
    expect(result.limits[1]).toMatchObject({ scope: "free_models", limitReached: true });
    expect(result.overage).toBe(null);
    const unknown = await probeAiConnectionUsage({ provider: "openrouter", method: "api_key" }, "key", {
      request: fixture({ data: { limit: 10, usage: 500, limit_reset: "weekly" } }),
    });
    expect(unknown.limits[0]).toMatchObject({ used: null, usedPercent: null, remaining: null, limitReached: null });
  });

  it("preserves an overdrawn OpenRouter key cap and does not turn an uncapped key into available credits", async () => {
    const overdrawn = await probeAiConnectionUsage({ provider: "openrouter", method: "api_key" }, "key", {
      request: fixture({ data: { limit: 10, limit_remaining: -2, usage: 200 } }),
    });
    expect(overdrawn.limits[0]).toMatchObject({ used: 12, usedPercent: 120, remaining: -2, limitReached: true });
    const unlimited = await probeAiConnectionUsage({ provider: "openrouter", method: "api_key" }, "key", {
      request: fixture({ data: { limit: null, limit_remaining: null, usage: 20 } }),
    });
    expect(unlimited).toMatchObject({ status: "ok", overage: null, limits: [{ used: 20, limit: null, usedPercent: null, limitReached: null }] });
  });

  it("reads a DeepSeek prepaid balance without inventing limit windows", async () => {
    const request = fixture({ is_available: true, balance_infos: [
      { currency: "USD", total_balance: "7.31", granted_balance: "0.00", topped_up_balance: "7.31" },
    ] });
    const result = await probeAiConnectionUsage({ provider: "deepseek", method: "api_key" }, "ds-selected-secret", { request });
    expect(result).toMatchObject({ status: "ok", source: "deepseek_balance", limits: [], planType: null });
    expect(result.overage).toMatchObject({ available: true, balance: 7.31, remaining: 7.31, unit: "USD" });
    expect(request).toHaveBeenCalledWith("https://api.deepseek.com/user/balance", expect.objectContaining({
      redirect: "error", signal: expect.any(AbortSignal), headers: { Authorization: "Bearer ds-selected-secret" },
    }));
    expect(JSON.stringify(result)).not.toContain("ds-selected-secret");
  });

  it("reports a spent DeepSeek balance and a missing entry without assuming zero", async () => {
    const exhausted = await probeAiConnectionUsage({ provider: "deepseek", method: "api_key" }, "token", {
      request: fixture({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }),
    });
    expect(exhausted.overage).toMatchObject({ available: false, balance: 0, unit: "CNY" });
    const absent = await probeAiConnectionUsage({ provider: "deepseek", method: "api_key" }, "token", {
      request: fixture({ is_available: true }),
    });
    expect(absent).toMatchObject({ status: "ok" });
    expect(absent.overage).toMatchObject({ available: true, balance: null, remaining: null, unit: null });
  });

  it("fails closed on a DeepSeek balance with no usable observation", async () => {
    expect(await probeAiConnectionUsage({ provider: "deepseek", method: "api_key" }, "token", {
      request: fixture({ balance_infos: [] }),
    })).toMatchObject({ status: "error", errorCode: "invalid_response" });
  });

  it("maps a DeepSeek authentication failure to re-sign-in, not exhaustion", async () => {
    const result = await probeAiConnectionUsage({ provider: "deepseek", method: "api_key" }, "token", {
      request: fixture({ error: "echoed-secret" }, 401),
    });
    expect(result).toMatchObject({ status: "unavailable", errorCode: "authentication_required", limits: [], overage: null });
    expect(JSON.stringify(result)).not.toContain("echoed-secret");
  });

  it.each(["openai", "anthropic", "xai", "google"] as const)("makes unsupported %s API probes explicit without a request", async provider => {
    const request = fixture({});
    expect(await probeAiConnectionUsage({ provider, method: "api_key" }, "key", { request })).toMatchObject({ status: "unsupported", limits: [], overage: null });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    [401, "unavailable", "authentication_required"], [403, "unavailable", "permission_denied"],
    [429, "error", "rate_limited"], [503, "error", "provider_unavailable"],
  ])("does not misreport HTTP %s as exhausted subscription capacity", async (status, expected, code) => {
    const result = await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", {
      request: fixture({ error: "echoed-credential-secret" }, status as number),
    });
    expect(result).toMatchObject({ status: expected, errorCode: code, limits: [], overage: null });
    expect(JSON.stringify(result)).not.toContain("echoed-credential-secret");
  });
  it.each([{}, [], { five_hour: { utilization: -1 } }, { five_hour: { utilization: "100" } }])("fails closed on missing or malformed limits: %j", async body => {
    expect(await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", { request: fixture(body) })).toMatchObject({ status: "error", errorCode: "invalid_response" });
  });
  it("sanitizes network exceptions and refuses malformed credentials without a request", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("Authorization: secret"));
    expect(await probeAiConnectionUsage({ provider: "openai", method: "subscription" }, "not-json", { request })).toMatchObject({ status: "unavailable" });
    expect(request).not.toHaveBeenCalled();
    const result = await probeAiConnectionUsage({ provider: "openai", method: "subscription" }, auth, { request });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("Authorization: secret");
  });
  it("bounds provider response bytes", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(" ".repeat(256 * 1024 + 1)));
    expect(await probeAiConnectionUsage({ provider: "anthropic", method: "subscription" }, "token", { request })).toMatchObject({ status: "error", errorCode: "invalid_response" });
  });
});
