import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL } from "./index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function asStringHeaders(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parseObject(value)).filter(
      (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function readApiToken(config: Record<string, unknown>): string {
  const explicit = asString(config.apiToken, "").trim();
  if (explicit) return explicit;

  const headers = asStringHeaders(config.headers);
  const candidates = [
    headers["cf-aig-authorization"],
    headers["CF-AIG-Authorization"],
    headers.Authorization,
    headers.authorization,
  ];
  for (const candidate of candidates) {
    const authorization = asString(candidate, "").trim();
    if (/^Bearer\s+/i.test(authorization)) {
      return authorization.replace(/^Bearer\s+/i, "").trim();
    }
  }
  return "";
}

function readSelectedModel(config: Record<string, unknown>): string {
  const configured = asString(config.model, "").trim();
  if (!configured || configured.toLowerCase() === "auto") {
    return DEFAULT_CLOUDFLARE_WORKERS_AI_MODEL;
  }
  return configured;
}

function encodeModelPath(model: string): string {
  return model
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildRunUrl(input: { accountId: string; gatewayId: string | null; model: string }): URL {
  const pathName = input.gatewayId
    ? `/v1/${encodeURIComponent(input.accountId)}/${encodeURIComponent(input.gatewayId)}/compat/chat/completions`
    : `/client/v4/accounts/${encodeURIComponent(input.accountId)}/ai/run/${encodeModelPath(input.model)}`;
  return new URL(pathName, input.gatewayId ? "https://gateway.ai.cloudflare.com" : "https://api.cloudflare.com");
}

function extractErrorMessage(value: unknown): string {
  const root = parseObject(value);
  const direct = asString(root.error, "").trim();
  if (direct) return direct;
  const errors = Array.isArray(root.errors) ? root.errors : [];
  const messages = errors
    .map((entry) => {
      const record = parseObject(entry);
      return asString(record.message, asString(record.error, "")).trim();
    })
    .filter(Boolean);
  return messages.join("; ");
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const accountId = asString(config.accountId, "").trim();
  const apiToken = readApiToken(config);
  const gatewayId = asString(config.gatewayId, "").trim() || null;
  const model = readSelectedModel(config);

  if (!accountId) {
    checks.push({
      code: "cloudflare_workers_ai_account_id_missing",
      level: "error",
      message: "Cloudflare Workers AI adapter requires an account ID.",
      hint: "Set adapterConfig.accountId to your Cloudflare account ID.",
    });
  }

  if (!apiToken) {
    checks.push({
      code: "cloudflare_workers_ai_api_token_missing",
      level: "error",
      message: "Cloudflare Workers AI adapter requires an API token.",
      hint: "Set adapterConfig.apiToken to a token with Workers AI access.",
    });
  }

  if (checks.some((check) => check.level === "error")) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const runUrl = buildRunUrl({ accountId, gatewayId, model });
  checks.push({
    code: gatewayId ? "cloudflare_workers_ai_gateway_enabled" : "cloudflare_workers_ai_direct_enabled",
    level: "info",
    message: gatewayId
      ? `Requests will route through AI Gateway "${gatewayId}" via the compat chat completions endpoint.`
      : "Requests will route directly to Cloudflare Workers AI.",
  });
  checks.push({
    code: "cloudflare_workers_ai_run_url_resolved",
    level: "info",
    message: `Resolved run endpoint: ${runUrl.toString()}`,
  });
  checks.push({
    code: "cloudflare_workers_ai_model_selected",
    level: "info",
    message: `Selected model: ${model}`,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      signal: controller.signal,
    });
    const payload = parseObject(await response.json().catch(() => null));
    const errorMessage = extractErrorMessage(payload);
    if (!response.ok || payload.success === false || errorMessage) {
      checks.push({
        code: "cloudflare_workers_ai_token_verify_failed",
        level: "error",
        message: errorMessage || `Cloudflare token verification failed with HTTP ${response.status}.`,
        hint: "Verify the token has Workers AI access and belongs to the same account you configured.",
      });
    } else {
      const result = parseObject(payload.result);
      const status = asString(result.status, "").trim();
      checks.push({
        code: "cloudflare_workers_ai_token_verify_ok",
        level: "info",
        message: status
          ? `Cloudflare API token verified (${status}).`
          : "Cloudflare API token verified.",
      });
    }
  } catch (err) {
    checks.push({
      code: "cloudflare_workers_ai_token_verify_unreachable",
      level: "warn",
      message: err instanceof Error ? err.message : "Cloudflare token verification failed",
      hint: "This may be expected in restricted networks; verify connectivity when invoking runs.",
    });
  } finally {
    clearTimeout(timeout);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
