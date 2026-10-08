import { describe, expect, it } from "vitest";
import { AGENT_ROLE_LABELS, acceptInviteSchema, builtInAgentProvisionSchema, createAgentSchema, updateAgentSchema } from "./index.js";

describe("dynamic adapter type validation schemas", () => {
  it("leaves an omitted built-in adapter choice for server-owned resolution", () => {
    expect(builtInAgentProvisionSchema.parse({})).toEqual({});
    expect(createAgentSchema.parse({ name: "Default Agent" }).adapterType).toBe("process");
  });

  it.each(["process", "codex_local", "claude_local", "paperclip_runner", "external_adapter"])(
    "preserves an explicit built-in adapter choice: %s",
    (adapterType) => {
      expect(builtInAgentProvisionSchema.parse({ adapterType }).adapterType).toBe(adapterType);
    },
  );

  it.each(["", "   ", null, 123])("rejects an invalid built-in adapter choice: %s", (adapterType) => {
    expect(() => builtInAgentProvisionSchema.parse({ adapterType })).toThrow();
  });

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
});
