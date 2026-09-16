import { describe, expect, it } from "vitest";

import { normalizeAcpFormElicitation } from "./acp-question-adapter.js";

describe("ACP form question adapter", () => {
  it("normalizes supported fields and restores typed ACP content", () => {
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      message: "Choose deployment settings.",
      requestedSchema: {
        type: "object",
        title: "Deployment",
        required: ["name", "region", "features", "confirmed", "replicas"],
        properties: {
          name: {
            type: "string",
            title: "Name",
            minLength: 2,
            maxLength: 20,
          },
          region: {
            type: "string",
            title: "Region",
            oneOf: [
              {
                const: "us-east-1",
                title: "Virginia",
                description: "Lowest latency for US East.",
              },
              { const: "eu-west-1", title: "Ireland" },
            ],
          },
          features: {
            type: "array",
            title: "Features",
            items: {
              anyOf: [
                { const: "tracing", title: "Tracing" },
                { const: "backups", title: "Backups" },
              ],
            },
          },
          confirmed: { type: "boolean", title: "Confirm" },
          replicas: {
            type: "integer",
            title: "Replicas",
            minimum: 1,
            maximum: 10,
          },
        },
      },
    });

    expect(normalized).not.toBeNull();
    const questionSet = normalized!.questionSet;
    expect(questionSet.title).toBe("Deployment");
    expect(questionSet.description).toContain("Choose deployment settings.");
    expect(
      questionSet.questions.map((question) => question.answerMode),
    ).toEqual([
      "text",
      "single_select",
      "multi_select",
      "single_select",
      "text",
    ]);
    expect(questionSet.questions[1]?.options?.[0]).toMatchObject({
      label: "Virginia",
      description: "Lowest latency for US East.",
    });
    expect(questionSet.questions[4]?.textValidation).toMatchObject({
      inputType: "integer",
      minimum: 1,
      maximum: 10,
    });

    const [name, region, features, confirmed, replicas] = questionSet.questions;
    const response = normalized!.accept({
      schema: "paperclip.question_response.v1",
      answers: {
        [name!.id]: { text: "paperclip" },
        [region!.id]: {
          selectedOptionIds: [region!.options![1]!.id],
        },
        [features!.id]: {
          selectedOptionIds: features!.options!.map((option) => option.id),
        },
        [confirmed!.id]: {
          selectedOptionIds: [confirmed!.options![0]!.id],
        },
        [replicas!.id]: { text: "3" },
      },
    });
    expect(response).toEqual({
      action: "accept",
      content: {
        name: "paperclip",
        region: "eu-west-1",
        features: ["tracing", "backups"],
        confirmed: true,
        replicas: 3,
      },
    });
  });

  it("rejects invalid numeric answers before they reach ACP", () => {
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      message: "How many?",
      requestedSchema: {
        type: "object",
        required: ["count"],
        properties: { count: { type: "integer", minimum: 1 } },
      },
    })!;
    expect(() =>
      normalized.accept({
        schema: "paperclip.question_response.v1",
        answers: {
          [normalized.questionSet.questions[0]!.id]: { text: "1.5" },
        },
      }),
    ).toThrow(/must be a valid integer/);
  });

  it("does not advertise a question shape for URL elicitation", () => {
    expect(
      normalizeAcpFormElicitation({
        mode: "url",
        message: "Authenticate",
      }),
    ).toBeNull();
  });

  it("bounds provider-controlled form and option inventories", () => {
    const tooManyProperties = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `field-${index}`,
        { type: "string" },
      ]),
    );
    expect(() =>
      normalizeAcpFormElicitation({
        mode: "form",
        requestedSchema: { properties: tooManyProperties },
      }),
    ).toThrow(/between 1 and 64/);

    expect(() =>
      normalizeAcpFormElicitation({
        mode: "form",
        requestedSchema: {
          properties: {
            choice: {
              type: "string",
              enum: Array.from({ length: 129 }, (_, index) => `v-${index}`),
            },
          },
        },
      }),
    ).toThrow(/more than 128 options/);
  });

  it("ignores unknown required names before applying field semantics", () => {
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      requestedSchema: {
        type: "object",
        required: [
          ...Array.from({ length: 80 }, (_, index) => `unknown-${index}`),
          "known",
        ],
        properties: { known: { type: "string" } },
      },
    });

    expect(normalized?.questionSet.questions).toEqual([
      expect.objectContaining({ required: true }),
    ]);
  });

  it("preserves property names without allowing prototype mutation", () => {
    const properties = JSON.parse(
      '{"__proto__":{"type":"string","title":"Value"}}',
    );
    const normalized = normalizeAcpFormElicitation({
      mode: "form",
      requestedSchema: {
        required: ["__proto__"],
        properties,
      },
    })!;
    const question = normalized.questionSet.questions[0]!;
    const response = normalized.accept({
      schema: "paperclip.question_response.v1",
      answers: { [question.id]: { text: "safe" } },
    });

    expect(Object.getPrototypeOf(response.content)).toBe(Object.prototype);
    expect(Object.hasOwn(response.content, "__proto__")).toBe(true);
    expect(JSON.stringify(response.content)).toBe('{"__proto__":"safe"}');
  });
});
