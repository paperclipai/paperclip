import { resolvePaperclipRunnerPiThinkingLevel } from "./paperclip-runner-permissions.js";
import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_RUNNER_DEFAULT_MODELS,
  PAPERCLIP_RUNNER_ACPX_PROFILES,
  paperclipRunnerTransitionConfig,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerModel,
  resolvePaperclipRunnerPermissionMode,
  resolvePaperclipRunnerCursorMode,
} from "./paperclip-runner-permissions.js";

describe("Paperclip Runner permission defaults", () => {
  it("admits Pi while keeping sibling ACP profiles pending", () => {
    expect(PAPERCLIP_RUNNER_ACPX_PROFILES.find(profile => profile.value === "pi"))
      .toMatchObject({ qualified: true, credentialEnvironment: ["OPENROUTER_API_KEY"] });
    for (const agent of ["cursor", "copilot"]) {
      expect(PAPERCLIP_RUNNER_ACPX_PROFILES.find(profile => profile.value === agent)?.qualified).toBe(false);
    }
  });
  it("defaults Codex to the only qualified non-interactive mode", () => {
    expect(resolvePaperclipRunnerPermissionMode("codex", undefined)).toBe(
      "never",
    );
    expect(resolvePaperclipRunnerPermissionMode("codex", "on-request")).toBe("never");
    expect(resolvePaperclipRunnerPermissionMode("codex", "untrusted")).toBe("never");
  });

  it("defaults Claude and OpenCode to full auto", () => {
    expect(resolvePaperclipRunnerPermissionMode("opencode", undefined)).toBe(
      "allow",
    );
    expect(resolvePaperclipRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-all",
    );
  });

  it.each(["approve-paperclip", "approve-reads", "deny-all", "approve-all"])("preserves explicit Claude %s settings", (mode) => {
    expect(resolvePaperclipRunnerPermissionMode("acpx", mode)).toBe(mode);
  });

  it.each([
    ["claude_local", "acpxPermissionMode", "approve-all"],
    ["codex_local", "codexPermissionMode", "never"],
    ["opencode_local", "opencodePermissionMode", "allow"],
  ])("uses full auto when converting %s to the new runner", (adapter, key, value) => {
    expect(paperclipRunnerTransitionConfig(adapter, undefined)).toMatchObject({ [key]: value });
  });

  it("recognizes only exact provider identifiers", () => {
    expect(isPaperclipRunnerProvider("codex")).toBe(true);
    expect(isPaperclipRunnerProvider("opencode")).toBe(true);
    expect(isPaperclipRunnerProvider("claude_managed")).toBe(true);
    expect(isPaperclipRunnerProvider("aws_agentcore")).toBe(true);
    expect(isPaperclipRunnerProvider("acpx")).toBe(true);
    expect(isPaperclipRunnerProvider("toString")).toBe(false);
    expect(isPaperclipRunnerProvider("__proto__")).toBe(false);
  });

  it("keeps managed provider permissions under the qualified profile", () => {
    expect(resolvePaperclipRunnerPermissionMode("claude_managed", "never"))
      .toBe("provider-managed");
    expect(resolvePaperclipRunnerPermissionMode("aws_agentcore", "approve-all"))
      .toBe("provider-managed");
  });

  it("uses the Codex default for missing or blank models", () => {
    expect(resolvePaperclipRunnerModel("codex", undefined)).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
    expect(resolvePaperclipRunnerModel("codex", "   ")).toBe(
      PAPERCLIP_RUNNER_DEFAULT_MODELS.codex,
    );
  });

  it("preserves an explicit Codex model", () => {
    expect(resolvePaperclipRunnerModel("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolvePaperclipRunnerModel("codex", "  gpt-5.5  ")).toBe("gpt-5.5");
  });
});


describe("Cursor session mode admission", () => {
  it.each([undefined, "agent", "plan", "ask"])("retains mode %s with an explicit Cursor default", mode => {
    expect(resolvePaperclipRunnerCursorMode("acpx", "cursor", mode)).toBe(mode ?? "agent");
  });
  it.each([null, "", "auto", "PLAN", true, {}, ["plan"]])("rejects invalid mode %j", mode => {
    expect(() => resolvePaperclipRunnerCursorMode("acpx", "cursor", mode)).toThrow("Cursor session mode");
  });
  it.each([["codex", "cursor"], ["acpx", "copilot"], ["acpx", "pi"], ["acpx", "claude"]])("rejects mode on %s/%s", (provider, agent) => {
    expect(resolvePaperclipRunnerCursorMode(provider, agent, undefined)).toBeUndefined();
    expect(() => resolvePaperclipRunnerCursorMode(provider, agent, "plan")).toThrow("only for Cursor");
  });
});

describe("Pi thinking configuration", () => {
  it.each([undefined, "off", "low", "high", "max"] as const)("persists exact level %s with low as the fresh-config default", value => {
    expect(resolvePaperclipRunnerPiThinkingLevel("acpx", "pi", value)).toBe(value ?? "low");
  });
  it.each(["medium", "minimal", "xhigh", "", null, 1])("rejects unsupported alias %s", value => {
    expect(() => resolvePaperclipRunnerPiThinkingLevel("acpx", "pi", value)).toThrow();
  });
  it("rejects foreign provider settings", () => {
    expect(() => resolvePaperclipRunnerPiThinkingLevel("codex", "pi", "low")).toThrow(/only/);
    expect(() => resolvePaperclipRunnerPiThinkingLevel("acpx", "cursor", "low")).toThrow(/only/);
    expect(resolvePaperclipRunnerPiThinkingLevel("codex", undefined, undefined)).toBeUndefined();
  });
});
