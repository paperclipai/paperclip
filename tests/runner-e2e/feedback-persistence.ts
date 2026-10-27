import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RunnerTaskFixture } from "./types.js";

export const FEEDBACK_PERSISTENCE_SUITE = "feedback-persistence";
const feedbackPersistenceSourceDigest = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .update(readFileSync(new URL("./catalog.ts", import.meta.url)))
  .update(readFileSync(new URL("./feedback.ts", import.meta.url)))
  .update(readFileSync(new URL("./runner.spec.ts", import.meta.url)))
  .digest("hex");

export function feedbackPersistenceDigest(base: RunnerTaskFixture) {
  return createHash("sha256").update(feedbackPersistenceSourceDigest)
    .update(JSON.stringify(base, (_key, value) => typeof value === "function" ? value.toString() : value))
    .digest("hex");
}

export function expectedFixtureFeedback(nonce: string) {
  return {
    complaint: `Synthetic eval complaint ${nonce}: the fixture export omitted its receipt. This is test data, not a real product incident.`,
    suggestion: `Synthetic eval suggestion ${nonce}: add a keyboard shortcut to the fixture preview. This is a separate test idea, not a real feature request.`,
  };
}

export function feedbackPersistenceTask(base: RunnerTaskFixture): RunnerTaskFixture {
  return {
    ...base, id: "complaint-and-suggestion", label: "Retain submitted feedback", automaticRetryPolicy: "single_attempt",
    attemptTimeoutMs: { local: 5 * 60_000, daytona: 5 * 60_000 },
    buildPrompt(nonce) {
      const bodies = expectedFixtureFeedback(nonce);
      return [
        "This disposable acceptance task verifies two different feedback tools. Before completing the task, discover the feedback tools and submit exactly one complaint and one suggestion through their real tool-call channel.",
        `Call submit_complaint with body ${JSON.stringify(bodies.complaint)} and idempotencyKey ${JSON.stringify(`complaint-${nonce}`)}.`,
        `Call submit_suggestion with body ${JSON.stringify(bodies.suggestion)} and idempotencyKey ${JSON.stringify(`suggestion-${nonce}`)}.`,
        "Wait for both saved acknowledgments. Do not substitute prose, a task comment, direct API calls, or files for these two tool submissions. These are distinct synthetic items; do not submit additional feedback.",
        base.buildPrompt(nonce),
      ].join("\n");
    },
  };
}

const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function gradeFeedbackPersistence(input: {
  evidence: unknown; nonce: string; companyId: string | undefined; agentId: string | undefined;
  taskId: string | undefined; runIds: string[];
}) {
  const evidence = row(input.evidence), summary = row(evidence.summary);
  const entries = Array.isArray(evidence.entries) ? evidence.entries.map(row) : [];
  const invocations = Array.isArray(evidence.invocations) ? evidence.invocations.map(row) : [];
  const expected = expectedFixtureFeedback(input.nonce);
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  check("complete-retained-evidence", evidence.version === 1 && Boolean(input.companyId)
    && evidence.companyId === input.companyId && summary.collection === "complete" && summary.invocationCollection === "complete",
  "Both collection passes completed and the saved evidence belongs to this company.");
  check("one-of-each", entries.length === 2 && new Set(entries.map(entry => entry.id)).size === 2
    && entries.every(entry => typeof entry.id === "string" && entry.id.length > 0),
  "Exactly two distinct saved feedback records remain after teardown.");
  for (const kind of ["complaint", "suggestion"] as const) {
    const saved = entries.filter(entry => entry.kind === kind);
    const entry = saved[0] ?? {};
    const calls = invocations.filter(call => call.kind === kind);
    check(`${kind}-body-and-attribution`, saved.length === 1 && entry.body === expected[kind]
      && Boolean(input.agentId) && row(entry.agent).id === input.agentId && Boolean(input.taskId)
      && row(entry.task).id === input.taskId && typeof entry.runId === "string" && input.runIds.includes(entry.runId),
    "The independently read saved body has the exact nonce, agent, task, and observed run.");
    check(`${kind}-completed-tool`, calls.length === 1 && calls[0]!.outcome === "completed"
      && typeof calls[0]!.callId === "string" && Boolean(calls[0]!.callId)
      && typeof entry.runId === "string" && calls[0]!.runId === entry.runId,
    "A real completed tool receipt from the same run corroborates the saved feedback.");
  }
  check("only-expected-submissions", invocations.length === 2 && new Set(invocations.map(call => call.callId)).size === 2,
    "There are no duplicate or extra feedback submissions.");
  return checks;
}
