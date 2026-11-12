import { describe, expect, it } from "vitest";
import { gradeInbox } from "./internal-inbox-search.js";
import type { InternalObservation } from "./internal-support.js";

// Calibration from cohort 3: the full answer with its links existed only as run-stream prose shown in
// the bubble; the saved reply said "Answered above" over nothing. Links must come from the saved reply.
function inbox(reply: string, links: string[]) {
  const review = { id: "review-id", identifier: "COM-1", title: "Launch review", status: "in_review" };
  const blocked = { id: "blocked-id", identifier: "COM-2", title: "Blocked launch decision", status: "blocked" };
  const done = { id: "done-id", identifier: "COM-3", title: "Delivered launch copy", status: "done" };
  const automated = { id: "automated-id", identifier: "COM-5", title: "Unrelated automated maintenance n-1", status: "backlog" };
  const tasks = [review, blocked, done, automated];
  return { scenarioId: "inbox-search.show-my-work", origin: "https://fixture.test", companyId: "company", leadId: "ceo",
    state: { originalTasks: structuredClone(tasks), originalPersonalIds: [review.id, blocked.id, done.id], automatedTask: automated },
    tasks, projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [], reply, links,
    runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded" }],
    personalItems: [review, blocked, done], policy: { mode: "disabled", allowedAgentIds: [] }, personalProbe: { status: 403, body: {} },
    responsibleUserProbe: { status: 200, body: [review, blocked, done] }, unreadProbe: { status: 200, body: [] } } as unknown as InternalObservation;
}
const failed = (o: InternalObservation) => gradeInbox(o).checks.filter(check => !check.passed).map(check => check.id);
const items = "1. [COM-1 Launch review](/COM/issues/COM-1) needs a reviewer.\n2. [COM-2 Blocked launch decision](/COM/issues/COM-2) needs your call.";

describe("inbox-search.show-my-work saved reply links", () => {
  it("rejects actionable links that render only from run-stream prose, not from the saved reply", () => {
    const rendered = ["/COM/inbox/mine", "/COM/issues/COM-2", "/COM/issues/COM-1", "/COM/issues/COM-3"];
    expect(failed(inbox("Answered above: two inbox items need your attention.", rendered))).toEqual(["responsible-user-scope-or-honest-limitation"]);
    expect(failed(inbox("Answered above: [COM-2](/COM/issues/COM-2) needs you.", rendered))).toEqual(["responsible-user-scope-or-honest-limitation"]);
  });
  it("accepts a saved reply whose task links or identifiers it carries, however it is worded", () => {
    const rendered = ["/COM/issues/COM-2", "/COM/issues/COM-1"];
    expect(failed(inbox(items, rendered))).toEqual([]);
    expect(failed(inbox("Waiting on you: COM-2 (blocked) and COM-1 (in review).", rendered))).toEqual([]);
    expect(failed(inbox("Waiting on you: com-2 (blocked) and com-1 (in review).", rendered))).toEqual([]);
    expect(failed(inbox("Waiting on you: [the decision][d] and [the review][r].\n\n[d]: /COM/issues/COM-2\n[r]: /COM/issues/COM-1", rendered))).toEqual([]);
    expect(failed(inbox(`Two of the three tasks in your [Mine](/COM/inbox/mine) inbox need you:\n${items}\n\nAnswered above.`, ["/COM/inbox/mine", ...rendered]))).toEqual([]);
  });
});
