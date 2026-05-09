import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_ENDPOINT_MODE,
  DEFAULT_HERMES_API_BASE_URL,
} from "../shared/constants.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1") && path.startsWith("/v1/")) {
    return `${trimmed}${path.slice(3)}`;
  }
  return `${trimmed}${path}`;
}

function normalizeBaseUrl(config: Record<string, unknown>): string {
  const configured = asString(config.hermesApiBaseUrl).trim();
  return configured || DEFAULT_HERMES_API_BASE_URL;
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const baseUrl = normalizeBaseUrl(config);
  const endpointMode = asString(config.endpointMode).trim() || DEFAULT_ENDPOINT_MODE;
  const checks: AdapterEnvironmentCheck[] = [];
  const testedAt = new Date().toISOString();

  try {
    const health = await fetch(joinUrl(baseUrl, "/health"), {
      headers: {
        Accept: "application/json",
      },
    });
    if (!health.ok) {
      checks.push({
        code: "hermes_api_health_failed",
        level: "error",
        message: `Hermes API health probe failed at ${joinUrl(baseUrl, "/health")}`,
        detail: `${health.status} ${health.statusText}`,
        hint: "Start Hermes gateway with the API server enabled and confirm /health returns 200.",
      });
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt,
      };
    }
    checks.push({
      code: "hermes_api_health_ok",
      level: "info",
      message: `Hermes API reachable at ${baseUrl}`,
      detail: "GET /health returned 200.",
    });
  } catch (error) {
    checks.push({
      code: "hermes_api_unreachable",
      level: "error",
      message: `Hermes API unreachable at ${baseUrl}`,
      detail: error instanceof Error ? error.message : String(error),
      hint: "Run `API_SERVER_ENABLED=1 API_SERVER_PORT=8000 hermes gateway` and confirm /health and /v1/capabilities respond.",
    });
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt,
    };
  }

  try {
    const capabilitiesResponse = await fetch(joinUrl(baseUrl, "/v1/capabilities"), {
      headers: {
        Accept: "application/json",
      },
    });
    if (capabilitiesResponse.ok) {
      const capabilities = await safeJson(capabilitiesResponse);
      const features =
        capabilities && typeof capabilities.features === "object" && capabilities.features !== null
          ? (capabilities.features as Record<string, unknown>)
          : {};

      const responsesStreaming = features.responses_streaming === true;
      const chatStreaming = features.chat_completions_streaming === true;
      const toolProgress = features.tool_progress_events === true;

      if (endpointMode === "responses" && !responsesStreaming) {
        checks.push({
          code: "hermes_capabilities_responses_missing",
          level: "warn",
          message: "Hermes capabilities do not advertise Responses streaming support.",
          hint: "The adapter can fall back to chat completions streaming at runtime, or you can set endpointMode=chat_completions.",
        });
      } else {
        checks.push({
          code: "hermes_capabilities_responses_ok",
          level: "info",
          message: "Hermes capabilities advertise Responses streaming support.",
        });
      }

      if (!chatStreaming) {
        checks.push({
          code: "hermes_capabilities_chat_missing",
          level: "warn",
          message: "Hermes capabilities do not advertise chat completions streaming support.",
        });
      }

      if (!toolProgress) {
        checks.push({
          code: "hermes_capabilities_tool_progress_missing",
          level: "warn",
          message: "Hermes capabilities do not advertise hermes.tool.progress events.",
          hint: "Responses streaming still works, but chat completions fallback will have reduced tool visibility.",
        });
      }
    } else {
      checks.push({
        code: "hermes_capabilities_unavailable",
        level: "warn",
        message: `Hermes capabilities probe returned ${capabilitiesResponse.status}.`,
        hint: "The adapter can still try the configured endpoint directly, but /v1/capabilities is the preferred compatibility check.",
      });
    }
  } catch (error) {
    checks.push({
      code: "hermes_capabilities_fetch_failed",
      level: "warn",
      message: "Failed to read Hermes /v1/capabilities.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const status =
    checks.some((check) => check.level === "error")
      ? "fail"
      : checks.some((check) => check.level === "warn")
        ? "warn"
        : "pass";

  return {
    adapterType: ADAPTER_TYPE,
    status,
    checks,
    testedAt,
  };
}
