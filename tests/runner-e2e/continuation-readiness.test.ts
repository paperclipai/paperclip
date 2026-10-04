import { describe, expect, it } from "vitest";
import { continuationAnswerCommitted, continuationInitialReady } from "./continuation-readiness.js";
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
