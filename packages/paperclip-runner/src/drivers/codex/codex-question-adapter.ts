import type {
  HarnessRuntimeRequest,
  HarnessRuntimeRequestKind,
  HarnessRuntimeRequestResolution,
  PaperclipQuestion,
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  parsePaperclipQuestionSet,
} from "../../contracts/harness-driver.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";

export interface CodexQuestionResponseContext {
  readonly kind: "codex_question_response_context";
}

const NATIVE_OPTION_VALUES = new WeakMap<
  CodexQuestionResponseContext,
  ReadonlyMap<string, ReadonlyMap<string, unknown>>
>();

/** Create one private response context for one provider runtime request. */
export function createCodexQuestionResponseContext(): CodexQuestionResponseContext {
  const context = Object.freeze({
    kind: "codex_question_response_context" as const,
  });
  NATIVE_OPTION_VALUES.set(context, new Map());
  return context;
}

interface NormalizedQuestionOptions {
  options: NonNullable<PaperclipQuestion["options"]>;
  nativeValues: ReadonlyMap<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boundedText(
  value: unknown,
  fallback = "unknown",
  maxCharacters = 1024,
): string {
  const candidate = text(value, fallback);
  return candidate.length <= maxCharacters
    ? candidate
    : `${candidate.slice(0, maxCharacters)}...[truncated]`;
}

export function runtimeRequestKind(method: string): HarnessRuntimeRequestKind | null {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return "command_approval";
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return "file_approval";
  }
  if (method === "item/permissions/requestApproval")
    return "permission_approval";
  if (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput"
  ) {
    return "user_input";
  }
  if (method === "mcpServer/elicitation/request") return "elicitation";
  return null;
}

/**
 * During the v1 migration, input requests that predate structured form data
 * remain opaque runtime requests. Once a provider supplies a native form,
 * however, a malformed/unsupported form must fail closed instead of silently
 * degrading back to the legacy textarea presentation.
 */
export function hasCodexQuestionForm(method: string, params: Record<string, unknown>): boolean {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    return "questions" in params;
  }
  if (method === "mcpServer/elicitation/request") {
    return "requestedSchema" in params || "schema" in params;
  }
  return false;
}

export function runtimeRequestPrompt(
  kind: HarnessRuntimeRequestKind,
  params: Record<string, unknown>,
): string {
  const reason = text(params.reason, text(params.message));
  if (reason.length > 0) return boundedText(redactCodexDiagnostic(reason));
  const labels: Record<HarnessRuntimeRequestKind, string> = {
    command_approval: "Codex requests approval to run a command.",
    file_approval: "Codex requests approval to change files.",
    permission_approval: "Codex requests additional runtime permissions.",
    user_input: "Codex requests user input.",
    elicitation: "A tool requests structured user input.",
  };
  return labels[kind];
}

function stableQuestionId(value: unknown, index: number): string {
  const candidate = text(value).trim();
  if (candidate.length > 160) {
    throw new Error("Codex question identifier exceeds 160 characters");
  }
  return candidate.length > 0 ? candidate : `question-${index + 1}`;
}

function exactOptionLabel(value: unknown, index: number): string {
  const label = text(value);
  if (label.length > 1_000) {
    throw new Error("Codex option label exceeds 1000 characters");
  }
  const redacted = redactCodexDiagnostic(label || `Option ${index + 1}`);
  if (redacted.length > 1_000) {
    throw new Error("Codex option label exceeds 1000 characters after redaction");
  }
  return redacted;
}

function exactQuestionText(
  value: unknown,
  field: string,
  maxCharacters = 4_000,
): string {
  const candidate = text(value);
  if (candidate.length > maxCharacters) {
    throw new Error(
      `Codex ${field} exceeds ${maxCharacters} characters`,
    );
  }
  return candidate;
}

