import { describe, expect, it } from "vitest";

import { buildHermesConfig } from "./build-config.js";

describe("buildHermesConfig", () => {
  it("persists schema-driven Hermes settings", () => {
    const config = buildHermesConfig({
      model: "",
      cwd: "",
      command: "",
      extraArgs: "",
      thinkingEffort: "",
      promptTemplate: "",
      maxTurnsPerRun: 1000,
      adapterSchemaValues: {
        provider: "openrouter",
        quiet: true,
        persistSession: false,
        maxTurnsPerRun: 12,
        timeoutSec: 1800,
      },
    } as any);

    expect(config).toMatchObject({
      provider: "openrouter",
      quiet: true,
      persistSession: false,
      maxTurnsPerRun: 12,
      timeoutSec: 1800,
    });
  });

  it("keeps the legacy run-limit fallback when schema values are unavailable", () => {
    const config = buildHermesConfig({
      model: "",
      cwd: "",
      command: "",
      extraArgs: "",
      thinkingEffort: "",
      promptTemplate: "",
      maxTurnsPerRun: 1000,
    } as any);

    expect(config).toMatchObject({
      maxTurnsPerRun: 1000,
      timeoutSec: 20000,
    });
  });
});
