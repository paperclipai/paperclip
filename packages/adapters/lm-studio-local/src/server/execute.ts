import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { execute as codexExecute } from "@paperclipai/adapter-codex-local/server";
import { DEFAULT_LM_STUDIO_BASE_URL, DEFAULT_LM_STUDIO_API_KEY } from "../index.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config } = ctx;
  const baseUrl = asString(config.baseUrl, DEFAULT_LM_STUDIO_BASE_URL).replace(/\/+$/, "");
  const envConfig = parseObject(config.env);

  const lmStudioEnv: Record<string, unknown> = {
    ...envConfig,
    OPENAI_BASE_URL: `${baseUrl}/v1`,
    OPENAI_API_KEY: DEFAULT_LM_STUDIO_API_KEY,
  };

  const wrappedCtx: AdapterExecutionContext = {
    ...ctx,
    config: {
      ...config,
      env: lmStudioEnv,
      command: asString(config.command, "codex"),
      dangerouslyBypassApprovalsAndSandbox: config.dangerouslyBypassApprovalsAndSandbox ?? true,
    },
  };

  const result = await codexExecute(wrappedCtx);
  return {
    ...result,
    provider: "lm_studio",
    billingType: "subscription",
  };
}
