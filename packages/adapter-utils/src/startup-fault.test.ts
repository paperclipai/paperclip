import { describe, expect, it } from "vitest";
import {
  ADAPTER_STARTUP_FAULT_ERROR_CODE,
  classifyAdapterStartupOutput,
} from "./startup-fault.js";

describe("classifyAdapterStartupOutput", () => {
  it("classifies a worktree diagnostic on stdout with exit 0 as a startup fault", () => {
    const stdout = [
      "x --worktree requires being inside a git repository",
      "cd into your project repo first, then run hermes -w",
    ].join("\n");
    const result = classifyAdapterStartupOutput({
      stdout,
      stderr: "Warning: Unknown toolsets: mcp-codegraph, messaging\n",
      exitCode: 0,
      timedOut: false,
      worktreeMode: true,
    });
    expect(result).toMatchObject({
      kind: "worktree_requires_git_repository",
      diagnostic: expect.stringContaining("worktree requires being inside a git repository"),
      fingerprint: expect.stringMatching(/^startup_fault:v1:worktree_requires_git_repository:/),
    });
  });

  it("keeps genuine agent output successful when a session id is present", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "session_id: abc123\nHere is the completed review summary.",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        sessionId: "abc123",
        response: "Here is the completed review summary.",
      }),
    ).toBeNull();
  });

  it("ignores warning-only stderr without treating it as a startup fault", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "[hermes] Starting Hermes Agent (model=gpt-5)\n",
        stderr: "Warning: Unknown toolsets: mcp-codegraph\n",
        exitCode: 0,
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("exports the adapter startup fault error code", () => {
    expect(ADAPTER_STARTUP_FAULT_ERROR_CODE).toBe("adapter_startup_fault");
  });
});
