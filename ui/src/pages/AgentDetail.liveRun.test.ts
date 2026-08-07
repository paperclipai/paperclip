import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { resolveLatestRunNavigation, type LatestRunIssue } from "./AgentDetail";

const AGENT_ID = "agent-1";

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "d3bd37f9-1111-2222-3333-444455556666",
    contextSnapshot: null,
    ...overrides,
  } as HeartbeatRun;
}

function issuesMap(...issues: LatestRunIssue[]): Map<string, LatestRunIssue> {
  return new Map(issues.map((i) => [i.id, i]));
}

describe("resolveLatestRunNavigation", () => {
  const runHref = `/agents/${AGENT_ID}/runs/d3bd37f9-1111-2222-3333-444455556666`;

  it("resolves the task from contextSnapshot.issueId and points the row at the task detail page", () => {
    const issue: LatestRunIssue = { id: "issue-7", title: "Fix the thing", status: "in_progress", identifier: "PAP-7" };
    const run = makeRun({ contextSnapshot: { issueId: "issue-7" } as HeartbeatRun["contextSnapshot"] });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap(issue));

    expect(nav.task).toBe(issue);
    expect(nav.runHref).toBe(runHref);
    expect(nav.rowHref).toBe("/issues/PAP-7");
  });

  it("falls back to contextSnapshot.taskId when issueId is absent (older snapshots)", () => {
    const issue: LatestRunIssue = { id: "issue-9", title: "Legacy", status: "todo", identifier: "PAP-9" };
    const run = makeRun({ contextSnapshot: { taskId: "issue-9" } as HeartbeatRun["contextSnapshot"] });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap(issue));

    expect(nav.task).toBe(issue);
    expect(nav.rowHref).toBe("/issues/PAP-9");
  });

  it("prefers issueId over taskId when both are present", () => {
    const wanted: LatestRunIssue = { id: "issue-a", title: "A", status: "in_progress", identifier: "PAP-A" };
    const other: LatestRunIssue = { id: "issue-b", title: "B", status: "in_progress", identifier: "PAP-B" };
    const run = makeRun({ contextSnapshot: { issueId: "issue-a", taskId: "issue-b" } as HeartbeatRun["contextSnapshot"] });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap(wanted, other));

    expect(nav.task).toBe(wanted);
    expect(nav.rowHref).toBe("/issues/PAP-A");
  });

  it("uses the issue id when the resolved task has no identifier slug", () => {
    const issue: LatestRunIssue = { id: "issue-noident", title: "No slug", status: "in_progress", identifier: null };
    const run = makeRun({ contextSnapshot: { issueId: "issue-noident" } as HeartbeatRun["contextSnapshot"] });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap(issue));

    expect(nav.rowHref).toBe("/issues/issue-noident");
  });

  it("falls back to the run detail page for a pure timer heartbeat with no snapshot", () => {
    const run = makeRun({ contextSnapshot: null });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap());

    expect(nav.task).toBeUndefined();
    expect(nav.runHref).toBe(runHref);
    expect(nav.rowHref).toBe(runHref);
  });

  it("falls back to the run detail page when the snapshot points at an issue not in the loaded set", () => {
    const run = makeRun({ contextSnapshot: { issueId: "issue-missing" } as HeartbeatRun["contextSnapshot"] });

    const nav = resolveLatestRunNavigation(run, AGENT_ID, issuesMap());

    expect(nav.task).toBeUndefined();
    expect(nav.rowHref).toBe(runHref);
  });
});
