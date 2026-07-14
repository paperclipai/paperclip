import { describe, expect, it } from "vitest";
import { createCostEventSchema } from "./cost.js";

const validCostEvent = {
  agentId: "5b8eec2a-3d7b-4ef0-b4c2-9fc7ed1fef38",
  provider: "openai",
  model: "gpt-5",
  costCents: 12,
  occurredAt: "2026-07-15T00:00:00.000Z",
};

describe("cost validators", () => {
  it("defaults external cost events to an unknown usage basis", () => {
    expect(createCostEventSchema.parse(validCostEvent).usageBasis).toBe("unknown");
  });

  it.each(["per_request", "per_run", "unknown"] as const)(
    "accepts the %s usage basis",
    (usageBasis) => {
      expect(createCostEventSchema.parse({ ...validCostEvent, usageBasis }).usageBasis)
        .toBe(usageBasis);
    },
  );

  it("rejects unsupported usage bases", () => {
    expect(() => createCostEventSchema.parse({
      ...validCostEvent,
      usageBasis: "per_token",
    })).toThrow();
  });
});
