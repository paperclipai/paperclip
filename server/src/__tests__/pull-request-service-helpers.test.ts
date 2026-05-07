import { describe, expect, it } from "vitest";
import type { ExecutionWorkspacePullRequestRecord, PullRequestPolicy } from "@paperclipai/shared";
import {
  applyPullRequestResult,
  buildPullRequestRequestRecord,
  mergePullRequestRecordIntoMetadata,
  readPullRequestRecord,
} from "../services/execution-workspaces.ts";

function makeBasePolicy(overrides: Partial<PullRequestPolicy> = {}): PullRequestPolicy {
  return { autoOpen: true, ...overrides };
}

describe("buildPullRequestRequestRecord", () => {
  it("returns an existing record untouched (idempotent)", () => {
    const existing: ExecutionWorkspacePullRequestRecord = {
      status: "requested",
      mode: "blocking",
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { requireResultBeforeArchive: true },
    };
    const built = buildPullRequestRequestRecord(makeBasePolicy(), existing);
    expect(built.record).toBe(existing);
    expect(built.mode).toBe("blocking");
  });

  it("defaults to fire_and_forget when requireResultBeforeArchive is not set", () => {
    const built = buildPullRequestRequestRecord(makeBasePolicy(), null);
    expect(built.record.status).toBe("requested");
    expect(built.mode).toBe("fire_and_forget");
    expect(built.record.mode).toBe("fire_and_forget");
  });

  it("stamps blocking when requireResultBeforeArchive=true", () => {
    const built = buildPullRequestRequestRecord(
      makeBasePolicy({ requireResultBeforeArchive: true }),
      null,
    );
    expect(built.mode).toBe("blocking");
    expect(built.record.mode).toBe("blocking");
  });

  it("snapshots the policy onto the record", () => {
    const policy = makeBasePolicy({ draft: true, titleTemplate: "feat: {{ branchName }}" });
    const built = buildPullRequestRequestRecord(policy, null);
    expect(built.record.policy).toEqual(policy);
  });
});

describe("applyPullRequestResult", () => {
  function makeRecord(
    overrides: Partial<ExecutionWorkspacePullRequestRecord> = {},
  ): ExecutionWorkspacePullRequestRecord {
    return {
      status: "requested",
      mode: "fire_and_forget",
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { autoOpen: true },
      ...overrides,
    };
  }

  it("fire_and_forget + opened leaves workspace status unchanged", () => {
    const result = applyPullRequestResult(makeRecord(), "archived", { status: "opened", url: "u" });
    expect(result.workspaceStatus).toBe("archived");
    expect(result.record.status).toBe("opened");
    expect(result.record.url).toBe("u");
  });

  it("fire_and_forget + merged does not re-archive (already archived)", () => {
    const result = applyPullRequestResult(makeRecord(), "archived", {
      status: "merged",
      sha: "abc123",
    });
    expect(result.workspaceStatus).toBe("archived");
    expect(result.record.status).toBe("merged");
    expect(result.record.sha).toBe("abc123");
    expect(result.record.mergedAt).not.toBeNull();
  });

  it("fire_and_forget + failed stamps error and leaves status", () => {
    const result = applyPullRequestResult(makeRecord(), "archived", {
      status: "failed",
      error: "token expired",
    });
    expect(result.workspaceStatus).toBe("archived");
    expect(result.record.status).toBe("failed");
    expect(result.record.error).toBe("token expired");
  });

  it("blocking + merged transitions in_review -> archived", () => {
    const result = applyPullRequestResult(
      makeRecord({ mode: "blocking" }),
      "in_review",
      { status: "merged", sha: "def" },
    );
    expect(result.workspaceStatus).toBe("archived");
  });

  it("blocking + skipped transitions in_review -> archived", () => {
    const result = applyPullRequestResult(
      makeRecord({ mode: "blocking" }),
      "in_review",
      { status: "skipped" },
    );
    expect(result.workspaceStatus).toBe("archived");
  });

  it("blocking + opened stays in_review", () => {
    const result = applyPullRequestResult(
      makeRecord({ mode: "blocking" }),
      "in_review",
      { status: "opened" },
    );
    expect(result.workspaceStatus).toBe("in_review");
  });

  it("blocking + failed transitions in_review -> cleanup_failed", () => {
    const result = applyPullRequestResult(
      makeRecord({ mode: "blocking" }),
      "in_review",
      { status: "failed", error: "rebase failed" },
    );
    expect(result.workspaceStatus).toBe("cleanup_failed");
    expect(result.record.error).toBe("rebase failed");
  });
});

describe("readPullRequestRecord / mergePullRequestRecordIntoMetadata", () => {
  it("ignores metadata without a pullRequest key", () => {
    expect(readPullRequestRecord({})).toBeNull();
    expect(readPullRequestRecord(null)).toBeNull();
    expect(readPullRequestRecord({ other: 1 })).toBeNull();
  });

  it("rejects records with unknown status or mode", () => {
    expect(
      readPullRequestRecord({ pullRequest: { status: "weird", mode: "blocking" } }),
    ).toBeNull();
    expect(
      readPullRequestRecord({ pullRequest: { status: "requested", mode: "weird" } }),
    ).toBeNull();
  });

  it("round-trips a record through merge/read", () => {
    const record: ExecutionWorkspacePullRequestRecord = {
      status: "opened",
      mode: "blocking",
      requestedAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
      url: "https://git.example.com/pr/1",
      number: 1,
      sha: null,
      mergedAt: null,
      error: null,
    };
    const merged = mergePullRequestRecordIntoMetadata({ other: 1 }, record);
    expect(merged).toMatchObject({ other: 1 });
    expect(readPullRequestRecord(merged)).toMatchObject({
      status: "opened",
      mode: "blocking",
      url: "https://git.example.com/pr/1",
      number: 1,
    });
  });

  it("merging null clears the record", () => {
    const merged = mergePullRequestRecordIntoMetadata(
      {
        pullRequest: { status: "requested", mode: "fire_and_forget" },
        other: 2,
      },
      null,
    );
    expect(merged).toEqual({ other: 2 });
  });
});
