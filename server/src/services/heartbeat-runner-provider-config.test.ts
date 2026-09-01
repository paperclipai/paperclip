import { describe, expect, it } from "vitest";

import { resolvePaperclipRunnerNativeProviderInput } from "./native-runtime/provider-profile.js";

describe("Paperclip Runner native provider configuration", () => {
  it("projects OpenCode identity, model, and permissions from adapter config", () => {
    expect(
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: {
          provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
          opencodePermissionMode: "deny",
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "deny",
    });
  });

  it.each([
    ["claude", "claude-sonnet-5", "approve-all"],
    ["codex", "gpt-5.6-sol", "deny-all"],
  ] as const)(
    "projects the qualified ACPX %s descriptor from adapter config",
    (acpxAgent, model, acpxPermissionMode) => {
      expect(
        resolvePaperclipRunnerNativeProviderInput({
          backend: "acpx_runtime",
          adapterConfig: { provider: "acpx", acpxAgent, model, acpxPermissionMode },
        }),
      ).toEqual({
        provider: "acpx",
        acpxAgent,
        model,
        acpxPermissionMode,
      });
    },
  );

  it("applies the safe provider permission default from adapter config", () => {
    expect(
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: {
          provider: "opencode",
          model: "openrouter/deepseek/deepseek-v4-flash-0731",
        },
      }),
    ).toEqual({
      provider: "opencode",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      opencodePermissionMode: "ask",
    });
  });

  it("fails closed when the persisted backend and current provider disagree", () => {
    expect(() =>
      resolvePaperclipRunnerNativeProviderInput({
        backend: "opencode_server",
        adapterConfig: { provider: "codex" },
      }),
    ).toThrow("provider changed after this run selected its native backend");
  });

  it("rejects Pi before a native descriptor is persisted", () => {
    expect(() =>
      resolvePaperclipRunnerNativeProviderInput({
        backend: "acpx_runtime",
        adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "pi-model" },
      }),
    ).toThrow("Pi is not available");
  });
});
