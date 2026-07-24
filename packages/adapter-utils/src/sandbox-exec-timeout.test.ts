import { describe, expect, it } from "vitest";
import {
  SANDBOX_EXEC_TIMEOUT_ERROR_CODE,
  detectSandboxExecTimeout,
  extractSandboxExecTimeoutMessage,
} from "./sandbox-exec-timeout.js";

describe("detectSandboxExecTimeout", () => {
  it("detects the execInPod watchdog marker", () => {
    expect(
      detectSandboxExecTimeout(
        "execInPod timed out after 870000ms (pod=agent-abc, container=agent, cmd0=claude). The WebSocket likely dropped before the command produced a status frame.",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      detectSandboxExecTimeout(
        "EXECINPOD TIMED OUT AFTER 870000MS (pod=agent-abc, container=agent, cmd0=claude).",
      ),
    ).toBe(true);
  });

  it("does not match a legitimate adapter wall-clock timeout message", () => {
    expect(detectSandboxExecTimeout("Timed out after 14400s")).toBe(false);
  });

  it("does not match an unrelated RPC timeout string", () => {
    expect(detectSandboxExecTimeout("RPC call timed out")).toBe(false);
  });

  it("does not match agent-authored output that echoes the watchdog phrase without the pod context", () => {
    // A run that genuinely wall-clock-timed-out could have its own stderr
    // contain text like this (e.g. the agent printing a log line it saw
    // elsewhere). Without the "(pod=" context this must not be misattributed
    // to a sandbox exec-channel timeout.
    expect(detectSandboxExecTimeout("execInPod timed out after 5ms")).toBe(false);
  });

  it("returns false for null/undefined/empty input", () => {
    expect(detectSandboxExecTimeout(null)).toBe(false);
    expect(detectSandboxExecTimeout(undefined)).toBe(false);
    expect(detectSandboxExecTimeout("")).toBe(false);
  });
});

describe("extractSandboxExecTimeoutMessage", () => {
  it("returns the first matching line, trimmed", () => {
    const stderr = [
      "some earlier noise",
      "  execInPod timed out after 870000ms (pod=agent-abc, container=agent, cmd0=claude). The WebSocket likely dropped before the command produced a status frame.  ",
      "trailing noise",
    ].join("\n");

    expect(extractSandboxExecTimeoutMessage(stderr)).toBe(
      "execInPod timed out after 870000ms (pod=agent-abc, container=agent, cmd0=claude). The WebSocket likely dropped before the command produced a status frame.",
    );
  });

  it("returns null when no line matches", () => {
    expect(extractSandboxExecTimeoutMessage("RPC call timed out\nsome other error")).toBeNull();
  });

  it("returns null for empty stderr", () => {
    expect(extractSandboxExecTimeoutMessage("")).toBeNull();
  });
});

describe("SANDBOX_EXEC_TIMEOUT_ERROR_CODE", () => {
  it("is a stable, descriptive error code", () => {
    expect(SANDBOX_EXEC_TIMEOUT_ERROR_CODE).toBe("sandbox_exec_timeout");
  });
});
