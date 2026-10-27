import { describe, expect, it } from "vitest";
import { continuationAnswerCommitted, continuationInitialReady, continuationCheckpointReady } from "./continuation-readiness.js";
import { runnerMatrix } from "./catalog.js";

describe("continuation readiness", () => {
  it("waits through the idle gap between child completion and its parent's question", () => {
    const polls = [[], [], [{ kind: "request_confirmation", status: "pending" }],
      [{ kind: "ask_user_questions", status: "answered" }],
      [{ kind: "ask_user_questions", status: "pending" }]];
    expect(polls.map(continuationInitialReady)).toEqual([false, false, false, false, true]);
  });
  it("never instructs a resumed provider to use a hardcoded completion revision", () => {
    for (const execution of runnerMatrix) {
      expect(execution.task.buildPrompt("revision-test")).not.toMatch(/contractRevision\s*:\s*["']1["']/);
    }
  });
});

it("waits for the clicked answer to commit instead of grading the original paused state", () => {
  const card = { id: "submitted", status: "pending" };
  expect(continuationAnswerCommitted([card], card.id)).toBe(false);
  expect(continuationAnswerCommitted([{ ...card, id: "different", status: "answered" }], card.id)).toBe(false);
  expect(continuationAnswerCommitted([{ ...card, status: "cancelled" }], card.id)).toBe(false);
  expect(continuationAnswerCommitted([{ ...card, status: "answered" }], card.id)).toBe(true);
});


describe("checkpoint finalization boundary", () => {
  const pending = [{ id: "question", kind: "ask_user_questions", status: "pending" }];
  const run = { id: "run", status: "succeeded", runtimeMode: "native" };
  it("waits across repeated terminal polls until review state and lock release are both visible", () => {
    const polls = [
      { status: "in_progress", executionRunId: "run" },
      { status: "in_progress", executionRunId: "run" },
      { status: "in_review", executionRunId: "run" },
      { status: "in_review", executionRunId: null },
    ];
    expect(polls.map(issue => continuationCheckpointReady({ issue, runs: [run], interactions: pending })))
      .toEqual([false, false, false, true]);
    expect(continuationCheckpointReady({ issue: { status: "in_progress", executionRunId: null },
      runs: [run], interactions: pending })).toBe(false);
  });
  it("also waits for final completion to release its execution lock", () => {
    for (const executionRunId of ["run", null]) {
      expect(continuationCheckpointReady({ issue: { status: "done", executionRunId },
        runs: [run], interactions: [{ ...pending[0], status: "answered" }] })).toBe(executionRunId === null);
    }
  });
  it("admits only the bound running native provider question without releasing its lock", () => {
    const input = { issue: { status: "in_progress", executionRunId: "run" },
      runs: [{ ...run, status: "running" }], interactions: [{ ...pending[0], sourceRunId: "run",
        payload: { runtimeRequestId: "provider-request" } }] };
    expect(continuationCheckpointReady(input)).toBe(true);
    expect(continuationCheckpointReady({ ...input, interactions: pending })).toBe(false);
    expect(continuationCheckpointReady({ ...input, issue: { ...input.issue, executionRunId: "other" } })).toBe(false);
    expect(continuationCheckpointReady({ ...input, runs: [{ ...input.runs[0], runtimeMode: "legacy" }] })).toBe(false);
    expect(continuationCheckpointReady({ ...input, runs: [...input.runs, { ...run, id: "extra", status: "queued" }] })).toBe(false);
  });
});
