import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

import {
  DEFAULT_GOOGLE_VERTEX_MODEL,
  DEFAULT_GOOGLE_VERTEX_REGION,
  GOOGLE_VERTEX_PROVIDER,
} from "../shared/constants.js";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function buildGoogleVertexRuntimeConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const env =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {};
  const projectId = nonEmptyString(config.projectId);
  const region = nonEmptyString(config.region) ?? DEFAULT_GOOGLE_VERTEX_REGION;
  const credentialsPath = nonEmptyString(config.credentialsPath);

  if (projectId) env.VERTEX_PROJECT_ID = projectId;
  if (region) env.VERTEX_REGION = region;
  if (credentialsPath) env.VERTEX_CREDENTIALS_PATH = credentialsPath;

  return {
    ...config,
    env,
    provider: GOOGLE_VERTEX_PROVIDER,
    model: nonEmptyString(config.model) ?? DEFAULT_GOOGLE_VERTEX_MODEL,
  };
}

export function withGoogleVertexExecutionConfig(
  ctx: AdapterExecutionContext,
): AdapterExecutionContext {
  const config = buildGoogleVertexRuntimeConfig(ctx.config ?? {});
  return {
    ...ctx,
    config,
    agent: { ...ctx.agent, adapterConfig: config },
  };
}

export function withGoogleVertexTestConfig(
  ctx: AdapterEnvironmentTestContext,
): AdapterEnvironmentTestContext {
  return { ...ctx, config: buildGoogleVertexRuntimeConfig(ctx.config ?? {}) };
}
