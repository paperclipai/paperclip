import { describe, expect, it } from "vitest";

import {
  isPaperclipRunnerProvider,
  resolvePaperclipRunnerPermissionMode,
} from "./paperclip-runner-permissions.js";

describe("Paperclip Runner permission defaults", () => {
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
});
