import { describe, it, expect, vi } from "vitest";
import { openPr, getPr } from "../src/tools/pr.js";
import { RefusalError } from "../src/audit.js";
import type { GitHubClient } from "../src/auth.js";
import type { ResolvedConfig } from "../src/config.js";

const cfg: ResolvedConfig = {
  appId: 1,
  privateKeyPem: "x",
  installationId: 1,
  repo: "owner/repo",
  defaultBranch: "main",
  mergeQueueEnabled: true,
};

const runCtx = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };
const env = { activity: { log: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, toolName: "test" };

function makeFakeClient(overrides: Record<string, unknown> = {}): GitHubClient {
  return {
    owner: "owner",
    name: "repo",
    rest: {
      pulls: {
        create: vi.fn().mockResolvedValue({
          data: { number: 42, html_url: "https://github.com/owner/repo/pull/42", head: { sha: "deadbeef" } },
        }),
      },
      issues: {
        addLabels: vi.fn().mockResolvedValue({ data: [] }),
      },
      ...overrides,
    } as never,
    graphql: vi.fn() as never,
  };
}

describe("openPr", () => {
  it("opens a PR with auto-appended issue ref when body lacks one", async () => {
    const client = makeFakeClient();
    const result = await openPr(
      client,
      cfg,
      { issueId: "123", branch: "feat/x", title: "Add x", body: "free text without ref" },
      runCtx,
      env,
    );
    expect(result.error).toBeUndefined();
    expect((result.data as { prNumber?: number }).prNumber).toBe(42);
    expect((client.rest as never as { pulls: { create: ReturnType<typeof vi.fn> } }).pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Add x",
        head: "feat/x",
        base: "main",
        body: expect.stringContaining("Fixes #123"),
        draft: true,
      }),
    );
  });

  it("keeps body intact when it already contains an issue ref", async () => {
    const client = makeFakeClient();
    await openPr(
      client,
      cfg,
      { issueId: "9", branch: "b", title: "T", body: "Closes #99 — note" },
      runCtx,
      env,
    );
    const callArgs = (client.rest as never as { pulls: { create: ReturnType<typeof vi.fn> } }).pulls.create.mock.calls[0]?.[0];
    expect(callArgs.body).toBe("Closes #99 — note");
  });

  it("applies labels after creation", async () => {
    const client = makeFakeClient();
    await openPr(
      client,
      cfg,
      {
        issueId: "1",
        branch: "b",
        title: "T",
        body: "Fixes #1",
        labels: ["compliance", "phase1"],
      },
      runCtx,
      env,
    );
    const addLabels = (client.rest as never as { issues: { addLabels: ReturnType<typeof vi.fn> } }).issues.addLabels;
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, labels: ["compliance", "phase1"] }),
    );
  });

  it("refuses when params lack issueId", async () => {
    const client = makeFakeClient();
    await expect(
      openPr(client, cfg, { branch: "b", title: "T", body: "Fixes #1" } as never, runCtx, env),
    ).rejects.toThrow(/issueId required/);
  });
});

describe("getPr", () => {
  it("aggregates state, mergeable, passing and failing checks", async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          baseRefOid: "base-sha",
          headRefOid: "head-sha",
          reviewDecision: "APPROVED",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", name: "quality / cargo-test", conclusion: "SUCCESS", status: "COMPLETED" },
                        { __typename: "CheckRun", name: "quality / cargo-clippy", conclusion: "FAILURE", status: "COMPLETED" },
                        { __typename: "StatusContext", context: "windows-desktop-gate", state: "SUCCESS" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    const client: GitHubClient = { owner: "o", name: "r", rest: {} as never, graphql: graphql as never };

    const result = await getPr(client, { prNumber: 5 }, runCtx);
    expect(result.error).toBeUndefined();
    const data = result.data as {
      state: string;
      passingChecks: string[];
      failingChecks: string[];
      reviewDecision: string | null;
      mergeable: boolean | null;
    };
    expect(data.state).toBe("OPEN");
    expect(data.mergeable).toBe(true);
    expect(data.passingChecks).toEqual(["quality / cargo-test", "windows-desktop-gate"]);
    expect(data.failingChecks).toEqual(["quality / cargo-clippy"]);
    expect(data.reviewDecision).toBe("APPROVED");
  });

  it("returns mergeable=null when GraphQL reports UNKNOWN", async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          state: "OPEN",
          isDraft: true,
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          baseRefOid: "b",
          headRefOid: "h",
          reviewDecision: null,
          commits: { nodes: [] },
        },
      },
    });
    const client: GitHubClient = { owner: "o", name: "r", rest: {} as never, graphql: graphql as never };
    const result = await getPr(client, { prNumber: 1 }, runCtx);
    expect((result.data as { mergeable: boolean | null }).mergeable).toBeNull();
  });
});

describe("RefusalError", () => {
  it("carries code, reason, and a code-prefixed message", () => {
    const err = new RefusalError("test_code", "test reason");
    expect(err.code).toBe("test_code");
    expect(err.reason).toBe("test reason");
    expect(err.message).toBe("test_code: test reason");
    expect(err.name).toBe("RefusalError");
  });
});
