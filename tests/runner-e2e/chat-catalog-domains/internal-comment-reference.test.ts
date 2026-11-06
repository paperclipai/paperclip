import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { savedDesignInstruction, validRenderedCommentReference } from "./internal-comment-reference.js";
import { grade_tasks } from "./internal-tasks.js";
import type { InternalObservation } from "./internal-support.js";
function valid(body = "Follow the approved design task RUN-1 as the source of truth for this landing page build."): InternalObservation {
  const task = { id: "landing", companyId: "company", title: "Landing page", status: "backlog" };
  const design = { id: "design", companyId: "company", identifier: "RUN-1", title: "Approved design", status: "done" };
  const comment = { id: "note", issueId: task.id, body, authorAgentId: "ceo", createdByRunId: "run" };
  return { scenarioId: "tasks.comment-with-reference", origin: "http://127.0.0.1:3100", companyId: "company", leadId: "ceo", state: { task, design,
    savedCommentReference: { commentId: comment.id, taskId: task.id, designId: design.id, bodySha256: createHash("sha256").update(body).digest("hex"), href: "/RUN/issues/RUN-1", visible: true, destinationMatched: true, publicReadMatched: true } },
    tasks: [task, design], comments: [comment], projects: [], goals: [], activity: [], documents: [], revisions: [], reply: "Saved the note on the landing page task.", links: ["/RUN/issues/landing"], humanQueries: ["Add a note."], runs: [{ id: "run", agentId: "ceo", companyId: "company", status: "succeeded" }] };
}
it("accepts the retained natural bare-identifier note and explicit Markdown links with actual comment-scoped proof", () => {
  for (const body of [valid().comments[0]!.body!, "Use [the approved design](/RUN/issues/RUN-1) when implementing the landing page.", "Build according to `RUN-1`.", "Follow [the design](http://127.0.0.1:3100/RUN/issues/RUN-1)."]) expect(grade_tasks(valid(body)).passed).toBe(true);
});
it("does not accept wrong/foreign/hidden or negated design instructions", () => {
  for (const body of ["Follow RUN-2.", "Follow [RUN-1](https://foreign.invalid/issues/RUN-1).", "Follow [RUN-1](/FOREIGN/issues/RUN-1).", "Do not follow RUN-1.", "Ignore the approved design RUN-1.", "Follow RUN-1. Ignore that design.", "```\nFollow RUN-1\n```", "<!-- Follow RUN-1 -->", "RUN-1 is the design, but this note gives no instruction."]) {
    const o = valid(body); expect(savedDesignInstruction(o, body, o.state.design as typeof o.tasks[0]), body).toBe(false); expect(grade_tasks(o).passed).toBe(false);
  }
});
it("requires exact saved-comment, body, task, destination and readable-resource proof instead of aggregate links", () => {
  for (const change of [{ commentId: "other-note" }, { taskId: "other-task" }, { designId: "other-design" }, { bodySha256: "stale" }, { href: "https://foreign.invalid/issues/RUN-1" }, { visible: false }, { destinationMatched: false }, { publicReadMatched: false }]) {
    const o = valid(); Object.assign(o.state.savedCommentReference!, change); o.links.push("/RUN/issues/RUN-1"); expect(grade_tasks(o).passed).toBe(false);
  }
  const o = valid(); delete o.state.savedCommentReference; expect(validRenderedCommentReference(o, o.comments[0]!, o.tasks[1]!)).toBe(false);
});
it("retains exactly one real agent/run-attributed comment", () => {
  for (const change of [{ authorAgentId: "human" }, { createdByRunId: "unrelated" }, { issueId: "foreign-task" }]) { const o = valid(); Object.assign(o.comments[0]!, change); expect(grade_tasks(o).passed).toBe(false); }
  const o = valid(); o.comments.push({ ...o.comments[0]!, id: "duplicate" }); expect(grade_tasks(o).passed).toBe(false);
});

// Retain the original affirmative/negative instruction calibration matrix.
function observation(body: string): InternalObservation {
  const task = { id: "task", companyId: "company", title: "Landing page", status: "backlog" }, design = { id: "design", identifier: "ACO-2", companyId: "company", title: "Approved design", status: "done" };
  return { scenarioId: "tasks.comment-with-reference", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: structuredClone(task), design: structuredClone(design), savedCommentReference: { commentId: "note", taskId: "task", designId: "design", bodySha256: createHash("sha256").update(body).digest("hex"), href: "/ACO/issues/design", visible: true, destinationMatched: true, publicReadMatched: true } }, tasks: [task, design], projects: [], goals: [], documents: [], revisions: [], activity: [], reply: "Note added.", humanQueries: [], links: ["/ACO/issues/task"], comments: [{ id: "note", issueId: "task", authorAgentId: "ceo", createdByRunId: "run", body }], runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded" }] };
}
for (const body of ["Follow [the approved design](/ACO/issues/design).", "Please use [this design](https://fixture.test/ACO/issues/ACO-2) for implementation.", "Adhere to [the approved design](/ACO/issues/design?tab=documents).", "Implement according to [the design](/ACO/issues/design).", "Build in line with [the approved design](/ACO/issues/design).", "Follow [the approved design](/ACO/issues/design) and avoid unrelated layout changes.", "Do not forget to follow [the approved design](/ACO/issues/design)."])
  it(`accepts affirmative actual design instruction: ${body}`, () => expect(grade_tasks(observation(body)).passed).toBe(true));
for (const body of ["Do not follow [the design](/ACO/issues/design).", "Never use [the design](/ACO/issues/design).", "Ignore [the design](/ACO/issues/design), but follow [the design](/ACO/issues/design).", "Follow [the design](/ACO/issues/design) but ignore it.", "Follow [the wrong task](/ACO/issues/other); the intended design ID is design.", "Follow [the design](https://foreign.test/ACO/issues/design).", "Follow [the design](/ACO/issues/design), but do not follow it.", "Here is [the design](/ACO/issues/design).", "Follow [another task](/ACO/issues/other). Reference [the design](/ACO/issues/design)."])
  it(`rejects negated, unrelated or merely mentioned reference: ${body}`, () => expect(grade_tasks(observation(body)).passed).toBe(false));
it("preserves exact note authorship and duplicate rejection", () => { const o = observation("Follow [the design](/ACO/issues/design)."); o.comments[0]!.authorAgentId = "other"; expect(grade_tasks(o).passed).toBe(false); o.comments[0]!.authorAgentId = "ceo"; o.comments.push(structuredClone(o.comments[0]!)); expect(grade_tasks(o).passed).toBe(false); });
