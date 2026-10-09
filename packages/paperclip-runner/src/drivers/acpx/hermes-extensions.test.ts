import { describe, expect, it } from "vitest";
import { createAcpxProfileExtensionAdapter, validateAcpxRichEvent } from "./profile-extensions.js";

describe("Hermes native extensions", () => {
  const adapter = () => createAcpxProfileExtensionAdapter("hermes", { sessionId: "session", turnId: "turn", workspacePath: "/workspace" })!;
  it("keeps native child identities stable across start, progress and completion", async () => {
    const context = { version: 1, sessionId: "session", turnToken: "token", childId: "child", delegationId: "batch", model: "exact-model", summary: "Read source", status: "completed" };
    const events = await Promise.all(["subagent.start", "subagent.progress", "subagent.complete"].map(event => adapter().notification("_hermes/delegation", { ...context, event })));
    for (const event of events.flat()) validateAcpxRichEvent(event);
    expect(new Set(events.flat().map(event => event.itemId)).size).toBe(1);
    expect(events[2]?.[0]?.payload.status).toBe("completed");
    await expect(adapter().notification("_hermes/delegation", { ...context, event: "subagent.start", childId: "" })).rejects.toThrow();
  });
  it("returns exactly the canonical batch answer and supports cancellation", async () => {
    const result = await adapter().request("_hermes/ask_questions", { version: 1, sessionId: "session", turnToken: "token", input: {
      schema: "paperclip.question_set.v1", questions: [{ id: "q0", prompt: "Why?", required: true, answerMode: "text" }],
    } });
    if (!("input" in result)) throw new Error("Missing canonical question form");
    expect(result.input.cancel()).toEqual({ outcome: "cancelled" });
    expect(result.input.resolve({ action: "submit", response: { schema: "paperclip.question_response.v1", answers: { q0: { text: "Because" } } } })).toEqual({ outcome: "answered", answers: { q0: { text: "Because" } } });
  });
  it.each(["text", "single_select", "multi_select"])("enforces the native %s limit before returning an answer", async answerMode => {
    const result = await adapter().request("_hermes/ask_questions", { version: 1, sessionId: "session", turnToken: "token", input: {
      schema: "paperclip.question_set.v1", questions: [{ id: "q0", prompt: "Why?", required: true, answerMode,
        textValidation: { maxLength: 65_536 },
        ...(answerMode === "text" ? {} : { options: [{ id: "o0", label: "A" }], customAnswer: { enabled: true } }),
      }],
    } });
    if (!("input" in result)) throw new Error("Missing canonical question form");
    const response = (value: string) => ({ action: "submit" as const, response: { schema: "paperclip.question_response.v1" as const,
      answers: { q0: answerMode === "text" ? { text: value } : { customText: value } },
    } });
    const limit = result.input.questionSet.questions[0]!.textValidation!.maxLength!;
    expect(limit).toBeLessThan(65_536);
    expect(result.input.resolve(response("😀".repeat(Math.floor(limit / 2))))).toMatchObject({ outcome: "answered" });
    for (const value of ["x".repeat(limit + 1), "x".repeat(70_000), "😀".repeat(Math.floor(limit / 2) + 1)]) {
      expect(() => result.input.resolve(response(value))).toThrow(`at most ${limit} characters`);
    }
  });
  it.each(["text", "single_select", "multi_select"])("keeps all accepted %s answers inside ACPX's encoded response bound", async answerMode => {
    const result = await adapter().request("_hermes/ask_questions", { version: 1, sessionId: "session", input: {
      schema: "paperclip.question_set.v1", questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i}` + "\u0000".repeat(158), prompt: "Why?", required: true, answerMode,
        textValidation: { maxLength: 65_536 },
        ...(answerMode === "text" ? {} : { options: Array.from({ length: 4 }, (_, j) => ({
          id: `o${j}` + "\u0000".repeat(158), label: `Choice ${j}`,
        })), customAnswer: { enabled: true } }),
      })),
    } });
    if (!("input" in result)) throw new Error("Missing canonical question form");
    const answers = Object.fromEntries(result.input.questionSet.questions.map(question => [question.id, {
      selectedOptionIds: answerMode === "multi_select" ? question.options!.map(option => option.id) : [],
      [answerMode === "text" ? "text" : "customText"]: "\u0000".repeat(question.textValidation!.maxLength!),
    }]));
    const response = result.input.resolve({ action: "submit", response: { schema: "paperclip.question_response.v1", answers } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(256 * 1024);
    const oversized = Object.fromEntries(result.input.questionSet.questions.map(question => [question.id, {
      [answerMode === "text" ? "text" : "customText"]: "x".repeat(60_000),
    }]));
    expect(() => result.input.resolve({ action: "submit", response: { schema: "paperclip.question_response.v1", answers: oversized } })).toThrow("at most");
  });
  it("preserves estimated-cost provenance without inventing billed cost", async () => {
    const events = await adapter().notification("_hermes/usage", { version: 1, sessionId: "session", tokens: "reported", cost: "estimated", estimatedUsd: 0.012 });
    events.forEach(validateAcpxRichEvent);
    expect(events[0]?.payload.category).toBe("hermes_usage_provenance");
    expect(JSON.stringify(events)).toContain("unverified");
  });
});
