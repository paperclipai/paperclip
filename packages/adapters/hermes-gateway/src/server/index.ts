export { execute } from "./execute.js";

import type { AdapterEnvironmentTestResult, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { buildAuthorizationHeader } from "./execute.js";

const ENVIRONMENT_TEST_TIMEOUT_MS = 10_000;

function fail(
  ctx: AdapterEnvironmentTestContext,
  code: string,
  message: string,
  hint?: string,
): AdapterEnvironmentTestResult {
  return {
    adapterType: ctx.adapterType,
    status: "fail",
    checks: [
      {
        code,
        level: "error",
        message,
        ...(hint ? { hint } : {}),
      },
    ],
    testedAt: new Date().toISOString(),
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function deriveModelsUrl(url: string): string {
  const normalized = normalizeUrl(url);
  if (normalized.endsWith("/v1")) return `${normalized}/models`;
  if (normalized.endsWith("/v1/responses")) return `${normalized.slice(0, -"/responses".length)}/models`;
  if (normalized.endsWith("/v1/chat/completions")) {
    return `${normalized.slice(0, -"/chat/completions".length)}/models`;
  }
  if (normalized.endsWith("/responses")) return `${normalized.slice(0, -"/responses".length)}/models`;
  if (normalized.endsWith("/chat/completions")) {
    return `${normalized.slice(0, -"/chat/completions".length)}/models`;
  }
  return `${normalized}/v1/models`;
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const url = asString(ctx.config?.url as unknown, "");
  if (!url) {
    return fail(
      ctx,
      "hermes_api_url_missing",
      "No URL configured for Hermes Gateway adapter.",
      "Set adapterConfig.url to the Hermes API base URL, for example http://hermes-gateway.local/v1",
    );
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return fail(
      ctx,
      "hermes_api_url_invalid",
      `Invalid Hermes Gateway URL: ${url}`,
      "Use a full http:// or https:// Hermes API URL, preferably ending in /v1.",
    );
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return fail(
      ctx,
      "hermes_api_url_invalid",
      `Invalid Hermes Gateway URL: ${url}`,
      "Use a full http:// or https:// Hermes API URL, preferably ending in /v1.",
    );
  }

  const modelsUrl = deriveModelsUrl(url);
  const headers: Record<string, string> = { Accept: "application/json" };
  const authorizationHeader = buildAuthorizationHeader(ctx.config?.apiKey);
  if (authorizationHeader) headers.Authorization = authorizationHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENVIRONMENT_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        adapterType: ctx.adapterType,
        status: "pass",
        checks: [
          {
            code: "hermes_api_reachable",
            level: "info",
            message: `Hermes Gateway API reachable at ${modelsUrl}`,
          },
        ],
        testedAt: new Date().toISOString(),
      };
    }

    if (response.status === 404) {
      return {
        adapterType: ctx.adapterType,
        status: "warn",
        checks: [
          {
            code: "hermes_api_models_unavailable",
            level: "warn",
            message: `Hermes Gateway responded at ${modelsUrl}, but /models returned 404.`,
            hint: "The adapter can still run if the configured chat/completions or responses endpoint exists.",
          },
        ],
        testedAt: new Date().toISOString(),
      };
    }

    if (response.status === 401 || response.status === 403) {
      return fail(
        ctx,
        "hermes_api_auth_failed",
        `Hermes Gateway rejected the environment check with HTTP ${response.status}.`,
        "Verify the configured API key or secret reference.",
      );
    }

    return fail(
      ctx,
      "hermes_api_probe_failed",
      `Hermes Gateway environment check failed with HTTP ${response.status}.`,
      `Check that ${modelsUrl} is reachable from the Paperclip server.`,
    );
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        {
          code: isAbort ? "hermes_api_probe_timeout" : "hermes_api_unreachable",
          level: "error",
          message: isAbort
            ? `Timed out checking Hermes Gateway at ${modelsUrl}.`
            : `Could not reach Hermes Gateway at ${modelsUrl}.`,
          hint: "Verify the URL, network policy, service DNS, and port from the Paperclip server.",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}
