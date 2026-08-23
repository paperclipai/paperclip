import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./agent.js";

const base = {
  name: "Test Agent",
  adapterType: "claude-code",
};

function parseIcon(icon: unknown) {
  return createAgentSchema.safeParse({ ...base, icon });
}

describe("createAgentSchema icon", () => {
  it("accepts a built-in AGENT_ICON_NAMES value", () => {
    expect(parseIcon("rocket").success).toBe(true);
  });

  it("accepts a namespaced plugin icon id", () => {
    expect(parseIcon("plugin:coldsmoke.customizations-by-nick:comms-at").success).toBe(true);
  });

  it("accepts null and omission", () => {
    expect(parseIcon(null).success).toBe(true);
    expect(createAgentSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an unknown bare name that isn't namespaced", () => {
    expect(parseIcon("comms-at").success).toBe(false);
  });

  it("rejects a plugin id missing the iconKey segment", () => {
    expect(parseIcon("plugin:coldsmoke.customizations-by-nick").success).toBe(false);
  });

  it("rejects a plugin id with an uppercase or invalid segment", () => {
    expect(parseIcon("plugin:ColdSmoke:comms-at").success).toBe(false);
    expect(parseIcon("plugin::comms-at").success).toBe(false);
    expect(parseIcon("plugin:coldsmoke:Comms_At").success).toBe(false);
  });
});
