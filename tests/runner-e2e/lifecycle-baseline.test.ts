import { describe, expect, it } from "vitest";
import {
  gradeLifecycleBaseline,
  type LifecycleCheckpoint,
} from "./lifecycle-baseline.js";
const idle = {
  executionRunId: null,
  scheduledRetry: null,
  activeRecoveryAction: null,
  monitorNextCheckAt: null,
};
function recording(): LifecycleCheckpoint[] {
  const base = {
    children: [],
    documents: [],
    attachments: [],
    comments: [],
    lifecycle: { ...idle },
    runs: [{ id: "run-1", status: "succeeded", runtimeMode: "native" }],
  };
  return [
    {
      ...structuredClone(base),
      phase: "initial",
      issue: { id: "task", status: "in_review" },
      interactions: [
        { id: "question", kind: "ask_user_questions", status: "pending" },
      ],
    },
    {
      ...structuredClone(base),
      phase: "final",
      issue: { id: "task", status: "done" },
      interactions: [
        { id: "question", kind: "ask_user_questions", status: "answered" },
      ],
      runs: [
        ...base.runs,
        { id: "run-2", status: "succeeded", runtimeMode: "native" },
      ],
    },
  ];
}
const failures = (rows: LifecycleCheckpoint[]) =>
  gradeLifecycleBaseline(rows)
    .filter((c) => !c.passed)
    .map((c) => c.id);
describe("LCA Product E2E evidence calibration", () => {
  it("LCA-03 accepts durable question and matching answered identity", () =>
    expect(failures(recording())).toEqual([]));
  it("LCA-03 rejects prose-only waiting even if final task completes", () => {
    const r = recording();
    r[0].interactions = [];
    expect(failures(r)).toContain("lifecycle.initial.durable-wait");
  });
  it("LCA-03 rejects answer on a different question", () => {
    const r = recording();
    r[1].interactions = [{ id: "other", status: "answered" }];
    expect(failures(r)).toContain("lifecycle.answer:question");
  });
  it("LCA-01 fails closed without API evidence", () => {
    const r = recording();
    delete r[1].lifecycle;
    expect(failures(r)).toContain("lifecycle.evidence-present");
  });
  it.each([
    "executionRunId",
    "scheduledRetry",
    "activeRecoveryAction",
    "monitorNextCheckAt",
  ] as const)("LCA-01 rejects leftover %s", (field) => {
    const r = recording();
    Object.assign(r[1].lifecycle!, { [field]: "unexpected" });
    expect(failures(r)).toContain("lifecycle.final.no-active-path");
  });
  it("LCA-12 rejects lost original receipt", () => {
    const r = recording();
    r[1].runs.shift();
    expect(failures(r)).toContain("lifecycle.final.preserved-runs");
  });
  it("LCA-05 accepts current revision and rejects stale or foreign plan targets", () => {
    const r = recording();
    r[0].documents = [{ key: "plan", body: "Draft", latestRevisionId: "v2" }];
    const target = {
      type: "issue_document",
      issueId: "task",
      key: "plan",
      revisionId: "v2",
    };
    r[0].interactions.push({
      id: "plan-approval",
      kind: "request_confirmation",
      status: "pending",
      payload: { target },
    });
    expect(failures(r)).toEqual([]);
    target.revisionId = "v1";
    expect(failures(r)).toContain("lifecycle.initial.revision:plan-approval");
    target.revisionId = "v2";
    target.issueId = "other";
    expect(failures(r)).toContain("lifecycle.initial.revision:plan-approval");
  });
});
