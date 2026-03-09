import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
/** Cache successful quota response to avoid hitting Anthropic rate limits (429). */
const QUOTA_CACHE_MS = 60_000; // 1 minute
let quotaCache: { token: string; at: number; data: ClaudeQuotaResult } | null = null;

interface OAuthUsagePayload {
  five_hour?: { utilization?: number; resets_at?: string } | null;
  seven_day?: { utilization?: number; resets_at?: string } | null;
  seven_day_sonnet?: { utilization?: number; resets_at?: string } | null;
  seven_day_opus?: { utilization?: number; resets_at?: string } | null;
}

interface ClaudeQuotaWindow {
  usedPercent: number | null;
  resetsAt: string | null;
}

interface ClaudeQuotaResult {
  configured: boolean;
  fiveHour: ClaudeQuotaWindow | null;
  weekly: ClaudeQuotaWindow | null;
  sevenDaySonnet: ClaudeQuotaWindow | null;
  sevenDayOpus: ClaudeQuotaWindow | null;
  error?: string;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toResetsAt(value: unknown): string | null {
  if (value == null || typeof value !== "string") return null;
  return value.trim() || null;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("claude-quota-launcher-example plugin setup complete");

    ctx.data.register("claude-quota", async (): Promise<ClaudeQuotaResult> => {
      const config = await ctx.config.get();
      const token = typeof config.anthropicOAuthAccessToken === "string"
        ? config.anthropicOAuthAccessToken.trim()
        : "";
      if (!token) {
        return {
          configured: false,
          fiveHour: null,
          weekly: null,
          sevenDaySonnet: null,
          sevenDayOpus: null,
        };
      }

      const now = Date.now();
      if (quotaCache && quotaCache.token === token && now - quotaCache.at < QUOTA_CACHE_MS) {
        return quotaCache.data;
      }

      try {
        const response = await ctx.http.fetch(ANTHROPIC_OAUTH_USAGE_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-beta": ANTHROPIC_BETA_HEADER,
          },
        });

        if (!response.ok) {
          const retryAfter = response.headers.get("Retry-After");
          const is429 = response.status === 429;
          const message = is429
            ? (retryAfter
              ? `Rate limited by Claude API. Try again in ${retryAfter} seconds.`
              : "Rate limited by Claude API. Try again in a few minutes.")
            : `API error: ${response.status}`;
          return {
            configured: true,
            fiveHour: null,
            weekly: null,
            sevenDaySonnet: null,
            sevenDayOpus: null,
            error: message,
          };
        }

        const payload = (await response.json()) as OAuthUsagePayload;
        const fiveHour = payload.five_hour ?? null;
        const sevenDay = payload.seven_day ?? null;
        const sevenDaySonnet = payload.seven_day_sonnet ?? null;
        const sevenDayOpus = payload.seven_day_opus ?? null;

        const result: ClaudeQuotaResult = {
          configured: true,
          fiveHour: fiveHour
            ? {
                usedPercent: toNumber(fiveHour.utilization) ?? null,
                resetsAt: toResetsAt(fiveHour.resets_at) ?? null,
              }
            : null,
          weekly: sevenDay
            ? {
                usedPercent: toNumber(sevenDay.utilization) ?? null,
                resetsAt: toResetsAt(sevenDay.resets_at) ?? null,
              }
            : null,
          sevenDaySonnet: sevenDaySonnet
            ? {
                usedPercent: toNumber(sevenDaySonnet.utilization) ?? null,
                resetsAt: toResetsAt(sevenDaySonnet.resets_at) ?? null,
              }
            : null,
          sevenDayOpus: sevenDayOpus
            ? {
                usedPercent: toNumber(sevenDayOpus.utilization) ?? null,
                resetsAt: toResetsAt(sevenDayOpus.resets_at) ?? null,
              }
            : null,
        };
        quotaCache = { token, at: now, data: result };
        return result;
      } catch (err) {
        return {
          configured: true,
          fiveHour: null,
          weekly: null,
          sevenDaySonnet: null,
          sevenDayOpus: null,
          error: err instanceof Error ? err.message : "Request failed",
        };
      }
    });
  },
  async onHealth() {
    return { status: "ok", message: "Claude quota launcher example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
