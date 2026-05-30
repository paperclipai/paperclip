import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildHttpConfig } from "./build-config";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "http",
    cwd: "",
    instructionsFilePath: "",
    promptTemplate: "",
    model: "",
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
    envBindingsJson: "",
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    workspaceStrategyType: "project_primary",
    workspaceBaseRef: "",
    workspaceBranchTemplate: "",
    worktreeParentDir: "",
    runtimeServicesJson: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildHttpConfig", () => {
  it("builds a full HTTP adapter config for remote Hermes-style bridges", () => {
    expect(
      buildHttpConfig(
        makeValues({
          url: "https://example.test/thomas-bridge/v1/runs",
          httpMethod: "POST",
          httpHeadersJson: '{"Authorization":"Bearer ${env:BRIDGE_TOKEN}","Content-Type":"application/json"}',
          envBindings: {
            BRIDGE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
          },
          payloadTemplateJson: '{"profile":"florence","timeoutSec":420}',
          httpTimeoutMs: 600000,
        }),
      ),
    ).toEqual({
      url: "https://example.test/thomas-bridge/v1/runs",
      method: "POST",
      timeoutMs: 600000,
      headers: {
        Authorization: "Bearer ${env:BRIDGE_TOKEN}",
        "Content-Type": "application/json",
      },
      env: {
        BRIDGE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      payloadTemplate: {
        profile: "florence",
        timeoutSec: 420,
      },
    });
  });

  it("keeps safe defaults when optional advanced fields are blank", () => {
    expect(buildHttpConfig(makeValues({ url: "https://example.test/hook" }))).toEqual({
      url: "https://example.test/hook",
      method: "POST",
      timeoutMs: 15000,
    });
  });

  it("rejects invalid methods", () => {
    expect(() => buildHttpConfig(makeValues({ httpMethod: "BREW" }))).toThrow(
      /HTTP method must be one of/,
    );
  });

  it("rejects non-object payload templates", () => {
    expect(() => buildHttpConfig(makeValues({ payloadTemplateJson: "[]" }))).toThrow(
      /Payload template must be a JSON object/,
    );
  });

  it("rejects non-string header values", () => {
    expect(() => buildHttpConfig(makeValues({ httpHeadersJson: '{"x-timeout": 600}' }))).toThrow(
      /HTTP header x-timeout must be a string/,
    );
  });

  it("rejects raw sensitive header values", () => {
    expect(() => buildHttpConfig(makeValues({ httpHeadersJson: '{"Authorization":"Bearer raw-token"}' }))).toThrow(
      /Sensitive HTTP header Authorization must use an env reference/,
    );
  });

  it("rejects mixed raw sensitive header values even when they include an env reference", () => {
    expect(() =>
      buildHttpConfig(
        makeValues({
          httpHeadersJson: '{"Authorization":"Bearer raw-token ${env:BRIDGE_TOKEN}"}',
          envBindings: { BRIDGE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
        }),
      ),
    ).toThrow(/Sensitive HTTP header Authorization must use an env reference/);
  });

  it("requires env bindings for referenced header templates", () => {
    expect(() =>
      buildHttpConfig(makeValues({ httpHeadersJson: '{"Authorization":"Bearer ${env:BRIDGE_TOKEN}"}' })),
    ).toThrow(/HTTP header references missing environment variable: BRIDGE_TOKEN/);
  });

  it("builds env bindings from the operator-facing Env bindings JSON field", () => {
    expect(
      buildHttpConfig(
        makeValues({
          url: "https://example.test/thomas-bridge/v1/runs",
          httpHeadersJson: '{"Authorization":"Bearer ${env:BRIDGE_TOKEN}"}',
          envBindingsJson: '{"BRIDGE_TOKEN":{"type":"secret_ref","secretId":"secret-1","version":"latest"}}',
        }),
      ),
    ).toMatchObject({
      env: {
        BRIDGE_TOKEN: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
    });
  });
});
