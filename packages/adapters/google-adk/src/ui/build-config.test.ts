import { describe, expect, it } from "vitest";
import { buildGoogleAdkConfig } from "./build-config.js";

describe("buildGoogleAdkConfig", () => {
  it("maps create-form values into an ADK adapter config", () => {
    const config = buildGoogleAdkConfig({
      cwd: "/tmp/adk-agent",
      instructionsFilePath: "/tmp/AGENTS.md",
      promptTemplate: "Run as {{agent.name}}",
      model: "gemini-2.5-pro",
      command: "adk",
      timeoutSec: 120,
      extraArgs: " --foo,bar , baz ",
      envBindings: {
        GOOGLE_API_KEY: { type: "secret_ref", secretId: "secret-123", version: "latest" },
        API_HOST: "https://example.test",
        "not-a-valid-key": "ignored",
      },
      envVars: [
        "EXTRA_TOKEN=abc123",
        "API_HOST=should-not-overwrite",
        "# comment",
        "INVALID LINE",
      ].join("\n"),
    } as never);

    expect(config).toEqual({
      agentPath: "/tmp/adk-agent",
      instructionsFilePath: "/tmp/AGENTS.md",
      promptTemplate: "Run as {{agent.name}}",
      model: "gemini-2.5-pro",
      command: "adk",
      timeoutSec: 120,
      graceSec: 15,
      extraArgs: ["--foo", "bar", "baz"],
      env: {
        GOOGLE_API_KEY: {
          type: "secret_ref",
          secretId: "secret-123",
          version: "latest",
        },
        API_HOST: {
          type: "plain",
          value: "https://example.test",
        },
        EXTRA_TOKEN: {
          type: "plain",
          value: "abc123",
        },
      },
    });
  });
});
