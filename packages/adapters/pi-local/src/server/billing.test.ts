import { describe, expect, it } from "vitest";
import { resolvePiBillingType } from "./execute.js";

describe("resolvePiBillingType", () => {
  it("marks subscription-backed billers as subscription_included", () => {
    expect(resolvePiBillingType({}, "clawrouter")).toBe("subscription_included");
    expect(resolvePiBillingType({}, "claude-bridge")).toBe("subscription_included");
  });

  it("keeps subscription attribution when the agent env holds non-LLM credentials", () => {
    const env = {
      GOOGLE_ADS_DEVELOPER_TOKEN: "token",
      WOOCOMMERCE_CONSUMER_KEY: "key",
    };
    expect(resolvePiBillingType(env, "clawrouter")).toBe("subscription_included");
  });

  it("prefers the subscription biller over a stray provider key", () => {
    expect(resolvePiBillingType({ OPENAI_API_KEY: "sk-test" }, "clawrouter")).toBe(
      "subscription_included",
    );
  });

  it("reports metered_api when a provider key backs a non-subscription biller", () => {
    expect(resolvePiBillingType({ ANTHROPIC_API_KEY: "sk-ant" }, "anthropic")).toBe("metered_api");
  });

  it("ignores empty provider keys", () => {
    expect(resolvePiBillingType({ OPENAI_API_KEY: "   " }, "openai")).toBe("subscription_included");
  });

  it("never emits unknown, which would suppress cost estimation", () => {
    expect(resolvePiBillingType({}, "unknown")).not.toBe("unknown");
  });
});
