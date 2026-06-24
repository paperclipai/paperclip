import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABELS, acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("accepts external adapter types in create/update agent schemas", () => {
    expect(
      createAgentSchema.parse({
        name: "External Agent",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");

    expect(
      updateAgentSchema.parse({
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("still rejects blank adapter types", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Blank Adapter",
        adapterType: "   ",
      }),
    ).toThrow();
  });

  it("accepts an explicit managed instructions bundle for new agents", () => {
    expect(
      createAgentSchema.parse({
        name: "Bundle Agent",
        adapterType: "codex_local",
        instructionsBundle: {
          files: {
            "AGENTS.md": "Use AGENTS.md.",
          },
        },
      }).instructionsBundle?.files["AGENTS.md"],
    ).toBe("Use AGENTS.md.");
  });

  it("accepts external adapter types in invite acceptance schema", () => {
    expect(
      acceptInviteSchema.parse({
        requestType: "agent",
        agentName: "External Joiner",
        adapterType: "external_adapter",
      }).adapterType,
    ).toBe("external_adapter");
  });

  it("preserves pause metadata in update agent schemas", () => {
    const pausedAt = "2026-06-24T00:00:00.000Z";
    const parsed = updateAgentSchema.parse({
      pauseReason: "budget exceeded: $223.85 spent / $200.00 cap",
      pausedAt,
    });

    expect(parsed.pauseReason).toBe("budget exceeded: $223.85 spent / $200.00 cap");
    expect(parsed.pausedAt).toEqual(new Date(pausedAt));
  });

  it("accepts the security agent role and exposes its UI label", () => {
    expect(
      createAgentSchema.parse({
        name: "Security Engineer",
        role: "security",
        adapterType: "codex_local",
      }).role,
    ).toBe("security");

    expect(AGENT_ROLE_LABELS.security).toBe("Security");
  });
});
