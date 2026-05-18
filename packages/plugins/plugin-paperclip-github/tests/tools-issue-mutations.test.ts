import { describe, it, expect, vi } from "vitest";
import { createIssue, updateIssue, labelIssue } from "../src/tools/issue_mutations.js";
import type { GitHubClient } from "../src/auth.js";

const runCtx = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };
const row = (s: Record<string, unknown>) => ({
  number: 7,
  html_url: "https://github.com/o/r/issues/7",
  title: "old title",
  state: "open",
  labels: [],
  body: "old body",
  ...s,
});

function client(): GitHubClient {
  const state = { title: "old title", body: "old body", state: "open", labels: [] as string[] };
  return {
    owner: "o",
    name: "r",
    rest: {
      issues: {
        create: vi.fn().mockImplementation(async (next) =>
          Object.assign(state, { title: next.title, body: next.body, labels: next.labels ?? [] }) && { data: row(state) },
        ),
        update: vi.fn().mockImplementation(async (next) =>
          Object.assign(state, {
            title: next.title ?? state.title,
            body: next.body ?? state.body,
            state: next.state ?? state.state,
          }) && { data: row(state) },
        ),
        addLabels: vi.fn().mockImplementation(async ({ labels }) => {
          state.labels = [...new Set([...state.labels, ...labels])];
          return { data: state.labels.map((name) => ({ name })) };
        }),
        get: vi.fn().mockImplementation(async () => ({ data: row({ ...state, labels: state.labels.map((name) => ({ name })) }) })),
      },
    } as never,
    graphql: vi.fn() as never,
  };
}

describe("issue mutation tools", () => {
  it("creates, updates, and labels issues with verified readback", async () => {
    const c = client();
    const created = await createIssue(c, { title: "COM-214 lane", body: "Fix PR #353", labels: ["merge-follow-up"] }, runCtx);
    expect(created.data).toMatchObject({ issueNumber: 7, htmlUrl: "https://github.com/o/r/issues/7", labels: ["merge-follow-up"], mutation: "create_issue", verified: true });

    const updated = await updateIssue(c, { issueNumber: 7, title: "new title", body: "new body", state: "closed" }, runCtx);
    expect(updated.data).toMatchObject({ issueNumber: 7, title: "new title", body: "new body", state: "closed", mutation: "update_issue", verified: true });

    const labeled = await labelIssue(c, { issueNumber: 7, labels: ["delivery-approved"] }, runCtx);
    expect(labeled.data).toMatchObject({ issueNumber: 7, mutation: "label_issue", verified: true });
    expect((labeled.data as { labels: string[] }).labels).toEqual(expect.arrayContaining(["delivery-approved", "merge-follow-up"]));
  });
});
