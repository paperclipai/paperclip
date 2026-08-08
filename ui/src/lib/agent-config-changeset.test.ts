import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { agentConfigValuesEqual, buildAgentConfigChanges, revertAgentConfigChange } from "./agent-config-changeset";

const agent = { adapterType: "codex_local", adapterConfig: { model: "gpt-5", cwd: "/old" }, runtimeConfig: { heartbeat: { intervalSec: 300 } } } as unknown as Agent;

describe("agent config changeset", () => {
  it("builds review rows from overlay keys", () => {
    const changes = buildAgentConfigChanges(agent, { identity: {}, adapterConfig: { model: "gpt-5.5", cwd: "/new" }, heartbeat: { intervalSec: 600 }, runtime: {} });
    expect(changes.map((change) => [change.key, change.before, change.after, change.section])).toEqual([
      ["adapterConfig.model", "gpt-5", "gpt-5.5", "Runtime"],
      ["adapterConfig.cwd", "/old", "/new", "Danger & Legacy"],
      ["runtimeConfig.heartbeat.intervalSec", 300, 600, "Schedule & Runs"],
    ]);
  });

  it("drops no-op rows that restore the saved value (danger toggle off->on)", () => {
    const dangerAgent = {
      adapterType: "claude_local",
      adapterConfig: { dangerouslySkipPermissions: true },
      runtimeConfig: {},
    } as unknown as Agent;
    // Overlay ends up holding the saved value again after off->on.
    const changes = buildAgentConfigChanges(dangerAgent, {
      identity: {},
      adapterConfig: { dangerouslySkipPermissions: true },
      heartbeat: {},
      runtime: {},
    });
    expect(changes).toEqual([]);
  });

  it("still records a genuine danger toggle change", () => {
    const dangerAgent = {
      adapterType: "claude_local",
      adapterConfig: { dangerouslySkipPermissions: true },
      runtimeConfig: {},
    } as unknown as Agent;
    const changes = buildAgentConfigChanges(dangerAgent, {
      identity: {},
      adapterConfig: { dangerouslySkipPermissions: false },
      heartbeat: {},
      runtime: {},
    });
    expect(changes.map((c) => [c.key, c.before, c.after, c.section])).toEqual([
      ["adapterConfig.dangerouslySkipPermissions", true, false, "Danger & Legacy"],
    ]);
  });

  it("compares structurally for object/array overlay values", () => {
    expect(agentConfigValuesEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(agentConfigValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(agentConfigValuesEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(agentConfigValuesEqual(undefined, undefined)).toBe(true);
  });

  it("reverts one row without disturbing the rest", () => {
    const overlay = { identity: {}, adapterConfig: { model: "gpt-5.5", cwd: "/new" }, heartbeat: {}, runtime: {} };
    expect(revertAgentConfigChange(overlay, "adapterConfig.model")).toEqual({ identity: {}, adapterConfig: { cwd: "/new" }, heartbeat: {}, runtime: {} });
  });
});
