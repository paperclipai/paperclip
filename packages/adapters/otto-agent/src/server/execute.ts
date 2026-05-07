import type {
  AdapterBillingType,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

type OttoAgentConfig = {
  url: string;
  apiKey: string;
  model?: string;
  provider?: string;
  timeoutSec?: number;
  toolsets?: string;
  env?: Record<string, string>;
};

type OttoRequest = {
  runId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  prompt: string;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  taskKey?: string | null;
  model?: string;
  provider?: string;
  toolsets?: string;
  env?: Record<string, string>;
  context?: Record<string, unknown>;
};

type UsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

type OttoResponse = {
  ok: boolean;
  summary: string;
  sessionId?: string | null;
  sessionDisplayId?: string | null;
  model?: string;
  provider?: string;
  usage?: UsageSummary;
  billingType?: unknown;
  costUsd?: unknown;
  errorMessage?: string;
  errorCode?: string;
};

function resolveConfig(ctx: AdapterExecutionContext): OttoAgentConfig {
  const raw = parseObject(ctx.config);
  const url = asString(raw.url, "").trim();

  if (!url) {
    throw new Error(
      "otto_agent adapter requires 'url' in adapterConfig. Contact your Otto operator for your endpoint.",
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`otto_agent adapter: invalid URL '${url}'. Use https:// for remote hosts.`);
  }
  if (
    parsedUrl.protocol === "http:" &&
    !["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname)
  ) {
    throw new Error(
      "otto_agent adapter: plaintext HTTP is not permitted for remote hosts. Use https://.",
    );
  }

  const apiKey = asString(raw.apiKey, "").trim() || undefined;
  if (!apiKey) {
    throw new Error(
      "otto_agent adapter requires 'apiKey' in adapterConfig. Contact your Otto operator for credentials.",
    );
  }

  const timeoutSec = asNumber(raw.timeoutSec, 1800);
  return {
    url,
    apiKey,
    model: asString(raw.model, "").trim() || undefined,
    provider: asString(raw.provider, "").trim() || undefined,
    timeoutSec: timeoutSec > 0 ? timeoutSec : 1800,
    toolsets: asString(raw.toolsets, "").trim() || undefined,
    env:
      typeof raw.env === "object" && raw.env !== null && !Array.isArray(raw.env)
        ? (raw.env as Record<string, string>)
        : undefined,
  };
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const parts: string[] = [];
  const c = parseObject(ctx.context);

  if (c.prompt) parts.push(String(c.prompt));
  if (parts.length === 0 && c.builderPrompt) parts.push(String(c.builderPrompt));
  if (c.instructions) parts.push(String(c.instructions));
  if (c.wakeText) parts.push(String(c.wakeText));
  if (parts.length === 0) parts.push(JSON.stringify(ctx.context, null, 2));

  return parts.join("\n\n");
}

function resolveBillingType(result: OttoResponse): AdapterBillingType {
  switch (result.billingType) {
    case "api":
    case "subscription":
    case "metered_api":
    case "subscription_included":
    case "subscription_overage":
    case "credits":
    case "fixed":
    case "unknown":
      return result.billingType;
  }
  return typeof result.costUsd === "number" && result.costUsd > 0 ? "metered_api" : "unknown";
}

function resolveCostUsd(result: OttoResponse): number | null {
  return typeof result.costUsd === "number" && Number.isFinite(result.costUsd)
    ? result.costUsd
    : null;
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  let config: OttoAgentConfig;
  try {
    config = resolveConfig(ctx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[otto-agent] ERROR: ${errorMessage}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      errorCode: "CONFIG_ERROR",
    };
  }
  const prompt = buildPrompt(ctx);

  const body: OttoRequest = {
    runId: ctx.runId,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    prompt,
    sessionId: ctx.runtime.sessionId,
    sessionParams: ctx.runtime.sessionParams,
    taskKey: ctx.runtime.taskKey,
    model: config.model,
    provider: config.provider,
    toolsets: config.toolsets,
    env: config.env,
    context: ctx.context,
  };

  await ctx.onLog("stdout", `[otto-agent] POST ${config.url}\n`);
  await ctx.onLog(
    "stdout",
    `[otto-agent] agent=${ctx.agent.name} session=${ctx.runtime.sessionId ?? "new"} model=${config.model ?? "default"}\n`,
  );

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "otto_agent",
      command: `POST ${config.url}`,
      prompt,
      context: ctx.context,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
  };

  const controller = new AbortController();
  const timeoutMs = (config.timeoutSec ?? 1800) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const errorMessage = isTimeout
      ? `Request timed out after ${config.timeoutSec}s`
      : `HTTP request failed: ${err instanceof Error ? err.message : String(err)}`;

    await ctx.onLog("stderr", `[otto-agent] ERROR: ${errorMessage}\n`);

    return {
      exitCode: 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage,
      errorCode: isTimeout ? "TIMEOUT" : "HTTP_ERROR",
    };
  }

  clearTimeout(timer);

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const errorMessage = `HTTP ${response.status}: ${response.statusText}${responseBody ? ` — ${responseBody.slice(0, 500)}` : ""}`;

    await ctx.onLog("stderr", `[otto-agent] ERROR: ${errorMessage}\n`);

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
      errorCode: `HTTP_${response.status}`,
    };
  }

  let result: OttoResponse;
  try {
    result = (await response.json()) as OttoResponse;
  } catch {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Failed to parse response JSON from Otto gateway",
      errorCode: "PARSE_ERROR",
    };
  }

  await ctx.onLog(
    "stdout",
    `[otto-agent] response ok — session=${result.sessionId ?? "none"}\n`,
  );

  if (result.summary) {
    await ctx.onLog("stdout", result.summary + "\n");
  }

  if (!result.ok) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: result.errorMessage ?? "Remote Otto Agent returned an error",
      errorCode: result.errorCode ?? "AGENT_ERROR",
      summary: result.summary ?? null,
      sessionId: result.sessionId,
      sessionDisplayId: result.sessionDisplayId,
      usage: result.usage,
      model: result.model,
      provider: result.provider,
    };
  }

  const costUsd = resolveCostUsd(result);

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: result.summary ?? null,
    sessionId: result.sessionId,
    sessionDisplayId: result.sessionDisplayId ?? result.sessionId,
    usage: result.usage,
    model: result.model,
    provider: result.provider,
    billingType: resolveBillingType(result),
    costUsd,
  };
}
