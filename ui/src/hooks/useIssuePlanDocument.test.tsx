// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { fetchIssueDetail, seedIssueDetailCache } from "@/lib/issueDetailCache";
import { queryKeys } from "@/lib/queryKeys";
import { useIssuePlanDocument } from "./useIssuePlanDocument";

vi.mock("@/api/issues", () => ({ issuesApi: { get: vi.fn(), getDocument: vi.fn() } }));
const issue = {
  id: "task-id", identifier: "TASK-1", companyId: "company-id", title: "Saved task",
  status: "todo", workMode: "standard", priority: "medium", projectId: null,
  parentId: null, description: null, assigneeAgentId: null, assigneeUserId: null,
  executionRunId: null, issueNumber: 1, requestDepth: 0, createdAt: new Date(), updatedAt: new Date(),
} as Issue;
const plan = { id: "plan-id", issueId: issue.id, key: "plan", body: "Saved plan", latestRevisionId: "revision-1" } as IssueDocument;
const planKey = [...queryKeys.issues.documents(issue.id), "plan"];
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function View({ issueId = issue.id }: { issueId?: string }) {
  const result = useIssuePlanDocument(issueId);
  return <div data-loading={result.isLoading} data-error={result.isError}>{result.data?.body ?? "No plan"}</div>;
}
async function mount(issueId = issue.id) {
  await act(async () => root.render(<QueryClientProvider client={client}><View issueId={issueId} /></QueryClientProvider>));
}
async function fetchDetail(value: IssueDocument | null | undefined) {
  vi.mocked(issuesApi.get).mockResolvedValue({ ...issue, planDocument: value });
  await fetchIssueDetail(client, issue.identifier!);
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.mocked(issuesApi.get).mockReset();
  vi.mocked(issuesApi.getDocument).mockReset().mockResolvedValue(plan);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});
it.each([null, plan])("uses the fetched task's plan without another loading round trip: %s", async (value) => {
  await fetchDetail(value);
  await mount();
  expect(host.firstElementChild?.getAttribute("data-loading")).toBe("false");
  expect(host.textContent).toBe(value?.body ?? "No plan");
  expect(issuesApi.getDocument).not.toHaveBeenCalled();
});
it.each([null, plan])("uses core plan data while a separate plan request remains pending: %s", async (value) => {
  let release!: () => void;
  vi.mocked(issuesApi.getDocument).mockReturnValue(new Promise<IssueDocument>((resolve, reject) => {
    release = () => value ? resolve(value) : reject(new ApiError("Not found", 404, null));
  }));
  await mount();
  expect(host.firstElementChild?.getAttribute("data-loading")).toBe("true");
  try {
    await act(async () => { await fetchDetail(value); });
    await vi.waitFor(() => {
      expect(host.firstElementChild?.getAttribute("data-loading")).toBe("false");
      expect(host.textContent).toBe(value?.body ?? "No plan");
    });
  } finally {
    await act(async () => { release(); });
  }
});
it.each([null, plan])("recovers an errored plan query from the core projection: %s", async (value) => {
  vi.mocked(issuesApi.getDocument).mockRejectedValue(new Error("Plan request unavailable"));
  await mount();
  await vi.waitFor(() => expect(host.firstElementChild?.getAttribute("data-error")).toBe("true"));
  await act(async () => { await fetchDetail(value); });
  await vi.waitFor(() => {
    expect(host.firstElementChild?.getAttribute("data-error")).toBe("false");
    expect(host.textContent).toBe(value?.body ?? "No plan");
  });
});
it("revalidates document events after seeding an absent plan, including deletion", async () => {
  await fetchDetail(null);
  await mount();
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) }); });
  expect(issuesApi.getDocument).toHaveBeenCalledExactlyOnceWith(issue.id, "plan");
  expect(client.getQueryData(planKey)).toEqual(plan);
  vi.mocked(issuesApi.getDocument).mockRejectedValue(new ApiError("Not found", 404, null));
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) }); });
  expect(client.getQueryData(planKey)).toBeNull();
  expect(host.firstElementChild?.getAttribute("data-error")).toBe("false");
});
it.each(["stale", "invalidated"])("fetches a current plan when the seeded query is %s", async (state) => {
  await fetchDetail(null);
  if (state === "stale") client.setQueryData(planKey, null, { updatedAt: Date.now() - 60_000 });
  else await client.invalidateQueries({ queryKey: queryKeys.issues.documents(issue.id) });
  await mount();
  expect(issuesApi.getDocument).toHaveBeenCalledExactlyOnceWith(issue.id, "plan");
  expect(client.getQueryData(planKey)).toEqual(plan);
});
it("fetches normally for list-only snapshots and responses without a plan projection", async () => {
  client.setQueryData(queryKeys.issues.detail(issue.id), issue);
  await fetchDetail(undefined);
  vi.mocked(issuesApi.getDocument).mockReturnValue(new Promise(() => {}));
  await mount();
  expect(issuesApi.getDocument).toHaveBeenCalledExactlyOnceWith(issue.id, "plan");
  expect(host.firstElementChild?.getAttribute("data-loading")).toBe("true");
});
it.each([null, { ...plan, body: "Newer revision", latestRevisionId: "revision-2" }])("does not overwrite a separately fetched plan when task detail finishes later: %s", async (newerPlan) => {
  client.setQueryData(planKey, newerPlan);
  await fetchDetail(plan);
  await mount();
  expect(client.getQueryData(planKey)).toEqual(newerPlan);
  expect(host.textContent).toBe(newerPlan?.body ?? "No plan");
});
it("does not mistake a refreshed list snapshot for a fresh plan after query eviction", async () => {
  await fetchDetail(null);
  client.removeQueries({ queryKey: planKey, exact: true });
  seedIssueDetailCache(client, issue);
  await mount();
  expect(issuesApi.getDocument).toHaveBeenCalledExactlyOnceWith(issue.id, "plan");
  expect(client.getQueryData(planKey)).toEqual(plan);
});
it("does not seed another task's plan or fetch draft conversations", async () => {
  await fetchDetail(plan);
  await mount("different-task");
  expect(issuesApi.getDocument).toHaveBeenCalledExactlyOnceWith("different-task", "plan");
  vi.mocked(issuesApi.getDocument).mockClear();
  await mount("chat:draft");
  expect(issuesApi.getDocument).not.toHaveBeenCalled();
});
