import { describe, expect, it } from "vitest";
import { buildDistillLocalConfig } from "./build-config.js";

describe("buildDistillLocalConfig", () => {
  it("defaults the model to auto and maps create-form values into adapter config", () => {
    expect(
      buildDistillLocalConfig({
        cwd: "/tmp/project",
        instructionsFilePath: "/tmp/AGENTS.md",
        thinkingEffort: "high",
        extraArgs: "--no-subagents, --foo",
      } as never),
    ).toEqual({
      cwd: "/tmp/project",
      instructionsFilePath: "/tmp/AGENTS.md",
      model: "auto",
      timeoutSec: 0,
      graceSec: 20,
      reasoningEffort: "high",
      extraArgs: ["--no-subagents", "--foo"],
    });
  });
});

describe("buildDistillLocalConfig distill settings", () => {
  it("copies execution mode, worker and variant choices from the create form", () => {
    const ac = buildDistillLocalConfig({
      adapterSchemaValues: { mode: "normal", workerModel: "glm-5.3", workerEffort: "low", mainVariant: "nitro", workerVariant: "" },
    } as never);
    expect(ac).toMatchObject({ mode: "normal", workerModel: "glm-5.3", workerEffort: "low", mainVariant: "nitro" });
    expect(ac).not.toHaveProperty("workerVariant");
  });
});
