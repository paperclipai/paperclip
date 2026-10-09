import {
  supportsAiConnectionUsage,
  type AiConnectionMetadata,
  type AiConnectionUsage,
  type AiConnectionUsageLimit,
  type AiConnectionUsageOverage,
} from "@paperclipai/shared";
import { parseGrokAuthPayload } from "@paperclipai/adapter-grok-local/server";

type Observation = Pick<AiConnectionUsage, "source" | "planType" | "limits" | "overage">;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const signedNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
// Grok's Cent messages use proto3 JSON: a present {} means zero; an absent
// message remains unknown. Other missing scalars (including percentages) do not.
const amount = (value: unknown): number | null => {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length === 0 ? 0 : number(object(value).val);
  }
  return number(value);
};
const balance = (value: unknown): number | null => {
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return signedNumber(Number(value));
  return signedNumber(value);
};

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function limit(input: Partial<AiConnectionUsageLimit> & Pick<AiConnectionUsageLimit, "id" | "label">): AiConnectionUsageLimit {
  const usedPercent = input.usedPercent ?? (
    input.used != null && input.limit != null && input.limit > 0 ? input.used / input.limit * 100 : null
  );
  return {
    scope: null, windowDurationSeconds: null, resetsAt: null,
    used: null, limit: null, remaining: null, unit: null, allowed: null,
    ...input,
    // Provider percentages are percentages, including values below 1 and above 100.
    usedPercent,
    remainingPercent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    limitReached: input.limitReached ?? (usedPercent != null ? usedPercent >= 100
      : input.used != null && input.limit != null ? input.used >= input.limit : null),
  };
}

function overage(input: Partial<AiConnectionUsageOverage>): AiConnectionUsageOverage {
  return {
    enabled: null, available: null, unlimited: null, used: null,
    limit: null, remaining: null, balance: null, unit: null, ...input,
  };
}

class ProbeFailure extends Error {
  constructor(readonly code: NonNullable<AiConnectionUsage["errorCode"]>) { super(code); }
}

