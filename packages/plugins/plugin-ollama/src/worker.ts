import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { listKnownFamilies, resolveLicense } from "./licenses.js";

type HealthState = {
  status: "ok" | "degraded" | "error";
  baseUrl: string;
  modelCount: number;
  models: Array<{ name: string; size?: number; family?: string }>;
  latencyMs: number | null;
  checkedAt: string;
  lastError?: string;
};

const HEALTH_STATE_KEY = { scopeKind: "instance" as const, stateKey: "ollama-health" };
const ACK_STATE_KEY = { scopeKind: "instance" as const, stateKey: "ollama-acknowledged-licenses" };
const USAGE_STATE_KEY = { scopeKind: "instance" as const, stateKey: "ollama-usage-summary" };

type UsageSummary = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  events: number;
  lastEventAt: string | null;
};

function zeroUsage(): UsageSummary {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, events: 0, lastEventAt: null };
}

function familyOf(modelName: string): string {
  return modelName.split(":")[0].toLowerCase();
}

async function readAcknowledged(ctx: PluginContext): Promise<string[]> {
  const raw = (await ctx.state.get(ACK_STATE_KEY)) as string[] | null;
  return Array.isArray(raw) ? raw : [];
}

function sanitizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "http://127.0.0.1:11434";
  return raw.trim().replace(/\/$/, "");
}

type OllamaTagsResponse = {
  models?: Array<{ name: string; size?: number; details?: { family?: string } }>;
};

