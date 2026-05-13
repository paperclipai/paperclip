import { describe, expect, it } from "vitest";
import {
  adapterConfigSchema,
  credentialDeliverySchema,
} from "./agent.js";

describe("adapterConfigSchema — credentialDelivery field", () => {
  it("accepts when credentialDelivery is unset", () => {
    expect(() => adapterConfigSchema.parse({})).not.toThrow();
    expect(() =>
      adapterConfigSchema.parse({ workspacePath: "/foo" }),
    ).not.toThrow();
  });

  it.each(["env", "paperclip-broker", "byo-broker"] as const)(
    "accepts credentialDelivery = %s",
    (value) => {
      expect(() =>
        adapterConfigSchema.parse({ credentialDelivery: value }),
      ).not.toThrow();
    },
  );

  it("rejects unknown credentialDelivery values", () => {
    const result = adapterConfigSchema.safeParse({
      credentialDelivery: "magic",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "credentialDelivery",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/credentialDelivery/i);
    }
  });

  it("rejects non-string credentialDelivery values", () => {
    expect(
      adapterConfigSchema.safeParse({ credentialDelivery: 42 }).success,
    ).toBe(false);
    expect(
      adapterConfigSchema.safeParse({ credentialDelivery: null }).success,
    ).toBe(false);
  });

  it("still validates env bindings alongside credentialDelivery", () => {
    const bad = adapterConfigSchema.safeParse({
      credentialDelivery: "env",
      env: { GH: 42 },
    });
    expect(bad.success).toBe(false);
  });
});

describe("credentialDeliverySchema", () => {
  it("is a strict enum of three values", () => {
    expect(credentialDeliverySchema.parse("env")).toBe("env");
    expect(credentialDeliverySchema.parse("paperclip-broker")).toBe(
      "paperclip-broker",
    );
    expect(credentialDeliverySchema.parse("byo-broker")).toBe("byo-broker");
    expect(() => credentialDeliverySchema.parse("magic")).toThrow();
  });
});
