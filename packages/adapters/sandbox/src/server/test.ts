import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  createSandboxProvider,
  describeSandboxProvider,
  readSandboxProviderType,
} from "./provider.js";

export function buildChecks(config: Record<string, unknown>): AdapterEnvironmentCheck[] {
  const checks: AdapterEnvironmentCheck[] = [];
  const providerConfig = parseObject(config.providerConfig);
  const env = parseObject(config.env);
  const sandboxAgentType = asString(config.sandboxAgentType, "").trim();
  let providerType: ReturnType<typeof readSandboxProviderType> | null = null;

  try {
    providerType = readSandboxProviderType(config);
  } catch (err) {
    checks.push({
      code: "unsupported_provider",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
      hint: "Use one of: cloudflare, e2b, opensandbox.",
    });
  }

  if (!sandboxAgentType) {
    checks.push({
      code: "missing_agent_type",
      level: "error",
      message: "sandboxAgentType is required",
      hint: "Set the inner runtime, for example claude_local or codex_local.",
    });
  }

  if (providerType === "cloudflare" && !asString(providerConfig.baseUrl, "").trim()) {
    checks.push({
      code: "missing_base_url",
      level: "error",
      message: "providerConfig.baseUrl is required",
      hint: "Point this at your deployed Cloudflare sandbox gateway worker.",
    });
  }

  if (
    providerType === "e2b" &&
    !asString(providerConfig.template, "").trim() &&
    !asString(providerConfig.image, "").trim()
  ) {
    checks.push({
      code: "missing_template",
      level: "error",
      message: "providerConfig.template is required",
      hint: "Set an E2B template or snapshot with the target CLI installed.",
    });
  }

  if (
    providerType === "e2b" &&
    !asString(providerConfig.apiKey, "").trim() &&
    !asString(providerConfig.accessToken, "").trim() &&
    !Object.prototype.hasOwnProperty.call(env, "E2B_API_KEY") &&
    !Object.prototype.hasOwnProperty.call(env, "E2B_ACCESS_TOKEN")
  ) {
    checks.push({
      code: "missing_e2b_auth",
      level: "error",
      message: "E2B credentials are required",
      hint: "Provide E2B_API_KEY or E2B_ACCESS_TOKEN in env bindings or providerConfig.",
    });
  }

  if (
    providerType === "opensandbox" &&
    !asString(providerConfig.image, "").trim()
  ) {
    checks.push({
      code: "missing_image",
      level: "error",
      message: "providerConfig.image is required",
      hint: "Set the OpenSandbox container image with the target CLI installed.",
    });
  }

  if (
    providerType === "opensandbox" &&
    !asString(providerConfig.apiKey, "").trim() &&
    !Object.prototype.hasOwnProperty.call(env, "OPEN_SANDBOX_API_KEY")
  ) {
    checks.push({
      code: "missing_opensandbox_auth",
      level: "error",
      message: "OpenSandbox credentials are required",
      hint: "Provide OPEN_SANDBOX_API_KEY in env bindings or providerConfig.",
    });
  }

  return checks;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks = buildChecks(ctx.config);

  if (checks.some((check) => check.level === "error")) {
    return {
      adapterType: "sandbox",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const providerType = readSandboxProviderType(ctx.config);
    const provider = createSandboxProvider(ctx.config);
    const result = await provider.testConnection(ctx.config);
    checks.push({
      code: result.ok ? "provider_ok" : "provider_warn",
      level: result.ok ? "info" : "warn",
      message: result.ok
        ? `${describeSandboxProvider(providerType)} reachable`
        : `${describeSandboxProvider(providerType)} returned a warning`,
      detail: result.detail ?? null,
    });
  } catch (err) {
    checks.push({
      code: "provider_unreachable",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    adapterType: "sandbox",
    status: checks.some((check) => check.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
