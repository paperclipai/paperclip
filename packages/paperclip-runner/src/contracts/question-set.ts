export const PAPERCLIP_QUESTION_SET_SCHEMA = "paperclip.question_set.v1" as const;
export const PAPERCLIP_QUESTION_RESPONSE_SCHEMA = "paperclip.question_response.v1" as const;
export const PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2 = "paperclip.runtime_request.v2" as const;

export type PaperclipQuestionAnswerMode = "single_select" | "multi_select" | "text";

export interface PaperclipQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface PaperclipQuestionCustomAnswer {
  enabled: true;
  label?: string;
  placeholder?: string;
}

export interface PaperclipQuestionTextValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  inputType?: "text" | "number" | "integer";
  minimum?: number;
  maximum?: number;
}

export interface PaperclipQuestion {
  id: string;
  header?: string;
  prompt: string;
  helpText?: string;
  required: boolean;
  answerMode: PaperclipQuestionAnswerMode;
  options?: PaperclipQuestionOption[];
  customAnswer?: PaperclipQuestionCustomAnswer;
  textValidation?: PaperclipQuestionTextValidation;
}

export interface PaperclipQuestionSet {
  schema: typeof PAPERCLIP_QUESTION_SET_SCHEMA;
  title?: string;
  description?: string;
  submitLabel?: string;
  questions: PaperclipQuestion[];
}

export interface PaperclipQuestionAnswer {
  selectedOptionIds?: string[];
  text?: string;
  customText?: string;
}

export interface PaperclipQuestionResponse {
  schema: typeof PAPERCLIP_QUESTION_RESPONSE_SCHEMA;
  answers: Record<string, PaperclipQuestionAnswer>;
}

export interface PaperclipRuntimeRequestOrigin {
  adapter: string;
  provider?: string;
  method?: string;
}

export interface PaperclipRuntimeInputRequest {
  schema: typeof PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2;
  requestKind: "runtime";
  requestId: string;
  type: "input";
  status: "pending" | "resolved" | "expired" | "cancelled";
  prompt: string;
  input: PaperclipQuestionSet;
  origin?: PaperclipRuntimeRequestOrigin;
  turnId?: string;
  itemId?: string;
}

export class PaperclipQuestionValidationError extends Error {
  readonly code = "invalid_question_response" as const;
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PaperclipQuestionValidationError";
    this.path = path;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new PaperclipQuestionValidationError(`${path}/${unknown}`, "is not part of the canonical response contract");
  }
}

function requiredText(value: unknown, path: string, maxLength = 4_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new PaperclipQuestionValidationError(path, `must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(value: unknown, path: string, maxLength = 4_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new PaperclipQuestionValidationError(path, `must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PaperclipQuestionValidationError(path, "must be a finite number");
  }
  return value;
}

