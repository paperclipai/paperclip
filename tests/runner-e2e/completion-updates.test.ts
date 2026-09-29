import { describe, expect, it } from "vitest";
import { completionDelivery, completionOutputUsesReleasedBrief, type CompletionObservation } from "./completion-updates.js";
import { runnerMatrix } from "./catalog.js";

const output = "Welcome to our free Friday garden meetup for beginners. Join us at 10:30; reference GARDEN123.";
const example: CompletionObservation = {
  sourceId: "source", marker: "GARDEN123",
  worker: { id: "worker", identifier: "FIR-2", status: "done", completedAt: "2026-09-24T10:01:00Z" },
  documents: [{ id: "doc", issueId: "worker", key: "welcome-note", body: output }],
  runs: [{ id: "reply-run", agentId: "lead", status: "succeeded", contextSnapshot: { issueId: "source" } }],
  comments: [{ id: "reply", issueId: "source", authorAgentId: "lead", createdByRunId: "reply-run", createdAt: "2026-09-24T10:02:00Z", body: `The note is ready: ${output}` }],
};
const failures = (e: CompletionObservation) => completionDelivery(e).checks.filter(c => !c.passed).map(c => c.id);
describe("completion-update delivery oracle", () => {
  it("requires a released brief fact rather than only the known request marker", () => {
    for (const time of ["10:30", "10.30", "10h30", "ten-thirty", "ten thirty", "half past ten", "half-past-ten", "half past 10"])
      expect(completionOutputUsesReleasedBrief(`Meet at ${time}. GARDEN123`)).toBe(true);
    for (const body of ["Welcome on Friday. GARDEN123", "Meet at 11:30. GARDEN123"])
      expect(completionOutputUsesReleasedBrief(body)).toBe(false);
  });
  it("accepts actual output and task links without requiring a canned response", () => {
    expect(failures(example)).toEqual([]);
    for (const body of ["Riley finished it. [Read the note](/FIR/issues/FIR-2)", "Here is [the result](/FIR/issues/worker?document=welcome-note)"])
      expect(failures({ ...example, comments: [{ ...example.comments[0], body }], renderedLinks: [{ commentId: "reply", href: "/FIR/issues/FIR-2" }] })).toEqual([]);
  });
  it.each([
    ["no source reply", { comments: [] }, "completion-source-response"],
    ["worker not done", { worker: { ...example.worker, status: "in_review" } }, "completion-worker-done"],
    ["no completion timestamp", { worker: { ...example.worker, completedAt: null } }, "completion-worker-done"],
    ["no output", { documents: [] }, "completion-output-saved"],
    ["plan is not output", { documents: [{ ...example.documents[0], key: "plan" }] }, "completion-output-saved"],
    ["foreign document", { documents: [{ ...example.documents[0], issueId: "other" }] }, "completion-output-saved"],
    ["premature reply", { comments: [{ ...example.comments[0], createdAt: "2026-09-24T10:00:00Z" }] }, "completion-source-response"],
    ["user reply", { comments: [{ ...example.comments[0], authorAgentId: null, authorUserId: "user" }] }, "completion-source-response"],
    ["worker thread reply", { comments: [{ ...example.comments[0], issueId: "worker" }] }, "completion-source-response"],
    ["wrong run", { runs: [{ ...example.runs[0], contextSnapshot: { issueId: "worker" } }] }, "completion-source-response"],
    ["failed reply run", { runs: [{ ...example.runs[0], status: "failed" }] }, "completion-source-response"],
    ["handoff promise", { comments: [{ ...example.comments[0], body: "FIR-2 is running. I'll post back when it finishes. GARDEN123" }] }, "completion-result-access"],
    ["unrelated link", { comments: [{ ...example.comments[0], body: "Done! [Output](/FIR/issues/FIR-3) GARDEN123" }] }, "completion-result-access"],
    ["identifier substring", { comments: [{ ...example.comments[0], body: "Done! [Output](/FIR/issues/FIR-20)" }] }, "completion-result-access"],
  ] as const)("rejects %s", (_label, change, check) => {
    expect(failures({ ...example, ...change } as CompletionObservation)).toContain(check);
  });
  it("accepts descriptive output keys and excludes only planning document keys", () => {
    for (const key of ["plants-welcome-note", "welcome-note-summary", "proposal-followup-note"])
      expect(failures({ ...example, documents: [{ ...example.documents[0], key }] })).toEqual([]);
    for (const key of ["plan", "summary", "proposal"])
      expect(failures({ ...example, documents: [{ ...example.documents[0], key }] })).toContain("completion-output-saved");
  });
  it("explicitly leaves semantic accuracy to review even if delivery/access pass", () => {
    const delivery = completionDelivery({ ...example, comments: [{ ...example.comments[0], body: "It is still running. [Task](/FIR/issues/FIR-2)" }], renderedLinks: [{ commentId: "reply", href: "/FIR/issues/FIR-2" }] });
    expect(delivery.checks.every(c => c.passed)).toBe(true);
    expect(delivery.semanticReview.status).toBe("required");
    expect(delivery.semanticReview.rubric[0]).toContain("accurately");
  });
  it("retains earlier delivery when a later clarification omits its link", () => {
    const earlier: CompletionObservation["comments"][number] = { ...example.comments[0], body: "Finished in FIR-2." };
    const later = { ...earlier, id: "correction", createdAt: "2026-09-24T10:03:00Z", body: "To clarify, it is a draft for you to use; it has not been published." };
    const result = completionDelivery({ ...example, comments: [earlier, later], renderedLinks: [{ commentId: earlier.id, href: "/FIR/issues/FIR-2" }] });
    expect(result.checks.every(c => c.passed)).toBe(true);
    expect(result.response).toEqual(earlier);
    expect(result.latestResponse).toEqual(later);
    expect(result.responses).toHaveLength(2);
  });
  it("accepts auto-linked identifiers only with matching browser evidence", () => {
    const e = { ...example, comments: [{ ...example.comments[0], body: "Finished in FIR-2." }] };
    expect(failures(e)).toContain("completion-result-access");
    expect(failures({ ...e, renderedLinks: [{ commentId: "reply", href: "/FIR/issues/FIR-2" }] })).toEqual([]);
    expect(failures({ ...e, renderedLinks: [{ commentId: "earlier", href: "/FIR/issues/FIR-2" }] })).toContain("completion-result-access");
    expect(failures({ ...e, renderedLinks: [{ commentId: "reply", href: "/FIR/issues/FIR-20" }] })).toContain("completion-result-access");
  });
  it("registers four explicit-only local native cells without adding scheduled work", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "completion-updates");
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map(c => c.task.id))).toEqual(new Set(["interview-plan-accept", "handoff-completion-idle"]));
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.profile.generation).toBe("native");
      expect(cell.environment.id).toBe("local");
    }
  });
});
