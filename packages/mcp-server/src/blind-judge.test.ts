import { describe, expect, it } from "vitest";
import {
  chunkBlindJudgeDocument,
  createBlindJudgeReadAuthorizer,
  readBlindJudgeConfig,
  summarizeBlindJudgeRevisions,
} from "./blind-judge.js";

describe("blind judge Paperclip MCP config", () => {
  it("normalizes the API URL and deduplicates the approved read scope", () => {
    const config = readBlindJudgeConfig({
      PAPERCLIP_API_URL: "http://127.0.0.1:3100/",
      PAPERCLIP_API_KEY: "token",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_TASK_ID: "task-1",
      PAPERCLIP_MCP_ALLOWED_READ_ISSUE_IDS: "RES-3, RES-3,RES-4",
    });

    expect(config).toEqual({
      apiUrl: "http://127.0.0.1:3100/api",
      apiKey: "token",
      runId: "run-1",
      taskId: "task-1",
      allowedReadIssueIds: ["RES-3", "RES-4"],
    });
  });

  it("fails closed without a current task or approved read scope", () => {
    expect(() => readBlindJudgeConfig({
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_KEY: "token",
      PAPERCLIP_TASK_ID: "task-1",
    })).toThrow("PAPERCLIP_MCP_ALLOWED_READ_ISSUE_IDS");
  });

  it("treats an approved identifier and its resolved UUID as the same issue", async () => {
    const lookups: string[] = [];
    const authorize = createBlindJudgeReadAuthorizer(["RES-3"], async (issueId) => {
      lookups.push(issueId);
      return {
        id: "c8c36329-e988-4cb3-9c38-6ea34301655f",
        identifier: "RES-3",
      };
    });

    await expect(authorize("RES-3")).resolves.toBeUndefined();
    await expect(authorize("c8c36329-e988-4cb3-9c38-6ea34301655f")).resolves.toBeUndefined();
    await expect(authorize("RES-4")).rejects.toThrow("may not read Paperclip issue RES-4");
    expect(lookups).toEqual(["RES-3"]);
  });

  it("returns bounded document chunks and revision hashes without full revision bodies", () => {
    expect(chunkBlindJudgeDocument({
      id: "doc-1",
      issueId: "issue-1",
      key: "protocol",
      body: "abcdefghij",
      latestRevisionId: "rev-1",
    }, 3, 4)).toMatchObject({
      id: "doc-1",
      body: "defg",
      bodyLength: 10,
      chunkStart: 3,
      chunkEnd: 7,
      nextOffset: 7,
    });

    const revisions = summarizeBlindJudgeRevisions([{
      id: "rev-1",
      revisionNumber: 18,
      body: "protocol body",
    }]) as Array<Record<string, unknown>>;
    expect(revisions[0]).toMatchObject({
      id: "rev-1",
      revisionNumber: 18,
      bodyLength: 13,
    });
    expect(revisions[0]?.computedBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(revisions[0]).not.toHaveProperty("body");
  });
});
