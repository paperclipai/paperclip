import { describe, expect, it } from "vitest";
import {
  ADAPTER_STARTUP_FAULT_ERROR_CODE,
  STARTUP_FAULT_DIAGNOSTIC,
  classifyAdapterStartupOutput,
  hashStartupFaultConfigIdentity,
  readStartupFaultIssueAdapterConfig,
  readStartupFaultModelProfileAdapterConfig,
} from "./startup-fault.js";

const SENTINEL_BEARER = "Authorization: Bearer sk-test-sentinel-aaaaaaaa";
const SENTINEL_KEY_VALUE = "OPENAI_API_KEY=sk-test-sentinel-bbbbbbbb";
const SENTINEL_URL_CREDENTIAL = "https://user:p4ssw0rd@example.invalid/repo.git";
const SENTINELS = [SENTINEL_BEARER, SENTINEL_KEY_VALUE, SENTINEL_URL_CREDENTIAL];

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
      diagnostic: STARTUP_FAULT_DIAGNOSTIC.worktree_requires_git_repository,
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
      diagnostic: STARTUP_FAULT_DIAGNOSTIC.worktree_requires_git_repository,
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

  it("does not persist bearer, key=value, or URL-credential sentinels in worktree diagnostics", () => {
    const result = classifyAdapterStartupOutput({
      stdout: [
        SENTINEL_BEARER,
        "x --worktree requires being inside a git repository",
        SENTINEL_KEY_VALUE,
        SENTINEL_URL_CREDENTIAL,
      ].join("\n"),
      stderr: `${SENTINEL_BEARER}\n`,
      exitCode: 0,
      timedOut: false,
      worktreeMode: true,
      adapterType: "hermes",
      effectiveConfigFingerprint: "cfg-a",
    });
    expect(result).toMatchObject({
      kind: "worktree_requires_git_repository",
      diagnostic: STARTUP_FAULT_DIAGNOSTIC.worktree_requires_git_repository,
    });
    const persisted = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(persisted).not.toContain(sentinel);
    }
  });

  it("does not persist sentinels in generic startup diagnostics and keeps a typed reason", () => {
    const result = classifyAdapterStartupOutput({
      stdout: [
        SENTINEL_BEARER,
        SENTINEL_KEY_VALUE,
        SENTINEL_URL_CREDENTIAL,
        "adapter failed before producing a session",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      adapterType: "hermes",
      effectiveConfigFingerprint: "cfg-a",
    });
    expect(result).toMatchObject({
      kind: "startup_diagnostic_without_agent_output",
      diagnostic: STARTUP_FAULT_DIAGNOSTIC.startup_diagnostic_without_agent_output,
    });
    const persisted = JSON.stringify(result);
    for (const sentinel of SENTINELS) {
      expect(persisted).not.toContain(sentinel);
    }
  });

  it("does not misclassify genuine agent output that mentions credential sentinels", () => {
    expect(
      classifyAdapterStartupOutput({
        stdout: [
          SENTINEL_BEARER,
          "Completed the review after rotating the local secret.",
        ].join("\n"),
        stderr: SENTINEL_URL_CREDENTIAL,
        exitCode: 0,
        timedOut: false,
        sessionId: "sess-safe",
        response: `Rotated ${SENTINEL_KEY_VALUE} and finished.`,
      }),
    ).toBeNull();
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
