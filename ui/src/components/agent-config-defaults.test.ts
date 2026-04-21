import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "./agent-config-defaults";

describe("defaultCreateValues", () => {
  it("starts new agents with bounded heartbeat runtime defaults", () => {
    expect(defaultCreateValues.timeoutSec).toBe(1800);
    expect(defaultCreateValues.graceSec).toBe(20);
  });
});
