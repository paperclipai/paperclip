import { describe, expect, it } from "vitest";
import { agentHarnessType, agentRuntimeSettingsHarness, paperclipRunnerProfileForHarness } from "./agent-runner.js";

describe("Cursor Cloud harness identity", () => {
  it("retains its cloud identity across the explicit runner selection", () => {
    expect(paperclipRunnerProfileForHarness("cursor_cloud")).toEqual({ provider: "cursor_cloud" });
    expect(agentHarnessType("paperclip_runner", { provider: "cursor_cloud" })).toBe("cursor_cloud");
    expect(agentRuntimeSettingsHarness("paperclip_runner", { provider: "cursor_cloud" })).toBe("cursor_cloud");
    expect(agentHarnessType("cursor_cloud")).toBe("cursor_cloud");
  });
});
