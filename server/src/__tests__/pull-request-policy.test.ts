import { describe, expect, it } from "vitest";
import {
  parseProjectExecutionWorkspacePolicy,
  parsePullRequestPolicy,
  pullRequestPolicyBlocksArchive,
  pullRequestPolicyRequestsAutoOpen,
} from "../services/execution-workspace-policy.ts";

describe("parsePullRequestPolicy", () => {
  it("returns null for empty or non-object input", () => {
    expect(parsePullRequestPolicy(null)).toBeNull();
    expect(parsePullRequestPolicy(undefined)).toBeNull();
    expect(parsePullRequestPolicy({})).toBeNull();
    expect(parsePullRequestPolicy("string")).toBeNull();
  });

  it("keeps only the declared fields and drops unknown types", () => {
    const parsed = parsePullRequestPolicy({
      autoOpen: true,
      mergeStrategy: "squash",
      draft: "truthy-but-not-bool",
      archiveTimeoutMs: 0, // not positive, dropped
      targetBranch: "",    // empty string, dropped
    });
    expect(parsed).toEqual({ autoOpen: true, mergeStrategy: "squash" });
  });

  it("normalizes autoMerge=true to autoOpen=true", () => {
    const parsed = parsePullRequestPolicy({ autoMerge: true });
    expect(parsed).toMatchObject({ autoMerge: true, autoOpen: true });
  });

  it("preserves unknown top-level keys on policy.extensions", () => {
    const parsed = parsePullRequestPolicy({
      autoOpen: true,
      gitlabApprovalRule: "main-requires-two",
      nestedExt: { ticket: "FOO-1" },
    });
    expect(parsed?.extensions).toEqual({
      gitlabApprovalRule: "main-requires-two",
      nestedExt: { ticket: "FOO-1" },
    });
  });

  it("merges an existing extensions bag with additional unknown keys", () => {
    const parsed = parsePullRequestPolicy({
      autoOpen: true,
      extensions: { a: 1 },
      otherUnknown: "x",
    });
    expect(parsed?.extensions).toEqual({ a: 1, otherUnknown: "x" });
  });

  it("round-trips through parseProjectExecutionWorkspacePolicy", () => {
    const raw = {
      enabled: true,
      pullRequestPolicy: {
        autoOpen: true,
        requireResultBeforeArchive: true,
        archiveTimeoutMs: 15 * 60 * 1000,
        unknownKey: "value",
      },
    };
    const parsed = parseProjectExecutionWorkspacePolicy(raw);
    expect(parsed?.pullRequestPolicy).toEqual({
      autoOpen: true,
      requireResultBeforeArchive: true,
      archiveTimeoutMs: 15 * 60 * 1000,
      extensions: { unknownKey: "value" },
    });
  });

  it("drops archiveTimeoutMs when not a positive integer", () => {
    expect(parsePullRequestPolicy({ archiveTimeoutMs: -1 })).toBeNull();
    expect(parsePullRequestPolicy({ archiveTimeoutMs: 1.5 })).toBeNull();
    expect(parsePullRequestPolicy({ archiveTimeoutMs: "900" })).toBeNull();
  });

  it("policyRequestsAutoOpen accepts autoOpen or requireResultBeforeArchive", () => {
    expect(pullRequestPolicyRequestsAutoOpen(null)).toBe(false);
    expect(pullRequestPolicyRequestsAutoOpen({})).toBe(false);
    expect(pullRequestPolicyRequestsAutoOpen({ autoOpen: true })).toBe(true);
    expect(pullRequestPolicyRequestsAutoOpen({ requireResultBeforeArchive: true })).toBe(true);
  });

  it("policyBlocksArchive requires requireResultBeforeArchive", () => {
    expect(pullRequestPolicyBlocksArchive({ autoOpen: true })).toBe(false);
    expect(pullRequestPolicyBlocksArchive({ requireResultBeforeArchive: true })).toBe(true);
  });
});
