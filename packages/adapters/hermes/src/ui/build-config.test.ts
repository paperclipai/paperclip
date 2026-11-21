import { describe, expect, it } from "vitest";
import { buildHermesConfig } from "./build-config.js";

describe("buildHermesConfig", () => {
  it("maps create-form values and environment bindings into adapter config", () => {
    expect(
      buildHermesConfig({
        cwd: "/tmp/project",
        model: "nousresearch/hermes-3-llama-3.1-405b",
        thinkingEffort: "medium",
        command: "hermes",
        extraArgs: "--verbose",
        promptTemplate: "You are a helpful assistant",
        maxTurnsPerRun: 50,
        envVars: "EXTRA_FLAG=1\n",
        envBindings: {
          OPENROUTER_API_KEY: {
            type: "secret_ref",
            secretId: "secret-1",
          },
        },
      } as never),
    ).toEqual({
      cwd: "/tmp/project",
      model: "nousresearch/hermes-3-llama-3.1-405b",
      hermesCommand: "hermes",
      timeoutSec: 1800,
      maxTurnsPerRun: 50,
      persistSession: true,
      extraArgs: ["--verbose", "--reasoning-effort", "medium"],
      promptTemplate: "You are a helpful assistant",
      env: {
        OPENROUTER_API_KEY: {
          type: "secret_ref",
          secretId: "secret-1",
        },
        EXTRA_FLAG: {
          type: "plain",
          value: "1",
        },
      },
    });
  });

  it("omits env when no variables or bindings are provided", () => {
    const config = buildHermesConfig({
      model: "hermes-default",
      envBindings: {},
      envVars: "",
    } as never);

    expect(config.env).toBeUndefined();
    expect(config.model).toBe("hermes-default");
  });
});
