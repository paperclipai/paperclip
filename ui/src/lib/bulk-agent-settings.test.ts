import { describe, expect, it } from "vitest";
import { mapBulkAgents, sameBinding } from "./bulk-agent-settings";

describe("bulk agent writes", () => {
  it("bounds concurrent requests and retains each success and failure in input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapBulkAgents([0, 1, 2, 3, 4, 5, 6], async id => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, id === 0 ? 15 : 1));
      active--;
      if (id === 2) throw new Error("Unavailable");
      return id;
    });
    expect(peak).toBe(4);
    expect(results.map(r => r.status === "fulfilled" ? r.value : "failed")).toEqual([0, 1, "failed", 3, 4, 5, 6]);
  });
  it("compares binding identity independently of JSON field order", () => {
    expect(sameBinding({ provider: "openai", method: "api_key", mode: "responsible_user" }, { mode: "responsible_user", method: "api_key", provider: "openai" })).toBe(true);
    expect(sameBinding(undefined, { mode: "responsible_user", method: "api_key", provider: "openai" })).toBe(false);
  });
});
