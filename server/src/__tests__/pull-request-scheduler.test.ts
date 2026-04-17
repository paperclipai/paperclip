import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionWorkspacePullRequestRecord } from "@paperclipai/shared";
import {
  __getScheduledArchiveTimeoutForTests,
  __resetArchiveTimeoutSchedulerForTests,
  cancelArchiveTimeout,
  onPullRequestRequested,
} from "../services/execution-workspace-timeout.ts";

describe("archive timeout scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetArchiveTimeoutSchedulerForTests();
  });

  afterEach(() => {
    __resetArchiveTimeoutSchedulerForTests();
    vi.useRealTimers();
  });

  it("does not schedule anything for fire-and-forget records", () => {
    const record: ExecutionWorkspacePullRequestRecord = {
      status: "requested",
      mode: "fire_and_forget",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { autoOpen: true, archiveTimeoutMs: 30_000 },
    };
    onPullRequestRequested({
      db: {} as any,
      companyId: "c",
      workspaceId: "w",
      record,
    });
    expect(__getScheduledArchiveTimeoutForTests("w")).toBeNull();
  });

  it("does not schedule when archiveTimeoutMs is missing", () => {
    const record: ExecutionWorkspacePullRequestRecord = {
      status: "requested",
      mode: "blocking",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { requireResultBeforeArchive: true },
    };
    onPullRequestRequested({
      db: {} as any,
      companyId: "c",
      workspaceId: "w",
      record,
    });
    expect(__getScheduledArchiveTimeoutForTests("w")).toBeNull();
  });

  it("schedules a deadline derived from requestedAt + archiveTimeoutMs for blocking records", () => {
    const requestedAt = new Date();
    const record: ExecutionWorkspacePullRequestRecord = {
      status: "requested",
      mode: "blocking",
      requestedAt: requestedAt.toISOString(),
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { requireResultBeforeArchive: true, archiveTimeoutMs: 30_000 },
    };
    onPullRequestRequested({
      db: {} as any,
      companyId: "c",
      workspaceId: "w",
      record,
    });
    const scheduled = __getScheduledArchiveTimeoutForTests("w");
    expect(scheduled).not.toBeNull();
    expect(scheduled).toBe(requestedAt.getTime() + 30_000);
  });

  it("cancelArchiveTimeout removes a scheduled timer", () => {
    const record: ExecutionWorkspacePullRequestRecord = {
      status: "requested",
      mode: "blocking",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      url: null,
      number: null,
      sha: null,
      mergedAt: null,
      error: null,
      policy: { requireResultBeforeArchive: true, archiveTimeoutMs: 1_000 },
    };
    onPullRequestRequested({
      db: {} as any,
      companyId: "c",
      workspaceId: "w",
      record,
    });
    expect(__getScheduledArchiveTimeoutForTests("w")).not.toBeNull();
    cancelArchiveTimeout("w");
    expect(__getScheduledArchiveTimeoutForTests("w")).toBeNull();
  });
});