function exactRedactedQuestionText(
  value: unknown,
  field: string,
  maxCharacters = 4_000,
): string {
  const redacted = redactCodexDiagnostic(
    exactQuestionText(value, field, maxCharacters),
  );
  if (redacted.length <= maxCharacters) return redacted;
  throw new Error(
    `Codex ${field} exceeds ${maxCharacters} characters after redaction`,
  );
}

function codexOptions(value: unknown): NormalizedQuestionOptions | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 128) throw new Error("Codex question exceeds 128 options");
  const explicitIds = value.map((rawOption, index) => {
    const optionId = text(record(rawOption).id).trim();
    return optionId.length > 0 ? stableQuestionId(optionId, index) : null;
  });
  const usedIds = new Set<string>();
  for (const id of explicitIds) {
    if (id === null) continue;
    if (usedIds.has(id)) {
      throw new Error("Codex option identifiers must be unique");
    }
    usedIds.add(id);
  }
  const nativeValues = new Map<string, unknown>();
  const options = value.map((rawOption, index) => {
    const option = record(rawOption);
    const nativeLabel = text(
      option.label,
      text(option.value, text(rawOption, `Option ${index + 1}`)),
    );
    let id = explicitIds[index];
    if (id === null || id === undefined) {
      let generatedIndex = index + 1;
      id = `option-${generatedIndex}`;
      while (usedIds.has(id)) {
        generatedIndex += 1;
        id = `option-${generatedIndex}`;
      }
      usedIds.add(id);
    }
    nativeValues.set(
      id,
      structuredClone("value" in option ? option.value : nativeLabel),
    );
    return {
      id,
      label: exactOptionLabel(nativeLabel, index),
      ...(text(option.description).length > 0
        ? {
            description: exactRedactedQuestionText(
              option.description,
              "option description",
            ),
          }
        : {}),
    };
  });
  return { options, nativeValues };
}

function jsonSchemaOptions(schema: Record<string, unknown>): NormalizedQuestionOptions {
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema.oneOf)
      ? schema.oneOf.map((entry) => record(entry).const)
      : [];
  if (values.length > 128) throw new Error("Codex question exceeds 128 options");
  const nativeValues = new Map<string, unknown>();
  const options = values.map((value, index) => {
    const oneOf = Array.isArray(schema.oneOf) ? record(schema.oneOf[index]) : {};
    const id = `option-${index + 1}`;
    nativeValues.set(id, structuredClone(value));
    return {
      id,
      label: exactOptionLabel(
        text(
          oneOf.title,
          typeof value === "string" ? value : JSON.stringify(value),
        ),
        index,
      ),
      ...(text(oneOf.description).length > 0
        ? {
            description: exactRedactedQuestionText(
              text(oneOf.description),
              "option description",
            ),
          }
        : {}),
    };
  });
  return { options, nativeValues };
}

function retainNativeOptionValues(
  questionSet: PaperclipQuestionSet,
  nativeValues: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  responseContext: CodexQuestionResponseContext,
): PaperclipQuestionSet {
  if (!NATIVE_OPTION_VALUES.has(responseContext)) {
    throw new Error("Codex question response context was not created by this adapter");
  }
  NATIVE_OPTION_VALUES.set(responseContext, nativeValues);
  return questionSet;
}

