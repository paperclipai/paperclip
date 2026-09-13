import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import { access } from "node:fs/promises";

import { execute as executeHermes } from "../../server/execute.js";
import { testEnvironment as testHermesEnvironment } from "../../server/test.js";
import { GOOGLE_VERTEX_ADAPTER_TYPE } from "../shared/constants.js";
import {
  buildGoogleVertexRuntimeConfig,
  withGoogleVertexExecutionConfig,
  withGoogleVertexTestConfig,
} from "./config.js";
export { getGoogleVertexConfigSchema } from "./config-schema.js";
export { buildGoogleVertexRuntimeConfig } from "./config.js";

export async function executeGoogleVertex(ctx: AdapterExecutionContext) {
  return executeHermes(withGoogleVertexExecutionConfig(ctx));
}

async function vertexCredentialCheck(
  config: Record<string, unknown>,
): Promise<AdapterEnvironmentCheck> {
  const env = (config.env ?? {}) as Record<string, unknown>;
  const credentialPath =
    typeof env.VERTEX_CREDENTIALS_PATH === "string" && env.VERTEX_CREDENTIALS_PATH.length > 0
      ? env.VERTEX_CREDENTIALS_PATH
      : typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string" && env.GOOGLE_APPLICATION_CREDENTIALS.length > 0
        ? env.GOOGLE_APPLICATION_CREDENTIALS
        : null;
  if (credentialPath) {
    try {
      await access(credentialPath);
    } catch {
      return {
        level: "error",
        message: "Vertex service-account credential file is not readable",
        hint: "Check credentialsPath on the selected execution host, or leave it blank to use Application Default Credentials.",
        code: "google_vertex_service_account_unreadable",
      };
    }
    return {
      level: "info",
      message: "Vertex service-account credential path is configured",
      hint: "Hermes will mint and refresh OAuth2 access tokens at runtime; tokens are never stored in Paperclip config.",
      code: "google_vertex_service_account_configured",
    };
  }
  return {
    level: "info",
    message: "Vertex will use Google Application Default Credentials",
    hint: "Ensure ADC is available on the selected execution host and can access the configured Google Cloud project.",
    code: "google_vertex_adc",
  };
}

export async function testGoogleVertexEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const vertexCtx = withGoogleVertexTestConfig(ctx);
  const result = await testHermesEnvironment(vertexCtx);
  const checks = result.checks.filter((check) => check.code !== "hermes_no_api_keys");
  checks.push(await vertexCredentialCheck(buildGoogleVertexRuntimeConfig(ctx.config ?? {})));
  const hasErrors = checks.some((check) => check.level === "error");
  const hasWarnings = checks.some((check) => check.level === "warn");
  return {
    ...result,
    adapterType: GOOGLE_VERTEX_ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
  };
}
