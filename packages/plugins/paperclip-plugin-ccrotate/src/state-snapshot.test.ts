import { describe, expect, it } from "vitest";
import { buildAccountRows, tierCacheAge } from "./state-snapshot.js";

const NOW = Date.parse("2026-06-11T22:00:00Z");

describe("state-backed ccrotate snapshot rows", () => {
  it("renders Claude rows from profiles plus tier-cache and overlays API limits", () => {
    const rows = buildAccountRows({
      target: "claude",
      now: NOW,
      activeEmail: "usable@example.com",
      profiles: {
        "usable@example.com": {
          credentials: {
            claudeAiOauth: {
              accessToken: "tok",
              rateLimitTier: "default_claude_max_20x",
            },
          },
        },
        "disabled@example.com": {
          stale: true,
          staleReason: "organization_disabled",
          credentials: { claudeAiOauth: { accessToken: "tok" } },
          oauthAccount: { seatTier: "unassigned" },
        },
      },
      tierCache: {
        updatedAt: new Date(NOW - 60_000).toISOString(),
        accounts: [
          {
            email: "usable@example.com",
            serviceTier: "base",
            rateLimits: { utilization5h: 10, utilization7d: 20 },
          },
          {
            email: "disabled@example.com",
            serviceTier: "base",
            rateLimits: { utilization5h: 5, utilization7d: 10 },
          },
        ],
      },
      rateLimitState: {
        anthropic: {
          accounts: {
            "usable@example.com": {
              modelGroups: {
                "claude-opus": {
                  requests: { remaining: 99, limit: 100 },
                },
              },
            },
          },
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      email: "usable@example.com",
      tier: "base·20x",
      availability: "usable now",
      availabilityMark: "🟢",
      apiLimit: "opus req 99/100",
      isActive: true,
      isHealthy: true,
    });
    expect(rows[1]).toMatchObject({
      email: "disabled@example.com",
      tier: "base·off",
      availability: "org-disabled (admin must enable)",
      availabilityMark: "🚫",
      isStale: true,
    });
  });

  it("marks active Anthropic cooldowns without dropping the row", () => {
    const rows = buildAccountRows({
      target: "claude",
      now: NOW,
      profiles: {
        "limited@example.com": {
          credentials: { claudeAiOauth: { accessToken: "tok" } },
        },
      },
      tierCache: {
        updatedAt: new Date(NOW).toISOString(),
        accounts: [
          {
            email: "limited@example.com",
            serviceTier: "base",
            rateLimits: { utilization5h: 10, utilization7d: 20 },
          },
        ],
      },
      rateLimitState: {
        anthropic: {
          accounts: {
            "limited@example.com": {
              modelGroups: {
                "claude-opus": {
                  cooldownUntil: new Date(NOW + 90_000).toISOString(),
                  last429Reason: "unknown",
                },
              },
            },
          },
        },
      },
    });

    expect(rows[0]).toMatchObject({
      email: "limited@example.com",
      availabilityMark: "🤌",
      apiLimit: "opus cooldown 1m30s · 429 unknown",
      isActive: false,
    });
  });

  it("renders every Codex profile even when the tier-cache has only a subset", () => {
    const rows = buildAccountRows({
      target: "codex",
      now: NOW,
      activeEmail: "bot3@example.com",
      profiles: {
        "bot2@example.com": { auth: { tokens: {} } },
        "bot3@example.com": { auth: { tokens: {} } },
        "new@example.com": { auth: { tokens: {} } },
      },
      tierCache: {
        updatedAt: new Date(NOW).toISOString(),
        accounts: [
          {
            email: "bot2@example.com",
            serviceTier: "available",
            rateLimits: { remaining5h: 84, remaining7d: 79, planType: "pro" },
          },
          {
            email: "bot3@example.com",
            serviceTier: "available",
            rateLimits: { remaining5h: 86, remaining7d: 83, planType: "pro" },
          },
        ],
      },
    });

    expect(rows.map((row) => row.email)).toEqual([
      "bot3@example.com",
      "bot2@example.com",
      "new@example.com",
    ]);
    expect(rows[0]).toMatchObject({
      isActive: true,
      availability: "usable now",
      apiLimit: "pro",
    });
    expect(rows[2]).toMatchObject({
      availability: "no data (needs refresh)",
      availabilityMark: "❔",
      apiLimit: "n/a",
    });
  });

  it("formats tier-cache age from canonical state metadata", () => {
    expect(tierCacheAge(new Date(NOW - 125_000).toISOString(), NOW)).toBe("2m");
    expect(tierCacheAge("2026-06-11 21:57:55.000000+00", NOW)).toBe("2m");
    expect(tierCacheAge(null, NOW)).toBeNull();
  });
});
