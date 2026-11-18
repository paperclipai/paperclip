/**
 * How the Claude CLI authenticates a run, read from the environment the CLI
 * process receives. Every billing and environment-check decision for Claude
 * derives from this one value, so a new provider is added here once.
 *
 * Precedence follows the CLI: a cloud provider flag wins over an API key.
 * Claude Code uses Microsoft Foundry only when CLAUDE_CODE_USE_FOUNDRY is set;
 * ANTHROPIC_FOUNDRY_RESOURCE and ANTHROPIC_FOUNDRY_BASE_URL only configure it.
 */
export type ClaudeAuthMode = "bedrock" | "foundry" | "api_key" | "subscription";

export interface ClaudeBillingIdentity {
  provider: "anthropic";
  biller: "anthropic" | "aws_bedrock" | "microsoft_foundry";
  billingType: "api" | "subscription" | "metered_api";
}

function flagEnabled(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const flag = value.trim();
  return flag === "1" || flag === "true";
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveClaudeAuthMode(env: Record<string, unknown>): ClaudeAuthMode {
  if (flagEnabled(env.CLAUDE_CODE_USE_BEDROCK) || nonEmpty(env.ANTHROPIC_BEDROCK_BASE_URL)) return "bedrock";
  if (flagEnabled(env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  return nonEmpty(env.ANTHROPIC_API_KEY) ? "api_key" : "subscription";
}

/** Cloud providers bill per token through their own account, so their runs are metered_api. */
export function claudeBillingIdentity(mode: ClaudeAuthMode): ClaudeBillingIdentity {
  switch (mode) {
    case "bedrock":
      return { provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" };
    case "foundry":
      return { provider: "anthropic", biller: "microsoft_foundry", billingType: "metered_api" };
    case "api_key":
      return { provider: "anthropic", biller: "anthropic", billingType: "api" };
    case "subscription":
      return { provider: "anthropic", biller: "anthropic", billingType: "subscription" };
  }
}