/** Codex-native requests are converted once, before they enter PRP. */
export function normalizeCodexQuestionSet(
  method: string,
  params: Record<string, unknown>,
  responseContext: CodexQuestionResponseContext,
): PaperclipQuestionSet | null {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
    if (!Array.isArray(params.questions) || params.questions.length === 0) return null;
    if (params.questions.length > 64) throw new Error("Codex question form exceeds 64 questions");
    const explicitQuestionIds = params.questions.map((rawQuestion, index) => {
      const questionId = text(record(rawQuestion).id).trim();
      return questionId.length > 0 ? stableQuestionId(questionId, index) : null;
    });
    const usedQuestionIds = new Set<string>();
    for (const id of explicitQuestionIds) {
      if (id === null) continue;
      if (usedQuestionIds.has(id)) {
        throw new Error("Codex question identifiers must be unique");
      }
      usedQuestionIds.add(id);
    }
    const nativeValues = new Map<string, ReadonlyMap<string, unknown>>();
    const questions = params.questions.map((rawQuestion, index): PaperclipQuestion => {
      const question = record(rawQuestion);
      const normalizedOptions = codexOptions(question.options);
      let questionId = explicitQuestionIds[index];
      if (questionId === null || questionId === undefined) {
        let generatedIndex = index + 1;
        questionId = `question-${generatedIndex}`;
        while (usedQuestionIds.has(questionId)) {
          generatedIndex += 1;
          questionId = `question-${generatedIndex}`;
        }
        usedQuestionIds.add(questionId);
      }
      if (normalizedOptions !== undefined) {
        nativeValues.set(questionId, normalizedOptions.nativeValues);
      }
      return {
        id: questionId,
        ...(text(question.header).length > 0
          ? {
              header: exactRedactedQuestionText(
                text(question.header),
                "question header",
                1_000,
              ),
            }
          : {}),
        prompt: exactRedactedQuestionText(
          text(question.question, text(question.prompt, `Question ${index + 1}`)),
          "question prompt",
        ),
        ...(text(question.description).length > 0
          ? {
              helpText: exactRedactedQuestionText(
                question.description,
                "question description",
              ),
            }
          : {}),
        // Codex requestUserInput questions do not normally declare requiredness.
        // Do not invent a required constraint when the provider omitted one.
        required: question.required === true,
        answerMode: normalizedOptions && normalizedOptions.options.length > 0
          ? question.multiSelect === true || question.multiple === true ? "multi_select" : "single_select"
          : "text",
        ...(normalizedOptions && normalizedOptions.options.length > 0
          ? { options: normalizedOptions.options }
          : {}),
        ...(question.isOther === true || question.allowOther === true
          ? { customAnswer: { enabled: true, label: "Other", placeholder: "Enter another answer" } }
          : {}),
        ...(!(normalizedOptions && normalizedOptions.options.length > 0) && (typeof question.minLength === "number" || typeof question.maxLength === "number")
          ? { textValidation: {
              ...(typeof question.minLength === "number" ? { minLength: question.minLength } : {}),
              ...(typeof question.maxLength === "number" ? { maxLength: question.maxLength } : {}),
            } }
          : {}),
      };
    });
    return retainNativeOptionValues(parsePaperclipQuestionSet({
      schema: PAPERCLIP_QUESTION_SET_SCHEMA,
      title: exactRedactedQuestionText(
        text(params.title, "Codex needs your input"),
        "form title",
        1_000,
      ),
      ...(text(params.description).length > 0
        ? {
            description: exactRedactedQuestionText(
              params.description,
              "form description",
            ),
          }
        : {}),
      submitLabel: exactRedactedQuestionText(
        text(params.submitLabel, "Submit answers"),
        "submit label",
        1_000,
      ),
      questions,
    }), nativeValues, responseContext);
  }
  if (method !== "mcpServer/elicitation/request") return null;
  const requestedSchema = record(params.requestedSchema ?? params.schema);
  const properties = record(requestedSchema.properties);
  const required = new Set(Array.isArray(requestedSchema.required) ? requestedSchema.required.filter((entry): entry is string => typeof entry === "string") : []);
  const propertyEntries = Object.entries(properties);
  if (propertyEntries.length > 64) throw new Error("Codex question form exceeds 64 questions");
  const nativeValues = new Map<string, ReadonlyMap<string, unknown>>();
  const questions = propertyEntries.map(([id, rawProperty]): PaperclipQuestion => {
    const property = record(rawProperty);
    const propertyType = text(property.type);
    const itemSchema = record(property.items);
    const selectSchema = propertyType === "array" ? itemSchema : property;
    const normalizedOptions = propertyType === "boolean"
      ? {
          options: [{ id: "true", label: "Yes" }, { id: "false", label: "No" }],
          nativeValues: new Map<string, unknown>([["true", true], ["false", false]]),
        }
      : jsonSchemaOptions(selectSchema);
    if (normalizedOptions.options.length > 0) {
      nativeValues.set(id, normalizedOptions.nativeValues);
    }
    const answerMode: PaperclipQuestion["answerMode"] = propertyType === "array" && normalizedOptions.options.length > 0
      ? "multi_select"
      : normalizedOptions.options.length > 0
        ? "single_select"
        : "text";
    const inputType = propertyType === "integer" ? "integer" : propertyType === "number" ? "number" : "text";
    return {
      id,
      ...(text(property.title).length > 0
        ? {
            header: exactRedactedQuestionText(
              text(property.title),
              "question header",
              1_000,
            ),
          }
        : {}),
      prompt: exactRedactedQuestionText(
        text(property.title, id),
        "question prompt",
      ),
      ...(text(property.description).length > 0
        ? {
            helpText: exactRedactedQuestionText(
              text(property.description),
              "question description",
            ),
          }
        : {}),
      required: required.has(id),
      answerMode,
      ...(normalizedOptions.options.length > 0 ? { options: normalizedOptions.options } : {}),
      ...(answerMode === "text" ? { textValidation: {
        inputType,
        ...(typeof property.minLength === "number" ? { minLength: property.minLength } : {}),
        ...(typeof property.maxLength === "number" ? { maxLength: property.maxLength } : {}),
        ...(typeof property.minimum === "number" ? { minimum: property.minimum } : {}),
        ...(typeof property.maximum === "number" ? { maximum: property.maximum } : {}),
        ...(typeof property.pattern === "string" ? { pattern: property.pattern } : {}),
      } } : {}),
    };
  });
  if (questions.length === 0) return null;
  return retainNativeOptionValues(parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: "A tool needs your input",
    ...(text(params.message).length > 0
      ? {
          description: exactRedactedQuestionText(
            text(params.message),
            "form description",
          ),
        }
      : {}),
    submitLabel: "Submit",
    questions,
  }), nativeValues, responseContext);
}

