import { describe, expect, it } from "vitest";
import { Code, Cpu } from "lucide-react";
import {
  getAdapterDisplay,
  getAdapterLabel,
} from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("returns copilot-local display metadata", () => {
    expect(getAdapterLabel("copilot_local")).toBe("Copilot (local)");
    expect(getAdapterDisplay("copilot_local")).toMatchObject({
      label: "Copilot",
      description: "Local GitHub Copilot CLI agent",
      icon: Code,
    });
  });

  it("falls back for unknown adapters", () => {
    expect(getAdapterLabel("custom_local")).toBe("Custom (local)");
    expect(getAdapterDisplay("custom_local")).toMatchObject({
      label: "Custom (local)",
      description: "External local adapter",
      icon: Cpu,
    });
  });
});
