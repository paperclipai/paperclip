import { describe, expect, it } from "vitest";
import { createAcpxProfileExtensionAdapter, isHermesCommittedHumanInputCompletion, validateAcpxRichEvent } from "./profile-extensions.js";

describe("Hermes native extensions", () => {
  const completion = { type: "tool_call", tag: "tool_call_update", status: "completed", title: "mcp__paperclip__request_human_input" };
  it.each(["ask_user_questions", "request_confirmation", "request_checkbox_confirmation"])("delays only the current run's structured committed human input completion (%s)", kind => {
    const committed = { disposition: "applied", interaction: { id: "input", companyId: "company", issueId: "issue",
      sourceRunId: "run", kind, status: "pending", continuationPolicy: "wake_assignee" } };
    for (const rawOutput of [committed, JSON.stringify(committed), { result: committed },
      { result: JSON.stringify(committed) }, { result: "Saved", structuredContent: committed }]) {
      expect(isHermesCommittedHumanInputCompletion({ ...completion, rawOutput }, "run")).toBe(true);
    }
    for (const event of [{ ...completion, title: "terminal", rawOutput: committed },
      { ...completion, status: "failed", rawOutput: committed }, { ...completion, tag: "tool_call", rawOutput: committed },
      { ...completion, rawOutput: "Saved a pending question" }, { ...completion, rawOutput: { ...committed, error: "denied" } },
      { ...completion, rawOutput: { result: { ...committed, error: "denied" } } },
      { ...completion, rawOutput: { ...committed, disposition: "rejected" } },
      ...["status", "kind", "continuationPolicy", "sourceRunId", "id", "companyId", "issueId"].map(key => ({
        ...completion, rawOutput: { ...committed, interaction: { ...committed.interaction, [key]: "" } },
      }))]) expect(isHermesCommittedHumanInputCompletion(event, "run")).toBe(false);
    expect(isHermesCommittedHumanInputCompletion({ ...completion, rawOutput: committed }, "other-run")).toBe(false);
    expect(isHermesCommittedHumanInputCompletion({ ...completion, title: completion.title + ": Choose the color", rawOutput: committed }, "run")).toBe(true);
    expect(isHermesCommittedHumanInputCompletion({ ...completion, title: completion.title + "_other", rawOutput: committed }, "run")).toBe(false);
    expect(isHermesCommittedHumanInputCompletion({ ...completion, rawOutput: { ...committed,
      interaction: { ...committed.interaction, kind: "future_interaction" } } }, "run")).toBe(false);
  });
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
  it("preserves estimated-cost provenance without inventing billed cost", async () => {
    const events = await adapter().notification("_hermes/usage", { version: 1, sessionId: "session", tokens: "reported", cost: "estimated", estimatedUsd: 0.012 });
    events.forEach(validateAcpxRichEvent);
    expect(events[0]?.payload.category).toBe("hermes_usage_provenance");
    expect(JSON.stringify(events)).toContain("unverified");
  });
  it("passes structured billing to the owned accounting callback separately from display events", async () => {
    const receipts: unknown[] = [];
    const owned = createAcpxProfileExtensionAdapter("hermes", { sessionId: "session", turnId: "turn", workspacePath: "/workspace",
      onBilling: receipt => { receipts.push(receipt); } })!;
    const billing = { schema: "paperclip.usage.billing/v1", source: "provider_reported", biller: "openrouter", currency: "USD",
      complete: true, requestCount: 2, reportedRequestCount: 2, amountUsd: 0.0042, amountUsdExact: "0.004200000" };
    const events = await owned.notification("_hermes/usage", { version: 1, sessionId: "session", tokens: "reported", cost: "unavailable", billing });
    events.forEach(validateAcpxRichEvent);
    expect(receipts).toEqual([billing]);
    expect(events[0]?.payload.summary).toContain("OpenRouter reports");
    await expect(owned.notification("_hermes/usage", { version: 1, sessionId: "other", tokens: "reported", cost: "unavailable", billing })).rejects.toThrow();
    await expect(adapter().notification("_hermes/usage", { version: 1, sessionId: "session", tokens: "reported", cost: "unavailable", billing })).rejects.toThrow("not negotiated");
  });
});
