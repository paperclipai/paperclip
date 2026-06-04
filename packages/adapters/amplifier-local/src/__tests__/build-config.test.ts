/**
 * Tests for the UI form → adapterConfig builder.
 */

import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildAmplifierLocalConfig } from "../ui/build-config.js";
import { DEFAULT_AMPLIFIER_LOCAL_MODEL } from "../index.js";

function vals(over: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    name: "test agent",
    role: "ic",
    description: "",
    instructionsFilePath: "",
    cwd: "",
    model: "",
    envBindings: {},
    envVars: "",
    promptTemplate: "",
    command: "",
    extraArgs: "",
    ...over,
  } as unknown as CreateConfigValues;
}

describe("buildAmplifierLocalConfig", () => {
  it("supplies sensible defaults", () => {
    const cfg = buildAmplifierLocalConfig(vals());
    expect(cfg.model).toBe(DEFAULT_AMPLIFIER_LOCAL_MODEL);
    expect(cfg.timeoutSec).toBe(0);
    expect(cfg.graceSec).toBe(15);
    expect(cfg.cwd).toBeUndefined();
    expect(cfg.instructionsFilePath).toBeUndefined();
  });

  it("preserves the operator's model selection", () => {
    const cfg = buildAmplifierLocalConfig(vals({ model: "claude-sonnet-4-5" }));
    expect(cfg.model).toBe("claude-sonnet-4-5");
  });

  it("emits env bindings only when set", () => {
    const cfgEmpty = buildAmplifierLocalConfig(vals());
    expect(cfgEmpty.env).toBeUndefined();

    const cfg = buildAmplifierLocalConfig(
      vals({
        envBindings: {
          ANTHROPIC_API_KEY: { type: "plain", value: "sk-xyz" },
        } as unknown as Record<string, unknown>,
      }),
    );
    expect(cfg.env).toEqual({
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-xyz" },
    });
  });

  it("merges legacy KEY=VALUE env-vars text without overwriting structured bindings", () => {
    const cfg = buildAmplifierLocalConfig(
      vals({
        envBindings: {
          ANTHROPIC_API_KEY: { type: "secret_ref", value: "secret://ant" },
        } as unknown as Record<string, unknown>,
        envVars: "ANTHROPIC_API_KEY=overridden\nOPENAI_API_KEY=sk-legacy" as unknown as string,
      }),
    );
    const env = cfg.env as Record<string, { type: string; value: string }>;
    // Structured binding wins; legacy fills only the missing key.
    expect(env.ANTHROPIC_API_KEY).toEqual({ type: "secret_ref", value: "secret://ant" });
    expect(env.OPENAI_API_KEY).toEqual({ type: "plain", value: "sk-legacy" });
  });

  it("parses extraArgs as a comma-separated list", () => {
    const cfg = buildAmplifierLocalConfig(
      vals({ extraArgs: "--verbose, --foo=bar" as unknown as string }),
    );
    expect(cfg.extraArgs).toEqual(["--verbose", "--foo=bar"]);
  });

  it("emits workspaceStrategy when git_worktree is selected", () => {
    const cfg = buildAmplifierLocalConfig(
      vals({
        workspaceStrategyType: "git_worktree",
        workspaceBaseRef: "main",
        workspaceBranchTemplate: "agent/{{slug}}",
      } as unknown as Partial<CreateConfigValues>),
    );
    expect(cfg.workspaceStrategy).toEqual({
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "agent/{{slug}}",
    });
  });
});
