// Regression tests for each of the five review findings raised
// against the initial PR. Each test pins one contract so a future
// refactor cannot silently undo the fix.

import { describe, expect, it } from "vitest";
import type { ExecutionWorkspacePullRequestRecord } from "@paperclipai/shared";
import {
  applyPullRequestResult,
} from "../services/execution-workspaces.ts";
import { projectExecutionWorkspacePolicySchema } from "../../../packages/shared/src/validators/project.ts";

describe("review finding #3 — skipped/failed results preserve input.error", () => {
  function requestedRecord(overrides: Partial<ExecutionWorkspacePullRequestRecord> = {}): ExecutionWorkspacePullRequestRecord {
    return {
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
      ...overrides,
    };
  }

  it("timeout's synthetic skipped carries error='archive_timeout_reached'", () => {
    const result = applyPullRequestResult(requestedRecord(), "in_review", {
      status: "skipped",
      error: "archive_timeout_reached",
    });
    expect(result.record.error).toBe("archive_timeout_reached");
  });

  it("operator Mark-skipped note is persisted on record.error", () => {
    const result = applyPullRequestResult(requestedRecord(), "in_review", {
      status: "skipped",
      error: "operator chose not to open a PR because the branch is empty",
    });
    expect(result.record.error).toBe("operator chose not to open a PR because the branch is empty");
  });

  it("failed still requires and persists error (unchanged)", () => {
    const result = applyPullRequestResult(requestedRecord(), "in_review", {
      status: "failed",
      error: "push rejected",
    });
    expect(result.record.error).toBe("push rejected");
  });

  it("skipped without input.error falls back to existing.error", () => {
    const result = applyPullRequestResult(
      requestedRecord({ error: "prior_error_kept" }),
      "in_review",
      { status: "skipped" },
    );
    expect(result.record.error).toBe("prior_error_kept");
  });
});

describe("review finding #5 — projectExecutionWorkspacePolicySchema validates pullRequestPolicy", () => {
  it("rejects unknown top-level keys on pullRequestPolicy (strict schema)", () => {
    const parsed = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      pullRequestPolicy: {
        autoOpen: true,
        nonsense: "rejected",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an archiveTimeoutMs that is not a positive integer", () => {
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({
        enabled: true,
        pullRequestPolicy: { archiveTimeoutMs: -1 },
      }).success,
    ).toBe(false);
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({
        enabled: true,
        pullRequestPolicy: { archiveTimeoutMs: 0 },
      }).success,
    ).toBe(false);
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({
        enabled: true,
        pullRequestPolicy: { archiveTimeoutMs: 3.5 },
      }).success,
    ).toBe(false);
  });

  it("accepts a well-formed strict policy", () => {
    const parsed = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      pullRequestPolicy: {
        autoOpen: true,
        autoMerge: true,
        mergeStrategy: "squash",
        targetBranch: "main",
        draft: false,
        requireResultBeforeArchive: true,
        archiveTimeoutMs: 60_000,
        extensions: { vendorExt: "value" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("preserves extensions as an unknown-record bag at the API boundary", () => {
    const parsed = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      pullRequestPolicy: {
        autoOpen: true,
        extensions: { arbitraryKey: { nested: 1 } },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pullRequestPolicy?.extensions).toEqual({ arbitraryKey: { nested: 1 } });
    }
  });
});
