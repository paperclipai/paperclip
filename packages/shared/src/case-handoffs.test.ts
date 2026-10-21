import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handoffCaseSchema, type HandoffCaseInput } from "./case-handoffs.js";

const recipient = randomUUID();
const kickoff = {
  idempotencyKey: "kickoff-1", case: { create: { caseType: "bug", title: "Fix the bug" } },
  toAgentId: recipient, phase: "triage", instructions: "Investigate and route this task.",
  workflow_document_text: "Triage the bug, implement the fix, verify it, then hand off to done.",
};

describe("handoff_case input", () => {
  it("accepts kickoff without inventing routing state or attribution", () => {
    expect(handoffCaseSchema.parse(kickoff)).toEqual(kickoff);
  });
  it("requires nonblank workflow text for every new case and preserves the exact document body", () => {
    const { workflow_document_text: _workflow, ...missing } = kickoff;
    expect(handoffCaseSchema.safeParse(missing).success).toBe(false);
    for (const text of ["", " \n\t ", "x".repeat(200_001)]) {
      expect(handoffCaseSchema.safeParse({ ...kickoff, workflow_document_text: text }).success).toBe(false);
    }
    const text = "  # Workflow\r\n\nUse literal \\n in the sample.\n ";
    expect(handoffCaseSchema.parse({ ...kickoff, workflow_document_text: text })).toMatchObject({ workflow_document_text: text });
    expect(handoffCaseSchema.safeParse({ ...missing, bindIssueId: randomUUID(), expectedIssueStatusVersion: 0 }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...kickoff, bindIssueId: randomUUID(), expectedIssueStatusVersion: 0 }).success).toBe(true);
  });
  it("accepts initial ordinary task documents and normalizes their keys and escaped line breaks", () => {
    expect(handoffCaseSchema.parse({ ...kickoff, initialDocuments: [{ key: " Plan ", title: " Brief ", body: "one\\ntwo" }] }))
      .toMatchObject({ initialDocuments: [{ key: "plan", title: "Brief", body: "one\ntwo" }] });
  });
  it.each([
    [{ key: "Plan", title: "Plan", body: "a" }, { key: " plan ", title: "Other", body: "b" }],
    [{ key: "invalid.dot", title: "Plan", body: "a" }],
    [{ key: "x".repeat(65), title: "Plan", body: "a" }],
    [{ key: "plan", title: " ", body: "a" }],
    [{ key: "plan", title: "x".repeat(201), body: "a" }],
    [{ key: "plan", title: "Plan", body: "a", format: "html" }],
    [{ key: "plan", title: "Plan", body: "a", createdByAgentId: recipient }],
    [{ key: " Workflow ", title: "Workflow", body: "Conflicting workflow" }],
    [{ key: "plan", title: "Plan", body: "x".repeat(200_001) }],
    [{ key: "one", title: "One", body: "x".repeat(100_001) }, { key: "two", title: "Two", body: "x".repeat(100_000) }],
    Array.from({ length: 21 }, (_, index) => ({ key: `doc-${index}`, title: "Doc", body: "" })),
  ])("rejects invalid, ambiguous, oversized or authority-bearing initial documents: %#", (...initialDocuments) => {
    // Vitest spreads array cases into arguments; preserve the document list.
    expect(handoffCaseSchema.safeParse({ ...kickoff, initialDocuments }).success).toBe(false);
  });
  it("accepts bounded document batches but rejects adding documents while binding a task", () => {
    const initialDocuments = [{ key: "brief", title: "Brief", body: "x".repeat(200_000 - kickoff.workflow_document_text.length) }];
    expect(handoffCaseSchema.safeParse({ ...kickoff, initialDocuments }).success).toBe(true);
    expect(handoffCaseSchema.safeParse({ ...kickoff, initialDocuments: [{ ...initialDocuments[0]!, body: `${initialDocuments[0]!.body}x` }] }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...kickoff, initialDocuments, bindIssueId: randomUUID(), expectedIssueStatusVersion: 0 }).success).toBe(false);
  });
  it("requires observed revisions when transferring existing work", () => {
    const { workflow_document_text: _workflow, ...base } = kickoff;
    const existing = { ...base, case: { id: randomUUID() } };
    expect(handoffCaseSchema.safeParse(existing).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...existing, expectedHandoffVersion: 0 }).success).toBe(true);
    expect(handoffCaseSchema.safeParse({ ...existing, expectedHandoffVersion: 0, bindIssueId: randomUUID() }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...existing, expectedHandoffVersion: 0, bindIssueId: randomUUID(), expectedIssueStatusVersion: 3 }).success).toBe(true);
    expect(handoffCaseSchema.safeParse({ ...existing, expectedHandoffVersion: 0, bindIssueId: randomUUID(), expectedIssueStatusVersion: 3,
      workflow_document_text: kickoff.workflow_document_text }).success).toBe(false);
  });
  it("rejects ambiguous case selection and caller-selected authority", () => {
    expect(handoffCaseSchema.safeParse({ ...kickoff, case: { ...kickoff.case, id: randomUUID() } }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...kickoff, responsibleUserId: "invented" }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...kickoff, status: "done" }).success).toBe(false);
  });
  it("records completion intent for existing work and normalizes the done phase", () => {
    const done = { to: "done", idempotencyKey: "finish-1", case: { id: randomUUID() },
      instructions: "Saved the final findings. Finish through the normal completion gates.",
      expectedHandoffVersion: 4, expectedIssueStatusVersion: 7 } satisfies HandoffCaseInput;
    expect(handoffCaseSchema.parse(done)).toEqual({ ...done, phase: "done" });
    expect(handoffCaseSchema.parse({ ...done, phase: "done" })).toEqual({ ...done, phase: "done" });
  });
  it("requires both observed versions for completion intent", () => {
    const done = { to: "done", idempotencyKey: "finish-1", case: { id: randomUUID() }, instructions: "Finish saved work." };
    expect(handoffCaseSchema.safeParse(done).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...done, expectedHandoffVersion: 4 }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...done, expectedIssueStatusVersion: 7 }).success).toBe(false);
    expect(handoffCaseSchema.safeParse({ ...done, expectedHandoffVersion: 4, expectedIssueStatusVersion: 7 }).success).toBe(true);
  });
  it.each([
    { toAgentId: recipient }, { bindIssueId: randomUUID() }, { phase: "verification" },
    { case: { create: { caseType: "bug", title: "New work cannot finish" } } },
    { responsibleUserId: "invented" }, { status: "done" }, { to: "completed" },
    { initialDocuments: [{ key: "plan", title: "Plan", body: "Work" }] },
    { workflow_document_text: kickoff.workflow_document_text },
  ])("rejects routing, creation, or authority overrides on completion intent: %j", (override) => {
    const done = { to: "done", idempotencyKey: "finish-1", case: { id: randomUUID() }, instructions: "Finish saved work.",
      expectedHandoffVersion: 4, expectedIssueStatusVersion: 7 };
    expect(handoffCaseSchema.safeParse({ ...done, ...override }).success).toBe(false);
  });
});