export function runtimeRequestProtocolPayload(request: HarnessRuntimeRequest): Record<string, unknown> {
  if (request.input !== undefined) {
    return {
      schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
      requestKind: "runtime",
      requestId: request.requestId,
      type: "input",
      status: request.status,
      prompt: request.prompt,
      input: structuredClone(request.input),
      origin: structuredClone(request.origin),
      turnId: request.turnId,
      itemId: request.itemId,
    };
  }
  return { ...request, type: request.method };
}

function canonicalCodexAnswers(
  request: HarnessRuntimeRequest,
  response: PaperclipQuestionResponse,
  responseContext: CodexQuestionResponseContext,
): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  for (const question of request.input?.questions ?? []) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    const nativeValues = request.input === undefined
      ? undefined
      : NATIVE_OPTION_VALUES.get(responseContext)?.get(question.id);
    const labels = (answer.selectedOptionIds ?? []).map((optionId) => {
      const value = nativeValues?.has(optionId)
        ? nativeValues.get(optionId)
        : question.options?.find((option) => option.id === optionId)?.label;
      if (typeof value === "string") return value;
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error("Codex native option value must be JSON-serializable");
      }
      return serialized;
    });
    if (answer.text !== undefined) labels.push(answer.text);
    if (answer.customText !== undefined) labels.push(answer.customText);
    result[question.id] = { answers: labels };
  }
  return result;
}

function jsonSchemaOptionValue(
  schema: Record<string, unknown>,
  optionId: string,
  nativeValues: ReadonlyMap<string, unknown> | undefined,
): unknown {
  if (nativeValues?.has(optionId)) return structuredClone(nativeValues.get(optionId));
  if (optionId === "true") return true;
  if (optionId === "false") return false;
  const index = Number(optionId.match(/^option-(\d+)$/)?.[1] ?? "0") - 1;
  if (index < 0) return optionId;
  if (Array.isArray(schema.enum)) return schema.enum[index];
  if (Array.isArray(schema.oneOf)) return record(schema.oneOf[index]).const;
  return optionId;
}

