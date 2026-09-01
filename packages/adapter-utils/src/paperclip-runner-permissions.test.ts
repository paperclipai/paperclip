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
    expect(isPaperclipRunnerProvider("acpx")).toBe(true);
    expect(isPaperclipRunnerProvider("toString")).toBe(false);
    expect(isPaperclipRunnerProvider("__proto__")).toBe(false);
  });
});