async function fetchTags(
  ctx: PluginContext,
  baseUrl: string,
): Promise<{ latencyMs: number; body: OllamaTagsResponse }> {
  const started = Date.now();
  const res = await ctx.http.fetch(`${baseUrl}/api/tags`);
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    throw new Error(`GET /api/tags -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as OllamaTagsResponse;
  return { latencyMs, body };
}

async function readBaseUrl(ctx: PluginContext): Promise<string> {
  const config = await ctx.config.get();
  return sanitizeBaseUrl(config.baseUrl);
}

const plugin = definePlugin({
  async setup(ctx) {
    async function probeHealth(): Promise<HealthState> {
      const baseUrl = await readBaseUrl(ctx);
      const checkedAt = new Date().toISOString();
      try {
        const { latencyMs, body } = await fetchTags(ctx, baseUrl);
        const models = (body.models ?? []).map((m) => ({
          name: m.name,
          size: m.size,
          family: m.details?.family,
        }));
        const state: HealthState = {
          status: latencyMs > 5000 ? "degraded" : "ok",
          baseUrl,
          modelCount: models.length,
          models,
          latencyMs,
          checkedAt,
        };
        await ctx.state.set(HEALTH_STATE_KEY, state);
        return state;
      } catch (err) {
        const state: HealthState = {
          status: "error",
          baseUrl,
          modelCount: 0,
          models: [],
          latencyMs: null,
          checkedAt,
          lastError: err instanceof Error ? err.message : String(err),
        };
        await ctx.state.set(HEALTH_STATE_KEY, state);
        return state;
      }
    }

    ctx.data.register("health", async () => {
      const cached = (await ctx.state.get(HEALTH_STATE_KEY)) as HealthState | null;
      if (cached) return cached;
      return probeHealth();
    });

    ctx.data.register("models", async () => {
      const baseUrl = await readBaseUrl(ctx);
      const { body } = await fetchTags(ctx, baseUrl);
      const raw = body.models ?? [];
      const acknowledged = new Set(await readAcknowledged(ctx));
      return raw.map((m) => {
        const license = resolveLicense(m.name);
        const family = familyOf(m.name);
        const licenseKnown = license !== null;
        const ack = acknowledged.has(family);
        return {
          name: m.name,
          size: m.size,
          family,
          license,
          licenseKnown,
          acknowledged: ack,
          blocked: !licenseKnown || !ack,
        };
      });
    });

    ctx.data.register("acknowledged-licenses", async () => {
      return readAcknowledged(ctx);
    });

    ctx.data.register("license-matrix", async () => {
      return listKnownFamilies().map((family) => ({
        family,
        ...resolveLicense(family)!,
      }));
    });

    ctx.actions.register("test-connection", async () => {
      const state = await probeHealth();
      return {
        ok: state.status !== "error",
        status: state.status,
        latencyMs: state.latencyMs,
        modelCount: state.modelCount,
        baseUrl: state.baseUrl,
        error: state.lastError ?? null,
      };
    });

    ctx.actions.register("refresh-health", async () => {
      return probeHealth();
    });

    ctx.actions.register("acknowledge-license", async (params) => {
      const family = typeof (params as { family?: unknown })?.family === "string"
        ? ((params as { family: string }).family).trim().toLowerCase()
        : "";
      if (!family) {
        throw new Error("acknowledge-license: 'family' is required");
      }
      if (!resolveLicense(family)) {
        throw new Error(
          `acknowledge-license: '${family}' is not in the known license matrix — refusing to acknowledge an unknown license`,
        );
      }
      const current = await readAcknowledged(ctx);
      if (!current.includes(family)) {
        const next = [...current, family].sort();
        await ctx.state.set(ACK_STATE_KEY, next);
        return { ok: true, family, acknowledged: next };
      }
      return { ok: true, family, acknowledged: current, alreadyAcknowledged: true };
    });

    ctx.actions.register("revoke-license", async (params) => {
      const family = typeof (params as { family?: unknown })?.family === "string"
        ? ((params as { family: string }).family).trim().toLowerCase()
        : "";
      if (!family) {
        throw new Error("revoke-license: 'family' is required");
      }
      const current = await readAcknowledged(ctx);
      const next = current.filter((f) => f !== family);
      await ctx.state.set(ACK_STATE_KEY, next);
      return { ok: true, family, acknowledged: next };
    });

    ctx.actions.register("check-model", async (params) => {
      const model = typeof (params as { model?: unknown })?.model === "string"
        ? (params as { model: string }).model
        : "";
      if (!model) {
        throw new Error("check-model: 'model' is required");
      }
      const family = familyOf(model);
      const license = resolveLicense(model);
      const acknowledged = (await readAcknowledged(ctx)).includes(family);
      const blocked = license === null || !acknowledged;
      return {
        model,
        family,
        license,
        licenseKnown: license !== null,
        acknowledged,
        blocked,
        reason: blocked
          ? license === null
            ? "unknown-license"
            : "license-not-acknowledged"
          : null,
      };
    });

    ctx.jobs.register("ollama-health", async (job) => {
      ctx.logger.info("Ollama health probe", { runId: job.runId, trigger: job.trigger });
      await probeHealth();
    });

    ctx.events.on("cost_event.created", async (event) => {
      const payload = event.payload as
        | {
            provider?: string;
            inputTokens?: number;
            cachedInputTokens?: number;
            outputTokens?: number;
            occurredAt?: string;
          }
        | undefined;
      if (!payload || payload.provider !== "ollama") return;
      const current = ((await ctx.state.get(USAGE_STATE_KEY)) as UsageSummary | null) ?? zeroUsage();
      const next: UsageSummary = {
        inputTokens: current.inputTokens + (payload.inputTokens ?? 0),
        cachedInputTokens: current.cachedInputTokens + (payload.cachedInputTokens ?? 0),
        outputTokens: current.outputTokens + (payload.outputTokens ?? 0),
        events: current.events + 1,
        lastEventAt: payload.occurredAt ?? new Date().toISOString(),
      };
      await ctx.state.set(USAGE_STATE_KEY, next);
    });

    ctx.data.register("usage-summary", async () => {
      const config = await ctx.config.get();
      const inputRate = Number(config.referenceInputCostPerMTok ?? 0.15);
      const outputRate = Number(config.referenceOutputCostPerMTok ?? 0.6);
      const referenceModel = typeof config.referenceHostedModel === "string" ? config.referenceHostedModel : "gpt-4o-mini";
      const usage = ((await ctx.state.get(USAGE_STATE_KEY)) as UsageSummary | null) ?? zeroUsage();
      const equivalentCostUsd =
        (usage.inputTokens / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate;
      return {
        ...usage,
        referenceModel,
        inputRatePerMTokUsd: inputRate,
        outputRatePerMTokUsd: outputRate,
        equivalentCostUsd,
      };
    });

    ctx.actions.register("reset-usage", async () => {
      await ctx.state.set(USAGE_STATE_KEY, zeroUsage());
      return { ok: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: "plugin-ollama worker running" };
  },

  async onValidateConfig(config) {
    const baseUrl = config?.baseUrl;
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
      return {
        ok: false,
        errors: ["baseUrl must be an http(s) URL"],
      };
    }
    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
