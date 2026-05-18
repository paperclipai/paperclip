import { describe, it, expect, vi } from "vitest";
import {
  openPr,
  getPr,
  updatePr,
  closePr,
  updatePrBody,
  convertPrToDraft,
  markPrReadyForReview,
  repairPrHead,
} from "../src/tools/pr.js";
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
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const baseSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const targetSha = "cccccccccccccccccccccccccccccccccccccccc";

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

interface FakePrState {
  title?: string;
  body?: string;
  draft?: boolean;
  headSha?: string;
  baseSha?: string;
  baseRef?: string;
  headRef?: string;
  headRepository?: string;
  state?: string;
}

function makePrMutationClient(initial: FakePrState = {}): GitHubClient {
  const state = {
    title: initial.title ?? "Old title",
    body: initial.body ?? "old body",
    draft: initial.draft ?? false,
    headSha: initial.headSha ?? headSha,
    baseSha: initial.baseSha ?? baseSha,
    baseRef: initial.baseRef ?? "main",
    headRef: initial.headRef ?? "codex/com-168",
    headRepository: initial.headRepository ?? "owner/repo",
    state: initial.state ?? "open",
  };
  const prData = () => ({
    number: 42,
    html_url: "https://github.com/owner/repo/pull/42",
    state: state.state,
    title: state.title,
    draft: state.draft,
    body: state.body,
    head: {
      sha: state.headSha,
      ref: state.headRef,
      repo: { full_name: state.headRepository },
    },
    base: { sha: state.baseSha, ref: state.baseRef },
  });
  const graphql = vi.fn().mockImplementation(async (query: string) => {
    if (query.includes("pullRequest(number:")) {
      return { repository: { pullRequest: { id: "PR_GID_42" } } };
    }
    if (query.includes("convertPullRequestToDraft")) {
      state.draft = true;
      return { convertPullRequestToDraft: { pullRequest: { id: "PR_GID_42", isDraft: true } } };
    }
    if (query.includes("markPullRequestReadyForReview")) {
      state.draft = false;
      return { markPullRequestReadyForReview: { pullRequest: { id: "PR_GID_42", isDraft: false } } };
    }
    throw new Error(`unexpected graphql query: ${query.slice(0, 50)}`);
  });

  return {
    owner: "owner",
    name: "repo",
    rest: {
      pulls: {
        get: vi.fn().mockImplementation(async () => ({ data: prData() })),
        update: vi.fn().mockImplementation(async (params: { title?: string; body?: string; state?: string; base?: string }) => {
          if (params.title !== undefined) state.title = params.title;
          if (params.body !== undefined) state.body = params.body;
          if (params.state !== undefined) state.state = params.state;
          if (params.base !== undefined) state.baseRef = params.base;
          return { data: prData() };
        }),
      },
      issues: {
        createComment: vi.fn().mockResolvedValue({ data: { id: 123 } }),
      },
      git: {
        getCommit: vi.fn().mockResolvedValue({ data: { sha: targetSha } }),
        updateRef: vi.fn().mockImplementation(async ({ sha }: { sha: string }) => {
          state.headSha = sha;
          return { data: { object: { sha } } };
        }),
      },
    } as never,
    graphql: graphql as never,
  };
}

