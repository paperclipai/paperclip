import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { testEnvironment as openclawTestEnvironment } from "@paperclipai/adapter-openclaw-gateway/server";

const NANOCLAW_DEFAULT_URL = "ws://127.0.0.1:18789";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  // Apply NanoClaw default URL if none provided
  const config =
    typeof ctx.config === "object" && ctx.config !== null && !Array.isArray(ctx.config)
      ? (ctx.config as Record<string, unknown>)
      : {};

  const url = typeof config.url === "string" && config.url.trim() ? config.url : NANOCLAW_DEFAULT_URL;

  const patchedCtx: AdapterEnvironmentTestContext = {
    ...ctx,
    config: { ...config, url },
  };

  const result = await openclawTestEnvironment(patchedCtx);

  // Re-label checks for NanoClaw context
  return {
    ...result,
    adapterType: "nanoclaw_gateway",
  };
}
