import { describe, expect, it } from "vitest";
import { randomAgentAppearance } from "@paperclipai/shared";
import { configPatchFromSnapshot } from "../lib/agent-records.js";

const baseSnapshot = {
  name: "Agent",
  role: "engineer",
  adapterType: "process",
  budgetMonthlyCents: 0,
};

describe("configPatchFromSnapshot", () => {
  it("restores icon and appearance from the snapshot", () => {
    const appearance = randomAgentAppearance();
    const patch = configPatchFromSnapshot({ ...baseSnapshot, icon: "bot", appearance });
    expect(patch.icon).toBe("bot");
    expect(patch.appearance).toEqual(appearance);
  });

  it("restores a null icon", () => {
    expect(configPatchFromSnapshot({ ...baseSnapshot, icon: null }).icon).toBeNull();
  });

  it("leaves icon and appearance out when the snapshot lacks valid values", () => {
    const patch = configPatchFromSnapshot({ ...baseSnapshot, icon: 5, appearance: { bad: true } });
    expect(patch).not.toHaveProperty("icon");
    expect(patch).not.toHaveProperty("appearance");
    const legacy = configPatchFromSnapshot(baseSnapshot);
    expect(legacy).not.toHaveProperty("icon");
    expect(legacy).not.toHaveProperty("appearance");
  });
});
