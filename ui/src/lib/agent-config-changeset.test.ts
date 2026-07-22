import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentConfigChanges, revertAgentConfigChange } from "./agent-config-changeset";

const agent = { adapterType: "codex_local", adapterConfig: { model: "gpt-5", cwd: "/old" }, runtimeConfig: { heartbeat: { intervalSec: 300 } } } as unknown as Agent;

describe("agent config changeset", () => {
  it("builds review rows from overlay keys", () => {
    const changes = buildAgentConfigChanges(agent, { identity: {}, adapterConfig: { model: "gpt-5.5", cwd: "/new" }, heartbeat: { intervalSec: 600 }, runtime: {} });
    expect(changes.map((change) => [change.key, change.before, change.after, change.section])).toEqual([
      ["adapterConfig.model", "gpt-5", "gpt-5.5", "Runtime"],
      ["adapterConfig.cwd", "/old", "/new", "Danger & Legacy"],
      ["heartbeat.intervalSec", 300, 600, "Schedule & Runs"],
    ]);
  });

  it("reverts one row without disturbing the rest", () => {
    const overlay = { identity: {}, adapterConfig: { model: "gpt-5.5", cwd: "/new" }, heartbeat: {}, runtime: {} };
    expect(revertAgentConfigChange(overlay, "adapterConfig.model")).toEqual({ identity: {}, adapterConfig: { cwd: "/new" }, heartbeat: {}, runtime: {} });
  });
});
