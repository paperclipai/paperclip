import { describe, expect, it } from "vitest";
import {
  buildStatedDispositionBlockerIssueInput,
  detectFileMutationVerifierContradiction,
  isTransientPaperclipControlPlaneWriteFailure,
  shouldRefuseTerminalDispositionForFileMutationVerifier,
} from "../services/heartbeat.js";

describe("stated-disposition blocker issue inheritance", () => {
  it("keeps the source project, workspace, owner, and work mode", () => {
    const blocker = buildStatedDispositionBlockerIssueInput({
      sourceIdentifier: "TSMC-20696",
      sourceId: "source-issue-id",
      blocker: "EPUB portable-link normalization is required",
      projectId: "project-id",
      projectWorkspaceId: "workspace-id",
      executionWorkspaceSettings: { strategy: "project_primary" },
      workMode: "execute",
      assigneeAgentId: "agent-id",
      assigneeUserId: null,
    });

    expect(blocker).toMatchObject({
      projectId: "project-id",
      projectWorkspaceId: "workspace-id",
      executionWorkspaceSettings: { strategy: "project_primary" },
      workMode: "execute",
      assigneeAgentId: "agent-id",
      assigneeUserId: null,
    });
    expect(blocker.description).toContain("TSMC-20696");
  });

  it("recognizes a transient Paperclip write failure rather than treating it as task work", () => {
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Could not record issue state because Paperclip API is unreachable at http://127.0.0.1:3100 (connection refused).",
    )).toBe(true);
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Paperclip control-plane write could not be recorded: ECONNREFUSED",
    )).toBe(true);
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Waiting for the approved design source package from the media team.",
    )).toBe(false);
  });
});

describe("file-mutation verifier disposition gate (TSMC-21385)", () => {
  const contradictionFooter = [
    "⚠️ File-mutation verifier: 1 file(s) were NOT modified this turn despite any wording above that may suggest otherwise. Run `git status` or `read_file` to confirm.",
    "  • `/Users/glad0s/paperclip/server/src/services/heartbeat.ts` — [patch] Escape-drift detected: old_string and new_string contain the literal sequence '\\\\\"'",
  ].join("\n");

  it("detects the Hermes unmodified-files footer and captures an excerpt", () => {
    const report = [
      "**TSMC-21377 done** ... Changed surface: server/src/services/heartbeat.ts",
      "Final disposition: done (all close bar items satisfied)",
      "",
      contradictionFooter,
    ].join("\n");

    const hit = detectFileMutationVerifierContradiction(report);
    expect(hit).not.toBeNull();
    expect(hit?.unmodifiedFileCount).toBe(1);
    expect(hit?.excerpt).toContain("File-mutation verifier");
    expect(hit?.excerpt).toContain("heartbeat.ts");
  });

  it("does not match green reports or bare mentions without the failure form", () => {
    expect(detectFileMutationVerifierContradiction(
      "All patches landed. No file-mutation verifier warnings.",
    )).toBeNull();
    expect(detectFileMutationVerifierContradiction(null)).toBeNull();
    expect(detectFileMutationVerifierContradiction("")).toBeNull();
  });

  it("refuses done and in_review when the verifier contradicts, not blocked/cancelled", () => {
    expect(shouldRefuseTerminalDispositionForFileMutationVerifier({
      statedStatus: "done",
      finalReport: contradictionFooter,
    })).not.toBeNull();
    expect(shouldRefuseTerminalDispositionForFileMutationVerifier({
      statedStatus: "in_review",
      finalReport: contradictionFooter,
    })).not.toBeNull();
    expect(shouldRefuseTerminalDispositionForFileMutationVerifier({
      statedStatus: "blocked",
      finalReport: contradictionFooter,
    })).toBeNull();
    expect(shouldRefuseTerminalDispositionForFileMutationVerifier({
      statedStatus: "cancelled",
      finalReport: contradictionFooter,
    })).toBeNull();
    expect(shouldRefuseTerminalDispositionForFileMutationVerifier({
      statedStatus: "done",
      finalReport: "Clean close with no verifier footer.",
    })).toBeNull();
  });
});
