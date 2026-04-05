import { describe, expect, it } from "vitest";
import { expandShellStyleAgentHome } from "@paperclipai/adapter-utils/server-utils";

describe("expandShellStyleAgentHome", () => {
  it("replaces $AGENT_HOME with the given directory", () => {
    expect(expandShellStyleAgentHome("Read $AGENT_HOME/HEARTBEAT.md", "/tmp/agent")).toBe(
      "Read /tmp/agent/HEARTBEAT.md",
    );
  });

  it("is a no-op without agent home", () => {
    const s = "See $AGENT_HOME/x";
    expect(expandShellStyleAgentHome(s, null)).toBe(s);
    expect(expandShellStyleAgentHome(s, "")).toBe(s);
    expect(expandShellStyleAgentHome(s, "   ")).toBe(s);
  });
});
