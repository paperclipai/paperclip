import { describe, expect, it } from "vitest";
import { buildEditedAgentAdapterConfig } from "./agent-config-patch";

describe("buildEditedAgentAdapterConfig", () => {
  it("keeps an explicit empty env object when the edit patch clears environment variables", () => {
    const result = buildEditedAgentAdapterConfig(
      {
        env: {
          HERMES_HOME: {
            type: "plain",
            value: "/Users/seb/.hermes/profiles/hermes-lebi-cmo",
          },
        },
        command: "hermes",
      },
      {
        env: undefined,
      },
    );

    expect(result).toMatchObject({
      env: {},
      command: "hermes",
    });
  });

  it("does not add env when the patch never touched it", () => {
    const result = buildEditedAgentAdapterConfig(
      {
        env: {
          OPENAI_API_KEY: {
            type: "secret_ref",
            secretId: "11111111-1111-4111-8111-111111111111",
            version: "latest",
          },
        },
        command: "codex",
      },
      {
        command: "codex --profile engineer",
      },
    );

    expect(result).toMatchObject({
      env: {
        OPENAI_API_KEY: {
          type: "secret_ref",
          secretId: "11111111-1111-4111-8111-111111111111",
          version: "latest",
        },
      },
      command: "codex --profile engineer",
    });
  });
});
