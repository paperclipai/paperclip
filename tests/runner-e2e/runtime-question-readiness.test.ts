import { expect, it } from "vitest";
import { answerableRuntimeRunIds } from "./runtime-question-readiness.js";
it("recognizes only a pending native question as an answerable active turn", () => {
  const native = { kind: "ask_user_questions", status: "pending", sourceRunId: "live", payload: { runtimeRequestId: "request" } };
  expect([...answerableRuntimeRunIds([native])]).toEqual(["live"]);
  expect([...answerableRuntimeRunIds([{ ...native, status: "answered" }, { ...native, payload: {} }])]).toEqual([]);
});

import { isSingleClaudeQuestion } from "./runtime-question-readiness.js";
it("allows Claude's optional Other companion but rejects another substantive question", () => {
  const choice = { id: "choice", answerMode: "single_select" };
  const other = { id: "field-2-question_0_custom-hash", answerMode: "text", required: false, header: "Other" };
  expect(isSingleClaudeQuestion([choice])).toBe(true);
  expect(isSingleClaudeQuestion([choice, other])).toBe(true);
  expect(isSingleClaudeQuestion([choice, { ...other, required: true }])).toBe(false);
  expect(isSingleClaudeQuestion([choice, { ...other, id: "organization", header: "Organization" }])).toBe(false);
  expect(isSingleClaudeQuestion([choice, other, other])).toBe(false);
});
