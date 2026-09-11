import { createHash } from "node:crypto";

import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  parsePaperclipQuestionResponse,
  parsePaperclipQuestionSet,
  type PaperclipQuestion,
  type PaperclipQuestionOption,
  type PaperclipQuestionResponse,
  type PaperclipQuestionSet,
} from "../../contracts/question-set.js";

const MAX_ACP_FORM_FIELDS = 64;
const MAX_ACP_FIELD_OPTIONS = 128;

export interface AcpFormElicitationRequest {
  mode: string;
  message?: unknown;
  requestedSchema?: unknown;
}

export type AcpFormContent = Record<
  string,
  string | number | boolean | string[]
>;

export interface AcpAcceptElicitationResponse {
  action: "accept";
  content: AcpFormContent;
}

interface AcpFieldBinding {
  propertyName: string;
  property: Record<string, unknown>;
  question: PaperclipQuestion;
  optionValues: Map<string, string>;
}

export interface NormalizedAcpForm {
  questionSet: PaperclipQuestionSet;
  /** Convert a validated Paperclip response back into typed ACP content. */
  accept(response: unknown): AcpAcceptElicitationResponse;
}

/**
 * ACP remains private to this adapter. Only the normalized question set is
 * allowed to cross the Paperclip runtime-request boundary.
 */
export function normalizeAcpFormElicitation(
  request: AcpFormElicitationRequest,
): NormalizedAcpForm | null {
  const rawRequest = record(request);
  if (rawRequest.mode !== "form") return null;
  const schema = record(rawRequest.requestedSchema);
  const properties = record(schema.properties);
  const propertyEntries = Object.entries(properties);
  if (
    propertyEntries.length === 0 ||
    propertyEntries.length > MAX_ACP_FORM_FIELDS
  ) {
    throw new Error(
      `ACP form elicitation must define between 1 and ${MAX_ACP_FORM_FIELDS} supported properties`,
    );
  }
  const propertyNames = new Set(propertyEntries.map(([name]) => name));
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required
          .filter(
            (value): value is string =>
              typeof value === "string" && propertyNames.has(value),
          )
      : [],
  );
  const bindings = propertyEntries.map(([propertyName, value], index) =>
    normalizeField(propertyName, value, index, required.has(propertyName)),
  );
  const title = optionalText(schema.title) ?? "Additional information needed";
  const descriptions = [
    optionalText(rawRequest.message),
    optionalText(schema.description),
  ]
    .filter((value) => value !== title)
    .filter(
      (value, position, all): value is string =>
        Boolean(value) && all.indexOf(value) === position,
    );
  const questionSet = parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title,
    ...(descriptions.length > 0
      ? { description: descriptions.join("\n\n") }
      : {}),
    submitLabel: "Submit answers",
    questions: bindings.map((binding) => binding.question),
  });

  return {
    questionSet,
    accept(response: unknown): AcpAcceptElicitationResponse {
      const parsed = parsePaperclipQuestionResponse(questionSet, response);
      return {
        action: "accept",
        content: acpContent(bindings, parsed),
      };
    },
  };
}

function normalizeField(
  propertyName: string,
  value: unknown,
  index: number,
  required: boolean,
): AcpFieldBinding {
  const property = record(value);
  const type = text(property.type);
  const id = stableFieldId(propertyName, index);
  const header = optionalText(property.title) ?? propertyName;
  const prompt = optionalText(property.description) ?? header;
  const base = { id, header, prompt, required };

  if (type === "string") {
    const nativeOptions = enumOptions(
      property.oneOf ?? property.anyOf,
      property.enum,
    );
    if (nativeOptions.length > 0) {
      const normalized = normalizeOptions(nativeOptions);
      return {
        propertyName,
        property,
        optionValues: normalized.values,
        question: {
          ...base,
          answerMode: "single_select",
          options: normalized.options,
        },
      };
    }
    const minLength = finiteNonNegativeInteger(property.minLength);
    const maxLength = finiteNonNegativeInteger(property.maxLength);
    const pattern = optionalText(property.pattern);
    return {
      propertyName,
      property,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: "text",
          ...(minLength !== undefined ? { minLength } : {}),
          ...(maxLength !== undefined ? { maxLength } : {}),
          ...(pattern !== undefined ? { pattern } : {}),
        },
      },
    };
  }

  if (type === "number" || type === "integer") {
    const minimum = finiteNumber(property.minimum);
    const maximum = finiteNumber(property.maximum);
    return {
      propertyName,
      property,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: type,
          ...(minimum !== undefined ? { minimum } : {}),
          ...(maximum !== undefined ? { maximum } : {}),
        },
      },
    };
  }

  if (type === "boolean") {
    const normalized = normalizeOptions([
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ]);
    return {
      propertyName,
      property,
      optionValues: normalized.values,
      question: {
        ...base,
        answerMode: "single_select",
        options: normalized.options,
      },
    };
  }

  if (type === "array") {
    const items = record(property.items);
    const nativeOptions = enumOptions(items.anyOf ?? items.oneOf, items.enum);
    if (nativeOptions.length === 0) {
      throw new Error(
        `ACP multi-select property ${propertyName} must define enum, anyOf, or oneOf options`,
      );
    }
    const normalized = normalizeOptions(nativeOptions);
    return {
      propertyName,
      property,
      optionValues: normalized.values,
      question: {
        ...base,
        answerMode: "multi_select",
        options: normalized.options,
      },
    };
  }

  throw new Error(
    `Unsupported ACP elicitation property type ${JSON.stringify(type)} for ${propertyName}`,
  );
}

