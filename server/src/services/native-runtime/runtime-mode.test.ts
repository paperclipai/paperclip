import { describe, expect, it } from "vitest";

import { BUILTIN_ADAPTER_TYPES } from "../../adapters/builtin-adapter-types.js";
import {
  NativeRunnerSelectionError,
  NativeRuntimeEligibilityError,
  resolveHeartbeatNativeRuntimeMode,
  resolveHeartbeatRuntimeMode,
  resolveNativeRuntimeMode,
} from "./runtime-mode.js";

const eligible = {
  enabled: true,
  runtimeConfig: {},
  adapterConfig: { provider: "codex" },
  agent: { status: "running", adapterType: "paperclip_runner" },
  issue: { id: "issue", workMode: "standard" },
  target: { kind: "local" },
  workspaceId: "workspace",
} as const;

describe("resolveNativeRuntimeMode", () => {
  it("keeps every direct built-in adapter outside native arbitration", () => {
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      if (adapterType === "paperclip_runner") continue;
      expect(resolveNativeRuntimeMode({
        ...eligible,
        enabled: false,
        runtimeConfig: {
          nativeRunner: {
            mode: "native",
            backend: "codex_app_server",
            protocolVersion: 1,
          },
        },
        agent: { ...eligible.agent, adapterType },
      })).toEqual({
        kind: "legacy",
        resolverVersion: "phase6-v1",
        reason: "direct_adapter",
      });
    }
  });

  it("rejects a fresh Paperclip Runner start while the rollout flag is disabled", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      enabled: false,
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_rollout_disabled",
    }));
  });

  it("rejects unknown Paperclip Runner providers", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      runtimeConfig: {},
      adapterConfig: { provider: "claude" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_provider_unsupported",
    }));
  });

  it("rejects fresh OpenCode and ACPX starts until their app profiles are activated", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4-flash-0731" },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_provider_unsupported",
    }));
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      adapterConfig: { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_provider_unsupported",
    }));
  });

  it("preserves legacy as the default and as the kill-switch behavior", () => {
    const direct = {
      ...eligible,
      agent: { ...eligible.agent, adapterType: "codex_local" },
      runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
    };
    expect(resolveNativeRuntimeMode(direct)).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "direct_adapter",
    }));
    expect(resolveNativeRuntimeMode({ ...direct, enabled: false })).toEqual(expect.objectContaining({
      kind: "legacy",
      reason: "direct_adapter",
    }));
  });

  it("selects native only for an eligible explicit profile", () => {
    expect(resolveNativeRuntimeMode(eligible)).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
    }));
  });

  it("keeps a persisted active run native while the global flag rejects a fresh runner start", () => {
    const disabled = { ...eligible, enabled: false };
    expect(resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
      },
    })).toEqual(expect.objectContaining({
      kind: "native",
      reason: "eligible_opt_in",
      authorityDecision: expect.objectContaining({ reasonCode: "live_continuation_registered" }),
    }));
    expect(() => resolveHeartbeatNativeRuntimeMode({
      ...disabled,
      persisted: { runtimeMode: null, runtimeModeReason: null, runtimeModeResolvedAt: null },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_rollout_disabled",
    }));
  });

  it.each(["paused", "terminated", "pending_approval"])(
    "refuses persisted native recovery for a %s agent",
    (status) => {
      expect(() => resolveHeartbeatNativeRuntimeMode({
        ...eligible,
        enabled: false,
        agent: { ...eligible.agent, status },
        persisted: {
          runtimeMode: "native",
          runtimeModeReason: "eligible_opt_in",
          runtimeModeResolvedAt: new Date(),
          driverKind: "codex_app_server",
        },
      })).toThrow(expect.objectContaining({
        code: "paperclip_runner_agent_ineligible",
      }));
    },
  );

  it("fails closed for an unknown persisted driver", () => {
    expect(() => resolveHeartbeatNativeRuntimeMode({
      ...eligible,
      enabled: false,
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        driverKind: "unknown_driver",
      },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_driver_unsupported",
    }));
  });

  it("does not recover a native run through a direct adapter", () => {
    expect(() => resolveHeartbeatNativeRuntimeMode({
      ...eligible,
      enabled: false,
      agent: { ...eligible.agent, adapterType: "codex_local" },
      persisted: {
        runtimeMode: "native",
        runtimeModeReason: "eligible_opt_in",
        runtimeModeResolvedAt: new Date(),
        driverKind: "codex_app_server",
      },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_adapter_binding_mismatch",
    }));
  });

  it("rejects an explicit native profile outside the approved boundary", () => {
    expect(resolveNativeRuntimeMode({ ...eligible, agent: { ...eligible.agent, adapterType: "claude_local" } }))
      .toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
    expect(() => resolveNativeRuntimeMode({ ...eligible, issue: { id: "issue", workMode: "skill_test" } }))
      .toThrow(NativeRuntimeEligibilityError);
  });

  it("rejects remote targets for fresh paperclip_runner starts", () => {
    expect(() => resolveNativeRuntimeMode({
      ...eligible,
      target: { kind: "remote" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toThrow(expect.objectContaining({
      code: "paperclip_runner_environment_unsupported",
    }));
  });

  it("allows paperclip_runner to use a transient local workspace for projectless issues", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      workspaceId: null,
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
    })).toEqual(expect.objectContaining({ kind: "native" }));
  });

  it("admits planning only through paperclip_runner", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "plan-issue", workMode: "planning" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toMatchObject({ kind: "native", profile: { backend: "codex_app_server" } });
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "plan-issue", workMode: "planning" },
      agent: { ...eligible.agent, adapterType: "codex_local" },
    })).toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
  });

  it("admits ask mode through paperclip_runner while preserving the legacy native boundary", () => {
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "ask-issue", workMode: "ask" },
      runtimeConfig: {},
      adapterConfig: { provider: "codex" },
      agent: { ...eligible.agent, adapterType: "paperclip_runner" },
    })).toMatchObject({ kind: "native", profile: { backend: "codex_app_server" } });
    expect(resolveNativeRuntimeMode({
      ...eligible,
      issue: { id: "ask-issue", workMode: "ask" },
      agent: { ...eligible.agent, adapterType: "codex_local" },
    })).toEqual(expect.objectContaining({ kind: "legacy", reason: "direct_adapter" }));
  });
});

