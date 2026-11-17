import { describe, expect, it } from "vitest";
import { validateQuestionPatterns } from "./question-pattern-validation.js";

const pathological = { questionId: "value", pattern: "^(a+)+$", text: "a".repeat(99_999) + "!" };

describe("isolated question pattern validation", () => {
  it("preserves matching and nonmatching regex semantics", async () => {
    await validateQuestionPatterns([{ questionId: "url", pattern: "^https://", text: "https://example.test" }]);
    await expect(validateQuestionPatterns([{ questionId: "url", pattern: "^https://", text: "http://example.test" }])).rejects.toThrow("does not match");
  });

  it("terminates pathological matching while the event loop remains responsive", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    try {
      await expect(validateQuestionPatterns([pathological])).rejects.toThrow("time limit");
      expect(ticks).toBeGreaterThan(1);
      await validateQuestionPatterns([{ questionId: "value", pattern: "^a$", text: "a" }]);
    } finally {
      clearInterval(timer);
    }
  }, 5_000);

  it("bounds concurrent workers and releases every slot after timeout", async () => {
    const pending = Array.from({ length: 4 }, () => validateQuestionPatterns([pathological]));
    const settled = Promise.allSettled(pending);
    await expect(validateQuestionPatterns([pathological])).rejects.toThrow("busy");
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    await validateQuestionPatterns([{ questionId: "value", pattern: "^a$", text: "a" }]);
  }, 5_000);
});
