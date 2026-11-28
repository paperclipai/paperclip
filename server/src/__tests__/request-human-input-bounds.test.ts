import { Ajv2020 } from "ajv/dist/2020.js";
import {
  capabilitySemanticToolDescriptor,
  paperclipSemanticAction,
} from "@paperclipai/paperclip-runner";
import { createIssueThreadInteractionSchema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";

describe("request_human_input advertised bounds", () => {
  const liveSchema = capabilitySemanticToolDescriptor("request_human_input")!.inputSchema as {
    properties: Record<string, { maxLength: number }>;
  };
  const catalogSchema = paperclipSemanticAction("request_human_input")!.inputSchema as {
    properties: Record<string, { maxLength: number }>;
  };
  const titleMax = liveSchema.properties.title.maxLength;
  const promptMax = liveSchema.properties.prompt.maxLength;
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

  it("advertises identical title and prompt bounds on both runner tool surfaces and rejects +1", () => {
    expect(titleMax).toBe(240);
    expect(promptMax).toBe(1000);
    expect(catalogSchema.properties.title.maxLength).toBe(titleMax);
    expect(catalogSchema.properties.prompt.maxLength).toBe(promptMax);
    const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });
    const input = {
      idempotencyKey: "bounds",
      interactionKind: "questions",
      title,
      prompt,
      continuationPolicy: "wake_assignee",
      payload: { version: 1, questionSet },
    };
    for (const schema of [liveSchema, catalogSchema]) {
      expect(ajv.validate(schema, input), JSON.stringify(ajv.errors)).toBe(true);
      expect(ajv.validate(schema, { ...input, title: `${title}t` })).toBe(false);
      expect(ajv.validate(schema, { ...input, prompt: `${prompt}p` })).toBe(false);
    }
  });

  const serverFixtures = [
    [
      "ask_user_questions",
      (t: string, p: string) => ({
        kind: "ask_user_questions" as const,
        title: t,
        summary: p,
        continuationPolicy: "wake_assignee" as const,
        payload: { version: 1 as const, questionSet },
      }),
      ["summary"],
    ],
    [
      "request_confirmation",
      (t: string, p: string) => ({
        kind: "request_confirmation" as const,
        title: t,
        summary: p,
        payload: { version: 1 as const, prompt: p },
      }),
      ["summary", "payload.prompt"],
    ],
    [
      "request_checkbox_confirmation",
      (t: string, p: string) => ({
        kind: "request_checkbox_confirmation" as const,
        title: t,
        summary: p,
        payload: {
          version: 1 as const,
          prompt: p,
          options: [{ id: "opt-1", label: "Option 1" }],
        },
      }),
      ["summary", "payload.prompt"],
    ],
    [
      "request_item_verdicts",
      (t: string, p: string) => ({
        kind: "request_item_verdicts" as const,
        title: t,
        summary: p,
        payload: {
          version: 1 as const,
          prompt: p,
          items: [{ id: "item-1", label: "Item 1" }],
        },
      }),
      ["summary", "payload.prompt"],
    ],
    [
      "suggest_tasks",
      (t: string, p: string) => ({
        kind: "suggest_tasks" as const,
        title: t,
        summary: p,
        payload: {
          version: 1 as const,
          tasks: [{ clientKey: "task-1", title: "Follow-up task" }],
        },
      }),
      ["summary"],
    ],
  ] as const;

  it.each(serverFixtures)(
    "accepts %s at the advertised title/prompt maximums and reports field-level too_big errors at +1",
    (_kind, buildInput, expectedPromptPaths) => {
      const atMax = createIssueThreadInteractionSchema.safeParse(buildInput(title, prompt));
      expect(atMax.success, JSON.stringify(atMax.error?.issues)).toBe(true);

      const overTitle = createIssueThreadInteractionSchema.safeParse(buildInput(`${title}t`, prompt));
      expect(overTitle.success).toBe(false);
      expect(overTitle.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "too_big",
            maximum: titleMax,
            path: ["title"],
          }),
        ]),
      );

      const overPrompt = createIssueThreadInteractionSchema.safeParse(buildInput(title, `${prompt}p`));
      expect(overPrompt.success).toBe(false);
      for (const expectedPath of expectedPromptPaths) {
        expect(overPrompt.error?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "too_big",
              maximum: promptMax,
              path: expectedPath.split("."),
            }),
          ]),
        );
      }
    },
  );
});