const compatibilityInput = {
  persisted: { runtimeMode: "legacy", runtimeModeResolvedAt: null },
  enabled: true,
  adapterConfig: { provider: "codex" },
  agentStatus: "running",
  issue: { workMode: "standard" },
  executionTarget: { kind: "local" },
} as const;

describe("resolveHeartbeatRuntimeMode compatibility", () => {
  it("keeps every direct built-in adapter on the legacy path", () => {
    for (const adapterType of BUILTIN_ADAPTER_TYPES) {
      if (adapterType === "paperclip_runner") continue;
      expect(resolveHeartbeatRuntimeMode({
        ...compatibilityInput,
        adapterType,
      })).toEqual({
        kind: "legacy",
        resolverVersion: "paperclip-runner-v1",
        reason: "direct_adapter",
      });
    }
  });

  it("preserves the original public result and error contracts", () => {
    expect(resolveHeartbeatRuntimeMode({
      ...compatibilityInput,
      adapterType: "paperclip_runner",
    })).toEqual({
      kind: "native",
      resolverVersion: "paperclip-runner-v1",
      reason: "explicit_paperclip_runner",
      provider: "codex",
    });
    expect(resolveHeartbeatRuntimeMode({
      ...compatibilityInput,
      enabled: false,
      adapterType: "paperclip_runner",
      persisted: { runtimeMode: "native", runtimeModeResolvedAt: new Date() },
    })).toEqual({
      kind: "native",
      resolverVersion: "paperclip-runner-v1",
      reason: "persisted_native_selection",
      provider: "codex",
    });
    expect(() => resolveHeartbeatRuntimeMode({
      ...compatibilityInput,
      enabled: false,
      adapterType: "paperclip_runner",
    })).toThrow(NativeRunnerSelectionError);
  });
});
