import { describe, expect, it } from "vitest";
import { resolveAgentCwd } from "../services/heartbeat.js";

describe("resolveAgentCwd", () => {
  it("prefers agent.cwd over adapterConfig.cwd", () => {
    const agent = { cwd: "/workspace/agent-1", adapterConfig: { cwd: "/old/path" } };
    expect(resolveAgentCwd(agent)).toBe("/workspace/agent-1");
  });

  it("falls back to adapterConfig.cwd when agent.cwd is null", () => {
    const agent = { cwd: null, adapterConfig: { cwd: "/legacy/path" } };
    expect(resolveAgentCwd(agent)).toBe("/legacy/path");
  });

  it("returns null when no cwd configured", () => {
    const agent = { cwd: null, adapterConfig: {} };
    expect(resolveAgentCwd(agent)).toBeNull();
  });

  it("trims whitespace from cwd", () => {
    const agent = { cwd: "  /workspace/agent-1  ", adapterConfig: {} };
    expect(resolveAgentCwd(agent)).toBe("/workspace/agent-1");
  });

  it("treats empty string as null and falls back", () => {
    const agent = { cwd: "   ", adapterConfig: { cwd: "/fallback" } };
    expect(resolveAgentCwd(agent)).toBe("/fallback");
  });
});
