import { questionSetSchema } from "../protocol/generated/schema-bundle.js";

// Inline the protocol's local references so each provider tool schema is
// self-contained, without a second definition of the canonical question form.
const canonicalQuestionSchema = {
  ...questionSetSchema.$defs.question,
  properties: {
    ...questionSetSchema.$defs.question.properties,
    options: { ...questionSetSchema.$defs.question.properties.options, items: questionSetSchema.$defs.option },
    customAnswer: questionSetSchema.$defs.customAnswer,
    textValidation: questionSetSchema.$defs.textValidation,
  },
} as const;

export const questionPayloadSchema = {
  type: "object",
  description: "Kind-specific interaction data. For questions, send version:1 and one complete questionSet containing every text and choice question. Paperclip generates compatibility questions. Each canonical question needs id, prompt, required, and answerMode: text, single_select, or multi_select. Text questions have no options or customAnswer. Choice questions need at least two meaningful options with id/label. Use customAnswer:{enabled:true} for an optional written answer to a choice question. Legacy questions remain supported; if both representations are supplied, they must describe the same complete form. Keep IDs stable across retries. For required output quality review, confirmation payload must contain qualityReview:{key:<required deliverable key>} and target:{type:issue_document,key:<output document key>,revisionId:<saved revision>} or target:{type:issue_attachment,attachmentId,assetId,sha256}. For item_verdicts put qualityReview and target on each reviewed item. Keep supersedeOnUserComment:false inside payload. Never discard these bindings to work around a validation error; an unbound confirmation cannot satisfy required quality review.",
  properties: {
    version: { const: 1 },
    qualityReview: {
      type: "object", required: ["key"],
      properties: { key: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" } },
      additionalProperties: false,
    },
    target: {
      type: ["object", "null"],
      description: "Exact registered output identity. Use an output document revision or immutable attachment for quality review; a plan does not qualify.",
      additionalProperties: true,
    },
    supersedeOnUserComment: { type: "boolean" },
    questionSet: {
      type: "object",
      required: questionSetSchema.required,
      properties: {
        ...questionSetSchema.properties,
        questions: { ...questionSetSchema.properties.questions, items: canonicalQuestionSchema },
      },
      additionalProperties: false,
    },
    questions: {
      type: "array", minItems: 1, maxItems: 64,
      items: {
        type: "object", required: ["id", "prompt", "selectionMode", "options"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 160 },
          prompt: { type: "string", minLength: 1, maxLength: 4000 },
          selectionMode: { enum: ["single", "multi"] },
          required: { type: "boolean" },
          options: {
            type: "array", minItems: 1, maxItems: 129,
            items: {
              type: "object", required: ["id", "label"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 160 },
                label: { type: "string", minLength: 1, maxLength: 1000 },
                freeText: { type: "boolean" },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
} as const;

export const questionsPayloadRequirement = {
  if: { properties: { interactionKind: { const: "questions" } }, required: ["interactionKind"] },
  then: {
    required: ["payload"],
    properties: {
      payload: { required: ["version"], anyOf: [{ required: ["questionSet"] }, { required: ["questions"] }] },
    },
  },
} as const;
