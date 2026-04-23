export { execute } from "./execute.js";

import type { AdapterEnvironmentTestResult, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const url = asString(ctx.config?.url as unknown, "");
  if (!url) {
    return {
      adapterType: ctx.adapterType,
      status: "warn",
      checks: [
        {
          code: "hermes_api_url_missing",
          level: "warn",
          message: "No URL configured for Hermes Gateway adapter.",
          hint: "Set adapterConfig.url to the Hermes API base URL, for example http://hermes-service:8642/v1",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        {
          code: "hermes_api_url_invalid",
          level: "error",
          message: `Invalid Hermes Gateway URL: ${url}`,
          hint: "Use a full http:// or https:// Hermes API URL, preferably ending in /v1.",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        {
          code: "hermes_api_url_invalid",
          level: "error",
          message: `Invalid Hermes Gateway URL: ${url}`,
          hint: "Use a full http:// or https:// Hermes API URL, preferably ending in /v1.",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  return {
    adapterType: ctx.adapterType,
    status: "pass",
    checks: [
      {
        code: "hermes_api_url",
        level: "info",
        message: `Hermes Gateway URL configured: ${parsedUrl.origin}`,
      },
    ],
    testedAt: new Date().toISOString(),
  };
}
