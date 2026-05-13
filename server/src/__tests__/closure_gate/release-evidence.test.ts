import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDetectCodeTouching = vi.hoisted(() => vi.fn());

vi.mock("../../services/release-evidence/code-touching.js", () => ({
  detectCodeTouching: mockDetectCodeTouching,
}));

import { validateReleaseEvidenceForIssueClose } from "../../services/release-evidence/validator.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const releaseOwnerAgentId = "33333333-3333-4333-8333-333333333333";

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: "44444444-4444-4444-8444-444444444444",
    parentId: null,
    title: "Closure gate test",
    identifier: "CLO-672",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: "55555555-5555-4555-8555-555555555555",
    assigneeUserId: null,
    executionWorkspaceId: null,
    releaseEvidence: null,
    createdAt: new Date("2026-05-13T12:00:00.000Z"),
    updatedAt: new Date("2026-05-13T12:00:00.000Z"),
    ...overrides,
  } as any;
}

function dbReturning(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return { select: vi.fn(() => chain) } as any;
}

function config() {
  return {
    requireReleaseEvidence: true,
    releaseOwnerAgentId,
    githubToken: undefined,
  };
}

describe("releaseEvidence closure gate STRIDE regressions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDetectCodeTouching.mockReset();
    mockDetectCodeTouching.mockResolvedValue({
      codeTouching: true,
      reason: "engineer_role_default_code_touching",
    });
  });

  it("rejects a forged PR URL against a different repo", async () => {
    // STRIDE: Spoofing - T1 forged PR URL.
    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/other/repo/pull/1",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("repo_mismatch");
  });

  it("rejects a replayed stale merge commit SHA", async () => {
    // STRIDE: Tampering - T2 stale SHA replay.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      commit: { author: { date: "2026-05-13T09:00:00.000Z" } },
    }), { status: 200 })));

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "merge_commit",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        sha: "abcdef1",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("sha_predates_issue");
  });

  it("rejects an unmerged PR during merge-close races", async () => {
    // STRIDE: Tampering - T3 merge then close race.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      merged: false,
      merged_at: null,
      base: { ref: "master" },
      merge_commit_sha: null,
    }), { status: 200 })));

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("pr_not_merged");
  });

  it("rejects a merged PR that does not reference this issue", async () => {
    // STRIDE: Spoofing - T1 forged PR URL.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      merged: true,
      merged_at: "2026-05-13T12:30:00.000Z",
      base: { ref: "master" },
      title: "Fix unrelated issue",
      body: "This PR solves CLO-999, not this issue.",
      merge_commit_sha: "1234567",
    }), { status: 200 })));

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("pr_not_linked_to_issue");
  });

  it("accepts PR evidence that references the issue identifier", async () => {
    // STRIDE: Spoofing - T1 with explicit issue binding.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return new Response(JSON.stringify({
          merged: true,
          merged_at: "2026-05-13T12:30:00.000Z",
          base: { ref: "master" },
          title: "Close CLO-672",
          body: "Closes CLO-672 after verification.",
          merge_commit_sha: "1234567",
        }), { status: 200 });
      }
      if (url.endsWith("/compare/1234567...master")) {
        // GitHub returns "ahead" when the head (ref) is ahead of the base (sha),
        // i.e. the SHA is reachable from the ref.
        return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    })) as any;

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(outcome.ok).toBe(true);
  });

  it("fails closed when GitHub cannot validate PR evidence", async () => {
    // STRIDE: Tampering - fail closed when PR merge state cannot be fetched.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.githubApiCalled).toBe(true);
    expect(outcome.degraded).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("github_api_unavailable");
  });

  it("fails closed when GitHub cannot validate PR merge SHA reachability", async () => {
    // STRIDE: Tampering - fail closed when the merged SHA cannot be compared to the target ref.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return new Response(JSON.stringify({
          merged: true,
          merged_at: "2026-05-13T12:30:00.000Z",
          base: { ref: "master" },
          title: "Close CLO-672",
          body: "Closes CLO-672 after verification.",
          merge_commit_sha: "1234567",
        }), { status: 200 });
      }
      if (url.endsWith("/compare/1234567...master")) {
        return new Response("server unavailable", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    })) as any;

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "pr_merged",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        prUrl: "https://github.com/paperclipai/paperclip/pull/123",
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.githubApiCalled).toBe(true);
    expect(outcome.degraded).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("github_api_unavailable");
  });

  it("fails closed when GitHub cannot validate merge commit SHA reachability", async () => {
    // STRIDE: Tampering - fail closed when SHA reachability cannot be checked.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/commits/abcdef1")) {
        return new Response(JSON.stringify({
          commit: { author: { date: "2026-05-13T12:30:00.000Z" } },
        }), { status: 200 });
      }
      if (url.endsWith("/compare/abcdef1...master")) {
        return new Response("server unavailable", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    })) as any;

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "merge_commit",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        sha: "abcdef1",
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.githubApiCalled).toBe(true);
    expect(outcome.degraded).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("github_api_unavailable");
  });

  it("rejects a release-owner signoff spoofed by another agent", async () => {
    // STRIDE: Spoofing - T4 release-owner signoff spoofing.
    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([{
      id: "66666666-6666-4666-8666-666666666666",
      issueId,
      companyId,
      authorAgentId: "77777777-7777-4777-8777-777777777777",
      body: "release:confirmed abcdef1",
    }]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "release_owner_signoff",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        signedOffByAgentId: releaseOwnerAgentId,
        signoffCommentId: "66666666-6666-4666-8666-666666666666",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("signoff_author_mismatch");
  });

  it("accepts release-owner signoff that confirms a merged PR URL", async () => {
    // STRIDE: Spoofing - T4 release-owner signoff with PR evidence revalidation.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return new Response(JSON.stringify({
          merged: true,
          merged_at: "2026-05-13T12:30:00.000Z",
          base: { ref: "master" },
          title: "Close CLO-672",
          body: "Closes CLO-672 after release-owner review.",
          merge_commit_sha: "1234567",
        }), { status: 200 });
      }
      if (url.endsWith("/compare/1234567...master")) {
        return new Response(JSON.stringify({ status: "ahead" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    })) as any;

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([{
      id: "66666666-6666-4666-8666-666666666666",
      issueId,
      companyId,
      authorAgentId: releaseOwnerAgentId,
      body: "release:confirmed https://github.com/paperclipai/paperclip/pull/123",
    }]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "release_owner_signoff",
        repo: "https://github.com/paperclipai/paperclip",
        ref: "master",
        signedOffByAgentId: releaseOwnerAgentId,
        signoffCommentId: "66666666-6666-4666-8666-666666666666",
      },
    });

    expect(outcome.ok).toBe(true);
  });

  it("rejects not_code evidence when workspace diffs exist", async () => {
    // STRIDE: Elevation of Privilege - T5 not_code abuse.
    mockDetectCodeTouching
      .mockResolvedValueOnce({ codeTouching: true, reason: "engineer_role_default_code_touching" })
      .mockResolvedValueOnce({ codeTouching: true, reason: "workspace_diff_present" });

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "not_code",
        notCodeReason: "This issue claims no code, but a workspace diff exists.",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("code_evidence_contradicts_not_code");
  });

  it("rejects not_code evidence with a short justification", async () => {
    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: null,
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: {
        kind: "not_code",
        notCodeReason: "too short",
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("not_code_reason_too_short");
  });

  it("rejects agent self-application of not-code-gate through the closure check", async () => {
    // STRIDE: Tampering - T6 label self-application.
    mockDetectCodeTouching.mockResolvedValue({
      codeTouching: true,
      reason: "label_code_touching",
    });

    const outcome = await validateReleaseEvidenceForIssueClose(dbReturning([]), {
      issue: issue(),
      actorAgentId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      config: config(),
      patchReleaseEvidence: null,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errorCode).toBe("release_evidence_required");
  });
});
