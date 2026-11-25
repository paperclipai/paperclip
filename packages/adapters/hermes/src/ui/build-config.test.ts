import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHermesConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "hermes_local",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "glm-4.6:cloud",
    thinkingEffort: "",
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
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildHermesConfig billing fields", () => {
  it("keeps the billing type and biller chosen in the create form", () => {
    const config = buildHermesConfig(makeValues({ adapterSchemaValues: { billingType: "subscription_included", biller: " ollama " } }));
    expect(config).toMatchObject({ billingType: "subscription_included", biller: "ollama" });
  });

  it("keeps a billing type without a biller", () => {
    const config = buildHermesConfig(makeValues({ adapterSchemaValues: { billingType: "metered_api", biller: "  " } }));
    expect(config.billingType).toBe("metered_api");
    expect(config).not.toHaveProperty("biller");
  });

  it.each([undefined, {}, { billingType: "" }, { billingType: "", biller: "ollama" }])(
    "stores no billing fields for %j", (adapterSchemaValues) => {
      const config = buildHermesConfig(makeValues({ adapterSchemaValues }));
      expect(config).not.toHaveProperty("billingType");
      expect(config).not.toHaveProperty("biller");
    },
  );
});
