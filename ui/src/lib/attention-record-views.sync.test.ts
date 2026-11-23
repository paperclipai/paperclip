import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { attentionApi } from "../api/attention";
import { detachInflightGets } from "../api/client";
import { coordinatorAttentionQueryKey } from "./coordinator-attention";
import { invalidateInteractionRecordViews } from "./attention-record-views";
import { coordinatorTaskQuestion } from "../fixtures/coordinatorTaskQuestion";
import { queryKeys } from "./queryKeys";

afterEach(() => { detachInflightGets(); vi.unstubAllGlobals(); });

it("publishes an answer to both task references without changing another question", () => {
  const client = new QueryClient();
  const question = coordinatorTaskQuestion;
  const other = { ...question, id: "another-question" };
  const uuidKey = queryKeys.issues.interactions(question.issueId);
  const identifierKey = queryKeys.issues.interactions("BOB-1");
  const unrelatedKey = queryKeys.issues.interactions("unrelated-task");
  client.setQueryData(uuidKey, [question, other]);
  client.setQueryData(identifierKey, [question]);
  client.setQueryData(unrelatedKey, [other]);
  const answered = { ...question, status: "answered" as const };
  invalidateInteractionRecordViews(client, question.companyId, answered);
  expect(client.getQueryData(uuidKey)).toEqual([answered, other]);
  expect(client.getQueryData(identifierKey)).toEqual([answered]);
  expect(client.getQueryData(unrelatedKey)).toEqual([other]);
  client.clear();
});

it.each(["initial", "background"])("does not restore an answered question from a pre-answer %s inbox read", async mode => {
  let reads = 0;
  const oldRead = mode === "initial" ? 1 : 2;
  let releaseOldRead!: () => void;
  const question = { id: "question-card", sourceKind: "issue_thread_interaction", subject: { id: "question" } };
  vi.stubGlobal("fetch", vi.fn(async () => {
    const read = ++reads;
    if (read === oldRead) await new Promise<void>(resolve => { releaseOldRead = resolve; });
    return new Response(JSON.stringify({ items: read <= oldRead ? [question] : [], deskBadgeCount: read <= oldRead ? 1 : 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = coordinatorAttentionQueryKey("company", "person", "mine");
  const observer = new QueryObserver(client, { queryKey: key, queryFn: () => attentionApi.list("company", { all: true, view: "mine" }) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    if (mode === "background") {
      await vi.waitFor(() => expect(observer.getCurrentResult().data?.items).toEqual([question]));
      void observer.refetch();
    }
    await vi.waitFor(() => expect(reads).toBe(oldRead));
    invalidateInteractionRecordViews(client, "company");
    await vi.waitFor(() => expect(reads).toBe(oldRead + 1));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.items).toEqual([]));
    releaseOldRead();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observer.getCurrentResult().data?.items).toEqual([]);
    expect(observer.getCurrentResult().data?.deskBadgeCount).toBe(0);
  } finally {
    releaseOldRead?.(); unsubscribe(); client.clear();
  }
});
