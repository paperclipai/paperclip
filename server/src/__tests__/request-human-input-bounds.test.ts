import { Ajv2020 } from "ajv/dist/2020.js";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { requestHumanInputAction } from "../../../packages/paperclip-runner/src/protocol-actions/request-human-input.js";

// The runner advertises request_human_input bounds to the model, and the server
// stores `title` and `prompt` (as `summary` and, for confirmations, as
// `payload.prompt`). An input the tool accepts must also pass the create schema,
// or the call fails after the agent did everything the tool told it to.
describe("request_human_input advertised bounds", () => {
  const schema = requestHumanInputAction.live.descriptor.inputSchema as {
    properties: Record<string, { maxLength: number }>;
  };
  const titleMax = schema.properties.title.maxLength;
  const promptMax = schema.properties.prompt.maxLength;
  const title = "t".repeat(titleMax);
  const prompt = "p".repeat(promptMax);
  const questionSet = {
    schema: "paperclip.question_set.v1",
    questions: [{
      id: "q1",
      prompt: "Pick one",
      required: true,
      answerMode: "single_select",
      options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    }],
  };

  it("accepts the longest title and prompt the tool allows", () => {
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
    const input = {
      idempotencyKey: "bounds",
      interactionKind: "questions",
      title,
      prompt,
      continuationPolicy: "wake_assignee",
      payload: { version: 1, questionSet },
    };
    expect(ajv.validate(schema, input), JSON.stringify(ajv.errors)).toBe(true);
    expect(ajv.validate(schema, { ...input, prompt: `${prompt}p` })).toBe(false);
    expect(ajv.validate(schema, { ...input, title: `${title}t` })).toBe(false);
  });

  it("creates a questions card at the advertised maximum", () => {
    const parsed = createIssueThreadInteractionSchema.safeParse({
      kind: "ask_user_questions",
      title,
      summary: prompt,
      continuationPolicy: "wake_assignee",
      payload: { version: 1, questionSet, prompt },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("creates a confirmation card at the advertised maximum", () => {
    const parsed = createIssueThreadInteractionSchema.safeParse({
      kind: "request_confirmation",
      title,
      summary: prompt,
      payload: { version: 1, prompt },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
