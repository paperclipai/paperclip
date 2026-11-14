import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { isSuccessfulClaudeTerminalCleanup } from "./heartbeat-terminal-cleanup.js";

const receipt: AdapterExecutionResult = {
  exitCode: 143, signal: null, timedOut: false, errorMessage: null,
  resultJson: { type: "result", subtype: "success", is_error: false, result: "Saved draft; CI monitor is scheduled.",
    unmanagedBackgroundTask: { kind: "terminal_result_cleanup", terminalResultSeen: true, stopped: true, signal: "SIGTERM", forceKilled: false } },
};

describe("Claude terminal cleanup outcome", () => {
  it("recognizes the captured successful-terminal/SIGTERM cleanup shape without rewriting exit143", () => {
    expect(isSuccessfulClaudeTerminalCleanup("claude_local", receipt)).toBe(true);
    expect(receipt.exitCode).toBe(143);
  });
  it("recognizes Node's null-exit/SIGTERM cleanup shape without rewriting its physical result", () => {
    const localReceipt = { ...receipt, exitCode: null, signal: "SIGTERM" };
    expect(isSuccessfulClaudeTerminalCleanup("claude_local", localReceipt)).toBe(true);
    expect(localReceipt.exitCode).toBeNull();
    expect(localReceipt.signal).toBe("SIGTERM");
  });
  it.each([
    { timedOut: true }, { errorCode: "claude_auth_required" }, { errorMessage: "Failed to authenticate" },
    { exitCode: 1 }, { exitCode: 137 }, { signal: "SIGKILL" },
    { exitCode: null, signal: null }, { exitCode: null, signal: "SIGKILL" },
  ])("preserves actual failure evidence: %j", patch => {
    expect(isSuccessfulClaudeTerminalCleanup("claude_local", { ...receipt, ...patch })).toBe(false);
  });
  it.each([
    { is_error: true }, { subtype: "error_during_execution" }, { is_error: undefined },
    { api_error_status: 401 }, { error_status: 403 }, { error: "authentication_failed" }, { errors: ["Provider failed"] },
    { unmanagedBackgroundTask: null },
    { unmanagedBackgroundTask: { ...(receipt.resultJson!.unmanagedBackgroundTask as object), forceKilled: true } },
    { unmanagedBackgroundTask: { ...(receipt.resultJson!.unmanagedBackgroundTask as object), terminalResultSeen: false } },
  ])("does not promote an unqualified terminal receipt: %j", patch => {
    expect(isSuccessfulClaudeTerminalCleanup("claude_local", { ...receipt, resultJson: { ...receipt.resultJson, ...patch } })).toBe(false);
  });
  it("does not change other adapters or a failed user stop", () => {
    expect(isSuccessfulClaudeTerminalCleanup("codex_local", receipt)).toBe(false);
    expect(isSuccessfulClaudeTerminalCleanup("claude_local", receipt, true)).toBe(false);
  });
});
