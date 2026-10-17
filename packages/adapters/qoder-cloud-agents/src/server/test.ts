import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_QODER_API_BASE_URL } from "../index.js";
import { createQoderClient, isHttpsUrl, normalizeQoderApiBaseUrl, type QoderFetch } from "./client.js";
import { parseHttpRepoUrl } from "./repo-url.js";

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

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: { fetchImpl?: QoderFetch } = {},
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = asStringEnvMap(config.env);
  const token = asString(env.QODER_ACCESS_TOKEN, "").trim() || asString(env.QODER_PAT, "").trim();
  const apiBaseUrl = normalizeQoderApiBaseUrl(asString(config.apiBaseUrl, ""), DEFAULT_QODER_API_BASE_URL);
  const repoUrl = asString(config.repoUrl, "").trim();
  const model = asString(config.model, "").trim();
  const environmentId = asString(config.environmentId, "").trim();

  if (!token) {
    checks.push({
      code: "qoder_cloud_agents_token_missing",
      level: "error",
      message: "QODER_ACCESS_TOKEN is required.",
      hint: "Add a Qoder personal access token or service account token as QODER_ACCESS_TOKEN under environment variables for this adapter.",
    });
  }

  if (repoUrl) {
    checks.push(parseHttpRepoUrl(repoUrl)
      ? {
          code: "qoder_cloud_agents_repo_present",
          level: "info",
          message: `Repository configured: ${repoUrl}`,
        }
      : {
          code: "qoder_cloud_agents_repo_invalid",
          level: "error",
          message: "repoUrl must be an http(s) repository URL; Qoder cannot clone SSH URLs.",
          detail: repoUrl,
        });
  }

  const secureApiBaseUrl = isHttpsUrl(apiBaseUrl);
  if (!secureApiBaseUrl) {
    checks.push({
      code: "qoder_cloud_agents_api_base_url_insecure",
      level: "error",
      message: "apiBaseUrl must be an https URL.",
      detail: apiBaseUrl,
      hint: "Paperclip does not send the Qoder access token over an unencrypted connection.",
    });
  }

  if (token && secureApiBaseUrl) {
    const client = createQoderClient({
      apiBaseUrl,
      token,
      fetchImpl: deps.fetchImpl,
      signal: AbortSignal.timeout(30_000),
    });
    let authenticated = false;
    try {
      await client.listAgents(1);
      authenticated = true;
      checks.push({
        code: "qoder_cloud_agents_auth_ok",
        level: "info",
        message: `Qoder access token is valid for ${apiBaseUrl}.`,
      });
    } catch (err) {
      checks.push({
        code: "qoder_cloud_agents_auth_failed",
        level: "error",
        message: err instanceof Error ? err.message : "Failed to validate the Qoder access token.",
        hint: `Check the token and that apiBaseUrl (${apiBaseUrl}) matches the token's region.`,
      });
    }

    if (authenticated && model) {
      try {
        const match = (await client.listModels()).some((entry) => entry.id === model);
        checks.push({
          code: match ? "qoder_cloud_agents_model_ok" : "qoder_cloud_agents_model_unknown",
          level: match ? "info" : "warn",
          message: match
            ? `Model "${model}" is available to the authenticated Qoder account.`
            : `Model "${model}" was not found in the authenticated Qoder model list.`,
        });
      } catch (err) {
        checks.push({
          code: "qoder_cloud_agents_model_probe_failed",
          level: "warn",
          message: err instanceof Error ? err.message : "Failed to validate model availability.",
        });
      }
    }

    if (authenticated && environmentId) {
      try {
        const match = (await client.listEnvironments()).find((entry) => entry.id === environmentId);
        const config = match?.config as { type?: unknown } | null | undefined;
        if (match && config?.type === "self_hosted") {
          checks.push({
            code: "qoder_cloud_agents_environment_self_hosted",
            level: "warn",
            message: `Environment "${environmentId}" is self-hosted.`,
            hint: "Tool calls only run when your own worker returns their results, and Qoder ignores session env vars and repository resources there. Use a cloud environment unless a worker is running.",
          });
        } else {
          checks.push({
            code: match ? "qoder_cloud_agents_environment_ok" : "qoder_cloud_agents_environment_unknown",
            level: match ? "info" : "warn",
            message: match
              ? `Environment "${environmentId}" exists in the authenticated Qoder account.`
              : `Environment "${environmentId}" was not found in the first page of Qoder environments.`,
          });
        }
      } catch (err) {
        checks.push({
          code: "qoder_cloud_agents_environment_probe_failed",
          level: "warn",
          message: err instanceof Error ? err.message : "Failed to validate the Qoder environment.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
