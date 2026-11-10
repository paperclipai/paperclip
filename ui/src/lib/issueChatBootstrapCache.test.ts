import { QueryClient } from "@tanstack/react-query";
import type { ActivityEvent, Issue, IssueComment } from "@paperclipai/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { RunForIssue } from "@/api/activity";
import { hasFreshIssueChatFirstFrame, seedIssueChatBootstrap, type IssueChatBootstrapEntry } from "./issueChatBootstrapCache";
import {
  issueCommentInputFactsQueryKey,
  recentIssueActivityQueryKey,
  recentIssueRunWindowQueryKey,
} from "./issue-chat-history-queries";
import { getCachedIssueDetail } from "./issueDetailCache";
import { queryKeys } from "./queryKeys";

const ID = "11111111-1111-4111-8111-111111111111";
const IDENTIFIER = "PAP-7";
const REQUESTED_AT = 1_000_000;

function issue(overrides: Partial<Issue> = {}) {
  return {
    id: ID, identifier: IDENTIFIER, companyId: "company-1", title: "Recent task", status: "todo", priority: "medium",
    workMode: "standard", projectId: null, parentId: null, description: null, assigneeAgentId: null,
    assigneeUserId: null, executionRunId: null, issueNumber: 7, requestDepth: 0,
    createdAt: new Date(0), updatedAt: new Date(0),
    ...overrides,
  } as Issue;
}

const comment = (id: string) => ({ id, issueId: ID, body: id, createdAt: new Date(0) }) as unknown as IssueComment;
const event = (id: string) => ({ id, action: "comment.created" }) as unknown as ActivityEvent;
const run = (runId: string) => ({ runId, status: "succeeded" }) as unknown as RunForIssue;

function item(overrides: Partial<IssueChatBootstrapEntry> = {}): IssueChatBootstrapEntry {
  return {
    ref: ID,
    issue: issue(),
    recentComments: { comments: [comment("c2"), comment("c1")], hasMore: true, oldestCommentId: "c1", latestCommentId: "c2" },
    commentInputFacts: [event("fact-1")],
    recentActivity: [event("a1"), event("a2"), event("a1")],
    recentRuns: [run("r2"), run("r1")],
    interactions: [],
    attachments: [],
    liveRuns: [],
    activeRun: null,
    ...overrides,
  };
}

const coreKey = (ref: string) => [...queryKeys.issues.detail(ref), "core"];
const commentsKey = (ref: string) => [...queryKeys.issues.comments(ref), "recent"];

let queryClient: QueryClient;
function client() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return queryClient;
}
afterEach(() => queryClient?.clear());

