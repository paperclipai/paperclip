import { describe, expect, it } from "vitest";
import {
  ADAPTER_STARTUP_FAULT_ERROR_CODE,
  classifyAdapterStartupOutput,
  hashStartupFaultConfigIdentity,
  readStartupFaultIssueAdapterConfig,
  readStartupFaultModelProfileAdapterConfig,
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
      adapterType: "hermes",
      effectiveConfigFingerprint: "cfg-a",
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

  it("treats a short completed response as successful agent output", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "[hermes] Starting Hermes Agent (model=gpt-5)\nDone.",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        response: "Done.",
      }),
    ).toBeNull();
  });

  it("does not classify agent prose that mentions a worktree diagnostic", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "I fixed the --worktree requires being inside a git repository error.",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        sessionId: "valid-session",
        response: "Fixed it.",
      }),
    ).toBeNull();
  });

  it("does not classify a genuine worktree diagnostic when agent output completed", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "x --worktree requires being inside a git repository",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        sessionId: "valid-session",
        response: "Recovered after fixing the repo checkout.",
      }),
    ).toBeNull();
  });

  it("changes the fingerprint when adapter or effective config identity changes", () => {
    const diagnostic = "x --worktree requires being inside a git repository";
    const first = classifyAdapterStartupOutput({
      stdout: diagnostic,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      adapterType: "hermes",
      effectiveConfigFingerprint: "cfg-a",
    });
    const second = classifyAdapterStartupOutput({
      stdout: diagnostic,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      adapterType: "hermes",
      effectiveConfigFingerprint: "cfg-b",
    });
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });


  it("classifies worktree diagnostics when warning lines are retained in the parsed response", () => {
    const response = [
      "Warning: Unknown toolsets: mcp-codegraph, messaging",
      "x --worktree requires being inside a git repository",
      "cd into your project repo first, then run hermes -w",
    ].join("\n");
    expect(
      classifyAdapterStartupOutput({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        response,
        worktreeMode: true,
        adapterType: "hermes",
        effectiveConfigFingerprint: "cfg-a",
      }),
    ).toMatchObject({
      kind: "worktree_requires_git_repository",
      diagnostic: expect.stringContaining("worktree requires being inside a git repository"),
    });
  });

  it("classifies a cd diagnostic passed only as response without positive agent output", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        response: "cd into your project repo first, then run hermes -w",
        worktreeMode: true,
        adapterType: "hermes",
        effectiveConfigFingerprint: "cfg-a",
      }),
    ).toMatchObject({
      kind: "worktree_requires_git_repository",
    });
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

describe("hashStartupFaultConfigIdentity", () => {
  it("changes when adapter config changes and stays stable for the same config", () => {
    const before = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: {},
    });
    const unchanged = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: {},
    });
    const after = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: { cwd: "/repaired/project-workspace" },
    });
    expect(before).toBe(unchanged);
    expect(after).not.toBe(before);
  });

  it("treats issue adapterConfig as effective identity over raw adapterConfig", () => {
    const issueOnly = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: {},
      issueAdapterConfig: { cwd: "/issue-cwd" },
    });
    const rawUnchanged = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: { cwd: "/raw-changed" },
      issueAdapterConfig: { cwd: "/issue-cwd" },
    });
    const rawOnly = hashStartupFaultConfigIdentity({
      adapterType: "codex_local",
      adapterConfig: {},
    });
    expect(issueOnly).toBe(rawUnchanged);
    expect(issueOnly).not.toBe(rawOnly);
  });

  it("reads issue and model-profile adapterConfig overlays", () => {
    expect(readStartupFaultIssueAdapterConfig({
      adapterConfig: { cwd: "/issue-cwd" },
    })).toEqual({ cwd: "/issue-cwd" });
    expect(readStartupFaultModelProfileAdapterConfig(
      { modelProfiles: { cheap: { adapterConfig: { model: "cheap-model" } } } },
      { modelProfile: "cheap" },
    )).toEqual({ model: "cheap-model" });
  });
});
