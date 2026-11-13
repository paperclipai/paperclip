import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { resolveGitHubReviewInstructions } from "./review-instructions.js";

const policy = { ...defaultGitHubReviewPolicy(), instructions: "REVIEW_POLICY" };
const delivery = (commentId: string, revision: number, manual = false) => ({
  endpointId: "endpoint", conversationId: "repository-pr-conversation", commentId,
  event: manual ? { githubManual: { revision, policy, event: "comment" } }
    : { githubAutomatic: { revision, policy, context: { repositoryId: "repository" } } },
});

// SQL authorization is exercised by the signed-webhook/database suite. These
// cases exercise policy projection after that bounded read, without PostgreSQL.
function boundRows(rows: ReturnType<typeof delivery>[]): Db {
  const query = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(async () => rows) };
  for (const method of [query.from, query.innerJoin, query.where, query.orderBy]) method.mockReturnValue(query);
  return { select: () => query } as unknown as Db;
}
const load = (rows: ReturnType<typeof delivery>[], commentIds: string[]) => resolveGitHubReviewInstructions({
  db: boundRows(rows), companyId: "company", agentId: "agent", issueId: "task", commentIds,
});

describe("admitted GitHub review configuration projection", () => {
  it("uses the last accepted request's policy when a batch spans revisions", async () => {
    const older = delivery("older", 5);
    const newer = delivery("newer", 6);
    const latest = await load([newer], ["newer"]);
    expect(await load([newer, older], ["older", "newer"])).toEqual(latest);
    expect(await load([newer, older], ["newer", "older"])).toEqual(await load([older], ["older"]));
  });

  it("keeps the same configuration identity across automatic, discussion, and automatic turns", async () => {
    const automatic = await load([delivery("automatic", 5)], ["automatic"]);
    const discussion = await load([delivery("discussion", 5, true)], ["discussion"]);
    const nextAutomatic = await load([delivery("next", 5)], ["next"]);
    expect(automatic).toHaveLength(1);
    expect(discussion).toEqual(automatic);
    expect(nextAutomatic).toEqual(discussion);
    expect(await load([delivery("changed", 6, true)], ["changed"])).not.toEqual(automatic);
  });
});