function mutationGuard(extra: Record<string, unknown> = {}) {
  return {
    repository: "owner/repo",
    prNumber: 42,
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
    ...extra,
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
                        { __typename: "CheckRun", name: "quality / still-running", conclusion: null, status: "IN_PROGRESS" },
                        { __typename: "StatusContext", context: "windows-desktop-gate", state: "SUCCESS" },
                        { __typename: "StatusContext", context: "pending-status", state: "PENDING" },
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
      allChecks: string[];
      reviewDecision: string | null;
      mergeable: boolean | null;
    };
    expect(data.state).toBe("OPEN");
    expect(data.mergeable).toBe(true);
    expect(data.passingChecks).toEqual(["quality / cargo-test", "windows-desktop-gate"]);
    expect(data.failingChecks).toEqual(["quality / cargo-clippy"]);
    expect(data.allChecks).toEqual(["quality / cargo-test", "windows-desktop-gate", "quality / cargo-clippy"]);
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

describe("PR mutation tools", () => {
  it("updates an existing PR title and body only after guard and readback", async () => {
    const client = makePrMutationClient({ title: "Old title", body: "old body" });
    const result = await updatePr(
      client,
      mutationGuard({
        title: "New title",
        body: "new body",
        expectedCurrentTitle: "Old title",
        expectedCurrentBody: "old body",
      }),
      runCtx,
    );
    expect(result.error).toBeUndefined();
    const data = result.data as {
      mutation: string;
      verified: boolean;
      changed: boolean;
      title: string;
      state: string;
      actor: { agentId: string; runId: string };
    };
    expect(data.mutation).toBe("update_pr");
    expect(data.verified).toBe(true);
    expect(data.changed).toBe(true);
    expect(data.title).toBe("New title");
    expect(data.state).toBe("open");
    expect(data.actor).toEqual({ agentId: "a", runId: "r" });
    expect((client.rest as never as { pulls: { update: ReturnType<typeof vi.fn> } }).pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, title: "New title", body: "new body" }),
    );
  });

  it("updates an existing PR base branch only after guard and readback", async () => {
    const client = makePrMutationClient({ baseRef: "main" });
    const result = await updatePr(client, mutationGuard({ base: "develop" }), runCtx);
    expect(result.error).toBeUndefined();
    const data = result.data as { mutation: string; verified: boolean; changed: boolean; baseRef: string };
    expect(data.mutation).toBe("update_pr");
    expect(data.verified).toBe(true);
    expect(data.changed).toBe(true);
    expect(data.baseRef).toBe("develop");
    expect((client.rest as never as { pulls: { update: ReturnType<typeof vi.fn> } }).pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, base: "develop" }),
    );
  });

  it("refuses general PR update when title/body/base are omitted", async () => {
    const client = makePrMutationClient();
    await expect(updatePr(client, mutationGuard(), runCtx)).rejects.toThrow(/title, body, or base required/);
  });

  it("refuses general PR update when expected body changed", async () => {
    const client = makePrMutationClient({ body: "newer body" });
    await expect(
      updatePr(client, mutationGuard({ body: "replacement", expectedCurrentBody: "old body" }), runCtx),
    ).rejects.toThrow(/expected_body_mismatch/);
  });

  it("closes an existing PR only after guard and readback", async () => {
    const client = makePrMutationClient({ state: "open" });
    const result = await closePr(
      client,
      mutationGuard({ reason: "superseded by PR #600", commentBody: "Replacement branch passed review." }),
      runCtx,
    );
    expect(result.error).toBeUndefined();
    const data = result.data as {
      mutation: string;
      verified: boolean;
      changed: boolean;
      state: string;
      actor: { agentId: string; runId: string };
    };
    expect(data.mutation).toBe("close_pr");
    expect(data.verified).toBe(true);
    expect(data.changed).toBe(true);
    expect(data.state).toBe("closed");
    expect(data.actor).toEqual({ agentId: "a", runId: "r" });
    const createComment = (client.rest as never as { issues: { createComment: ReturnType<typeof vi.fn> } }).issues.createComment;
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 42,
        body: expect.stringContaining("Reason: superseded by PR #600"),
      }),
    );
    expect(createComment.mock.calls[0]?.[0]?.body).toContain("Agent: a");
    expect(createComment.mock.calls[0]?.[0]?.body).toContain("Run: r");
    expect(createComment.mock.calls[0]?.[0]?.body).not.toMatch(/\n{3,}/);
    expect((client.rest as never as { pulls: { update: ReturnType<typeof vi.fn> } }).pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, state: "closed" }),
    );
  });

  it("refuses to close a PR without an explicit reason", async () => {
    const client = makePrMutationClient();
    await expect(closePr(client, mutationGuard(), runCtx)).rejects.toThrow(/reason required/);
  });

  it("refuses to close a PR whose expected base does not match readback", async () => {
    const client = makePrMutationClient({ baseSha: targetSha });
    await expect(closePr(client, mutationGuard({ reason: "superseded" }), runCtx)).rejects.toThrow(/expected_base_mismatch/);
  });

  it("refuses to close an already closed PR", async () => {
    const client = makePrMutationClient({ state: "closed" });
    await expect(closePr(client, mutationGuard({ reason: "superseded" }), runCtx)).rejects.toThrow(/pr_not_open/);
  });

  it("updates an existing PR body only after head/base guard and readback", async () => {
    const client = makePrMutationClient({ body: "old body" });
    const result = await updatePrBody(
      client,
      mutationGuard({ body: "new body", expectedCurrentBody: "old body" }),
      runCtx,
    );
    expect(result.error).toBeUndefined();
    expect((result.data as { mutation: string; verified: boolean; changed: boolean }).mutation).toBe("update_body");
    expect((result.data as { verified: boolean }).verified).toBe(true);
    expect((client.rest as never as { pulls: { update: ReturnType<typeof vi.fn> } }).pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, body: "new body" }),
    );
  });

  it("refuses mutation when expected head does not match readback", async () => {
    const client = makePrMutationClient({ headSha: targetSha });
    await expect(
      updatePrBody(client, mutationGuard({ body: "new body" }), runCtx),
    ).rejects.toThrow(/expected_head_mismatch/);
  });

  it("converts a PR to draft with GraphQL mutation and readback", async () => {
    const client = makePrMutationClient({ draft: false });
    const result = await convertPrToDraft(client, mutationGuard(), runCtx);
    expect(result.error).toBeUndefined();
    expect((result.data as { draft: boolean; mutation: string }).draft).toBe(true);
    expect((result.data as { mutation: string }).mutation).toBe("convert_to_draft");
    expect(client.graphql).toHaveBeenCalledWith(expect.stringContaining("convertPullRequestToDraft"), {
      prId: "PR_GID_42",
    });
  });

  it("marks a draft PR ready for review with GraphQL mutation and readback", async () => {
    const client = makePrMutationClient({ draft: true });
    const result = await markPrReadyForReview(client, mutationGuard(), runCtx);
    expect(result.error).toBeUndefined();
    expect((result.data as { draft: boolean; mutation: string }).draft).toBe(false);
    expect((result.data as { mutation: string }).mutation).toBe("mark_ready_for_review");
    expect(client.graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), {
      prId: "PR_GID_42",
    });
  });

  it("repairs an existing PR head branch with target commit verification and readback", async () => {
    const client = makePrMutationClient();
    const result = await repairPrHead(client, mutationGuard({ targetHeadSha: targetSha }), runCtx);
    expect(result.error).toBeUndefined();
    expect((result.data as { headSha: string; mutation: string }).headSha).toBe(targetSha);
    expect((result.data as { mutation: string }).mutation).toBe("repair_head");
    const git = (client.rest as never as { git: { getCommit: ReturnType<typeof vi.fn>; updateRef: ReturnType<typeof vi.fn> } }).git;
    expect(git.getCommit).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo", commit_sha: targetSha }),
    );
    expect(git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "heads/codex/com-168", sha: targetSha, force: false }),
    );
  });

  it("refuses head repair for a forked or unauthorized head branch", async () => {
    const client = makePrMutationClient({ headRepository: "someone/repo" });
    await expect(
      repairPrHead(client, mutationGuard({ targetHeadSha: targetSha }), runCtx),
    ).rejects.toThrow(/unauthorized_head_branch/);
  });

  it("maps branch protection failures separately from generic GitHub API failures", async () => {
    const client = makePrMutationClient();
    (client.rest as never as { git: { updateRef: ReturnType<typeof vi.fn> } }).git.updateRef.mockRejectedValueOnce(
      Object.assign(new Error("Protected branch update failed"), { status: 422 }),
    );
    await expect(
      repairPrHead(client, mutationGuard({ targetHeadSha: targetSha }), runCtx),
    ).rejects.toThrow(/branch_protected/);
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
