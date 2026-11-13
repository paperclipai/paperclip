import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

const values = (adapterSchemaValues: Record<string, unknown>): CreateConfigValues => ({
  model: "",
  maxTurnsPerRun: 0,
  adapterSchemaValues,
} as CreateConfigValues);

describe("buildHermesConfig", () => {
  it("preserves explicit structured-result booleans from schema-driven fields", () => {
    expect(buildHermesConfig(values({ quiet: true, emitResultRecord: true }))).toMatchObject({
      quiet: true,
      emitResultRecord: true,
    });
    expect(buildHermesConfig(values({ quiet: false, emitResultRecord: false }))).toMatchObject({
      quiet: false,
      emitResultRecord: false,
    });
  });

  it("ignores non-boolean structured-result values", () => {
    const config = buildHermesConfig(values({ quiet: "yes", emitResultRecord: 1 }));
    expect(config).not.toHaveProperty("quiet");
    expect(config).not.toHaveProperty("emitResultRecord");
  });
});
