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
      issue: { id: "task", status: "in_review", assigneeAgentId: "agent" },
      interactions: [
        { id: "question", kind: "ask_user_questions", status: "pending" },
      ],
    },
    {
      ...structuredClone(base),
      phase: "final",
      issue: { id: "task", status: "done", assigneeAgentId: "agent" },
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


describe("settled waiting and every resumed question", () => {
  it.each(["todo", "in_progress", "blocked", "done", "cancelled"])(
    "rejects a settled question left %s even when the final result succeeds", (status) => {
      const r = recording();
      r[0].issue.status = status;
      expect(failures(r)).toContain("lifecycle.initial.wait-state");
    },
  );
  it.each(["executionRunId", "scheduledRetry", "activeRecoveryAction", "monitorNextCheckAt"] as const)(
    "rejects a waiting task with leftover %s", (field) => {
      const r = recording();
      Object.assign(r[0].lifecycle!, { [field]: "unexpected" });
      expect(failures(r)).toContain("lifecycle.initial.wait-state");
    },
  );
  it.each(["queued", "running", "failed", "cancelled", "timed_out"])(
    "rejects an unexplained %s run during a settled wait", (status) => {
      const r = recording();
      r[0].runs[0].status = status;
      expect(failures(r)).toContain("lifecycle.initial.wait-state");
    },
  );
  it.each(["id", "assigneeAgentId"] as const)("rejects changed task %s", field => {
    const r = recording();
    r[1].issue[field] = "other";
    expect(failures(r)).toContain("lifecycle.task-owner-preserved");
  });
  it("fails closed when waiting-state or assignee evidence is absent", () => {
    const r = recording();
    delete r[0].lifecycle;
    delete r[0].issue.assigneeAgentId;
    expect(failures(r)).toContain("lifecycle.initial.wait-state");
    expect(failures(r)).toContain("lifecycle.task-owner-preserved");
  });
  function pausedRecording() {
    const r = recording();
    r[0].issue.status = "in_progress";
    r[0].runs[0].status = "running";
    r[0].lifecycle!.executionRunId = "run-1";
    r[0].interactions = [{ id: "question", kind: "ask_user_questions", status: "pending",
      sourceRunId: "run-1", payload: { runtimeRequestId: "request-1" } }];
    r[1].runs = [r[1].runs[0]];
    return r;
  }
  it("accepts the native provider-question bridge paused in its original run", () => {
    expect(failures(pausedRecording())).toEqual([]);
  });
  it.each(["sourceRunId", "runtimeRequestId", "runtimeMode", "executionRunId"])(
    "rejects an unbound provider pause: %s", field => {
      const r = pausedRecording();
      if (field === "runtimeMode") r[0].runs[0].runtimeMode = "legacy";
      else if (field === "executionRunId") r[0].lifecycle!.executionRunId = "other";
      else {
        const interaction = r[0].interactions[0] as Record<string, any>;
        if (field === "sourceRunId") interaction.sourceRunId = "other";
        else delete interaction.payload.runtimeRequestId;
      }
      expect(failures(r)).toContain("lifecycle.initial.wait-state");
    },
  );
  function twoQuestions() {
    const r = recording();
    const middle = structuredClone(r[1]);
    middle.phase = "answered";
    middle.issue.status = "in_review";
    middle.interactions.push({ id: "second-question", kind: "ask_user_questions", status: "pending" });
    r[1].interactions.push({ id: "second-question", kind: "ask_user_questions", status: "answered" });
    r[1].runs.push({ id: "run-3", status: "succeeded", runtimeMode: "native" });
    return [r[0], middle, r[1]];
  }
  it("accepts two sequential questions with all run and answer receipts retained", () => {
    expect(failures(twoQuestions())).toEqual([]);
  });
  it.each(["missing", "replaced", "cancelled", "duplicate"])(
    "rejects a %s second answer although the first answer and final task are correct", mutation => {
      const r = twoQuestions();
      const final = r[2].interactions as Array<Record<string, any>>;
      if (mutation === "missing") final.pop();
      else if (mutation === "replaced") final[1].id = "replacement";
      else if (mutation === "cancelled") final[1].status = "cancelled";
      else final.push({ ...final[1] });
      expect(failures(r)).toContain("lifecycle.answer:second-question");
    },
  );
  it("rejects losing the intermediate run even when the first receipt survives", () => {
    const r = twoQuestions();
    r[2].runs = r[2].runs.filter(run => run.id !== "run-2");
    expect(failures(r)).toContain("lifecycle.final.preserved-runs");
  });
  it("rejects missing or empty question IDs", () => {
    const r = recording();
    r[0].interactions = [{ id: "", kind: "ask_user_questions", status: "pending" }];
    r[1].interactions = [{ id: "", kind: "ask_user_questions", status: "answered" }];
    expect(failures(r)).toContain("lifecycle.initial.durable-wait");
    expect(failures(r)).toContain("lifecycle.answer:");
  });
});
