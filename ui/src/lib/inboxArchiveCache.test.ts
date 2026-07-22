import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginLocalInboxArchive,
  boundLocalInboxArchive,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  filterLocalInboxArchivedIssues,
  getIssuePresenceInActiveInboxCaches,
  getLocalInboxArchiveIssueIds,
  removeIssueFromInboxCaches,
  restoreIssueToInboxCaches,
  snapshotInboxIssueCaches,
} from "./inboxArchiveCache";
import { queryKeys } from "./queryKeys";

function issue(id: string): Issue {
  return { id } as Issue;
}

describe("inboxArchiveCache", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const issueId of getLocalInboxArchiveIssueIds("company-1")) {
      clearLocalInboxArchive("company-1", issueId);
    }
  });

  it("restores only the failed archive during overlapping optimistic removals", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.issues.listMineByMe(companyId), "with-routine-executions"] as const;

    queryClient.setQueryData<Issue[]>(queryKey, [
      issue("issue-a"),
      issue("issue-b"),
      issue("issue-c"),
    ]);

    const archiveASnapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "issue-a");

    const archiveBSnapshot = snapshotInboxIssueCaches(queryClient, companyId);
    removeIssueFromInboxCaches(queryClient, companyId, "issue-b");

    restoreIssueToInboxCaches(queryClient, archiveASnapshot, "issue-a");

    expect(queryClient.getQueryData<Issue[]>(queryKey)?.map((cachedIssue) => cachedIssue.id)).toEqual([
      "issue-a",
      "issue-c",
    ]);

    restoreIssueToInboxCaches(queryClient, archiveBSnapshot, "issue-b");

    expect(queryClient.getQueryData<Issue[]>(queryKey)?.map((cachedIssue) => cachedIssue.id)).toEqual([
      "issue-a",
      "issue-b",
      "issue-c",
    ]);
  });

  it("filters locally archived issues until confirmed grace expires", () => {
    vi.useFakeTimers();
    const issues = [issue("issue-a"), issue("issue-b")];

    beginLocalInboxArchive("company-1", "issue-a");
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual([issue("issue-b")]);

    confirmLocalInboxArchive("company-1", "issue-a");
    vi.advanceTimersByTime(4_999);
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual([issue("issue-b")]);

    vi.advanceTimersByTime(1);
    expect(filterLocalInboxArchivedIssues("company-1", issues)).toEqual(issues);
  });

  it("does not expire an in-flight archive before post-settle bounding starts", () => {
    vi.useFakeTimers();
    beginLocalInboxArchive("company-1", "issue-a");

    vi.advanceTimersByTime(30_000);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(true);

    boundLocalInboxArchive("company-1", "issue-a");
    vi.advanceTimersByTime(29_999);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(getLocalInboxArchiveIssueIds("company-1").has("issue-a")).toBe(false);
  });

  it("distinguishes present, absent, and unavailable active inbox data", () => {
    const companyId = "company-1";
    const queryClient = new QueryClient();
    const queryKey = [...queryKeys.issues.listMineByMe(companyId), "with-routine-executions"] as const;

    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("unknown");

    queryClient.setQueryData<Issue[]>(queryKey, [issue("issue-a")]);
    const observer = new QueryObserver<Issue[]>(queryClient, {
      queryKey,
      queryFn: async () => [],
    });
    const unsubscribe = observer.subscribe(() => undefined);

    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("present");
    queryClient.setQueryData<Issue[]>(queryKey, [issue("issue-b")]);
    expect(getIssuePresenceInActiveInboxCaches(queryClient, companyId, "issue-a")).toBe("absent");

    unsubscribe();
  });
});