function acpContent(
  bindings: AcpFieldBinding[],
  response: PaperclipQuestionResponse,
): AcpFormContent {
  const content: AcpFormContent = {};
  for (const binding of bindings) {
    const answer = response.answers[binding.question.id];
    if (!answer) continue;
    const type = text(binding.property.type);
    if (type === "string" && binding.question.answerMode === "text") {
      if (answer.text !== undefined)
        setContent(content, binding.propertyName, answer.text);
      continue;
    }
    if (type === "number" || type === "integer") {
      if (answer.text !== undefined)
        setContent(content, binding.propertyName, Number(answer.text));
      continue;
    }
    if (type === "boolean") {
      const selected = answer.selectedOptionIds?.[0];
      if (selected !== undefined)
        setContent(
          content,
          binding.propertyName,
          binding.optionValues.get(selected) === "true",
        );
      continue;
    }
    const selectedValues = (answer.selectedOptionIds ?? []).map((id) => {
      const selected = binding.optionValues.get(id);
      if (selected === undefined)
        throw new Error(`ACP option ${id} is no longer available`);
      return selected;
    });
    if (type === "array")
      setContent(content, binding.propertyName, selectedValues);
    else if (selectedValues[0] !== undefined)
      setContent(content, binding.propertyName, selectedValues[0]);
  }
  return content;
}

function setContent(
  content: AcpFormContent,
  propertyName: string,
  value: AcpFormContent[string],
): void {
  Object.defineProperty(content, propertyName, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function enumOptions(
  titled: unknown,
  values: unknown,
): Array<{ value: string; label: string; description?: string }> {
  const source = Array.isArray(titled)
    ? titled
    : Array.isArray(values)
      ? values
      : [];
  if (source.length > MAX_ACP_FIELD_OPTIONS) {
    throw new Error(
      `ACP elicitation fields cannot define more than ${MAX_ACP_FIELD_OPTIONS} options`,
    );
  }
  if (Array.isArray(titled)) {
    return titled.map((entry, index) => {
      const option = record(entry);
      const optionValue = requiredText(
        option.const,
        `ACP enum option ${index} const`,
      );
      const description = optionalText(option.description);
      return {
        value: optionValue,
        label: optionalText(option.title) ?? optionValue,
        ...(description !== undefined ? { description } : {}),
      };
    });
  }
  return source.map((value, index) => {
    const native = requiredText(value, `ACP enum option ${index}`);
    return { value: native, label: native };
  });
}

function normalizeOptions(
  nativeOptions: Array<{
    value: string;
    label: string;
    description?: string;
  }>,
): { options: PaperclipQuestionOption[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  const options = nativeOptions.map(
    (option, index): PaperclipQuestionOption => {
      const id = `option-${index + 1}`;
      values.set(id, option.value);
      return {
        id,
        label: option.label,
        ...(option.description !== undefined
          ? { description: option.description }
          : {}),
      };
    },
  );
  return { options, values };
}

function stableFieldId(value: string, index: number): string {
  const readable = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `field-${index + 1}-${readable || "value"}-${digest}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredText(value: unknown, field: string): string {
  const result = optionalText(value);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}
