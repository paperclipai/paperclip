import { describe, expect, it } from "vitest";
import { claudeBillingIdentity, resolveClaudeAuthMode, type ClaudeAuthMode } from "./auth-mode.js";

describe("resolveClaudeAuthMode", () => {
  it.each<[string, Record<string, unknown>, ClaudeAuthMode]>([
    ["no credentials", {}, "subscription"],
    ["an API key", { ANTHROPIC_API_KEY: "sk-ant-test" }, "api_key"],
    ["a blank API key", { ANTHROPIC_API_KEY: "  " }, "subscription"],
    ["the Bedrock flag", { CLAUDE_CODE_USE_BEDROCK: "1" }, "bedrock"],
    ["the Bedrock flag as true", { CLAUDE_CODE_USE_BEDROCK: "true" }, "bedrock"],
    ["a Bedrock base URL", { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" }, "bedrock"],
    ["the Foundry flag", { CLAUDE_CODE_USE_FOUNDRY: "1" }, "foundry"],
    ["the Foundry flag as true", { CLAUDE_CODE_USE_FOUNDRY: "true" }, "foundry"],
    ["the Foundry flag over an API key", { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_API_KEY: "sk-ant-test" }, "foundry"],
    ["the Bedrock flag over the Foundry flag", { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_FOUNDRY: "1" }, "bedrock"],
    ["a disabled Foundry flag", { CLAUDE_CODE_USE_FOUNDRY: "0" }, "subscription"],
    ["an empty Foundry flag", { CLAUDE_CODE_USE_FOUNDRY: "" }, "subscription"],
    ["a Foundry resource alone", { ANTHROPIC_FOUNDRY_RESOURCE: "my-resource" }, "subscription"],
    ["a Foundry base URL alone", { ANTHROPIC_FOUNDRY_BASE_URL: "https://gw.example/anthropic" }, "subscription"],
  ])("resolves %s", (_name, env, mode) => {
    expect(resolveClaudeAuthMode(env)).toBe(mode);
  });
});

describe("claudeBillingIdentity", () => {
  it.each<[ClaudeAuthMode, ReturnType<typeof claudeBillingIdentity>]>([
    ["bedrock", { provider: "anthropic", biller: "aws_bedrock", billingType: "metered_api" }],
    ["foundry", { provider: "anthropic", biller: "microsoft_foundry", billingType: "metered_api" }],
    ["api_key", { provider: "anthropic", biller: "anthropic", billingType: "api" }],
    ["subscription", { provider: "anthropic", biller: "anthropic", billingType: "subscription" }],
  ])("bills %s runs", (mode, identity) => {
    expect(claudeBillingIdentity(mode)).toEqual(identity);
  });
});