describe("seedIssueChatBootstrap", () => {
  it("fills every first-frame key in the shape of its single endpoint, under id and identifier", () => {
    const qc = client();
    const entry = item();
    expect(seedIssueChatBootstrap(qc, entry, { companyId: "company-1", requestedAt: REQUESTED_AT })).toBe(true);
    for (const ref of [ID, IDENTIFIER]) {
      expect(qc.getQueryData(coreKey(ref))).toBe(entry.issue);
      expect(qc.getQueryData(commentsKey(ref))).toBe(entry.recentComments);
      // The activity key holds the de-duplicated recent answer.
      expect(qc.getQueryData(recentIssueActivityQueryKey(ref))).toEqual([event("a1"), event("a2")]);
      // A cold open shows the latest run and discloses the earlier one.
      expect(qc.getQueryData(recentIssueRunWindowQueryKey(ref))).toEqual({ runs: [run("r2")], hasEarlierRuns: true });
      expect(qc.getQueryData(queryKeys.issues.interactions(ref))).toEqual([]);
      expect(qc.getQueryData(queryKeys.issues.attachments(ref))).toEqual([]);
      expect(qc.getQueryData(queryKeys.issues.liveRuns(ref))).toEqual([]);
      // The input facts are stored as the single batch the chat requests: the sorted saved comment ids.
      const factsKey = issueCommentInputFactsQueryKey(ref);
      expect(qc.getQueryData([...factsKey, "batch-ids"])).toEqual([["c1", "c2"]]);
      expect(qc.getQueryData([...factsKey, "batch", ["c1", "c2"]])).toEqual([event("fact-1")]);
      expect(qc.getQueryState(coreKey(ref))?.dataUpdatedAt).toBe(REQUESTED_AT);
    }
    // Core cannot stand in for the full detail read and its related data.
    expect(qc.getQueryData(queryKeys.issues.detail(ID))).toBeUndefined();
    expect(getCachedIssueDetail(qc, IDENTIFIER)).toBeUndefined();
  });

  it("stores an explicit null active run but leaves missing fields unset", () => {
    const qc = client();
    const entry = item({ activeRun: null });
    delete (entry as Partial<IssueChatBootstrapEntry>).liveRuns;
    delete (entry as Partial<IssueChatBootstrapEntry>).commentInputFacts;
    seedIssueChatBootstrap(qc, entry, { companyId: "company-1", requestedAt: REQUESTED_AT });
    expect(qc.getQueryState(queryKeys.issues.activeRun(ID))?.data).toBeNull();
    expect(qc.getQueryState(queryKeys.issues.activeRun(ID))?.status).toBe("success");
    expect(qc.getQueryState(queryKeys.issues.liveRuns(ID))).toBeUndefined();
    expect(qc.getQueryState([...issueCommentInputFactsQueryKey(ID), "batch-ids"])).toBeUndefined();
  });

  it("ignores an item for another company", () => {
    const qc = client();
    expect(seedIssueChatBootstrap(qc, item({ issue: issue({ companyId: "company-2" }) }), { companyId: "company-1", requestedAt: REQUESTED_AT })).toBe(false);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it("never replaces cached data that is as new or newer, or a key with a read in flight or pending invalidation", () => {
    const qc = client();
    const newer = issue({ title: "Newer title" });
    qc.setQueryData(coreKey(ID), newer, { updatedAt: REQUESTED_AT + 1 });
    qc.setQueryData(queryKeys.issues.interactions(ID), ["stale"], { updatedAt: REQUESTED_AT - 1 });
    qc.invalidateQueries({ queryKey: queryKeys.issues.interactions(ID) });
    qc.setQueryData(queryKeys.issues.attachments(ID), ["older"], { updatedAt: REQUESTED_AT - 1 });
    seedIssueChatBootstrap(qc, item(), { companyId: "company-1", requestedAt: REQUESTED_AT });
    expect(qc.getQueryData(coreKey(ID))).toBe(newer);
    expect(qc.getQueryData(queryKeys.issues.interactions(ID))).toEqual(["stale"]);
    // A whole-answer endpoint with older, valid data takes the newer answer.
    expect(qc.getQueryData(queryKeys.issues.attachments(ID))).toEqual([]);
  });

  it("only fills empty keys whose page merges observed history", () => {
    const qc = client();
    const observed = { comments: [comment("c3")], hasMore: false, oldestCommentId: "c3", latestCommentId: "c3" };
    qc.setQueryData(commentsKey(ID), observed, { updatedAt: REQUESTED_AT - 10_000 });
    qc.setQueryData(recentIssueActivityQueryKey(ID), [event("seen")], { updatedAt: REQUESTED_AT - 10_000 });
    qc.setQueryData(recentIssueRunWindowQueryKey(ID), { runs: [run("r9")], hasEarlierRuns: false }, { updatedAt: REQUESTED_AT - 10_000 });
    qc.setQueryData([...issueCommentInputFactsQueryKey(ID), "batch-ids"], [["c3"]]);
    seedIssueChatBootstrap(qc, item(), { companyId: "company-1", requestedAt: REQUESTED_AT });
    expect(qc.getQueryData(commentsKey(ID))).toBe(observed);
    expect(qc.getQueryData(recentIssueActivityQueryKey(ID))).toEqual([event("seen")]);
    expect(qc.getQueryData(recentIssueRunWindowQueryKey(ID))).toEqual({ runs: [run("r9")], hasEarlierRuns: false });
    expect(qc.getQueryData([...issueCommentInputFactsQueryKey(ID), "batch-ids"])).toEqual([["c3"]]);
  });
});

describe("hasFreshIssueChatFirstFrame", () => {
  it("is true only while every first-frame read is cached, valid and fresh", () => {
    const qc = client();
    expect(hasFreshIssueChatFirstFrame(qc, [ID], REQUESTED_AT)).toBe(false);
    seedIssueChatBootstrap(qc, item(), { companyId: "company-1", requestedAt: REQUESTED_AT });
    expect(hasFreshIssueChatFirstFrame(qc, [IDENTIFIER], REQUESTED_AT + 29_999)).toBe(true);
    expect(hasFreshIssueChatFirstFrame(qc, [IDENTIFIER], REQUESTED_AT + 30_000)).toBe(false);
    qc.invalidateQueries({ queryKey: commentsKey(IDENTIFIER) });
    expect(hasFreshIssueChatFirstFrame(qc, [IDENTIFIER], REQUESTED_AT + 1)).toBe(false);
  });

  it("is false after a light warm that cached only the core issue and recent comments", () => {
    const qc = client();
    const entry = item();
    qc.setQueryData(coreKey(IDENTIFIER), entry.issue, { updatedAt: REQUESTED_AT });
    qc.setQueryData(commentsKey(IDENTIFIER), entry.recentComments, { updatedAt: REQUESTED_AT });
    expect(hasFreshIssueChatFirstFrame(qc, [ID, IDENTIFIER], REQUESTED_AT + 1)).toBe(false);
  });

  it("is false while a recent comment's input facts are missing", () => {
    const qc = client();
    seedIssueChatBootstrap(qc, item(), { companyId: "company-1", requestedAt: REQUESTED_AT });
    const factsKey = issueCommentInputFactsQueryKey(IDENTIFIER);
    qc.removeQueries({ queryKey: [...factsKey, "batch", ["c1", "c2"]], exact: true });
    expect(hasFreshIssueChatFirstFrame(qc, [IDENTIFIER], REQUESTED_AT + 1)).toBe(false);
  });
});
