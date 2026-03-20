import { describe, it, expect } from "vitest";
import {
  resolveStripeKeysFromProcessEnv,
  syncStripeStandardEnvFromResolved,
  trimEnv,
} from "../stripe-env.js";

describe("stripe-env", () => {
  it("trimEnv returns undefined for blank", () => {
    expect(trimEnv(undefined)).toBeUndefined();
    expect(trimEnv("")).toBeUndefined();
    expect(trimEnv("  ")).toBeUndefined();
    expect(trimEnv(" pk_1 ")).toBe("pk_1");
  });

  it("prefers STRIPE_TEST_* over generic STRIPE_*", () => {
    const env = {
      STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_a",
      STRIPE_PUBLISHABLE_KEY: "pk_live_b",
      STRIPE_TEST_SECRET_KEY: "sk_test_c",
      STRIPE_SECRET_KEY: "sk_live_d",
    };
    const r = resolveStripeKeysFromProcessEnv(env);
    expect(r.publishableKey).toBe("pk_test_a");
    expect(r.secretKey).toBe("sk_test_c");
  });

  it("falls back to generic names when test-prefixed unset", () => {
    const env = {
      STRIPE_PUBLISHABLE_KEY: "pk_x",
      STRIPE_SECRET_KEY: "sk_y",
    };
    const r = resolveStripeKeysFromProcessEnv(env);
    expect(r.publishableKey).toBe("pk_x");
    expect(r.secretKey).toBe("sk_y");
  });

  it("syncStripeStandardEnvFromResolved writes standard names", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    syncStripeStandardEnvFromResolved(env, {
      publishableKey: "pk_test_z",
      secretKey: "sk_test_z",
    });
    expect(env.STRIPE_PUBLISHABLE_KEY).toBe("pk_test_z");
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_z");
  });
});
