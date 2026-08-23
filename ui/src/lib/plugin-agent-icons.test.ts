import { describe, expect, it } from "vitest";
import {
  registerAgentIcon,
  getRegisteredAgentIcon,
  listRegisteredAgentIcons,
} from "./plugin-agent-icons";

function Dummy() {
  return null;
}

describe("registerAgentIcon", () => {
  it("rejects an id that isn't plugin:<pluginId>:<iconKey>", () => {
    expect(() => registerAgentIcon("mail", Dummy)).toThrow(/plugin:<pluginId>:<iconKey>/);
    expect(() => registerAgentIcon("plugin:only-namespace", Dummy)).toThrow();
  });

  it("registers and retrieves a namespaced icon", () => {
    const id = "plugin:coldsmoke.customizations-by-nick:comms-at";
    registerAgentIcon(id, Dummy);
    expect(getRegisteredAgentIcon(id)).toBe(Dummy);
  });

  it("never shadows a built-in name — it can only add under plugin:", () => {
    expect(() => registerAgentIcon("cpu", Dummy)).toThrow();
  });

  it("lists every registered icon", () => {
    const id = "plugin:coldsmoke.customizations-by-nick:dada-core";
    registerAgentIcon(id, Dummy);
    const listed = listRegisteredAgentIcons();
    expect(listed.some(([name, Icon]) => name === id && Icon === Dummy)).toBe(true);
  });
});
