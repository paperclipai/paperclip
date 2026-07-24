import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildCopilotLocalConfig } from "./build-config.js";

function values(
  overrides: Partial<CreateConfigValues> = {},
): CreateConfigValues {
  return {
    adapterType: "copilot_local",
    cwd: "/workspace",
    promptTemplate: "",
    model: "gpt-5.6-sol",
    thinkingEffort: "high",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 1,
    heartbeatEnabled: true,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildCopilotLocalConfig", () => {
  it("builds persistent ACP configuration with secret-aware environment bindings", () => {
    expect(
      buildCopilotLocalConfig(
        values({
          copilotAcpPermissionMode: "approve-reads",
          envBindings: {
            COPILOT_GITHUB_TOKEN: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        }),
      ),
    ).toMatchObject({
      cwd: "/workspace",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      mode: "persistent",
      permissionMode: "approve-reads",
      nonInteractivePermissions: "deny",
      env: {
        COPILOT_GITHUB_TOKEN: {
          type: "secret_ref",
          secretId: "secret-1",
          version: "latest",
        },
      },
    });
  });
});
