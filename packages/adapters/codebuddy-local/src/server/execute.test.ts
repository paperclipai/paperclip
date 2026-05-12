import { describe, it, expect, vi } from "vitest";
import { resolveCodeBuddyBillingType } from "./execute.js";

describe("resolveCodeBuddyBillingType", () => {
  it("returns subscription when no API keys are set", () => {
    expect(resolveCodeBuddyBillingType({})).toBe("subscription");
  });

  it("returns api when CODEBUDDY_API_KEY is set", () => {
    expect(resolveCodeBuddyBillingType({ CODEBUDDY_API_KEY: "sk-xxx" })).toBe("api");
  });

  it("returns api when OPENAI_API_KEY is set", () => {
    expect(resolveCodeBuddyBillingType({ OPENAI_API_KEY: "sk-xxx" })).toBe("api");
  });

  it("returns api when ANTHROPIC_API_KEY is set", () => {
    expect(resolveCodeBuddyBillingType({ ANTHROPIC_API_KEY: "sk-xxx" })).toBe("api");
  });

  it("returns subscription when API key is empty string", () => {
    expect(resolveCodeBuddyBillingType({ CODEBUDDY_API_KEY: "" })).toBe("subscription");
  });

  it("returns subscription when API key is whitespace", () => {
    expect(resolveCodeBuddyBillingType({ CODEBUDDY_API_KEY: "   " })).toBe("subscription");
  });
});
