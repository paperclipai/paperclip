import { describe, expect, it } from "vitest";

import type { HarnessRuntimeRequest } from "../../contracts/harness-driver.js";
import {
  createCodexQuestionResponseContext,
  hasCodexQuestionForm,
  normalizeCodexQuestionSet as normalizeCodexQuestionSetWithContext,
  runtimeRequestKind,
  runtimeRequestProtocolPayload,
  runtimeRequestResponse as runtimeRequestResponseWithContext,
} from "./codex-question-adapter.js";

function normalizeCodexQuestionSet(
  method: string,
  params: Record<string, unknown>,
) {
  return normalizeCodexQuestionSetWithContext(
    method,
    params,
    createCodexQuestionResponseContext(),
  );
}

function runtimeRequestResponse(
  request: Parameters<typeof runtimeRequestResponseWithContext>[0],
  resolution: Parameters<typeof runtimeRequestResponseWithContext>[1],
) {
  return runtimeRequestResponseWithContext(
    request,
    resolution,
    createCodexQuestionResponseContext(),
  );
}

describe("Codex structured question adapter", () => {
  it("normalizes requestUserInput without inventing required answers", () => {
    const questions = normalizeCodexQuestionSet("item/tool/requestUserInput", {
      title: "Deployment",
      questions: [
        {
          id: "environment",
          header: "Target",
          question: "Where should we deploy?",
          options: [
            { id: "staging", label: "Staging", description: "Safe first step" },
            { id: "production", label: "Production" },
          ],
        },
        {
          id: "regions",
          question: "Which regions?",
          multiSelect: true,
          options: [{ id: "us", label: "US" }, { id: "eu", label: "EU" }],
          required: true,
        },
        {
          id: "notes",
          question: "Anything else?",
          minLength: 2,
          maxLength: 500,
        },
      ],
    });

    expect(questions).toMatchObject({
      schema: "paperclip.question_set.v1",
      title: "Deployment",
      questions: [
        { id: "environment", required: false, answerMode: "single_select" },
        { id: "regions", required: true, answerMode: "multi_select" },
        {
          id: "notes",
          required: false,
          answerMode: "text",
          textValidation: { minLength: 2, maxLength: 500 },
        },
      ],
    });
    expect(runtimeRequestKind("item/tool/requestUserInput")).toBe("user_input");
    expect(hasCodexQuestionForm("item/tool/requestUserInput", { questions: [] })).toBe(true);
  });

  it("fails closed on a malformed native question form", () => {
    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [
        { id: "duplicate", question: "First?" },
        { id: "duplicate", question: "Second?" },
      ],
    })).toThrow("must be unique");
  });

  it("keeps explicit question ids distinct from generated question ids", () => {
    const questions = normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [
        { id: "question-2", question: "First?" },
        { question: "Second?" },
        { id: "question-1", question: "Third?" },
      ],
    });

    expect(questions?.questions.map((question) => question.id)).toEqual([
      "question-2",
      "question-3",
      "question-1",
    ]);
  });

  it("keeps explicit option ids distinct from generated option ids", () => {
    const responseContext = createCodexQuestionResponseContext();
    const input = normalizeCodexQuestionSetWithContext("tool/requestUserInput", {
      questions: [{
        id: "target",
        question: "Where?",
        options: [
          { id: "option-2", label: "First" },
          { label: "Second" },
          { id: "question-1", label: "Third" },
          { id: "option-1", label: "Fourth" },
        ],
      }],
    }, responseContext)!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-distinct-option-ids",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };

    expect(input.questions[0]?.options?.map((option) => option.id)).toEqual([
      "option-2",
      "option-3",
      "question-1",
      "option-1",
    ]);
    expect(runtimeRequestResponseWithContext(request, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { target: { selectedOptionIds: ["question-1", "option-1"] } },
      },
    }, responseContext)).toEqual({
      answers: { target: { answers: ["Third", "Fourth"] } },
    });
  });

  it("returns native option values instead of their display labels", () => {
    const responseContext = createCodexQuestionResponseContext();
    const input = normalizeCodexQuestionSetWithContext("tool/requestUserInput", {
      questions: [{
        id: "environment",
        question: "Where?",
        options: [{
          id: "production",
          label: "Production (recommended)",
          value: "prod-us-east-1",
        }],
      }],
    }, responseContext)!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-native-option-value",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };

    expect(input.questions[0]?.options?.[0]?.label).toBe(
      "Production (recommended)",
    );
    expect(runtimeRequestResponseWithContext(request, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { selectedOptionIds: ["production"] },
        },
      },
    }, responseContext)).toEqual({
      answers: { environment: { answers: ["prod-us-east-1"] } },
    });
  });

  it("serializes non-string native option values instead of discarding them", () => {
    const responseContext = createCodexQuestionResponseContext();
    const input = normalizeCodexQuestionSetWithContext("tool/requestUserInput", {
      questions: [{
        id: "settings",
        question: "Which settings?",
        multiSelect: true,
        options: [
          { id: "retries", label: "Three retries", value: 3 },
          { id: "enabled", label: "Disabled", value: false },
          {
            id: "policy",
            label: "Strict policy",
            value: { mode: "strict", retries: 2 },
          },
        ],
      }],
    }, responseContext)!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-non-string-option-values",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };

    expect(runtimeRequestResponseWithContext(request, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          settings: {
            selectedOptionIds: ["retries", "enabled", "policy"],
          },
        },
      },
    }, responseContext)).toEqual({
      answers: {
        settings: {
          answers: ["3", "false", '{"mode":"strict","retries":2}'],
        },
      },
    });
  });

  it("fails closed instead of truncating oversized native forms", () => {
    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: Array.from({ length: 65 }, (_, index) => ({
        id: `question-${index}`,
        question: `Question ${index}`,
      })),
    })).toThrow("Codex question form exceeds 64 questions");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "oversized-options",
        question: "Choose one",
        options: Array.from({ length: 129 }, (_, index) => ({
          id: `option-${index}`,
          label: `Option ${index}`,
        })),
      }],
    })).toThrow("Codex question exceeds 128 options");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "q".repeat(161),
        question: "Choose one",
      }],
    })).toThrow("Codex question identifier exceeds 160 characters");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "oversized-label",
        question: "Choose one",
        options: [{ id: "option-1", label: "x".repeat(1_001) }],
      }],
    })).toThrow("Codex option label exceeds 1000 characters");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      description: "x".repeat(4_001),
      questions: [{ id: "prompt", question: "Choose one" }],
    })).toThrow("Codex form description exceeds 4000 characters");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{ id: "prompt", question: "x".repeat(4_001) }],
    })).toThrow("Codex question prompt exceeds 4000 characters");

    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "option-description",
        question: "Choose one",
        options: [{
          id: "option-1",
          label: "One",
          description: "x".repeat(4_001),
        }],
      }],
    })).toThrow("Codex option description exceeds 4000 characters");

    const oversizedSecret = `Bearer ${"a".repeat(4_001)}`;
    for (const params of [
      {
        description: oversizedSecret,
        questions: [{ id: "form", question: "Choose one" }],
      },
      {
        questions: [{
          id: "question",
          question: "Choose one",
          description: oversizedSecret,
        }],
      },
      {
        questions: [{
          id: "option",
          question: "Choose one",
          options: [{ id: "option-1", label: "One", description: oversizedSecret }],
        }],
      },
    ]) {
      expect(() => normalizeCodexQuestionSet("tool/requestUserInput", params))
        .toThrow("exceeds 4000 characters");
    }

    const boundaryPrefix = "Bearer a ";
    const boundaryDescription = `${boundaryPrefix}${"x".repeat(4_000 - boundaryPrefix.length)}`;
    expect(() => normalizeCodexQuestionSet("tool/requestUserInput", {
      description: boundaryDescription,
      questions: [{ id: "form", question: "Choose one" }],
    })).toThrow("Codex form description exceeds 4000 characters after redaction");

    const preservedTail = "description-tail";
    const safeDescription = `${boundaryPrefix}${"x".repeat(3_900)}${preservedTail}`;
    const safeForm = normalizeCodexQuestionSet("tool/requestUserInput", {
      description: safeDescription,
      questions: [{ id: "form", question: "Choose one" }],
    });
    expect(safeForm?.description).toContain("Bearer [REDACTED]");
    expect(safeForm?.description.endsWith(preservedTail)).toBe(true);

    expect(() => normalizeCodexQuestionSet("mcpServer/elicitation/request", {
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            oneOf: [{ const: "one", title: "x".repeat(1_001) }],
          },
        },
      },
    })).toThrow("Codex option label exceeds 1000 characters");

    expect(() => normalizeCodexQuestionSet("mcpServer/elicitation/request", {
      requestedSchema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
          `property-${index}`,
          { type: "string" },
        ])),
      },
    })).toThrow("Codex question form exceeds 64 questions");
  });

  it("maps canonical answers back to Codex user-input and elicitation shapes", () => {
    const input = normalizeCodexQuestionSet("tool/requestUserInput", {
      questions: [{
        id: "environment",
        question: "Where?",
        options: [{ id: "staging", label: "Staging" }],
      }],
    })!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-1",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };
    const response = {
      schema: "paperclip.question_response.v1" as const,
      answers: { environment: { selectedOptionIds: ["staging"] } },
    };

    expect(runtimeRequestResponse(request, { action: "submit", response })).toEqual({
      answers: { environment: { answers: ["Staging"] } },
    });
    expect(runtimeRequestProtocolPayload(request)).toMatchObject({
      schema: "paperclip.runtime_request.v2",
      requestKind: "runtime",
      requestId: "request-1",
      type: "input",
      input,
    });

    const elicitationInput = normalizeCodexQuestionSet("mcpServer/elicitation/request", {
      requestedSchema: {
        type: "object",
        properties: {
          retries: { type: "integer", title: "Retries", minimum: 0, maximum: 5 },
          enabled: { type: "boolean", title: "Enabled" },
        },
        required: ["retries"],
      },
    })!;
    const elicitationRequest: HarnessRuntimeRequest = {
      ...request,
      requestId: "request-2",
      requestKind: "elicitation",
      method: "mcpServer/elicitation/request",
      details: {
        requestedSchema: {
          type: "object",
          properties: {
            retries: { type: "integer" },
            enabled: { type: "boolean" },
          },
        },
      },
      input: elicitationInput,
    };
    expect(runtimeRequestResponse(elicitationRequest, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          retries: { text: "3" },
          enabled: { selectedOptionIds: ["true"] },
        },
      },
    })).toEqual({
      action: "accept",
      content: { retries: 3, enabled: true },
      _meta: null,
    });
  });

  it("keeps native option answers private while redacting their display labels", () => {
    const responseContext = createCodexQuestionResponseContext();
    const input = normalizeCodexQuestionSetWithContext("tool/requestUserInput", {
      questions: [{
        id: "credential",
        question: "Choose the configured credential.",
        options: [{ id: "configured", label: "token=native-option-secret" }],
      }],
    }, responseContext)!;
    const request: HarnessRuntimeRequest = {
      requestId: "request-private-option",
      requestKind: "user_input",
      method: "tool/requestUserInput",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "Codex requests user input.",
      details: {},
      input,
      origin: { adapter: "codex", method: "tool/requestUserInput" },
    };

    expect(JSON.stringify(input)).not.toContain("native-option-secret");
    expect(input.questions[0]?.options?.[0]?.label).toContain("[REDACTED]");
    const rehydratedRequest = structuredClone(request);
    expect(runtimeRequestResponseWithContext(rehydratedRequest, {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { credential: { selectedOptionIds: ["configured"] } },
      },
    }, responseContext)).toEqual({
      answers: { credential: { answers: ["token=native-option-secret"] } },
    });
  });

  it("redacts credential text from every MCP elicitation display field", () => {
    const responseContext = createCodexQuestionResponseContext();
    const input = normalizeCodexQuestionSetWithContext("mcpServer/elicitation/request", {
      message: "Authorization: Bearer message-secret",
      requestedSchema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            title: "Authorization: Bearer property-title-secret",
            description: "token=property-secret",
            oneOf: [
              {
                const: "staging",
                title: "token=option-title-secret",
                description: "password=option-secret",
              },
              { const: "password=option-value-secret" },
            ],
          },
        },
      },
    }, responseContext);

    expect(input).toMatchObject({
      description: expect.stringContaining("[REDACTED]"),
      questions: [{
        header: expect.stringContaining("[REDACTED]"),
        prompt: expect.stringContaining("[REDACTED]"),
        helpText: expect.stringContaining("[REDACTED]"),
        options: [
          {
            label: expect.stringContaining("[REDACTED]"),
            description: expect.stringContaining("[REDACTED]"),
          },
          { label: expect.stringContaining("[REDACTED]") },
        ],
      }],
    });
    expect(JSON.stringify(input)).not.toMatch(
      /message-secret|property-title-secret|property-secret|option-title-secret|option-value-secret|option-secret/,
    );
    const request: HarnessRuntimeRequest = {
      requestId: "request-private-elicitation-option",
      requestKind: "elicitation",
      method: "mcpServer/elicitation/request",
      turnId: "turn-1",
      itemId: "item-1",
      status: "pending",
      prompt: "A tool requests structured user input.",
      details: {},
      input: input!,
      origin: { adapter: "codex", method: "mcpServer/elicitation/request" },
    };
    expect(runtimeRequestResponseWithContext(structuredClone(request), {
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { environment: { selectedOptionIds: ["option-2"] } },
      },
    }, responseContext)).toEqual({
      action: "accept",
      content: { environment: "password=option-value-secret" },
      _meta: null,
    });
  });
});
