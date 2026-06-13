import { describe, expect, it } from "vitest";
import { isThirdPartyAnthropicGateway } from "./execute.js";

describe("isThirdPartyAnthropicGateway", () => {
  it("returns false when ANTHROPIC_BASE_URL is unset", () => {
    expect(isThirdPartyAnthropicGateway({})).toBe(false);
  });

  it("returns false for the anthropic.com apex host", () => {
    expect(
      isThirdPartyAnthropicGateway({ ANTHROPIC_BASE_URL: "https://anthropic.com" }),
    ).toBe(false);
  });

  it("returns false for api.anthropic.com (default)", () => {
    expect(
      isThirdPartyAnthropicGateway({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
    ).toBe(false);
  });

  it("returns true for kimi/moonshot anthropic-shim hosts", () => {
    expect(
      isThirdPartyAnthropicGateway({
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      }),
    ).toBe(true);
  });

  it("returns true for minimax / glm gateway hosts", () => {
    expect(
      isThirdPartyAnthropicGateway({
        ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      }),
    ).toBe(true);
    expect(
      isThirdPartyAnthropicGateway({
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      }),
    ).toBe(true);
  });

  it("does not treat phishing-style hosts ending with anthropic.com.evil as Anthropic", () => {
    expect(
      isThirdPartyAnthropicGateway({
        ANTHROPIC_BASE_URL: "https://api.anthropic.com.evil.example/anthropic",
      }),
    ).toBe(true);
  });

  it("returns false when Bedrock auth is enabled (Bedrock is its own path)", () => {
    expect(
      isThirdPartyAnthropicGateway({
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      }),
    ).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isThirdPartyAnthropicGateway({ ANTHROPIC_BASE_URL: "not a url" })).toBe(false);
    expect(isThirdPartyAnthropicGateway({ ANTHROPIC_BASE_URL: "   " })).toBe(false);
  });
});
