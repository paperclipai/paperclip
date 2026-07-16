import { describe, expect, it } from "vitest";
import {
  mergeAgentAdapterConfigForUpdate,
  mergeAgentRuntimeConfigForUpdate,
} from "../serializers/agent-config-merge.js";

describe("agent projected config update merge", () => {
  it("preserves hidden adapter credentials and unknown settings during a visible replacement edit", () => {
    expect(mergeAgentAdapterConfigForUpdate(
      {
        model: "gpt-4",
        fastMode: false,
        env: { OPENAI_API_KEY: { secretRef: "secret-1" } },
        headers: { authorization: "hidden" },
        pluginRuntime: { credentialBindingId: "binding-1" },
      },
      { model: "gpt-5", fastMode: true },
      true,
    )).toEqual({
      model: "gpt-5",
      fastMode: true,
      env: { OPENAI_API_KEY: { secretRef: "secret-1" } },
      headers: { authorization: "hidden" },
      pluginRuntime: { credentialBindingId: "binding-1" },
    });
  });

  it("preserves unrelated hidden runtime settings while applying visible heartbeat/profile edits", () => {
    expect(mergeAgentRuntimeConfigForUpdate(
      {
        heartbeat: { enabled: true, intervalSec: 300, leaseToken: "hidden" },
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Cheap",
            adapterConfig: { model: "gpt-4-mini", env: { OPENAI_API_KEY: { secretRef: "secret-2" } } },
            runtimeLease: "hidden-profile",
          },
          pluginProfile: { privateSetting: "keep" },
        },
        pluginRuntime: { privateSetting: "keep" },
      },
      {
        heartbeat: { enabled: true, intervalSec: 60 },
        modelProfiles: {
          cheap: { enabled: true, label: "Cheap", adapterConfig: { model: "gpt-5-mini" } },
        },
      },
    )).toEqual({
      heartbeat: { enabled: true, intervalSec: 60, leaseToken: "hidden" },
      modelProfiles: {
        cheap: {
          enabled: true,
          label: "Cheap",
          adapterConfig: { model: "gpt-5-mini", env: { OPENAI_API_KEY: { secretRef: "secret-2" } } },
          runtimeLease: "hidden-profile",
        },
        pluginProfile: { privateSetting: "keep" },
      },
      pluginRuntime: { privateSetting: "keep" },
    });
  });
});
