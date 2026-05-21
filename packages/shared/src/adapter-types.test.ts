import { describe, expect, it } from "vitest";
import { AGENT_KINDS, AGENT_ROLE_LABELS, acceptInviteSchema, createAgentSchema, updateAgentSchema } from "./index.js";

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

  it("defaults kind to 'agent' when omitted (legacy callers unchanged)", () => {
    expect(
      createAgentSchema.parse({
        name: "Legacy Agent",
        adapterType: "codex_local",
      }).kind,
    ).toBe("agent");
  });

  it("accepts kind='guild' for v2 organisation guild records", () => {
    expect(
      createAgentSchema.parse({
        name: "Eng Guild",
        kind: "guild",
        adapterType: "codex_local",
      }).kind,
    ).toBe("guild");
  });

  it("exposes all four AGENT_KINDS values to createAgentSchema", () => {
    for (const kind of AGENT_KINDS) {
      expect(
        createAgentSchema.parse({
          name: `kind-${kind}`,
          kind,
          adapterType: "codex_local",
        }).kind,
      ).toBe(kind);
    }
  });

  it("rejects unknown kind values", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "Bogus",
        kind: "wizard" as unknown as (typeof AGENT_KINDS)[number],
        adapterType: "codex_local",
      }),
    ).toThrow();
  });

  it("allows updating kind via updateAgentSchema", () => {
    expect(
      updateAgentSchema.parse({
        kind: "guild",
      }).kind,
    ).toBe("guild");
  });
});