async function readUsage(url: string, headers: Record<string, string>, request: typeof fetch): Promise<ObjectValue> {
  // Fixed origins, no redirects, and a deadline covering headers AND response bytes.
  const response = await request(url, {
    headers, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProbeFailure(response.status === 401 ? "authentication_required"
      : response.status === 403 ? "permission_denied"
      : response.status === 429 ? "rate_limited" : "provider_unavailable");
  }
  // Provider errors and raw responses must never be returned to the caller.
  const reader = response.body?.getReader();
  if (!reader) throw new ProbeFailure("invalid_response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new ProbeFailure("invalid_response");
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProbeFailure("invalid_response");
    return parsed as ObjectValue;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof ProbeFailure ? error : new ProbeFailure("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

function parseCredential(credential: string): ObjectValue {
  try { return object(JSON.parse(credential)); }
  catch { throw new ProbeFailure("authentication_required"); }
}

function requireToken(value: unknown): string {
  const token = string(value);
  if (!token?.trim()) throw new ProbeFailure("authentication_required");
  return token;
}

function codexLimits(body: ObjectValue): AiConnectionUsageLimit[] {
  const limits: AiConnectionUsageLimit[] = [];
  function add(id: string, label: string, scope: string | null, raw: unknown) {
    const group = object(raw);
    for (const key of ["primary_window", "secondary_window"]) {
      if (!group[key] || typeof group[key] !== "object") continue;
      const window = object(group[key]);
      limits.push(limit({
        id: `${id}.${key}`, label: `${label} · ${key === "primary_window" ? "Primary" : "Secondary"}`,
        scope, windowDurationSeconds: number(window.limit_window_seconds),
        resetsAt: timestamp(window.reset_at), usedPercent: number(window.used_percent),
        // Admission describes the whole group; utilization belongs to this window.
        allowed: bool(group.allowed), limitReached: number(window.used_percent) == null ? bool(group.limit_reached) : null, unit: "percent",
      }));
    }
    if (limits.every((entry) => !entry.id.startsWith(`${id}.`)) && (bool(group.limit_reached) != null || bool(group.allowed) != null)) {
      limits.push(limit({ id, label, scope, allowed: bool(group.allowed), limitReached: bool(group.limit_reached) }));
    }
  }
  add("codex", "Codex", null, body.rate_limit);
  if (body.code_review_rate_limit) add("code_review", "Code review", "code_review", body.code_review_rate_limit);
  if (Array.isArray(body.additional_rate_limits)) {
    body.additional_rate_limits.forEach((value, index) => {
      const additional = object(value);
      const id = string(additional.metered_feature) ?? `additional_${index}`;
      add(id, string(additional.limit_name) ?? id, id, additional.rate_limit);
    });
  }
  return limits;
}

async function codex(credential: string, request: typeof fetch): Promise<Observation> {
  const auth = parseCredential(credential);
  const tokens = object(auth.tokens);
  const headers: Record<string, string> = { Authorization: `Bearer ${requireToken(tokens.access_token ?? auth.accessToken)}` };
  const accountId = string(tokens.account_id ?? auth.accountId);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const body = await readUsage("https://chatgpt.com/backend-api/wham/usage", headers, request);
  const credits = object(body.credits);
  const unlimited = bool(credits.unlimited);
  const hasCredits = bool(credits.has_credits);
  const spendControl = object(body.spend_control);
  const spendLimit = object(spendControl.individual_limit);
  const limits = codexLimits(body);
  if (bool(spendControl.reached) != null) {
    limits.push(limit({ id: "spend_control", label: "Workspace spend control", limitReached: bool(spendControl.reached),
      usedPercent: number(spendLimit.used_percent), used: balance(spendLimit.used), limit: balance(spendLimit.limit),
      remaining: balance(spendLimit.remaining), resetsAt: timestamp(spendLimit.reset_at),
    }));
  }
  return {
    source: "codex_wham", planType: string(body.plan_type), limits,
    overage: body.credits == null ? null : overage({
      available: unlimited === true ? true : hasCredits,
      unlimited, balance: balance(credits.balance), unit: "credits",
    }),
  };
}

async function claude(credential: string, request: typeof fetch): Promise<Observation> {
  const body = await readUsage("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${requireToken(credential)}`, "anthropic-beta": "oauth-2025-04-20",
  }, request);
  const limits: AiConnectionUsageLimit[] = [];
  const labels: Record<string, string> = {
    five_hour: "5 hour limit", seven_day: "Weekly limit", seven_day_sonnet: "Sonnet weekly limit",
    seven_day_opus: "Opus weekly limit", seven_day_oauth_apps: "OAuth apps weekly limit",
  };
  for (const [id, value] of Object.entries(body)) {
    const window = object(value);
    if (id === "extra_usage" || !("utilization" in window || "resets_at" in window)) continue;
    limits.push(limit({
      id, label: labels[id] ?? id.replaceAll("_", " "),
      scope: id === "five_hour" || id === "seven_day" ? null : id,
      windowDurationSeconds: id === "five_hour" ? 18000 : id.startsWith("seven_day") ? 604800 : null,
      resetsAt: timestamp(window.resets_at), usedPercent: number(window.utilization), unit: "percent",
    }));
  }
  if (Array.isArray(body.limits)) {
    const seen = new Set<string>();
    body.limits.forEach((value, index) => {
      const window = object(value);
      const kind = string(window.kind);
      if (!kind || !("percent" in window || "resets_at" in window)) return;
      const rawScope = object(window.scope);
      const group = string(window.group);
      const model = object(rawScope.model);
      const modelName = string(model.id) ?? string(model.display_name);
      const surface = string(rawScope.surface) ?? string(object(rawScope.surface).id)
        ?? string(object(rawScope.surface).display_name);
      const knownModel = !surface && modelName?.match(/\b(sonnet|opus)\b/i)?.[1].toLowerCase();
      const legacyId = kind === "session" ? "five_hour" : kind === "weekly_all" ? "seven_day"
        : kind === "weekly_scoped" && knownModel ? `seven_day_${knownModel}` : `${kind}.${index}`;
      const scopeParts = [group && `group:${group}`, modelName && `model:${modelName}`, surface && `surface:${surface}`].filter(Boolean);
      // A named group is its own allowance, even for session/weekly_all kinds.
      // Merge a legacy alias only when the structured window has the same scope.
      const baseId = group || ((kind === "session" || kind === "weekly_all") && scopeParts.length)
        ? `${legacyId}.scope.${encodeURIComponent(scopeParts.join("|"))}` : legacyId;
      const id = seen.has(baseId) ? `${baseId}.${index}` : baseId;
      seen.add(baseId);
      const scope = scopeParts.join(" · ") || (kind === "session" || kind === "weekly_all" ? null : id);
      const previousIndex = limits.findIndex((entry) => entry.id === id);
      const previous = limits[previousIndex];
      const entry = limit({ id, label: `${labels[legacyId] ?? kind.replaceAll("_", " ")}${group ? ` · ${group}` : ""}${modelName && (!labels[legacyId] || legacyId === "five_hour" || legacyId === "seven_day") ? ` · ${modelName}` : ""}${surface ? ` · ${surface}` : ""}`,
        scope, windowDurationSeconds: kind === "session" ? 18000 : kind.startsWith("weekly_") ? 604800 : null,
        usedPercent: number(window.percent) ?? previous?.usedPercent,
        resetsAt: timestamp(window.resets_at) ?? previous?.resetsAt ?? null, unit: "percent",
        // is_active selects the dashboard's current meter, not admission.
      });
      if (previousIndex < 0) limits.push(entry);
      else limits[previousIndex] = entry;
    });
  }
  const extra = object(body.extra_usage);
  const spend = object(body.spend);
  const money = (value: unknown) => {
    const raw = object(value);
    const minor = number(raw.amount_minor);
    const exponent = number(raw.exponent);
    const currency = string(raw.currency);
    return minor != null && exponent != null && Number.isInteger(exponent) && exponent <= 10 && currency
      ? { value: minor / 10 ** exponent, currency } : null;
  };
  const spendLimit = money(spend.limit);
  const spendUsed = money(spend.used);
  const spendBalance = money(spend.balance);
  const legacyExtra = body.extra_usage != null;
  const unit = legacyExtra ? "cents" : spendLimit?.currency ?? spendUsed?.currency ?? spendBalance?.currency ?? null;
  const enabled = legacyExtra ? bool(extra.is_enabled) : bool(spend.enabled);
  const cap = legacyExtra ? number(extra.monthly_limit) : spendLimit?.value ?? null;
  const used = legacyExtra ? number(extra.used_credits) : spendUsed?.currency === unit ? spendUsed.value : null;
  const prepaidBalance = spendBalance?.currency === unit ? spendBalance.value : null;
  const remaining = cap == null || used == null ? null : Math.max(0, cap - used);
  const hasExtra = legacyExtra || body.spend != null;
  if (hasExtra) {
    limits.push(limit({ id: "extra_usage", label: "Monthly extra usage", scope: "overage",
      usedPercent: number(legacyExtra ? extra.utilization : spend.percent), used, limit: cap, remaining, unit,
      allowed: enabled === false ? false : null,
    }));
  }
  return {
    source: "anthropic_oauth", planType: null, limits,
    overage: !hasExtra ? null : overage({
      enabled, available: enabled === false || remaining === 0 ? false : null,
      used, limit: cap, remaining, balance: prepaidBalance, unit,
    }),
  };
}

async function grok(credential: string, request: typeof fetch): Promise<Observation> {
  const payload = parseGrokAuthPayload(parseCredential(credential));
  const body = await readUsage("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    Authorization: `Bearer ${requireToken(payload?.value.key)}`,
    "x-xai-token-auth": "xai-grok-cli", Accept: "application/json",
  }, request);
  const config = object(body.config);
  const period = object(config.currentPeriod);
  const start = timestamp(period.start ?? config.billingPeriodStart);
  const end = timestamp(period.end ?? config.billingPeriodEnd);
  const duration = start && end ? (Date.parse(end) - Date.parse(start)) / 1000 : null;
  const used = amount(config.used);
  const cap = amount(config.monthlyLimit);
  const usedPercent = number(config.creditUsagePercent);
  // Do not derive included-plan consumption from the separate on-demand pool.
  const limits = [limit({ id: "grok_credits", label: "Grok plan credits",
    usedPercent, used, limit: cap, remaining: cap == null || used == null ? null : Math.max(0, cap - used),
    unit: "cents", resetsAt: end, windowDurationSeconds: duration != null && duration > 0 ? duration : null,
  })];
  const extraUsed = amount(config.onDemandUsed);
  const extraCap = amount(config.onDemandCap);
  const remaining = extraUsed == null || extraCap == null ? null : Math.max(0, extraCap - extraUsed);
  const enabled = bool(body.on_demand_enabled ?? body.onDemandEnabled);
  const prepaidBalance = amount(config.prepaidBalance);
  const extra = enabled == null && extraUsed == null && extraCap == null && prepaidBalance == null ? null
    : overage({ enabled, available: enabled === false || (remaining === 0 && prepaidBalance === 0) ? false : null,
      used: extraUsed, limit: extraCap, remaining, balance: prepaidBalance, unit: "cents" });
  if (extra) limits.push(limit({ id: "grok_overage", label: "Grok on-demand credits", scope: "overage",
    used: extraUsed, limit: extraCap, remaining, unit: "cents", resetsAt: timestamp(config.billingPeriodEnd) ?? end }));
  return { source: "grok_cli_billing", planType: string(body.subscription_tier ?? body.subscriptionTier), limits, overage: extra };
}

async function openrouter(credential: string, request: typeof fetch): Promise<Observation> {
  const body = await readUsage("https://openrouter.ai/api/v1/key", {
    Authorization: `Bearer ${requireToken(credential)}`,
  }, request);
  const data = object(body.data);
  const cap = number(data.limit);
  const remaining = signedNumber(data.limit_remaining);
  const resetInterval = string(data.limit_reset);
  const limits = [limit({ id: "key_credits", label: "API key credit cap", scope: "api_key",
    limit: cap, remaining, used: cap != null
      ? remaining == null ? null : Math.max(0, cap - remaining)
      : number(data.usage),
    unit: "USD", resetInterval, windowDurationSeconds: resetInterval === "daily" ? 86400 : resetInterval === "weekly" ? 604800 : null,
    limitReached: remaining == null ? null : remaining <= 0,
  })];
  const free = object(data.free_model_daily_requests);
  if (Object.keys(free).length) limits.push(limit({ id: "free_requests", label: "Free model daily requests", scope: "free_models",
    used: number(free.used), limit: number(free.limit), remaining: number(free.remaining),
    unit: "requests", windowDurationSeconds: 86400,
    limitReached: number(free.remaining) == null ? null : number(free.remaining) === 0,
  }));
  // An unlimited per-key cap says nothing about the account's funded balance.
  return { source: "openrouter_key", planType: null, limits, overage: null };
}

const probes = { openai: codex, anthropic: claude, xai: grok, openrouter };
const messages: Record<NonNullable<AiConnectionUsage["errorCode"]>, string> = {
  unsupported: "This provider does not expose usage limits through this sign-in method.",
  connection_unavailable: "Reconnect or enable this AI connection before checking usage.",
  authentication_required: "The provider could not authenticate this usage check. Reconnect the account.",
  permission_denied: "The provider denied access to usage limits for this credential. Its sign-in permissions may not include usage access.",
  rate_limited: "The provider rate limited the usage check. Try again later.",
  provider_unavailable: "Could not read provider usage. Try again later.",
  invalid_response: "The provider did not return usable limit data. Try again later.",
};

export async function probeAiConnectionUsage(
  metadata: AiConnectionMetadata,
  credential: string,
  options: { request?: typeof fetch } = {},
): Promise<Omit<AiConnectionUsage, "connectionId" | "grantId">> {
  const base = { ...metadata, checkedAt: new Date().toISOString(), source: null, planType: null, limits: [], overage: null };
  if (metadata.provider === "google" || metadata.provider === "github" || !supportsAiConnectionUsage(metadata.provider, metadata.method)) {
    return { ...base, status: "unsupported", errorCode: "unsupported", message: messages.unsupported };
  }
  try {
    const observation = await probes[metadata.provider](credential, options.request ?? fetch);
    if (!observation.limits.some((entry) => entry.usedPercent != null || entry.used != null || entry.limit != null || entry.limitReached != null || entry.allowed != null)
      && !Object.values(observation.overage ?? {}).some((value) => typeof value === "number" || typeof value === "boolean")) throw new ProbeFailure("invalid_response");
    return { ...base, ...observation, status: "ok", checkedAt: new Date().toISOString() };
  } catch (error) {
    const errorCode = error instanceof ProbeFailure ? error.code : "provider_unavailable";
    return { ...base, status: errorCode === "authentication_required" || errorCode === "permission_denied" ? "unavailable" : "error", errorCode, message: messages[errorCode] };
  }
}
