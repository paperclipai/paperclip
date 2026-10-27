import { describe, expect, it } from "vitest";
import { expectedFixtureFeedback, feedbackPersistenceDigest, gradeFeedbackPersistence } from "./feedback-persistence.js";
import { runnerMatrix, runnerTasks, suiteDefinitionHash } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

function fixture() {
  const nonce = "fixture-nonce", bodies = expectedFixtureFeedback(nonce);
  return { nonce, companyId: "company", agentId: "agent", taskId: "task", runIds: ["run"],
    evidence: { version: 1, companyId: "company", summary: { collection: "complete", invocationCollection: "complete" },
      entries: (["complaint", "suggestion"] as const).map(kind => ({ id: kind, kind, body: bodies[kind],
        agent: { id: "agent" }, task: { id: "task" }, runId: "run" })),
      invocations: (["complaint", "suggestion"] as const).map(kind => ({ callId: `${kind}-call`, kind, runId: "run", outcome: "completed" })),
    },
  };
}

describe("feedback persistence oracle", () => {
  it("changes the suite hash when the inherited prompt or matchers change", () => {
    const base = runnerTasks.find(task => task.id === "message-marker")!;
    const suite = runnerMatrix.find(execution => execution.suite.id === "feedback-persistence")!.suite;
    const baseline = suiteDefinitionHash(suite);
    expect(suite.definitionMetadata?.sourceDigest).toBe(feedbackPersistenceDigest(base));
    for (const changed of [
      { ...base, buildPrompt: () => "A different completion contract" },
      { ...base, buildMatchers: () => [] },
    ]) {
      expect(suiteDefinitionHash({ ...suite, definitionMetadata: {
        ...suite.definitionMetadata, sourceDigest: feedbackPersistenceDigest(changed),
      } })).not.toBe(baseline);
    }
  });
  it("accepts independently retained bodies with same-run real tool receipts", () => {
    expect(gradeFeedbackPersistence(fixture()).every(check => check.passed)).toBe(true);
  });
  it.each([
    ["missing saved evidence", (f: ReturnType<typeof fixture>) => { f.evidence.entries = []; }],
    ["prose without tool receipts", (f: ReturnType<typeof fixture>) => { f.evidence.invocations = []; }],
    ["wrong saved body", (f: ReturnType<typeof fixture>) => { f.evidence.entries[0]!.body = "submitted successfully"; }],
    ["foreign company", (f: ReturnType<typeof fixture>) => { f.evidence.companyId = "other"; }],
    ["foreign task", (f: ReturnType<typeof fixture>) => { f.evidence.entries[0]!.task.id = "other"; }],
    ["foreign agent", (f: ReturnType<typeof fixture>) => { f.evidence.entries[0]!.agent.id = "other"; }],
    ["foreign run", (f: ReturnType<typeof fixture>) => { f.evidence.entries[0]!.runId = "other"; }],
    ["unrelated successful receipt", (f: ReturnType<typeof fixture>) => { f.evidence.invocations[0]!.runId = "other"; }],
    ["failed tool", (f: ReturnType<typeof fixture>) => { f.evidence.invocations[0]!.outcome = "failed"; }],
    ["partial collection", (f: ReturnType<typeof fixture>) => { f.evidence.summary.collection = "partial"; }],
    ["partial invocation scan", (f: ReturnType<typeof fixture>) => { f.evidence.summary.invocationCollection = "partial"; }],
    ["duplicate submission", (f: ReturnType<typeof fixture>) => { f.evidence.invocations.push(f.evidence.invocations[0]!); }],
    ["duplicate saved row", (f: ReturnType<typeof fixture>) => { f.evidence.entries.push(f.evidence.entries[0]!); }],
  ] as const)("rejects %s", (_name, mutate) => {
    const f = fixture(); mutate(f);
    expect(gradeFeedbackPersistence(f).some(check => !check.passed)).toBe(true);
  });
  it("fails closed on unavailable or malformed retained evidence", () => {
    for (const evidence of [undefined, null, {}, { entries: [null], invocations: [null] }]) {
      expect(gradeFeedbackPersistence({ ...fixture(), evidence }).some(check => !check.passed)).toBe(true);
    }
  });
  it("registers only two explicit local native cases with no automatic retry", () => {
    const selected = selectRunnerExecutions(parseRunnerSelectors(["--suite", "feedback-persistence"]));
    expect(selected.map(execution => execution.id)).toEqual([
      "feedback-persistence.runner-codex.local.complaint-and-suggestion",
      "feedback-persistence.runner-acpx-claude.local.complaint-and-suggestion",
    ]);
    expect(selected.every(execution => execution.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(runnerMatrix).toEqual(expect.arrayContaining(selected));
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(execution => execution.suite.id === "feedback-persistence")).toBe(false);
  });
});
