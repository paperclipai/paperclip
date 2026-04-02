import { asNumber, asString } from "@paperclipai/adapter-utils/server-utils";

export type LocalFallbackPolicy = "never" | "critical_only" | "always";

export type LocalHealthcheckResult = {
  ok: boolean;
  status: number | null;
  detail: string | null;
  url: string;
};

export type LocalFirstDecision = {
  action: "primary" | "fallback" | "defer";
  model: string | null;
  reason: string | null;
  detail: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseModelProvider(model: string | null | undefined): string | null {
  const normalized = readNonEmptyString(model);
  if (!normalized || !normalized.includes("/")) return null;
  return normalized.slice(0, normalized.indexOf("/")).trim() || null;
}

export function extractProviderModelName(model: string | null | undefined): string | null {
  const normalized = readNonEmptyString(model);
  if (!normalized || !normalized.includes("/")) return normalized;
  return normalized.slice(normalized.indexOf("/") + 1).trim() || null;
}

export function isOllamaModel(model: string | null | undefined): boolean {
  return parseModelProvider(model) === "ollama";
}

export function parseFallbackPolicy(value: unknown): LocalFallbackPolicy {
  const normalized = asString(value, "").trim().toLowerCase();
  if (normalized === "always") return "always";
  if (normalized === "critical_only") return "critical_only";
  return "never";
}

export function readIssuePriority(context: Record<string, unknown>): string | null {
  return readNonEmptyString(context.issuePriority)?.toLowerCase() ?? null;
}

export function normalizeOllamaBaseUrl(raw: string | null | undefined): string | null {
  const normalized = readNonEmptyString(raw);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") {
      url.pathname = "/v1";
    } else if (!pathname.endsWith("/v1")) {
      url.pathname = `${pathname}/v1`;
    } else {
      url.pathname = pathname;
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function resolveOllamaBaseUrl(
  config: Record<string, unknown>,
  env: Record<string, string>,
): string | null {
  const configured =
    readNonEmptyString(config.ollamaBaseUrl) ??
    readNonEmptyString(env.OLLAMA_HOST) ??
    readNonEmptyString(process.env.OLLAMA_HOST);
  return normalizeOllamaBaseUrl(configured);
}

export function resolveOllamaHealthcheckUrl(
  config: Record<string, unknown>,
  env: Record<string, string>,
): string | null {
  const explicit = readNonEmptyString(config.healthcheckUrl);
  if (explicit) return explicit;

  const baseUrl = resolveOllamaBaseUrl(config, env);
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = "/api/tags";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function collectOllamaModelNames(models: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  for (const model of models) {
    if (!isOllamaModel(model)) continue;
    const modelName = extractProviderModelName(model);
    if (!modelName || result.includes(modelName)) continue;
    result.push(modelName);
  }
  return result;
}

export function parseOllamaTagsPayload(
  payload: unknown,
  options?: { prefix?: string },
): Array<{ id: string; label: string }> {
  const prefix = readNonEmptyString(options?.prefix) ?? "ollama";
  const models = Array.isArray((payload as { models?: unknown[] } | null | undefined)?.models)
    ? ((payload as { models: Array<{ name?: unknown; model?: unknown }> }).models)
    : [];
  const result: Array<{ id: string; label: string }> = [];
  for (const entry of models) {
    const name = readNonEmptyString(entry?.name) ?? readNonEmptyString(entry?.model);
    if (!name) continue;
    const id = `${prefix}/${name}`;
    if (result.some((model) => model.id === id)) continue;
    result.push({ id, label: id });
  }
  return result;
}

function summarizeError(value: unknown): string | null {
  if (value instanceof Error && value.message.trim()) return value.message.trim();
  const text = readNonEmptyString(value);
  return text ?? null;
}

export async function probeOllamaHealthcheck(input: {
  url: string;
  timeoutMs?: unknown;
  expectedModel?: string | null;
}): Promise<LocalHealthcheckResult> {
  const timeoutMs = Math.max(100, asNumber(input.timeoutMs, 1500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: `healthcheck returned HTTP ${response.status}`,
        url: input.url,
      };
    }

    const payload = await response.json().catch(() => null) as
      | { models?: Array<{ name?: unknown; model?: unknown }> }
      | null;
    const expectedModel = readNonEmptyString(input.expectedModel);
    if (expectedModel && Array.isArray(payload?.models)) {
      const modelFound = payload.models.some((entry) => {
        const name = readNonEmptyString(entry?.name) ?? readNonEmptyString(entry?.model);
        return name === expectedModel;
      });
      if (!modelFound) {
        return {
          ok: false,
          status: response.status,
          detail: `model ${expectedModel} is not available in Ollama`,
          url: input.url,
        };
      }
    }

    return {
      ok: true,
      status: response.status,
      detail: null,
      url: input.url,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      detail: summarizeError(error) ?? "healthcheck failed",
      url: input.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function listOllamaModels(input: {
  url: string;
  timeoutMs?: unknown;
}): Promise<Array<{ id: string; label: string }>> {
  const timeoutMs = Math.max(100, asNumber(input.timeoutMs, 1500));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input.url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return parseOllamaTagsPayload(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function resolveLocalFirstDecision(input: {
  primaryModel: string | null;
  fallbackModel: string | null;
  fallbackPolicy: LocalFallbackPolicy;
  deferWhenPrimaryUnavailable: boolean;
  issuePriority: string | null;
  healthcheck: LocalHealthcheckResult;
}): LocalFirstDecision {
  if (input.healthcheck.ok) {
    return {
      action: "primary",
      model: input.primaryModel,
      reason: null,
      detail: null,
    };
  }

  const allowFallback =
    Boolean(input.fallbackModel) &&
    (
      input.fallbackPolicy === "always" ||
      (input.fallbackPolicy === "critical_only" && input.issuePriority === "critical")
    );
  if (allowFallback) {
    return {
      action: "fallback",
      model: input.fallbackModel,
      reason: "primary_unavailable",
      detail: input.healthcheck.detail,
    };
  }

  if (input.deferWhenPrimaryUnavailable) {
    return {
      action: "defer",
      model: input.primaryModel,
      reason: "primary_unavailable",
      detail: input.healthcheck.detail,
    };
  }

  return {
    action: "primary",
    model: input.primaryModel,
    reason: "primary_unavailable",
    detail: input.healthcheck.detail,
  };
}
