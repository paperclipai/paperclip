import { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getIssueEntityMap,
  getIssueFromEntityStore,
  installIssueEntityStoreSubscriber,
  seedIssueEntityStore,
} from "./issueEntityStore";
import { queryKeys } from "./queryKeys";

// Use unique company IDs per describe block to avoid cross-test contamination
// in the module-level entity store.
const SEED_COMPANY = "company-seed-tests";
const LOOKUP_COMPANY = "company-lookup-tests";
const SUBSCRIBER_COMPANY = "company-subscriber-tests";

function createIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-05-08T00:00:00.000Z");
  return {
    id: "issue-1",
    identifier: "ALL-1",
    companyId: SEED_COMPANY,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
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
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    workMode: "standard",
    ...overrides,
  };
}

describe("seedIssueEntityStore", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("stores issues keyed by id", () => {
    const issue = createIssue();
    seedIssueEntityStore(queryClient, SEED_COMPANY, [issue]);

    const map = getIssueEntityMap(queryClient, SEED_COMPANY);
    expect(map).toBeDefined();
    expect(map!["issue-1"]).toEqual(issue);
  });

  it("merges multiple batches without dropping earlier entries", () => {
    const a = createIssue({ id: "seed-a", identifier: "ALL-10" });
    const b = createIssue({ id: "seed-b", identifier: "ALL-11" });

    seedIssueEntityStore(queryClient, SEED_COMPANY, [a]);
    seedIssueEntityStore(queryClient, SEED_COMPANY, [b]);

    const map = getIssueEntityMap(queryClient, SEED_COMPANY);
    expect(map!["seed-a"]).toMatchObject({ id: "seed-a" });
    expect(map!["seed-b"]).toMatchObject({ id: "seed-b" });
  });

  it("replaces an entry when incoming updatedAt is newer", () => {
    const old = createIssue({ id: "seed-replace", title: "Old title", updatedAt: new Date("2026-01-01") });
    const updated = createIssue({ id: "seed-replace", title: "New title", updatedAt: new Date("2026-06-01") });

    seedIssueEntityStore(queryClient, SEED_COMPANY, [old]);
    seedIssueEntityStore(queryClient, SEED_COMPANY, [updated]);

    expect(getIssueEntityMap(queryClient, SEED_COMPANY)!["seed-replace"]?.title).toBe("New title");
  });

  it("keeps existing entry when incoming updatedAt is older", () => {
    const current = createIssue({ id: "seed-keep", title: "Current title", updatedAt: new Date("2026-06-01") });
    const stale = createIssue({ id: "seed-keep", title: "Stale title", updatedAt: new Date("2026-01-01") });

    seedIssueEntityStore(queryClient, SEED_COMPANY, [current]);
    seedIssueEntityStore(queryClient, SEED_COMPANY, [stale]);

    expect(getIssueEntityMap(queryClient, SEED_COMPANY)!["seed-keep"]?.title).toBe("Current title");
  });

  it("does not let a partial summary overwrite a full issue", () => {
    const full = createIssue({ id: "seed-guard", title: "Full title", description: "Some description", companyId: SEED_COMPANY, updatedAt: new Date("2026-01-01") });
    // Simulate an IssueSummary: only 7 fields, no companyId
    const summary = { id: "seed-guard", title: "Summary title", status: "todo", priority: "medium", assigneeAgentId: null, identifier: "ALL-1", updatedAt: new Date("2026-06-01") } as unknown as Issue;

    seedIssueEntityStore(queryClient, SEED_COMPANY, [full]);
    seedIssueEntityStore(queryClient, SEED_COMPANY, [summary]);

    const stored = getIssueEntityMap(queryClient, SEED_COMPANY)!["seed-guard"];
    // Full-issue fields must survive; summary fields may be updated
    expect(stored?.description).toBe("Some description");
    expect(stored?.title).toBe("Summary title"); // summary field is newer, so merged in
  });

  it("is a no-op for empty arrays", () => {
    // Use a unique company that has never been seeded
    const emptyCompany = "company-empty-noop";
    seedIssueEntityStore(queryClient, emptyCompany, []);
    expect(getIssueEntityMap(queryClient, emptyCompany)).toBeUndefined();
  });

  it("scopes entity maps per companyId", () => {
    const issue = createIssue({ id: "seed-scope", companyId: SEED_COMPANY });
    seedIssueEntityStore(queryClient, SEED_COMPANY, [issue]);

    expect(getIssueEntityMap(queryClient, "company-99-never-used")).toBeUndefined();
    expect(getIssueEntityMap(queryClient, SEED_COMPANY)).toBeDefined();
  });
});

describe("getIssueFromEntityStore", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("returns the issue by id", () => {
    const issue = createIssue({ id: "lookup-find", companyId: LOOKUP_COMPANY });
    seedIssueEntityStore(queryClient, LOOKUP_COMPANY, [issue]);
    expect(getIssueFromEntityStore(queryClient, LOOKUP_COMPANY, "lookup-find")).toMatchObject({ id: "lookup-find" });
  });

  it("returns undefined for an unknown id", () => {
    expect(getIssueFromEntityStore(queryClient, LOOKUP_COMPANY, "never-exists-xyz")).toBeUndefined();
  });
});

describe("installIssueEntityStoreSubscriber", () => {
  let queryClient: QueryClient;
  // Use unique IDs per test to avoid cross-test contamination
  let testCompany: string;
  let n = 0;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    testCompany = `${SUBSCRIBER_COMPANY}-${++n}`;
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("seeds entity map from a successful Issue[] list query result", () => {
    installIssueEntityStoreSubscriber(queryClient);

    const issue = createIssue({ id: `sub-issue-${n}`, companyId: testCompany });
    queryClient.setQueryData(queryKeys.issues.list(testCompany), [issue]);

    expect(getIssueFromEntityStore(queryClient, testCompany, `sub-issue-${n}`)).toMatchObject({ id: `sub-issue-${n}` });
  });

  it("seeds entity map from InfiniteData<Issue[]>", () => {
    installIssueEntityStoreSubscriber(queryClient);

    const issue = createIssue({ id: `sub-inf-${n}`, companyId: testCompany });
    queryClient.setQueryData(
      [...queryKeys.issues.list(testCompany), "infinite"],
      { pages: [[issue]], pageParams: [0] },
    );

    expect(getIssueFromEntityStore(queryClient, testCompany, `sub-inf-${n}`)).toMatchObject({ id: `sub-inf-${n}` });
  });

  it("does not seed from detail key", () => {
    installIssueEntityStoreSubscriber(queryClient);

    const issue = createIssue({ id: `sub-detail-${n}`, companyId: testCompany });
    queryClient.setQueryData(queryKeys.issues.detail(`sub-detail-${n}`), issue);

    expect(getIssueFromEntityStore(queryClient, testCompany, `sub-detail-${n}`)).toBeUndefined();
  });

  it("returns an unsubscribe function that stops seeding", () => {
    const unsubscribe = installIssueEntityStoreSubscriber(queryClient);
    const issueId = `sub-unsub-${n}`;
    const issue = createIssue({ id: issueId, companyId: testCompany });

    unsubscribe();
    queryClient.setQueryData(queryKeys.issues.list(testCompany), [issue]);

    expect(getIssueFromEntityStore(queryClient, testCompany, issueId)).toBeUndefined();
  });
});
