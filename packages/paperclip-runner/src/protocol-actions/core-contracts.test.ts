import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PAPERCLIP_CORE_PROTOCOL_ACTIONS } from "./core.js";
import { requestHumanInputExamples } from "./request-human-input.js";

describe("core Paperclip protocol action contracts", () => {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: false });

  it("advertises a complete typed form for mixed text and choice questions", () => {
    const action = PAPERCLIP_CORE_PROTOCOL_ACTIONS.find(action => action.id === "request_human_input")!;
    const payload = { version: 1, questionSet: { schema: "paperclip.question_set.v1", questions: [
      { id: "repo", prompt: "Repository URL?", required: true, answerMode: "text" },
      { id: "scope", prompt: "Review scope?", required: true, answerMode: "single_select", options: [{ id: "all", label: "All changes" }, { id: "selected", label: "Selected changes" }] },
    ] } };
    for (const schema of [action.live!.descriptor.inputSchema, action.scenario!.descriptor.inputSchema]) {
      const input = { ...action.examples.call.input, interactionKind: "questions", payload };
      if (schema === action.scenario!.descriptor.inputSchema) delete (input as { idempotencyKey?: string }).idempotencyKey;
      expect(ajv.validate(schema, input), JSON.stringify(ajv.errors)).toBe(true);
      expect(ajv.validate(schema, { ...input, payload: undefined })).toBe(false);
      expect(ajv.validate(schema, { ...input, payload: { version: 1 } })).toBe(false);
      expect(ajv.validate(schema, { ...input, payload: { version: 1, questionSet: { ...payload.questionSet, questions: [{ ...payload.questionSet.questions[0], options: [{ id: "a", label: "A" }] }] } } })).toBe(false);
    }
    expect(action.documentation.description).not.toContain("questions for choices");
  });

  it("delivers schema-valid question and confirmation invocation examples", () => {
    const action = PAPERCLIP_CORE_PROTOCOL_ACTIONS.find(action => action.id === "request_human_input")!;
    const schema = action.live!.descriptor.inputSchema;
    for (const input of Object.values(requestHumanInputExamples)) {
      expect(action.live!.descriptor.description).toContain(JSON.stringify(input));
      expect(ajv.validate(schema, input), JSON.stringify(ajv.errors)).toBe(true);
    }
    const questions = requestHumanInputExamples.questions;
    expect(ajv.validate(schema, { ...questions, payload: { version: 1 } })).toBe(false);
  });

  it("accepts the payload version forms models naturally send, because Paperclip stores version 1 itself", () => {
    // Recorded opencode/deepseek runs sent payload.version as the string "1" (or
    // omitted it after the rejection) and every call failed with
    // "/payload/version must be equal to constant". The server overwrites the
    // stored payload version with 1, so the tool must not reject these forms.
    const action = PAPERCLIP_CORE_PROTOCOL_ACTIONS.find(action => action.id === "request_human_input")!;
    const { questions, confirmation } = requestHumanInputExamples;
    const questionSet = questions.payload.questionSet;
    for (const schema of [action.live!.descriptor.inputSchema, action.scenario!.descriptor.inputSchema]) {
      const strip = (input: Record<string, unknown>) => {
        if (schema !== action.scenario!.descriptor.inputSchema) return input;
        const { idempotencyKey: _key, ...rest } = input;
        return rest;
      };
      for (const payload of [{ version: 1, questionSet }, { version: "1", questionSet }, { questionSet }]) {
        expect(ajv.validate(schema, strip({ ...questions, payload })), JSON.stringify(ajv.errors)).toBe(true);
      }
      expect(ajv.validate(schema, strip({ ...confirmation, payload: { version: "1", supersedeOnUserComment: false } })), JSON.stringify(ajv.errors)).toBe(true);
      // An unknown protocol version and a payload without any question form still fail.
      expect(ajv.validate(schema, strip({ ...questions, payload: { version: 2, questionSet } }))).toBe(false);
      expect(ajv.validate(schema, strip({ ...questions, payload: { version: 1 } }))).toBe(false);
    }
  });

  it("tells agents to batch independent questions into one card instead of asking them one by one", () => {
    const action = PAPERCLIP_CORE_PROTOCOL_ACTIONS.find(action => action.id === "request_human_input")!;
    const description = action.live!.descriptor.description;
    // Execution agents read "For one question at a time, ask only the next unanswered
    // question" as a rule and posted five sequential cards for five independent inputs.
    expect(description).not.toContain("For one question at a time");
    expect(description).toContain("ask them together in one questions card");
    expect(description).toContain("only when it depends on an earlier answer");
    // A user who explicitly asks for one question at a time is still honored.
    expect(description).toContain("If the user asks for one question at a time, ask only the next unanswered question");
  });

  it("keeps the live input tool's guidance consistent with conversational confirmation recording", () => {
    const action = PAPERCLIP_CORE_PROTOCOL_ACTIONS.find(action => action.id === "request_human_input")!;
    expect(action.live!.descriptor.description).toBe(action.documentation.description);
    expect(action.live!.descriptor.description).toContain("resolve-from-comment");
    expect(action.live!.descriptor.description).toContain("resolver permissions");
    expect(action.live!.descriptor.description).not.toContain("Never infer answers, answer your own card");
  });

  it.each(PAPERCLIP_CORE_PROTOCOL_ACTIONS.map((action) => [action.id, action] as const))(
    "%s has immutable metadata and schema-valid examples",
    (operationId, action) => {
      expect(action.canonical.operationId).toBe(operationId);
      expect(action.canonical.placement).toBe("always_agent_tool");
      expect(action.examples.call.operationId).toBe(operationId);
      expect(action.examples.success.operationId).toBe(operationId);
      expect(Object.isFrozen(action)).toBe(true);
      expect(Object.isFrozen(action.canonical)).toBe(true);

      expect(action.live !== null || action.scenario !== null).toBe(true);

      if (action.live !== null) {
        expect(
          ajv.validate(action.live.descriptor.inputSchema, action.examples.call.input),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(action.live.descriptor.outputSchema, action.examples.success.result),
          JSON.stringify(ajv.errors),
        ).toBe(true);
      }

      if (action.scenario !== null) {
        expect(action.scenario.successExample.operationId).toBe(operationId);
        const scenarioProperties = action.scenario.descriptor.inputSchema.properties ?? {};
        const callEntries = Object.entries(action.examples.call.input);
        const outOfBandKeys = callEntries
          .map(([key]) => key)
          .filter((key) => !(key in scenarioProperties));
        // Scenario mutation idempotency is carried by the invocation envelope,
        // not the operation input. No other example field may be omitted.
        expect(outOfBandKeys).toEqual(
          "idempotencyKey" in action.examples.call.input ? ["idempotencyKey"] : [],
        );
        const scenarioInput = Object.fromEntries(
          callEntries.filter(([key]) => key !== "idempotencyKey"),
        );
        expect(
          ajv.validate(action.scenario.descriptor.inputSchema, scenarioInput),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        expect(
          ajv.validate(
            action.scenario.descriptor.outputSchema,
            action.scenario.successExample,
          ),
          JSON.stringify(ajv.errors),
        ).toBe(true);
      }
    },
  );
});
