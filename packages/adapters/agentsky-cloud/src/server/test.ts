import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, buildPaperclipEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  AGENTSKY_HARNESSES,
  AGENTSKY_MODELS,
  DEFAULT_AGENTSKY_API_BASE_URL,
  DEFAULT_AGENTSKY_HARNESS,
  defaultAgentskyModel,
  isAgentskyHarness,
  isAgentskyModelCompatible,
} from "../models.js";
import { AgentskyApiError, createAgentskyClient } from "./agentsky-api.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function asStringEnvMap(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const rec = entry as Record<string, unknown>;
      if (rec.type === "plain" && typeof rec.value === "string") env[key] = rec.value;
    }
  }
  return env;
}

function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = asStringEnvMap(config.env);
  const apiToken = asString(env.AGENTSKY_API_TOKEN, "").trim();
  const agentSlug = asString(config.agentSlug, "").trim();
  const harness = asString(config.harness, "").trim() || DEFAULT_AGENTSKY_HARNESS;
  const model = asString(config.model, "").trim();
  const apiBaseUrl = asString(config.apiBaseUrl, "").trim() || DEFAULT_AGENTSKY_API_BASE_URL;

  if (!apiToken) {
    checks.push({
      code: "agentsky_cloud_api_token_missing",
      level: "error",
      message: "AGENTSKY_API_TOKEN is required.",
      hint: "Add AGENTSKY_API_TOKEN under environment variables for this adapter (mint one at agentsky.dev → Settings → API tokens).",
    });
  } else if (!apiToken.startsWith("ast_")) {
    checks.push({
      code: "agentsky_cloud_api_token_format",
      level: "warn",
      message: "AGENTSKY_API_TOKEN does not look like an AgentSky token (expected an ast_ prefix).",
    });
  }

  let baseUrlValid = true;
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http(s)");
  } catch {
    baseUrlValid = false;
    checks.push({
      code: "agentsky_cloud_base_url_invalid",
      level: "error",
      message: "apiBaseUrl must be an http(s) URL.",
      detail: apiBaseUrl,
    });
  }

  if (!isAgentskyHarness(harness)) {
    checks.push({
      code: "agentsky_cloud_harness_invalid",
      level: "error",
      message: `Unknown harness "${harness}". Valid harnesses: ${AGENTSKY_HARNESSES.join(", ")}.`,
    });
  } else if (model && !isAgentskyModelCompatible(harness, model)) {
    checks.push({
      code: "agentsky_cloud_model_incompatible",
      level: "error",
      message: `Model "${model}" is not compatible with harness "${harness}". Valid models: ${AGENTSKY_MODELS[harness].join(", ")}.`,
    });
  } else if (!model) {
    checks.push({
      code: "agentsky_cloud_model_default",
      level: "info",
      message: `No model configured; the ${harness} default (${defaultAgentskyModel(harness)}) will be used.`,
    });
  }

  if (apiToken && baseUrlValid) {
    const client = createAgentskyClient({ baseUrl: apiBaseUrl, token: apiToken });
    try {
      const me = await client.whoami();
      checks.push({
        code: "agentsky_cloud_auth_ok",
        level: "info",
        message: "AgentSky API token is valid.",
        detail: [
          me.email ? `Authenticated as ${me.email}` : null,
          me.universe ? `universe ${me.universe}` : null,
          me.scopes.length > 0 ? `scopes: ${me.scopes.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      if (me.scopes.length > 0 && !me.scopes.includes("write") && !me.scopes.includes("admin")) {
        checks.push({
          code: "agentsky_cloud_scope_missing",
          level: "warn",
          message: "The token lacks the write scope; agent/session creation and message sends will fail.",
        });
      }
    } catch (err) {
      checks.push({
        code: "agentsky_cloud_auth_failed",
        level: "error",
        message:
          err instanceof AgentskyApiError
            ? `AgentSky rejected the token${err.code ? ` (${err.code})` : ""}: ${err.message}`
            : err instanceof Error
              ? `Failed to reach the AgentSky API: ${err.message}`
              : "Failed to validate the AgentSky API token.",
      });
    }

    if (agentSlug && !checks.some((check) => check.code === "agentsky_cloud_auth_failed")) {
      try {
        const remote = await client.getAgent(agentSlug);
        if (remote.archived) {
          checks.push({
            code: "agentsky_cloud_agent_archived",
            level: "warn",
            message: `AgentSky agent "${agentSlug}" is archived; new sessions cannot be started on it.`,
          });
        } else {
          checks.push({
            code: "agentsky_cloud_agent_ok",
            level: "info",
            message: `AgentSky agent "${agentSlug}" is reachable${
              remote.agentType ? ` (${remote.agentType}${remote.llm ? ` / ${remote.llm}` : ""})` : ""
            }.`,
          });
          if (
            (remote.agentType && remote.agentType !== harness) ||
            (model && remote.llm && remote.llm !== model)
          ) {
            checks.push({
              code: "agentsky_cloud_agent_mismatch",
              level: "warn",
              message: `Configured harness/model (${harness}${model ? ` / ${model}` : ""}) differ from the attached agent's (${remote.agentType ?? "?"} / ${remote.llm ?? "?"}); the attached agent's values win.`,
            });
          }
        }
      } catch (err) {
        checks.push({
          code: "agentsky_cloud_agent_not_found",
          level: "error",
          message:
            err instanceof AgentskyApiError && err.status === 404
              ? `AgentSky agent "${agentSlug}" was not found (or the token cannot see it).`
              : `Failed to look up AgentSky agent "${agentSlug}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  const paperclipApiUrl = buildPaperclipEnv({ id: "environment-test", companyId: ctx.companyId }).PAPERCLIP_API_URL;
  if (paperclipApiUrl && isLoopbackUrl(paperclipApiUrl)) {
    checks.push({
      code: "agentsky_cloud_paperclip_api_local",
      level: "warn",
      message: `The Paperclip API URL advertised to agents (${paperclipApiUrl}) is a loopback address; cloud AgentSky agents cannot reach it, so agent-initiated callbacks will not work and the run report is the only feedback channel.`,
      hint: "Expose Paperclip publicly and set PAPERCLIP_API_URL if agents should call back.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
