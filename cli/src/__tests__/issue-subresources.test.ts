import { Command } from "commander";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerIssueCommands } from "../commands/client/issue.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";
const PRODUCT_ID = "77777777-7777-4777-8777-777777777777";
const INTERACTION_ID = "88888888-8888-4888-8888-888888888888";
const HOLD_ID = "99999999-9999-4999-8999-999999999999";
const ATTACHMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LABEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerIssueCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

describe("issue subresource commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps core issue get, update, and delete endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "get", ISSUE_ID]);
    await run(["issue", "update", ISSUE_ID, "--title", "New title"]);
    await run(["issue", "delete", ISSUE_ID, "--yes"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}`],
      ["PATCH", `http://localhost:3100/api/issues/${ISSUE_ID}`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}`],
    ]);
  });

  it("wraps comments, approvals, markers, and recovery action endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "comments", ISSUE_ID, "--limit", "10"]);
    await run(["issue", "comment:get", ISSUE_ID, COMMENT_ID]);
    await run(["issue", "comment:delete", ISSUE_ID, COMMENT_ID]);
    await run(["issue", "approvals", ISSUE_ID]);
    await run(["issue", "approval:link", ISSUE_ID, APPROVAL_ID]);
    await run(["issue", "approval:unlink", ISSUE_ID, APPROVAL_ID]);
    await run(["issue", "read", ISSUE_ID]);
    await run(["issue", "unread", ISSUE_ID]);
    await run(["issue", "archive", ISSUE_ID]);
    await run(["issue", "unarchive", ISSUE_ID]);
    await run(["issue", "recovery-actions", ISSUE_ID]);
    await run([
      "issue", "recovery:resolve", ISSUE_ID,
      "--outcome", "restored",
      "--source-issue-status", "todo",
      "--action-id", APPROVAL_ID,
    ]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/comments?limit=10`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/comments/${COMMENT_ID}`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/comments/${COMMENT_ID}`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/approvals`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/approvals`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/approvals/${APPROVAL_ID}`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/read`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/read`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/inbox-archive`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/inbox-archive`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/recovery-actions`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/recovery-actions/resolve`],
    ]);
  });

  it("wraps document and work product endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);

    await run(["issue", "documents", ISSUE_ID, "--include-system"]);
    await run(["issue", "document:get", ISSUE_ID, "plan"]);
    await run(["issue", "document:put", ISSUE_ID, "plan", "--body", "# Plan", "--title", "Plan"]);
    await run(["issue", "document:lock", ISSUE_ID, "plan"]);
    await run(["issue", "document:unlock", ISSUE_ID, "plan"]);
    await run(["issue", "document:revisions", ISSUE_ID, "plan"]);
    await run(["issue", "document:restore", ISSUE_ID, "plan", APPROVAL_ID]);
    await run(["issue", "document:delete", ISSUE_ID, "plan"]);
    await run(["issue", "work-products", ISSUE_ID]);
    await run([
      "issue", "work-product:create", ISSUE_ID,
      "--payload-json", JSON.stringify({ type: "pull_request", provider: "github", title: "PR", url: "https://example.com/pr/1" }),
    ]);
    await run([
      "issue", "work-product:update", PRODUCT_ID,
      "--payload-json", JSON.stringify({ title: "Updated PR" }),
    ]);
    await run(["issue", "work-product:delete", PRODUCT_ID]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/documents?includeSystem=true`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan`],
      ["PUT", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan/lock`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan/unlock`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan/revisions`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan/revisions/${APPROVAL_ID}/restore`],
      ["DELETE", `http://localhost:3100/api/issues/${ISSUE_ID}/documents/plan`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/work-products`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/work-products`],
      ["PATCH", `http://localhost:3100/api/work-products/${PRODUCT_ID}`],
      ["DELETE", `http://localhost:3100/api/work-products/${PRODUCT_ID}`],
    ]);
  });

  it("wraps interactions, tree holds, labels, feedback votes, and attachments", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "paperclip-cli-test-"));
    const filePath = join(tmp, "attachment.txt");
    await writeFile(filePath, "hello", "utf8");
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await run(["issue", "interactions", ISSUE_ID]);
      await run([
        "issue", "interaction:create", ISSUE_ID,
        "--payload-json", JSON.stringify({
          kind: "request_confirmation",
          payload: { version: 1, prompt: "Continue?" },
        }),
      ]);
      await run(["issue", "interaction:accept", ISSUE_ID, INTERACTION_ID]);
      await run(["issue", "interaction:accept", ISSUE_ID, INTERACTION_ID, "--selected-client-keys", "yes"]);
      await run(["issue", "interaction:accept", ISSUE_ID, INTERACTION_ID, "--selected-option-ids", "file-a,file-b"]);
      await run(["issue", "interaction:reject", ISSUE_ID, INTERACTION_ID, "--reason", "no"]);
      await run(["issue", "interaction:cancel", ISSUE_ID, INTERACTION_ID, "--reason", "stale"]);
      await run([
        "issue", "interaction:respond", ISSUE_ID, INTERACTION_ID,
        "--answers-json", JSON.stringify([{ questionId: "q1", optionIds: ["a1"] }]),
      ]);
      await run(["issue", "tree-state", ISSUE_ID]);
      await run(["issue", "tree-preview", ISSUE_ID, "--payload-json", JSON.stringify({ mode: "pause" })]);
      await run(["issue", "tree-holds", ISSUE_ID, "--status", "active", "--include-members"]);
      await run(["issue", "tree-hold:create", ISSUE_ID, "--payload-json", JSON.stringify({ mode: "pause", reason: "test" })]);
      await run(["issue", "tree-hold:get", ISSUE_ID, HOLD_ID]);
      await run(["issue", "tree-hold:release", ISSUE_ID, HOLD_ID]);
      await run(["issue", "attachments", ISSUE_ID]);
      await run(["issue", "attachment:upload", ISSUE_ID, "--company-id", COMPANY_ID, "--file", filePath]);
      await run(["issue", "attachment:download", ATTACHMENT_ID]);
      await run(["issue", "attachment:delete", ATTACHMENT_ID]);
      await run(["issue", "label:list", "--company-id", COMPANY_ID]);
      await run(["issue", "label:create", "--company-id", COMPANY_ID, "--name", "bug", "--color", "#ff0000"]);
      await run(["issue", "label:delete", LABEL_ID]);
      await run(["issue", "feedback:votes", ISSUE_ID]);
      await run([
        "issue", "feedback:vote", ISSUE_ID,
        "--payload-json", JSON.stringify({ targetType: "issue_comment", targetId: COMMENT_ID, vote: "up" }),
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/accept`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/accept`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/accept`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/reject`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/cancel`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/interactions/${INTERACTION_ID}/respond`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-control/state`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-control/preview`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-holds?status=active&includeMembers=true`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-holds`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-holds/${HOLD_ID}`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/tree-holds/${HOLD_ID}/release`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/attachments`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/attachments`],
      ["GET", `http://localhost:3100/api/attachments/${ATTACHMENT_ID}/content`],
      ["DELETE", `http://localhost:3100/api/attachments/${ATTACHMENT_ID}`],
      ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/labels`],
      ["POST", `http://localhost:3100/api/companies/${COMPANY_ID}/labels`],
      ["DELETE", `http://localhost:3100/api/labels/${LABEL_ID}`],
      ["GET", `http://localhost:3100/api/issues/${ISSUE_ID}/feedback-votes`],
      ["POST", `http://localhost:3100/api/issues/${ISSUE_ID}/feedback-votes`],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      selectedOptionIds: ["file-a", "file-b"],
    });
  });
});

function jsonResponse(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), init);
}