function canonicalElicitationContent(
  request: HarnessRuntimeRequest,
  response: PaperclipQuestionResponse,
  responseContext: CodexQuestionResponseContext,
): Record<string, unknown> {
  const requestedSchema = record(request.details.requestedSchema ?? request.details.schema);
  const properties = record(requestedSchema.properties);
  const content: Record<string, unknown> = {};
  for (const question of request.input?.questions ?? []) {
    const answer = response.answers[question.id];
    if (answer === undefined) continue;
    const property = record(properties[question.id]);
    const itemSchema = record(property.items);
    const nativeValues = request.input === undefined
      ? undefined
      : NATIVE_OPTION_VALUES.get(responseContext)?.get(question.id);
    if (question.answerMode === "text") {
      const value = answer.text ?? "";
      content[question.id] = property.type === "integer" || property.type === "number" ? Number(value) : value;
    } else if (question.answerMode === "multi_select") {
      content[question.id] = (answer.selectedOptionIds ?? []).map((optionId) =>
        jsonSchemaOptionValue(itemSchema, optionId, nativeValues));
    } else {
      const optionId = answer.selectedOptionIds?.[0];
      if (optionId !== undefined) {
        content[question.id] = jsonSchemaOptionValue(property, optionId, nativeValues);
      }
      else if (answer.customText !== undefined) content[question.id] = answer.customText;
    }
  }
  return content;
}

/**
 * Maps an already-validated resolution onto the provider's response shape.
 * `parseHarnessRuntimeRequestResolution` is the only gate on shape, so every
 * branch here answers a resolution the request kind actually accepts.
 */
export function runtimeRequestResponse(
  request: HarnessRuntimeRequest,
  resolution: HarnessRuntimeRequestResolution,
  responseContext: CodexQuestionResponseContext,
): Record<string, unknown> {
  if (
    request.requestKind === "command_approval" ||
    request.requestKind === "file_approval"
  ) {
    if (resolution.action === "submit") {
      throw new Error(
        `${request.requestKind} does not accept submitted form data`,
      );
    }
    const decisions = {
      accept: "accept",
      accept_for_session: "acceptForSession",
      decline: "decline",
      cancel: "cancel",
    } as const;
    return { decision: decisions[resolution.action] };
  }
  if (request.requestKind === "permission_approval") {
    if (resolution.action === "submit") {
      throw new Error(
        "permission approval does not accept submitted form data",
      );
    }
    return {
      permissions: {},
      scope: resolution.action === "accept_for_session" ? "session" : "turn",
    };
  }
  if (request.requestKind === "user_input") {
    if (resolution.action === "submit" && "response" in resolution) {
      return {
        answers: canonicalCodexAnswers(
          request,
          resolution.response,
          responseContext,
        ),
      };
    }
    if (resolution.action !== "submit" || !("answers" in resolution)) {
      // Declines and cancels are the only non-submit answers the validator
      // lets through, and neither carries form data.
      return { answers: {} };
    }
    return { answers: structuredClone(resolution.answers) };
  }
  if (resolution.action === "submit" && "response" in resolution) {
    return {
      action: "accept",
      content: canonicalElicitationContent(
        request,
        resolution.response,
        responseContext,
      ),
      _meta: null,
    };
  }
  if (resolution.action === "submit" && "content" in resolution) {
    return {
      action: "accept",
      content: structuredClone(resolution.content),
      _meta: null,
    };
  }
  if (
    resolution.action === "submit" ||
    resolution.action === "accept_for_session"
  ) {
    throw new Error("elicitation submissions require content");
  }
  return { action: resolution.action, content: null, _meta: null };
}
