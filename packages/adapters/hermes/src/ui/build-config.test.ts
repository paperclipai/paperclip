import { expect, test } from "vitest";

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { buildHermesConfig } from "./build-config.js";

test("buildHermesConfig preserves schema-configured MOA bindings", () => {
  const config = buildHermesConfig({
    model: "qwen3.6:27b",
    maxTurnsPerRun: 0,
    adapterSchemaValues: {
      profile: "planner",
      moaProfileBindings: '{ "planner": "LagunaS-Qwen" }',
    },
  } as unknown as CreateConfigValues);

  expect(config.profile).toBe("planner");
  expect(config.moaProfileBindings).toBe('{ "planner": "LagunaS-Qwen" }');
});
