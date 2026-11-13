import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

describe("buildHermesConfig", () => {
  it("stores thinking effort as adapter config instead of an unknown CLI flag", () => {
    const config = buildHermesConfig({ model: "", maxTurnsPerRun: 0, thinkingEffort: "high" } as unknown as CreateConfigValues);
    expect(config.effort).toBe("high");
    expect(config.extraArgs).toBeUndefined();
  });
});
