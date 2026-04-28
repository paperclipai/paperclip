import { describe, expect, it } from "vitest";
import {
  getAdapterDisplay,
  getAdapterLabel,
  isKnownAdapterType,
} from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("treats copilot_local as a first-class built-in adapter", () => {
    const display = getAdapterDisplay("copilot_local");

    expect(display.label).toBe("GitHub Copilot");
    expect(display.description).toBe("Local GitHub Copilot agent");
    expect(display.icon).toBeDefined();
    expect(isKnownAdapterType("copilot_local")).toBe(true);
    expect(getAdapterLabel("copilot_local")).toBe("GitHub Copilot (local)");
  });
});
