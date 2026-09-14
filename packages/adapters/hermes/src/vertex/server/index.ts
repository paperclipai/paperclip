import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
} from "@paperclipai/adapter-utils";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

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

const MINIMUM_VERTEX_HERMES_VERSION = [0, 21, 2] as const;
const MINIMUM_VERTEX_HERMES_VERSION_LABEL = MINIMUM_VERTEX_HERMES_VERSION.join(".");

function parseSemanticVersion(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function vertexHermesMinimumVersionCheck(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentCheck | null {
  if (checks.some((check) => check.code === "hermes_cli_not_found")) return null;

  const versionCheck = checks.find((check) => check.code === "hermes_version");
  const version = versionCheck ? parseSemanticVersion(versionCheck.message) : null;
  if (!version) {
    return {
      level: "error",
      message: `Could not verify Hermes Agent ${MINIMUM_VERTEX_HERMES_VERSION_LABEL}+ for Vertex`,
      hint: `Install or upgrade Hermes Agent to version ${MINIMUM_VERTEX_HERMES_VERSION_LABEL} or newer.`,
      code: "google_vertex_hermes_version_unknown",
    };
  }

  let supported = true;
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] > MINIMUM_VERTEX_HERMES_VERSION[index]) break;
    if (version[index] < MINIMUM_VERTEX_HERMES_VERSION[index]) {
      supported = false;
      break;
    }
  }
  if (supported) return null;

  return {
    level: "error",
    message: `Hermes Agent ${version.join(".")} does not support the Vertex adapter`,
    hint: `Upgrade Hermes Agent to version ${MINIMUM_VERTEX_HERMES_VERSION_LABEL} or newer.`,
    code: "google_vertex_hermes_version_unsupported",
  };
}

export async function vertexCredentialCheck(
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
    if (!isAbsolute(credentialPath)) {
      return {
        level: "error",
        message: "Vertex service-account credential path must be absolute",
        hint: "Set credentialsPath to an absolute JSON file path on the selected execution host, or leave it blank to use Application Default Credentials.",
        code: "google_vertex_service_account_path_not_absolute",
      };
    }
    try {
      await access(credentialPath, fsConstants.R_OK);
      const credentialStat = await stat(credentialPath);
      if (!credentialStat.isFile()) {
        return {
          level: "error",
          message: "Vertex service-account credential path is not a regular file",
          hint: "Set credentialsPath to a readable service-account JSON file on the selected execution host.",
          code: "google_vertex_service_account_not_file",
        };
      }
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
  const checks = result.checks.filter(
    (check) =>
      check.code !== "hermes_no_api_keys" &&
      check.code !== "hermes_version_unknown" &&
      check.code !== "hermes_version_failed",
  );
  const versionCheck = vertexHermesMinimumVersionCheck(result.checks);
  if (versionCheck) checks.push(versionCheck);
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
