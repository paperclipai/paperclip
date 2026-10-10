import { describe, expect, it } from "vitest";
import {
  agentApiKeyScopeSchema,
  normalizeAgentApiKeyScope,
} from "./agent.js";

describe("agentApiKeyScopeSchema", () => {
  it("accepts the service scope", () => {
    expect(agentApiKeyScopeSchema.parse({ kind: "service" })).toEqual({
      kind: "service",
    });
  });

  it("rejects a service scope carrying extra boundary fields", () => {
    expect(
      agentApiKeyScopeSchema.safeParse({
        kind: "service",
        issueId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });

  it("keeps the service scope through normalization", () => {
    expect(normalizeAgentApiKeyScope({ kind: "service" })).toEqual({
      kind: "service",
    });
  });

  it("falls back to the standard scope for unknown kinds", () => {
    expect(normalizeAgentApiKeyScope({ kind: "not_a_scope" })).toEqual({
      kind: "standard",
    });
  });
});
