import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExecutionWorkspaceCommands } from "../commands/client/execution-workspace.js";

describe("execution-workspace reap command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gets company-scoped dry-run reports without posting mutation intent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      companyId: "company-1",
      dryRun: true,
      deleteFiles: false,
      checkedCount: 0,
      candidateCount: 0,
      archivedCount: 0,
      excludedActiveCount: 0,
      noopArchivedCount: 0,
      noopNoReasonCount: 0,
      items: [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command();
    program.exitOverride();
    registerExecutionWorkspaceCommands(program);

    await program.parseAsync([
      "execution-workspace",
      "reap",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "test-token",
      "--company-id",
      "company-1",
    ], { from: "user" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/execution-workspaces/reap",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("posts apply/delete-files intent and prints metadata-only rows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      companyId: "company-1",
      dryRun: false,
      deleteFiles: true,
      checkedCount: 1,
      candidateCount: 1,
      archivedCount: 1,
      excludedActiveCount: 0,
      noopArchivedCount: 0,
      noopNoReasonCount: 0,
      items: [{
        workspaceId: "workspace-1",
        workspaceStatus: "active",
        sourceIssueIdentifier: "PAP-1",
        sourceIssueStatus: "done",
        reason: "source_issue_terminal",
        reasons: ["source_issue_terminal"],
        pathExists: true,
        activeLinkedCount: 0,
        plannedAction: "archive_record_and_delete_files",
        archived: true,
        cleanupAttempted: true,
        cleanupDeleted: false,
        cleanupSkippedReason: "raw cleanup warning should stay out of CLI table",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const logMock = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const program = new Command();
    program.exitOverride();
    registerExecutionWorkspaceCommands(program);

    await program.parseAsync([
      "execution-workspace",
      "reap",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "test-token",
      "--company-id",
      "company-1",
      "--apply",
      "--delete-files",
    ], { from: "user" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/company-1/execution-workspaces/reap",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dryRun: false, deleteFiles: true }),
      }),
    );
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("id=workspace-1"));
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining("action=archive_record_and_delete_files"));
    expect(logMock.mock.calls.map((call) => call.join(" ")).join("\n")).not.toContain("raw cleanup warning");
  });

  it("rejects contradictory apply and dry-run flags before calling the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    const program = new Command();
    program.exitOverride();
    registerExecutionWorkspaceCommands(program);

    await expect(program.parseAsync([
      "execution-workspace",
      "reap",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "test-token",
      "--company-id",
      "company-1",
      "--apply",
      "--dry-run",
    ], { from: "user" })).rejects.toThrow("exit 1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
