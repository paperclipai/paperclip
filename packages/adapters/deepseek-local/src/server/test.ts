import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import { DEEPSEEK_DEFAULT_BASE_URL } from "../index.js";
import { resolveDeepseekApiKey } from "./execute.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export interface TestEnvironmentDeps {
  fetchImpl?: typeof fetch;
  processEnv?: NodeJS.ProcessEnv;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: TestEnvironmentDeps = {},
): Promise<AdapterEnvironmentTestResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const processEnv = deps.processEnv ?? process.env;
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const apiKey = resolveDeepseekApiKey({ config, processEnv });
  if (!apiKey) {
    checks.push({
      code: "deepseek_api_key_missing",
      level: "error",
      message: "DeepSeek API key not configured.",
      hint: "Set adapter env DEEPSEEK_API_KEY (preferably via a Paperclip secret) or set DEEPSEEK_API_KEY in the server environment.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const baseUrl = trimTrailingSlash(nonEmpty(config.baseUrl) ?? DEEPSEEK_DEFAULT_BASE_URL);
  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      checks.push({
        code: "deepseek_api_key_unauthorized",
        level: "error",
        message: `DeepSeek rejected the API key (HTTP ${response.status}).`,
        hint: "Verify the key in https://platform.deepseek.com and that DEEPSEEK_API_KEY is set correctly.",
      });
    } else if (!response.ok) {
      checks.push({
        code: "deepseek_models_endpoint_failed",
        level: "warn",
        message: `DeepSeek /models endpoint returned HTTP ${response.status}.`,
        hint: "Auth looks reachable but the catalog probe failed. Check DeepSeek status or override baseUrl.",
      });
    } else {
      checks.push({
        code: "deepseek_api_reachable",
        level: "info",
        message: `DeepSeek API reachable at ${baseUrl} and key is accepted.`,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "deepseek_api_unreachable",
      level: "error",
      message: `Could not reach DeepSeek API at ${baseUrl}: ${reason}`,
      hint: "Check network egress and baseUrl. The default endpoint is https://api.deepseek.com/v1.",
    });
  } finally {
    clearTimeout(timer);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
