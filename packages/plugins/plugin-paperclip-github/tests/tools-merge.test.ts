import { describe, it, expect, vi } from "vitest";
import { enqueueMerge } from "../src/tools/merge.js";
import type { GitHubClient } from "../src/auth.js";
import type { ResolvedConfig } from "../src/config.js";

const baseCfg: ResolvedConfig = {
  appId: 1,
  privateKeyPem: "x",
  installationId: 1,
  repo: "o/r",
  defaultBranch: "main",
  mergeQueueEnabled: true,
};

const runCtx = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };

interface FakePrStatus {
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  passing?: string[];
  failing?: string[];
}

function makeClient(status: FakePrStatus = {}): GitHubClient {
  const passing = (status.passing ?? ["quality / cargo-test"]).map((n) => ({
    __typename: "CheckRun" as const,
    name: n,
    conclusion: "SUCCESS",
    status: "COMPLETED",
  }));
  const failing = (status.failing ?? []).map((n) => ({
    __typename: "CheckRun" as const,
    name: n,
    conclusion: "FAILURE",
    status: "COMPLETED",
  }));

  const prStatusResp = {
    repository: {
      pullRequest: {
        state: status.state ?? "OPEN",
        isDraft: status.isDraft ?? false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        baseRefOid: "b",
        headRefOid: "h",
        reviewDecision: status.reviewDecision === undefined ? "APPROVED" : status.reviewDecision,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [...passing, ...failing] },
                },
              },
            },
          ],
        },
      },
    },
  };
  const prIdResp = { repository: { pullRequest: { id: "PR_GID_1" } } };
  const enqueueResp = {
    enqueuePullRequest: { mergeQueueEntry: { position: 3, enqueuedAt: "2026-05-14T00:00:00Z", state: "QUEUED" } },
  };

  const graphql = vi.fn().mockImplementation(async (query: string) => {
    if (query.includes("statusCheckRollup")) return prStatusResp;
    if (query.includes("pullRequest(number:")) return prIdResp;
    if (query.includes("enqueuePullRequest")) return enqueueResp;
    throw new Error(`unexpected graphql query: ${query.slice(0, 50)}`);
  });

  return { owner: "o", name: "r", rest: {} as never, graphql: graphql as never };
}

describe("enqueueMerge refusal chain", () => {
  it("enqueues when status is clean and approved", async () => {
    const client = makeClient();
    const result = await enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx);
    expect(result.error).toBeUndefined();
    expect((result.data as { position: number }).position).toBe(3);
  });

  it("refuses when mergeQueueEnabled=false", async () => {
    const client = makeClient();
    await expect(
      enqueueMerge(client, { ...baseCfg, mergeQueueEnabled: false }, { prNumber: 11 }, runCtx),
    ).rejects.toThrow(/merge_queue_disabled/);
  });

  it("refuses when PR is draft", async () => {
    const client = makeClient({ isDraft: true });
    await expect(enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx)).rejects.toThrow(/pr_is_draft/);
  });

  it("refuses when PR is closed", async () => {
    const client = makeClient({ state: "CLOSED" });
    await expect(enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx)).rejects.toThrow(/pr_not_open/);
  });

  it("refuses when failing checks exist", async () => {
    const client = makeClient({ failing: ["quality / cargo-clippy"] });
    await expect(enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx)).rejects.toThrow(/failing_checks/);
  });

  it("refuses when review decision is CHANGES_REQUESTED", async () => {
    const client = makeClient({ reviewDecision: "CHANGES_REQUESTED" });
    await expect(enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx)).rejects.toThrow(
      /review_not_approved/,
    );
  });

  it("allows null reviewDecision (CODEOWNERS not required)", async () => {
    const client = makeClient({ reviewDecision: null });
    const result = await enqueueMerge(client, baseCfg, { prNumber: 11 }, runCtx);
    expect(result.error).toBeUndefined();
  });
});
