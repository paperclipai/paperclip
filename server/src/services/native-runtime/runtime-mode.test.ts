import { describe, expect, it } from "vitest";

import { BUILTIN_ADAPTER_TYPES } from "../../adapters/builtin-adapter-types.js";
import {
  NativeRunnerSelectionError,
  resolveHeartbeatRuntimeMode,
} from "./runtime-mode.js";

const base = {
  persisted: { runtimeMode: "legacy", runtimeModeResolvedAt: null },
  enabled: true,
  adapterConfig: { provider: "codex" },
  agentStatus: "running",
  issue: { workMode: "standard" },
  executionTarget: { kind: "local" },
} as const;

describe("resolveHeartbeatRuntimeMode", () => {
  it("keeps every direct built-in adapter on the legacy path", () => {
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      if (adapterType === "paperclip_runner") continue;
      expect(resolveHeartbeatRuntimeMode({ ...base, adapterType })).toEqual({
        kind: "legacy",
        resolverVersion: "paperclip-runner-v1",
        reason: "direct_adapter",
      });
    }
  });

  it("fails closed for fresh runner starts while the flag is off", () => {
    expect(() => resolveHeartbeatRuntimeMode({
      ...base,
      enabled: false,
      adapterType: "paperclip_runner",
    })).toThrowError(expect.objectContaining({
      code: "paperclip_runner_rollout_disabled",
    }) as NativeRunnerSelectionError);
  });

  it("selects only Codex on a local target", () => {
    expect(resolveHeartbeatRuntimeMode({
      ...base,
      adapterType: "paperclip_runner",
    })).toMatchObject({ kind: "native", provider: "codex" });
    expect(() => resolveHeartbeatRuntimeMode({
      ...base,
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode" },
    })).toThrow(/only the Codex provider/);
    expect(() => resolveHeartbeatRuntimeMode({
      ...base,
      adapterType: "paperclip_runner",
      executionTarget: { kind: "remote" },
    })).toThrow(/local execution environment/);
  });

  it("recovers a persisted native run after the flag changes", () => {
    expect(resolveHeartbeatRuntimeMode({
      ...base,
      enabled: false,
      adapterType: "paperclip_runner",
      persisted: { runtimeMode: "native", runtimeModeResolvedAt: new Date() },
    })).toEqual({
      kind: "native",
      resolverVersion: "paperclip-runner-v1",
      reason: "persisted_native_selection",
      provider: "codex",
    });
  });
});
