// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { getIssueDetailQueryOptions } from "./issueDetailCache";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-04-13T20:00:00.000Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1442,
    identifier: "PAP-1442",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    scheduledFor: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function IssueDetailQueryHarness({
  issueRef,
  placeholderIssue,
}: {
  issueRef: string;
  placeholderIssue?: Pick<Issue, "id" | "identifier"> | null;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issueRef, { placeholderIssue }),
  });

  return <div>{query.data?.description ?? "EMPTY"}</div>;
}

async function flush() {
  // Multiple act cycles to allow React Query to process the async queryFn
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("getIssueDetailQueryOptions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("treats cached issue data as placeholder and still fetches full detail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const partialIssue = makeIssue({ description: null });
    const fullIssue = makeIssue({ description: "GitHub Security Advisory body" });

    queryClient.setQueryData(queryKeys.issues.detail("issue-1"), partialIssue);
    queryClient.setQueryData(queryKeys.issues.detail("PAP-1442"), partialIssue);
    vi.mocked(issuesApi.get).mockResolvedValue(fullIssue);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetailQueryHarness
            issueRef="PAP-1442"
            placeholderIssue={{ id: partialIssue.id, identifier: partialIssue.identifier }}
          />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(issuesApi.get).toHaveBeenCalledWith("PAP-1442");
    expect(container.textContent).toContain("GitHub Security Advisory body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });
});
