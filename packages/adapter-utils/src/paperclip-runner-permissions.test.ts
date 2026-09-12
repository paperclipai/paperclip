import { describe, expect, it } from "vitest";

import {
  PAPERCLIP_RUNNER_DEFAULT_MODELS,
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerModel,
  resolvePaperclipRunnerPermissionMode,
} from "./paperclip-runner-permissions.js";

describe("Paperclip Runner permission defaults", () => {
  it("defaults Codex to the only qualified non-interactive mode", () => {
    expect(resolvePaperclipRunnerPermissionMode("codex", undefined)).toBe(
      "never",
    );
    expect(resolvePaperclipRunnerPermissionMode("codex", "on-request")).toBe("never");
    expect(resolvePaperclipRunnerPermissionMode("codex", "untrusted")).toBe("never");
  });

  it("uses interactive defaults for dormant non-Codex providers", () => {
    expect(resolvePaperclipRunnerPermissionMode("opencode", undefined)).toBe(
      "ask",
    );
    expect(resolvePaperclipRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-reads",
    );
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
