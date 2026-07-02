import { describe, expect, it } from "vitest";
import { getAdapterLabel } from "./adapter-display-registry";

describe("getAdapterLabel", () => {
  it("keeps built-in display map labels with local suffix", () => {
    expect(getAdapterLabel("claude_local")).toBe("Claude Code (local)");
  });

  it("parenthesizes external adapter type segments after the first", () => {
    expect(getAdapterLabel("cursor_phantom_agent")).toBe("Cursor (Phantom Agent)");
    expect(getAdapterLabel("hermes_phantom_agent")).toBe("Hermes (Phantom Agent)");
  });

  it("uses flat spacing before suffix for multi-segment local adapters", () => {
    expect(getAdapterLabel("phantom_agent_local")).toBe("Phantom Agent (local)");
  });
});
