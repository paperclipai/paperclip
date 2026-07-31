import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestStatus,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_API_VERSION,
  type DeploymentKind,
} from "../shared/constants.js";
import { buildRequestUrl } from "./execute.js";

/**
 * Environment probe:
 *  - Config completeness (endpoint, apiKey, deployment when required)
 *  - HTTP reachability via a 1-token completion probe
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { config } = ctx;
  const checks: AdapterEnvironmentCheck[] = [];

  const endpoint = asString(config.endpoint, "");
  const apiKey = asString(config.apiKey, "");
  const deploymentKind: DeploymentKind =
    asString(config.deploymentKind, "azure_openai") === "azure_ai_foundry"
      ? "azure_ai_foundry"
      : "azure_openai";
  const deployment = asString(config.deployment, "");
  const apiVersion = asString(config.apiVersion, DEFAULT_API_VERSION);

  checks.push({
    code: "endpoint",
    level: endpoint ? "info" : "error",
    message: endpoint ? `endpoint=${endpoint}` : "config.endpoint is required",
  });
  checks.push({
    code: "api_key",
    level: apiKey ? "info" : "error",
    message: apiKey ? "api key present" : "config.apiKey is required",
  });
  checks.push({
    code: "deployment",
    level: deploymentKind === "azure_ai_foundry" || deployment ? "info" : "error",
    message:
      deploymentKind === "azure_ai_foundry"
        ? "not required for Foundry serverless"
        : deployment
          ? `deployment=${deployment}`
          : "config.deployment is required for Azure OpenAI",
  });

  const configOk = checks.every((c) => c.level !== "error");
  if (!configOk) {
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const url = buildRequestUrl({ endpoint, deployment, apiVersion, deploymentKind });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
    });

    if (res.ok) {
      checks.push({
        code: "reachability",
        level: "info",
        message: `HTTP ${res.status}`,
      });
      return {
        adapterType: ADAPTER_TYPE,
        status: "pass",
        checks,
        testedAt: new Date().toISOString(),
      };
    }

    const level: AdapterEnvironmentCheckLevel =
      res.status === 401 || res.status === 403 || res.status === 404 ? "error" : "warn";
    const body = await safeReadText(res);
    checks.push({
      code: "reachability",
      level,
      message: `HTTP ${res.status} — ${truncate(body, 300)}`,
    });
    return {
      adapterType: ADAPTER_TYPE,
      status: level === "error" ? "fail" : "warn",
      checks,
      testedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "reachability",
      level: "error",
      message,
    });
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
