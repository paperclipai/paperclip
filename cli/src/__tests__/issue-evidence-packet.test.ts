import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import {
  registerIssueCommands,
  renderQaEvidencePacket,
  renderQaEvidencePacketComment,
  validateQaEvidencePacketInput,
} from "../commands/client/issue.js";

const ORIGINAL_EXIT = process.exit;

function makeIssue(): Issue {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Ship QA evidence packets",
    description: null,
    status: "in_review",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 26,
    identifier: "CLI-26",
    originKind: undefined,
    originId: null,
    originRunId: null,
    originFingerprint: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-30T20:00:00.000Z"),
    updatedAt: new Date("2026-05-30T20:00:00.000Z"),
  };
}

describe("issue evidence packet command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exit = ORIGINAL_EXIT;
  });

  it("registers the publisher under issue commands", () => {
    const program = new Command();

    registerIssueCommands(program);

    const issue = program.commands.find((command) => command.name() === "issue");
    expect(issue?.commands.map((command) => command.name())).toContain("evidence:publish");
  });

  it("renders all QA-required packet sections with Paperclip attachment paths", () => {
    const body = renderQaEvidencePacket({
      issue: makeIssue(),
      prUrl: "https://github.com/example/paperclip/pull/26",
      commitSha: "abc123",
      changedFiles: ["cli/src/commands/client/issue.ts"],
      checks: ["pnpm --filter paperclipai typecheck: passed"],
      screenshots: [{
        id: "attachment-shot",
        originalFilename: "packet.png",
        contentPath: "/api/attachments/attachment-shot/content",
        contentType: "image/png",
        byteSize: 123,
        kind: "screenshot",
      }],
      logs: [{
        id: "attachment-log",
        originalFilename: "worker.log",
        contentPath: "/api/attachments/attachment-log/content",
        contentType: "text/plain",
        byteSize: 456,
        kind: "log",
      }],
      residualRisks: ["No live server smoke was run."],
      diffSummary: "Added CLI evidence publisher.",
      workerLog: "Implemented and typechecked.",
    });

    expect(body).toContain("PR URL: https://github.com/example/paperclip/pull/26");
    expect(body).toContain("Commit SHA: abc123");
    expect(body).toContain("- cli/src/commands/client/issue.ts");
    expect(body).toContain("pnpm --filter paperclipai typecheck: passed");
    expect(body).toContain("/api/attachments/attachment-shot/content");
    expect(body).toContain("/api/attachments/attachment-log/content");
    expect(body).toContain("No live server smoke was run.");
  });

  it("renders a concise QA pointer comment with revision and attachment ids", () => {
    const document = {
      id: "document-1",
      companyId: "company-1",
      issueId: "issue-1",
      key: "qa-evidence-packet",
      title: "QA Evidence Packet",
      format: "markdown",
      body: "packet",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 3,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lockedAt: null,
      lockedByAgentId: null,
      lockedByUserId: null,
      createdAt: new Date("2026-05-30T20:00:00.000Z"),
      updatedAt: new Date("2026-05-30T20:00:00.000Z"),
    } satisfies IssueDocument;
    const workProduct = {
      id: "work-product-1",
      companyId: "company-1",
      projectId: null,
      issueId: "issue-1",
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "pull_request",
      provider: "github",
      externalId: "https://github.com/example/paperclip/pull/26",
      title: "PR evidence",
      url: "https://github.com/example/paperclip/pull/26",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      isPrimary: true,
      healthStatus: "unknown",
      summary: null,
      metadata: null,
      createdByRunId: null,
      createdAt: new Date("2026-05-30T20:00:00.000Z"),
      updatedAt: new Date("2026-05-30T20:00:00.000Z"),
    } satisfies IssueWorkProduct;

    const comment = renderQaEvidencePacketComment(document, [{
      id: "attachment-1",
      originalFilename: "worker.log",
      contentPath: "/api/attachments/attachment-1/content",
      contentType: "text/plain",
      byteSize: 1,
      kind: "log",
    }], workProduct);

    expect(comment).toContain("`qa-evidence-packet` revision 3 (revision-1)");
    expect(comment).toContain("attachment-1 (/api/attachments/attachment-1/content)");
    expect(comment).toContain("PR work product: work-product-1");
  });

  it("rejects incomplete QA evidence packets before publishing", () => {
    expect(() => validateQaEvidencePacketInput({
      prUrl: "https://github.com/example/paperclip/pull/26",
      commitSha: "abc123",
      changedFiles: [],
      checks: [],
      screenshotPaths: [],
      logPaths: [],
      residualRisks: [],
      diffSummary: null,
      workerLog: null,
    })).toThrow(
      "QA evidence packet is incomplete. Missing required evidence: diff summary or changed-file list, exact checks/output, screenshot artifacts, log excerpt or attachment, residual risks.",
    );
  });

  it("does not create uploads, documents, work products, or comments for incomplete packets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeIssue()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit ${code}`);
    });

    const program = new Command();
    registerIssueCommands(program);

    await expect(program.parseAsync([
      "node",
      "paperclipai",
      "issue",
      "evidence:publish",
      "CLI-28",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "token-123",
      "--pr-url",
      "https://github.com/example/paperclip/pull/28",
      "--commit-sha",
      "abc123",
      "--changed-file",
      "cli/src/client/http.ts",
      "--check",
      "vitest passed",
      "--worker-log",
      "worker log excerpt",
      "--risk",
      "No residual risks beyond targeted CLI scope.",
    ])).rejects.toThrow("process.exit 1");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Missing required evidence: screenshot artifacts."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/issues/CLI-28");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });
});
