import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildMuseCodeLocalConfig } from "./build-config.js";

function values(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "muse_code_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
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
    ...overrides,
  } as CreateConfigValues;
}

describe("buildMuseCodeLocalConfig", () => {
  it("keeps defaults minimal so Muse uses host settings", () => {
    expect(buildMuseCodeLocalConfig(values())).toEqual({
      dangerouslySkipPermissions: true,
      timeoutSec: 0,
      graceSec: 20,
    });
  });

  it("carries model, effort, command, and extra args", () => {
    const config = buildMuseCodeLocalConfig(
      values({
        model: "muse-wonder-full-1.0",
        thinkingEffort: "xhigh",
        command: "/opt/muse/bin/muse",
        extraArgs: "--preset, native-basic",
        dangerouslyBypassSandbox: true,
      }),
    );
    expect(config).toMatchObject({
      model: "muse-wonder-full-1.0",
      effort: "xhigh",
      command: "/opt/muse/bin/muse",
      extraArgs: ["--preset", "native-basic"],
      dangerouslyBypassSandbox: true,
    });
  });

  it("drops reasoning efforts Muse does not accept", () => {
    expect(buildMuseCodeLocalConfig(values({ thinkingEffort: "extreme" }))).not.toHaveProperty("effort");
  });
});
