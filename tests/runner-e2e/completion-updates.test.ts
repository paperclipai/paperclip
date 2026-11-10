import { describe, expect, it } from "vitest";
import { COMPLETION_RESTART_GATE_SKIPPED, completionDelivery, completionOutputUsesReleasedBrief, completionRestartGateSkipped, completionRestartGateTimeoutDetail, type CompletionObservation } from "./completion-updates.js";
import { runnerMatrix } from "./catalog.js";

const output = "Welcome to our free Friday garden meetup for beginners. Join us at 10:30; reference GARDEN123.";
const example: CompletionObservation = {
  sourceId: "source", marker: "GARDEN123",
  worker: { id: "worker", identifier: "FIR-2", status: "done", completedAt: "2026-09-24T10:01:00Z" },
  documents: [{ id: "doc", issueId: "worker", key: "welcome-note", body: output }],
  runs: [{ id: "reply-run", agentId: "lead", status: "succeeded", contextSnapshot: { issueId: "source", chatCompletionUpdates: [{ id: "worker", status: "done" }] } }],
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
    ["late handoff reply", { runs: [{ ...example.runs[0], contextSnapshot: { issueId: "source" } }] }, "completion-source-correlated"],
    ["other task's callback", { runs: [{ ...example.runs[0], contextSnapshot: { issueId: "source", chatCompletionUpdates: [{ id: "other", status: "done" }] } }] }, "completion-source-correlated"],
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
  it("registers ten explicit-only local native cells without adding scheduled work", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "completion-updates");
    expect(cells).toHaveLength(10);
    expect(new Set(cells.map(c => c.task.id))).toEqual(new Set(["interview-plan-accept", "handoff-completion-idle", "handoff-completion-busy", "handoff-completion-multiple", "handoff-completion-restart"]));
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.profile.generation).toBe("native");
      expect(cell.environment.id).toBe("local");
    }
  });
});

describe("completion restart gate", () => {
  const turn = (status: string, id = "turn", workerId: string | null = "worker") => ({ id, status,
    contextSnapshot: { issueId: "source", wakeReason: "chat_task_completed", ...(workerId ? { chatCompletionUpdates: [{ id: workerId, status: "done" }] } : {}) } });
  const base = { sourceId: "source", workerId: "worker", runs: [] as Record<string, any>[], comments: [] as Record<string, any>[] };
  it("keeps waiting while the completion turn is pending or running at the gate", () => {
    expect(completionRestartGateSkipped({ ...base, ready: "" })).toBeUndefined();
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("queued", "turn", null)] })).toBeUndefined();
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("running")] })).toBeUndefined();
    expect(completionRestartGateSkipped({ ...base, ready: "waiting", runs: [turn("succeeded")] })).toBeUndefined();
  });
  it("names a correlated completion turn that succeeded without reaching the gate", () => {
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("succeeded")] }))
      .toBe(`${COMPLETION_RESTART_GATE_SKIPPED}: completion turn turn ended succeeded without the reference gate reporting waiting`);
  });
  it("keeps waiting while a later completion turn is still active", () => {
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("succeeded", "first"), turn("queued", "retry", null)] })).toBeUndefined();
  });
  it("does not blame the agent for a turn that failed before the gate, and names it on timeout", () => {
    const state = { ...base, ready: "", runs: [turn("failed")] };
    expect(completionRestartGateSkipped(state)).toBeUndefined();
    expect(completionRestartGateTimeoutDetail(state))
      .toBe("restart boundary not reached: completion turn(s) turn ended failed before the reference gate reported waiting");
    expect(completionRestartGateTimeoutDetail({ ...state, ready: "waiting" })).toBeUndefined();
    expect(completionRestartGateTimeoutDetail(undefined)).toBeUndefined();
  });
  it("names a correlated agent reply and ignores unrelated replies", () => {
    const comments = [
      { id: "handoff", authorAgentId: "lead", createdByRunId: "initial" },
      { id: "user", authorUserId: "board" },
    ];
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("failed")], comments })).toBeUndefined();
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [turn("failed")],
      comments: [...comments, { id: "reply", authorAgentId: "lead", createdByRunId: "turn" }] }))
      .toBe(`${COMPLETION_RESTART_GATE_SKIPPED}: agent reply reply was published without the reference gate reporting waiting`);
  });
  it("ignores other conversations, other tasks and ordinary chat turns", () => {
    const other = { id: "o", status: "succeeded", contextSnapshot: { issueId: "other", wakeReason: "chat_task_completed", chatCompletionUpdates: [{ id: "worker" }] } };
    const ordinary = { id: "u", status: "succeeded", contextSnapshot: { issueId: "source", wakeReason: "chat_message" } };
    expect(completionRestartGateSkipped({ ...base, ready: "", runs: [other, ordinary, turn("succeeded", "t2", "another-worker")] })).toBeUndefined();
  });
});