/** Parse and sanitize the provider-neutral presentation contract at an adapter boundary. */
export function parsePaperclipQuestionSet(value: unknown): PaperclipQuestionSet {
  const candidate = record(value);
  if (candidate === null || candidate.schema !== PAPERCLIP_QUESTION_SET_SCHEMA) {
    throw new PaperclipQuestionValidationError("/input", `must use ${PAPERCLIP_QUESTION_SET_SCHEMA}`);
  }
  if (!Array.isArray(candidate.questions) || candidate.questions.length === 0 || candidate.questions.length > 64) {
    throw new PaperclipQuestionValidationError("/input/questions", "must contain between 1 and 64 questions");
  }
  const questionIds = new Set<string>();
  const questions = candidate.questions.map((rawQuestion, questionIndex): PaperclipQuestion => {
    const path = `/input/questions/${questionIndex}`;
    const question = record(rawQuestion);
    if (question === null) throw new PaperclipQuestionValidationError(path, "must be an object");
    const id = requiredText(question.id, `${path}/id`, 160);
    if (questionIds.has(id)) throw new PaperclipQuestionValidationError(`${path}/id`, "must be unique");
    questionIds.add(id);
    const answerMode = question.answerMode;
    if (answerMode !== "single_select" && answerMode !== "multi_select" && answerMode !== "text") {
      throw new PaperclipQuestionValidationError(`${path}/answerMode`, "must be single_select, multi_select, or text");
    }
    if (typeof question.required !== "boolean") {
      throw new PaperclipQuestionValidationError(`${path}/required`, "must be boolean");
    }
    if (Array.isArray(question.options) && question.options.length > 128) {
      throw new PaperclipQuestionValidationError(`${path}/options`, "cannot contain more than 128 options");
    }
    const options: PaperclipQuestionOption[] | undefined = Array.isArray(question.options)
      ? question.options.map((rawOption, optionIndex) => {
          const optionPath = `${path}/options/${optionIndex}`;
          const option = record(rawOption);
          if (option === null) throw new PaperclipQuestionValidationError(optionPath, "must be an object");
          return {
            id: requiredText(option.id, `${optionPath}/id`, 160),
            label: requiredText(option.label, `${optionPath}/label`, 1_000),
            ...(optionalText(option.description, `${optionPath}/description`) !== undefined
              ? { description: optionalText(option.description, `${optionPath}/description`) }
              : {}),
          };
        })
      : undefined;
    if (options !== undefined && new Set(options.map((option) => option.id)).size !== options.length) {
      throw new PaperclipQuestionValidationError(`${path}/options`, "option IDs must be unique within a question");
    }
    if (answerMode !== "text" && (!options || options.length === 0)) {
      throw new PaperclipQuestionValidationError(`${path}/options`, "select questions require at least one option");
    }
    if (answerMode === "text" && options !== undefined && options.length > 0) {
      throw new PaperclipQuestionValidationError(`${path}/options`, "text questions cannot define options");
    }
    const custom = record(question.customAnswer);
    const customAnswer = custom === null
      ? undefined
      : {
          enabled: true as const,
          ...(optionalText(custom.label, `${path}/customAnswer/label`, 1_000) !== undefined
            ? { label: optionalText(custom.label, `${path}/customAnswer/label`, 1_000) }
            : {}),
          ...(optionalText(custom.placeholder, `${path}/customAnswer/placeholder`, 1_000) !== undefined
            ? { placeholder: optionalText(custom.placeholder, `${path}/customAnswer/placeholder`, 1_000) }
            : {}),
        };
    if (custom !== null && custom.enabled !== true) {
      throw new PaperclipQuestionValidationError(`${path}/customAnswer/enabled`, "must be true when customAnswer is present");
    }
    if (answerMode === "text" && customAnswer !== undefined) {
      throw new PaperclipQuestionValidationError(`${path}/customAnswer`, "text questions do not use a separate custom answer");
    }
    const validation = record(question.textValidation);
    const textValidation: PaperclipQuestionTextValidation | undefined = validation === null
      ? undefined
      : {
          ...(typeof validation.minLength === "number" ? { minLength: validation.minLength } : {}),
          ...(typeof validation.maxLength === "number" ? { maxLength: validation.maxLength } : {}),
          ...(optionalText(validation.pattern, `${path}/textValidation/pattern`, 1_000) !== undefined
            ? { pattern: optionalText(validation.pattern, `${path}/textValidation/pattern`, 1_000) }
            : {}),
          ...(validation.inputType === "number" || validation.inputType === "integer" || validation.inputType === "text"
            ? { inputType: validation.inputType }
            : {}),
          ...(optionalFiniteNumber(validation.minimum, `${path}/textValidation/minimum`) !== undefined
            ? { minimum: optionalFiniteNumber(validation.minimum, `${path}/textValidation/minimum`) }
            : {}),
          ...(optionalFiniteNumber(validation.maximum, `${path}/textValidation/maximum`) !== undefined
            ? { maximum: optionalFiniteNumber(validation.maximum, `${path}/textValidation/maximum`) }
            : {}),
        };
    if (validation !== null) {
      for (const key of ["minLength", "maxLength"] as const) {
        const raw = validation[key];
        if (raw !== undefined && (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > 100_000)) {
          throw new PaperclipQuestionValidationError(`${path}/textValidation/${key}`, "must be an integer from 0 through 100000");
        }
      }
      if (validation.inputType !== undefined && !["text", "number", "integer"].includes(String(validation.inputType))) {
        throw new PaperclipQuestionValidationError(`${path}/textValidation/inputType`, "must be text, number, or integer");
      }
      if (textValidation?.minLength !== undefined && textValidation.maxLength !== undefined && textValidation.minLength > textValidation.maxLength) {
        throw new PaperclipQuestionValidationError(`${path}/textValidation`, "minLength cannot exceed maxLength");
      }
      if (textValidation?.minimum !== undefined && textValidation.maximum !== undefined && textValidation.minimum > textValidation.maximum) {
        throw new PaperclipQuestionValidationError(`${path}/textValidation`, "minimum cannot exceed maximum");
      }
      if (textValidation?.pattern !== undefined) {
        try { new RegExp(textValidation.pattern); } catch {
          throw new PaperclipQuestionValidationError(`${path}/textValidation/pattern`, "must be a valid regular expression");
        }
      }
    }
    return {
      id,
      ...(optionalText(question.header, `${path}/header`, 1_000) !== undefined
        ? { header: optionalText(question.header, `${path}/header`, 1_000) }
        : {}),
      prompt: requiredText(question.prompt, `${path}/prompt`),
      ...(optionalText(question.helpText, `${path}/helpText`) !== undefined
        ? { helpText: optionalText(question.helpText, `${path}/helpText`) }
        : {}),
      required: question.required,
      answerMode,
      ...(options !== undefined ? { options } : {}),
      ...(customAnswer !== undefined ? { customAnswer } : {}),
      ...(textValidation !== undefined ? { textValidation } : {}),
    };
  });
  return {
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    ...(optionalText(candidate.title, "/input/title", 1_000) !== undefined
      ? { title: optionalText(candidate.title, "/input/title", 1_000) }
      : {}),
    ...(optionalText(candidate.description, "/input/description") !== undefined
      ? { description: optionalText(candidate.description, "/input/description") }
      : {}),
    ...(optionalText(candidate.submitLabel, "/input/submitLabel", 200) !== undefined
      ? { submitLabel: optionalText(candidate.submitLabel, "/input/submitLabel", 200) }
      : {}),
    questions,
  };
}

