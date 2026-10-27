import { describe, expect, it } from "vitest";
import { AGENT_COMMENTARY_MAX_LENGTH, submitAgentCommentarySchema } from "./validators/agent-commentary.js";

describe("agent commentary input", () => {
  const input = { kind: "complaint", body: "WHY 😭\n\nThis tool again.", idempotencyKey: "one" };
  it("preserves free-form text and the document-sized ceiling", () => {
    expect(submitAgentCommentarySchema.parse(input)).toEqual(input);
    const body = "🙂".repeat(AGENT_COMMENTARY_MAX_LENGTH / 2);
    expect(submitAgentCommentarySchema.parse({ ...input, kind: "suggestion", body }).body).toBe(body);
    expect(submitAgentCommentarySchema.safeParse({ ...input, body: body + "x" }).success).toBe(false);
  });
  it.each([
    { body: " \n\t" }, { kind: "other" }, { idempotencyKey: "" }, { idempotencyKey: "x".repeat(241) },
    { agentId: "spoof" }, { companyId: "spoof" }, { runId: "spoof" }, { issueId: "spoof" }, { category: "tooling" },
  ])("rejects invalid or caller-owned fields: %j", (change) => {
    expect(submitAgentCommentarySchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
