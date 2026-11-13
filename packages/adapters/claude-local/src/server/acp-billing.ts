import type { AdapterBillingType } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

export function resolveManagedApiKeyBilling(
  config: Record<string, unknown>,
): { provider: string; biller: string; billingType: AdapterBillingType; preferRequestedModel: true } | null {
  const connection = parseObject(config.managedAiConnection);
  const provider = typeof connection.provider === "string" ? connection.provider.trim() : "";
  if (connection.method !== "api_key" || !provider) return null;
  return {
    provider,
    biller: parseObject(config.managedAiRouting).kind === "bedrock" ? "aws_bedrock" : provider,
    billingType: "metered_api",
    preferRequestedModel: true,
  };
}

export function resolveEnvBillingIdentity(
  readEnvValue: (key: string) => string,
): { provider: string; biller: string; billingType: AdapterBillingType } {
  const bedrockFlag = readEnvValue("CLAUDE_CODE_USE_BEDROCK");
  const bedrock = bedrockFlag === "1" || bedrockFlag === "true" || Boolean(readEnvValue("ANTHROPIC_BEDROCK_BASE_URL"));
  const billingType: AdapterBillingType = bedrock
    ? "metered_api"
    : readEnvValue("ANTHROPIC_API_KEY")
    ? "api"
    : "subscription";
  return {
    provider: "anthropic",
    biller: bedrock ? "aws_bedrock" : "anthropic",
    billingType,
  };
}