function answerHasValue(answer: PaperclipQuestionAnswer): boolean {
  return Boolean(answer.text?.trim() || answer.customText?.trim() || answer.selectedOptionIds?.length);
}

/** Revalidate untrusted UI input against the persisted question set. */
export function parsePaperclipQuestionResponse(
  questionSetValue: unknown,
  responseValue: unknown,
): PaperclipQuestionResponse {
  const questionSet = parsePaperclipQuestionSet(questionSetValue);
  const response = record(responseValue);
  if (response === null || response.schema !== PAPERCLIP_QUESTION_RESPONSE_SCHEMA) {
    throw new PaperclipQuestionValidationError("/response", `must use ${PAPERCLIP_QUESTION_RESPONSE_SCHEMA}`);
  }
  rejectUnknownKeys(response, ["schema", "answers"], "/response");
  const rawAnswers = record(response.answers);
  if (rawAnswers === null) throw new PaperclipQuestionValidationError("/response/answers", "must be an object keyed by question ID");
  const questions = new Map(questionSet.questions.map((question) => [question.id, question]));
  for (const questionId of Object.keys(rawAnswers)) {
    if (!questions.has(questionId)) throw new PaperclipQuestionValidationError(`/response/answers/${questionId}`, "does not match a question in the persisted set");
  }
  const answers: Record<string, PaperclipQuestionAnswer> = {};
  for (const question of questionSet.questions) {
    const path = `/response/answers/${question.id}`;
    const raw = rawAnswers[question.id];
    if (raw === undefined) {
      if (question.required) throw new PaperclipQuestionValidationError(path, "is required");
      continue;
    }
    const answer = record(raw);
    if (answer === null) throw new PaperclipQuestionValidationError(path, "must be an object");
    rejectUnknownKeys(answer, ["selectedOptionIds", "text", "customText"], path);
    const selectedOptionIds = answer.selectedOptionIds === undefined
      ? undefined
      : Array.isArray(answer.selectedOptionIds) && answer.selectedOptionIds.every((entry) => typeof entry === "string")
        ? [...answer.selectedOptionIds]
        : null;
    if (selectedOptionIds === null) throw new PaperclipQuestionValidationError(`${path}/selectedOptionIds`, "must be an array of strings");
    if (selectedOptionIds !== undefined && new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      throw new PaperclipQuestionValidationError(`${path}/selectedOptionIds`, "cannot contain duplicates");
    }
    const textValue = optionalText(answer.text, `${path}/text`, 100_000);
    const customText = optionalText(answer.customText, `${path}/customText`, 100_000);
    if (question.answerMode === "text") {
      if (selectedOptionIds?.length || customText !== undefined) throw new PaperclipQuestionValidationError(path, "text answers only carry text");
    } else {
      if (textValue !== undefined) throw new PaperclipQuestionValidationError(path, "select answers do not carry text");
      const allowed = new Set((question.options ?? []).map((option) => option.id));
      for (const optionId of selectedOptionIds ?? []) {
        if (!allowed.has(optionId)) throw new PaperclipQuestionValidationError(`${path}/selectedOptionIds`, `contains unknown option ${optionId}`);
      }
      if (question.answerMode === "single_select" && (selectedOptionIds?.length ?? 0) > 1) {
        throw new PaperclipQuestionValidationError(`${path}/selectedOptionIds`, "single-select answers choose at most one option");
      }
      if (customText !== undefined && question.customAnswer?.enabled !== true) {
        throw new PaperclipQuestionValidationError(`${path}/customText`, "custom answers are not enabled for this question");
      }
      if (customText?.trim() && (selectedOptionIds?.length ?? 0) > 0 && question.answerMode === "single_select") {
        throw new PaperclipQuestionValidationError(path, "single-select answers cannot select an option and a custom answer");
      }
    }
    const parsed: PaperclipQuestionAnswer = {
      ...(selectedOptionIds !== undefined ? { selectedOptionIds } : {}),
      ...(textValue !== undefined ? { text: textValue } : {}),
      ...(customText !== undefined ? { customText } : {}),
    };
    if (question.required && !answerHasValue(parsed)) throw new PaperclipQuestionValidationError(path, "is required");
    const boundedText = question.answerMode === "text" ? parsed.text : parsed.customText;
    if (boundedText !== undefined) {
      const validation = question.textValidation;
      if (validation?.minLength !== undefined && boundedText.length < validation.minLength) {
        throw new PaperclipQuestionValidationError(path, `must contain at least ${validation.minLength} characters`);
      }
      if (validation?.maxLength !== undefined && boundedText.length > validation.maxLength) {
        throw new PaperclipQuestionValidationError(path, `must contain at most ${validation.maxLength} characters`);
      }
      if (validation?.pattern !== undefined && !new RegExp(validation.pattern).test(boundedText)) {
        throw new PaperclipQuestionValidationError(path, "does not match the required format");
      }
      if (validation?.inputType === "number" || validation?.inputType === "integer") {
        const numeric = Number(boundedText);
        if (!Number.isFinite(numeric) || (validation.inputType === "integer" && !Number.isInteger(numeric))) {
          throw new PaperclipQuestionValidationError(path, `must be a valid ${validation.inputType}`);
        }
        if (validation.minimum !== undefined && numeric < validation.minimum) throw new PaperclipQuestionValidationError(path, `must be at least ${validation.minimum}`);
        if (validation.maximum !== undefined && numeric > validation.maximum) throw new PaperclipQuestionValidationError(path, `must be at most ${validation.maximum}`);
      }
    }
    if (answerHasValue(parsed)) answers[question.id] = parsed;
  }
  return { schema: PAPERCLIP_QUESTION_RESPONSE_SCHEMA, answers };
}
