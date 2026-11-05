import { describe, expect, it } from "vitest";
import { classifyWorkspaceRestorationError, GitCacheRestorationFailure } from "../services/git-workspace-restoration.js";
import { workspaceReopenDiagnostic } from "../services/execution-workspaces.js";
import { GitConnectionFailureError } from "../services/git-connection-failure.js";

const gitError = (stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Command failed: git fetch\n${stderr}`), { code: 128, stderr, ...extra });

describe("workspace restoration diagnostic", () => {
  it.each([
    ["fatal: Authentication failed for 'https://user:sk-secret@example.test/repo.git/'", "auth_rejected"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "auth_rejected"],
    ["fatal: remote error: upload-pack: not our ref 9a204a56", "commit_unavailable"],
    ["fatal: couldn't find remote ref refs/heads/gone", "commit_unavailable"],
    ["fatal: unable to access 'https://example.test/repo.git/': Could not resolve host: example.test", "remote_unavailable"],
    ["fatal: '/srv/repo.git' does not appear to be a git repository", "remote_unavailable"],
    ["fatal: bad revision", "git_command"],
  ])("classifies %s", (stderr, kind) => {
    expect(classifyWorkspaceRestorationError(gitError(stderr))).toBe(kind);
  });

  it("classifies timeouts, typed connection failures, filesystem errors and checks", () => {
    expect(classifyWorkspaceRestorationError(gitError("", { killed: true, signal: "SIGTERM" }))).toBe("timeout");
    expect(classifyWorkspaceRestorationError(new GitConnectionFailureError("clone failed",
      { schemaVersion: 1, provider: "git", operation: "clone", reason: "authentication_failed" }))).toBe("auth_rejected");
    expect(classifyWorkspaceRestorationError(new GitConnectionFailureError("clone failed",
      { schemaVersion: 1, provider: "git", operation: "clone", reason: "dns_failure" }))).toBe("remote_unavailable");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: "EACCES" })))
      .toBe("filesystem");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }))).toBe("filesystem");
    expect(classifyWorkspaceRestorationError(new GitCacheRestorationFailure())).toBe("verification");
    expect(classifyWorkspaceRestorationError("not an error")).toBe("unknown");
  });

  it("keeps the innermost restoration step and never carries Git output", () => {
    const inner = new GitCacheRestorationFailure({ step: "saved_commit", kind: "commit_unavailable" });
    expect(workspaceReopenDiagnostic("source_verify", inner)).toEqual({ step: "saved_commit", kind: "commit_unavailable" });
    const diagnostic = workspaceReopenDiagnostic("managed_base", gitError("fatal: Authentication failed for 'https://user:sk-secret@example.test/r.git/'"));
    expect(diagnostic).toEqual({ step: "managed_base", kind: "auth_rejected" });
    expect(JSON.stringify(diagnostic)).not.toContain("sk-secret");
    expect(workspaceReopenDiagnostic("publish", undefined)).toEqual({ step: "publish", kind: "unknown" });
    expect(inner.message).toBe("The saved workspace commit could not be restored. Check repository access and retry.");
  });

  it("bounds command text and distinguishes network failures from filesystem failures", () => {
    const text = "x".repeat(16_384) + "Authentication failed for a private repository";
    expect(classifyWorkspaceRestorationError(gitError(text))).toBe("git_command");
    expect(classifyWorkspaceRestorationError(gitError("", { stderr: Buffer.from(text) }))).toBe("git_command");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("network failure"), { code: "ECONNRESET" }))).toBe("remote_unavailable");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("resolver failure"), { code: "EAI_AGAIN" }))).toBe("remote_unavailable");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe("timeout");
    expect(classifyWorkspaceRestorationError(gitError("", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }))).toBe("git_command");
    expect(classifyWorkspaceRestorationError(Object.assign(new Error("unknown"), { code: "EUNRECOGNIZED" }))).toBe("unknown");
  });
});
