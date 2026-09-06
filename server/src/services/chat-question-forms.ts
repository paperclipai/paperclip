import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions } from "@paperclipai/db";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestion,
  PaperclipQuestionSetQuestion,
} from "@paperclipai/shared";
import {
  Modal,
  Select,
  SelectOption,
  TextInput,
  type ModalElement,
  type SelectOptionElement,
} from "chat";

const TOKEN_BYTES = 16;
const OPEN_ACTION_PREFIX = "pcf:";
const SUBMIT_ACTION_PREFIX = "pcfs:";
const FIELD_PREFIX = "pcff:";
const OPTION_PREFIX = "pcfo:";
const MAX_NATIVE_FORM_QUESTIONS = 64;
const MAX_NATIVE_SELECT_OPTIONS = 100;
const MAX_NATIVE_TEXT_LENGTH = 3_000;

export const CHAT_QUESTION_FORM_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type ChatQuestionFormDb = Pick<Db, "select">;
type ChatQuestionFormMutationDb = Pick<Db, "update">;

interface ChatQuestionFormTextField {
  fieldId: string;
  kind: "text";
  maxLength: number;
  minLength: number;
  inputType: "integer" | "number" | "text";
  maximum?: number;
  minimum?: number;
  questionId: string;
  required: boolean;
}

interface ChatQuestionFormSelectOption {
  optionId: string;
  value: string;
}

interface ChatQuestionFormSelectField {
  fieldId: string;
  kind: "single_select";
  options: ChatQuestionFormSelectOption[];
  questionId: string;
  required: boolean;
}

export type ChatQuestionFormField =
  ChatQuestionFormTextField | ChatQuestionFormSelectField;

export interface ChatQuestionFormDraft {
  expiresAt: string;
  fields: ChatQuestionFormField[];
  interactionId: string;
  openActionId: string;
  submitActionId: string;
}

export interface ChatQuestionFormOpenTokenPayload {
  expiresAt: string;
  formActionId: string;
  interactionId: string;
  publicationId: string;
  version: 1;
}

export interface ChatQuestionFormSubmitTokenPayload {
  expiresAt: string;
  fields: ChatQuestionFormField[];
  formActionId: string;
  interactionId: string;
  publicationId: string;
  version: 1;
}

export interface ChatQuestionFormActionRecordContext {
  companyId: string;
  conversationId: string;
  endpointId: string;
  publicationId: string;
}

export interface ResolvedChatQuestionFormOpen {
  interactionId: string;
  modal: ModalElement;
  openActionId: string;
  openActionRowId: string;
  publicationId: string;
  submitActionId: string;
  submitActionRowId: string;
}

export interface ResolvedChatQuestionFormSubmission {
  actionRowId: string;
  conversationId: string;
  interactionId: string;
  payload: ChatQuestionFormSubmitTokenPayload;
  publicationId: string;
  validation: ChatQuestionFormValidationResult;
}

export interface LoadedChatQuestionFormSubmissionToken {
  actionRowId: string;
  conversationId: string;
  interactionId: string;
  principalId: string | null;
  payload: ChatQuestionFormSubmitTokenPayload;
  publicationId: string;
  result: Record<string, unknown> | null;
  status: "issued" | "processed";
}

export type ChatQuestionFormValidationResult =
  | { ok: true; answers: AskUserQuestionsAnswer[] }
  | {
      ok: false;
      code:
        "expired" | "invalid_callback" | "invalid_form" | "stale_interaction";
      fieldErrors: Record<string, string>;
    };

function opaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function boundedLabel(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOpaqueToken(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{22}$/.test(value.slice(prefix.length))
  );
}

export function isChatQuestionFormOpenActionId(
  value: unknown,
): value is string {
  return isOpaqueToken(value, OPEN_ACTION_PREFIX);
}

export function isChatQuestionFormSubmitActionId(
  value: unknown,
): value is string {
  return isOpaqueToken(value, SUBMIT_ACTION_PREFIX);
}

function canonicalQuestion(
  interaction: AskUserQuestionsInteraction,
  questionId: string,
): AskUserQuestionsQuestion | null {
  return (
    interaction.payload.questions.find(
      (question) => question.id === questionId,
    ) ?? null
  );
}

function questionSetQuestion(
  interaction: AskUserQuestionsInteraction,
  questionId: string,
): PaperclipQuestionSetQuestion | null {
  return (
    interaction.payload.questionSet?.questions.find(
      (question) => question.id === questionId,
    ) ?? null
  );
}

function formKind(
  interaction: AskUserQuestionsInteraction,
  question: AskUserQuestionsQuestion,
): "single_select" | "text" | null {
  const source = questionSetQuestion(interaction, question.id);
  if (source) {
    if (source.answerMode === "text") {
      // Regex evaluation supplied by an agent can be computationally unsafe.
      // Keep those uncommon forms in Paperclip, whose canonical validator owns
      // that policy, instead of evaluating a pattern inside a webhook callback.
      return source.textValidation?.pattern ? null : "text";
    }
    return source.answerMode === "single_select" && !source.customAnswer
      ? "single_select"
      : null;
  }

  const freeTextOptions = question.options.filter(
    (option) => option.freeText === true,
  );
  if (
    question.selectionMode === "single" &&
    freeTextOptions.length === 1 &&
    question.options.length === 1
  ) {
    return "text";
  }
  if (
    question.selectionMode === "single" &&
    question.allowOther !== true &&
    freeTextOptions.length === 0
  ) {
    return "single_select";
  }
  return null;
}

/**
 * Creates the provider-neutral opaque field map for a native Slack/Teams form.
 * A lone closed select deliberately stays on the compact button path. Native
 * forms are used when text input or a multi-question response needs them.
 */
export function createChatQuestionFormDraft(
  interaction: AskUserQuestionsInteraction,
  options: { now?: Date } = {},
): ChatQuestionFormDraft | null {
  if (
    interaction.status !== "pending" ||
    interaction.payload.questions.length === 0 ||
    interaction.payload.questions.length > MAX_NATIVE_FORM_QUESTIONS
  ) {
    return null;
  }

  const classified = interaction.payload.questions.map((question) => ({
    question,
    kind: formKind(interaction, question),
  }));
  if (classified.some(({ kind }) => kind === null)) return null;
  if (classified.length === 1 && classified[0]?.kind === "single_select") {
    return null;
  }

  const fields: ChatQuestionFormField[] = [];
  for (const { question, kind } of classified) {
    const fieldId = opaqueToken(FIELD_PREFIX);
    if (kind === "single_select") {
      const options = question.options.filter((option) => !option.freeText);
      if (options.length === 0 || options.length > MAX_NATIVE_SELECT_OPTIONS) {
        return null;
      }
      fields.push({
        fieldId,
        kind,
        questionId: question.id,
        required: question.required !== false,
        options: options.map((option) => ({
          optionId: option.id,
          value: opaqueToken(OPTION_PREFIX),
        })),
      });
      continue;
    }

    const source = questionSetQuestion(interaction, question.id);
    const validation = source?.textValidation;
    const canonicalMax = validation?.maxLength ?? 100_000;
    const canonicalMin = validation?.minLength ?? 0;
    if (canonicalMin > MAX_NATIVE_TEXT_LENGTH) return null;
    fields.push({
      fieldId,
      kind: "text",
      questionId: question.id,
      required: question.required !== false,
      minLength: canonicalMin,
      maxLength: Math.min(canonicalMax, MAX_NATIVE_TEXT_LENGTH),
      inputType: validation?.inputType ?? "text",
      ...(validation?.minimum !== undefined
        ? { minimum: validation.minimum }
        : {}),
      ...(validation?.maximum !== undefined
        ? { maximum: validation.maximum }
        : {}),
    });
  }

  const now = options.now ?? new Date();
  return {
    expiresAt: new Date(
      now.getTime() + CHAT_QUESTION_FORM_TOKEN_TTL_MS,
    ).toISOString(),
    fields,
    interactionId: interaction.id,
    openActionId: opaqueToken(OPEN_ACTION_PREFIX),
    submitActionId: opaqueToken(SUBMIT_ACTION_PREFIX),
  };
}

/** Values ready for one durable chat_actions insert. */
export function chatQuestionFormActionRecords(
  draft: ChatQuestionFormDraft,
  context: ChatQuestionFormActionRecordContext,
) {
  const shared = {
    companyId: context.companyId,
    endpointId: context.endpointId,
    conversationId: context.conversationId,
    status: "issued",
  } as const;
  return [
    {
      ...shared,
      kind: "question_form_open",
      providerActionId: draft.openActionId,
      payload: {
        version: 1,
        publicationId: context.publicationId,
        interactionId: draft.interactionId,
        formActionId: draft.submitActionId,
        expiresAt: draft.expiresAt,
      } satisfies ChatQuestionFormOpenTokenPayload,
    },
    {
      ...shared,
      kind: "question_form_submit",
      providerActionId: draft.submitActionId,
      payload: {
        version: 1,
        publicationId: context.publicationId,
        interactionId: draft.interactionId,
        formActionId: draft.submitActionId,
        fields: draft.fields,
        expiresAt: draft.expiresAt,
      } satisfies ChatQuestionFormSubmitTokenPayload,
    },
  ];
}

export function parseChatQuestionFormOpenTokenPayload(
  value: unknown,
): ChatQuestionFormOpenTokenPayload | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.publicationId !== "string" ||
    typeof value.interactionId !== "string" ||
    !isChatQuestionFormSubmitActionId(value.formActionId) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  return value as unknown as ChatQuestionFormOpenTokenPayload;
}

function parseFormField(value: unknown): ChatQuestionFormField | null {
  if (
    !isRecord(value) ||
    !isOpaqueToken(value.fieldId, FIELD_PREFIX) ||
    typeof value.questionId !== "string" ||
    typeof value.required !== "boolean"
  ) {
    return null;
  }
  if (value.kind === "text") {
    if (
      typeof value.minLength !== "number" ||
      !Number.isSafeInteger(value.minLength) ||
      value.minLength < 0 ||
      typeof value.maxLength !== "number" ||
      !Number.isSafeInteger(value.maxLength) ||
      value.maxLength < value.minLength ||
      value.maxLength > MAX_NATIVE_TEXT_LENGTH ||
      !["text", "number", "integer"].includes(String(value.inputType)) ||
      (value.minimum !== undefined &&
        (typeof value.minimum !== "number" ||
          !Number.isFinite(value.minimum))) ||
      (value.maximum !== undefined &&
        (typeof value.maximum !== "number" || !Number.isFinite(value.maximum)))
    ) {
      return null;
    }
    return value as unknown as ChatQuestionFormTextField;
  }
  if (
    value.kind !== "single_select" ||
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > MAX_NATIVE_SELECT_OPTIONS
  ) {
    return null;
  }
  const options: ChatQuestionFormSelectOption[] = [];
  const values = new Set<string>();
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      typeof option.optionId !== "string" ||
      !isOpaqueToken(option.value, OPTION_PREFIX) ||
      values.has(option.value)
    ) {
      return null;
    }
    values.add(option.value);
    options.push({ optionId: option.optionId, value: option.value });
  }
  return {
    fieldId: value.fieldId,
    kind: "single_select",
    options,
    questionId: value.questionId,
    required: value.required,
  };
}

export function parseChatQuestionFormSubmitTokenPayload(
  value: unknown,
): ChatQuestionFormSubmitTokenPayload | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.publicationId !== "string" ||
    typeof value.interactionId !== "string" ||
    !isChatQuestionFormSubmitActionId(value.formActionId) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > MAX_NATIVE_FORM_QUESTIONS
  ) {
    return null;
  }
  const fields = value.fields.map(parseFormField);
  if (fields.some((field) => field === null)) return null;
  const fieldIds = new Set(fields.map((field) => field!.fieldId));
  const questionIds = new Set(fields.map((field) => field!.questionId));
  if (fieldIds.size !== fields.length || questionIds.size !== fields.length) {
    return null;
  }
  return {
    version: 1,
    publicationId: value.publicationId,
    interactionId: value.interactionId,
    formActionId: value.formActionId,
    expiresAt: value.expiresAt,
    fields: fields as ChatQuestionFormField[],
  };
}

/** Build a safe modal only from a durable token map and current interaction. */
export function buildChatQuestionFormModal(
  interaction: AskUserQuestionsInteraction,
  callbackId: string,
  payload: ChatQuestionFormSubmitTokenPayload,
): ModalElement | null {
  if (
    !isChatQuestionFormSubmitActionId(callbackId) ||
    callbackId !== payload.formActionId ||
    payload.interactionId !== interaction.id
  ) {
    return null;
  }
  if (
    payload.interactionId !== interaction.id ||
    interaction.status !== "pending"
  ) {
    return null;
  }

  const children = [];
  for (const field of payload.fields) {
    const question = canonicalQuestion(interaction, field.questionId);
    if (!question || formKind(interaction, question) !== field.kind)
      return null;
    const label = boundedLabel(question.prompt, 2_000) || "Response";
    if (field.kind === "text") {
      children.push(
        TextInput({
          id: field.fieldId,
          label,
          maxLength: field.maxLength,
          multiline: field.inputType === "text",
          optional: !field.required,
          ...(question.helpText
            ? { placeholder: boundedLabel(question.helpText, 150) }
            : {}),
        }),
      );
      continue;
    }
    const mappedOptions = field.options.map((mapping) => {
      const option = question.options.find(
        (candidate) =>
          candidate.id === mapping.optionId && candidate.freeText !== true,
      );
      return option
        ? SelectOption({
            label: boundedLabel(option.label, 75),
            value: mapping.value,
            ...(option.description
              ? { description: boundedLabel(option.description, 75) }
              : {}),
          })
        : null;
    });
    if (mappedOptions.some((option) => option === null)) return null;
    children.push(
      Select({
        id: field.fieldId,
        label,
        optional: !field.required,
        options: mappedOptions as SelectOptionElement[],
        placeholder: "Choose one",
      }),
    );
  }

  return Modal({
    callbackId,
    title:
      boundedLabel(
        interaction.payload.title ?? interaction.title ?? "Input needed",
        24,
      ) || "Input needed",
    submitLabel:
      boundedLabel(interaction.payload.submitLabel ?? "Submit", 24) || "Submit",
    closeLabel: "Cancel",
    privateMetadata: callbackId,
    children,
  });
}

function invalid(
  code: Exclude<ChatQuestionFormValidationResult, { ok: true }>["code"],
  fieldErrors: Record<string, string> = {},
): ChatQuestionFormValidationResult {
  return { ok: false, code, fieldErrors };
}

/**
 * Converts opaque submitted values to canonical Paperclip answers. Provider
 * labels, question ids, option ids, private metadata, and extra form fields are
 * never trusted as canonical identifiers.
 */
export function validateChatQuestionFormSubmission(args: {
  callbackId: string;
  interaction: AskUserQuestionsInteraction;
  now?: Date;
  payload: ChatQuestionFormSubmitTokenPayload;
  privateMetadata?: string;
  values: Record<string, string>;
}): ChatQuestionFormValidationResult {
  const { callbackId, interaction, payload, values } = args;
  if (
    !isChatQuestionFormSubmitActionId(callbackId) ||
    callbackId !== payload.formActionId ||
    // Teams task modules in Chat SDK 4.39 do not round-trip privateMetadata.
    // When a provider does return it (Slack), it must match the opaque durable
    // callback token. The callback id itself remains mandatory everywhere.
    (args.privateMetadata !== undefined && args.privateMetadata !== callbackId)
  ) {
    return invalid("invalid_callback");
  }
  if (
    payload.interactionId !== interaction.id ||
    interaction.status !== "pending"
  ) {
    return invalid("stale_interaction");
  }
  const now = args.now ?? new Date();
  if (Date.parse(payload.expiresAt) <= now.getTime()) return invalid("expired");

  const expectedFields = new Set(payload.fields.map((field) => field.fieldId));
  if (Object.keys(values).some((fieldId) => !expectedFields.has(fieldId))) {
    return invalid("invalid_form");
  }

  const answers: AskUserQuestionsAnswer[] = [];
  const fieldErrors: Record<string, string> = {};
  for (const field of payload.fields) {
    const question = canonicalQuestion(interaction, field.questionId);
    if (!question || formKind(interaction, question) !== field.kind) {
      return invalid("stale_interaction");
    }
    const submitted = values[field.fieldId] ?? "";
    if (field.kind === "single_select") {
      if (!submitted) {
        if (field.required) fieldErrors[field.fieldId] = "Choose an option";
        else answers.push({ questionId: question.id, optionIds: [] });
        continue;
      }
      const mapping = field.options.find(
        (option) => option.value === submitted,
      );
      const option = mapping
        ? question.options.find(
            (candidate) =>
              candidate.id === mapping.optionId && candidate.freeText !== true,
          )
        : null;
      if (!mapping || !option) {
        fieldErrors[field.fieldId] = "Choose a valid option";
        continue;
      }
      answers.push({ questionId: question.id, optionIds: [option.id] });
      continue;
    }

    const text = submitted.trim();
    if (!text) {
      if (field.required) {
        fieldErrors[field.fieldId] = "Enter a response";
      } else {
        answers.push({ questionId: question.id, optionIds: [] });
      }
      continue;
    }
    if (text.length < field.minLength) {
      fieldErrors[field.fieldId] =
        `Enter at least ${field.minLength} characters`;
      continue;
    }
    if (text.length > field.maxLength) {
      fieldErrors[field.fieldId] =
        `Enter no more than ${field.maxLength} characters`;
      continue;
    }
    if (text && field.inputType !== "text") {
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        (field.inputType === "integer" && !Number.isInteger(number))
      ) {
        fieldErrors[field.fieldId] =
          field.inputType === "integer"
            ? "Enter a whole number"
            : "Enter a number";
        continue;
      }
      if (field.minimum !== undefined && number < field.minimum) {
        fieldErrors[field.fieldId] = `Enter ${field.minimum} or more`;
        continue;
      }
      if (field.maximum !== undefined && number > field.maximum) {
        fieldErrors[field.fieldId] = `Enter ${field.maximum} or less`;
        continue;
      }
    }
    answers.push({
      questionId: question.id,
      optionIds: [],
      ...(text ? { otherText: text } : {}),
    });
  }
  return Object.keys(fieldErrors).length
    ? invalid("invalid_form", fieldErrors)
    : { ok: true, answers };
}

/**
 * Lookup helper for onAction after actor/resource/message authorization. It
 * verifies both durable rows and rebuilds the modal from the current pending
 * interaction; it does not consume either token.
 */
export async function resolveChatQuestionFormOpen(
  db: ChatQuestionFormDb,
  args: {
    companyId: string;
    conversationId: string;
    endpointId: string;
    interaction: AskUserQuestionsInteraction;
    now?: Date;
    openActionId: string;
  },
): Promise<ResolvedChatQuestionFormOpen | null> {
  if (!isChatQuestionFormOpenActionId(args.openActionId)) return null;
  const open = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, args.companyId),
        eq(chatActions.endpointId, args.endpointId),
        eq(chatActions.conversationId, args.conversationId),
        eq(chatActions.kind, "question_form_open"),
        eq(chatActions.providerActionId, args.openActionId),
        eq(chatActions.status, "issued"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const openPayload = parseChatQuestionFormOpenTokenPayload(open?.payload);
  if (
    !open ||
    !openPayload ||
    openPayload.interactionId !== args.interaction.id ||
    Date.parse(openPayload.expiresAt) <= (args.now ?? new Date()).getTime()
  ) {
    return null;
  }
  const submit = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, args.companyId),
        eq(chatActions.endpointId, args.endpointId),
        eq(chatActions.conversationId, args.conversationId),
        eq(chatActions.kind, "question_form_submit"),
        eq(chatActions.providerActionId, openPayload.formActionId),
        eq(chatActions.status, "issued"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const submitPayload = parseChatQuestionFormSubmitTokenPayload(
    submit?.payload,
  );
  if (
    !submit ||
    !submitPayload ||
    submitPayload.publicationId !== openPayload.publicationId ||
    submitPayload.interactionId !== openPayload.interactionId ||
    submitPayload.formActionId !== openPayload.formActionId ||
    submitPayload.expiresAt !== openPayload.expiresAt
  ) {
    return null;
  }
  const modal = buildChatQuestionFormModal(
    args.interaction,
    submit.providerActionId,
    submitPayload,
  );
  return modal
    ? {
        interactionId: openPayload.interactionId,
        modal,
        openActionId: open.providerActionId,
        openActionRowId: open.id,
        publicationId: openPayload.publicationId,
        submitActionId: submit.providerActionId,
        submitActionRowId: submit.id,
      }
    : null;
}

/**
 * Lookup and pure-validation wrapper for onModalSubmit. Call this only after
 * actor, resource, conversation, and source-publication authorization. An
 * invalid user value is returned as fieldErrors so the provider can keep the
 * modal open; missing/tampered durable state returns null.
 */
export async function resolveChatQuestionFormSubmission(
  db: ChatQuestionFormDb,
  args: {
    callbackId: string;
    companyId: string;
    conversationId?: string;
    endpointId: string;
    interaction: AskUserQuestionsInteraction;
    now?: Date;
    privateMetadata?: string;
    values: Record<string, string>;
  },
): Promise<ResolvedChatQuestionFormSubmission | null> {
  const loaded = await loadChatQuestionFormSubmissionToken(db, {
    callbackId: args.callbackId,
    companyId: args.companyId,
    endpointId: args.endpointId,
  });
  if (
    !loaded ||
    (args.conversationId !== undefined &&
      loaded.conversationId !== args.conversationId)
  ) {
    return null;
  }
  return {
    ...loaded,
    validation: validateChatQuestionFormSubmission({
      callbackId: args.callbackId,
      privateMetadata: args.privateMetadata,
      interaction: args.interaction,
      payload: loaded.payload,
      values: args.values,
      ...(args.now ? { now: args.now } : {}),
    }),
  };
}

/**
 * Loads an opaque submit token without depending on Chat SDK's relatedThread.
 * This matters after a provider-side validation retry: Chat SDK 4.39 consumes
 * its short-lived modal context on the first submit, while this durable record
 * remains the authoritative conversation/publication binding.
 */
export async function loadChatQuestionFormSubmissionToken(
  db: ChatQuestionFormDb,
  args: {
    callbackId: string;
    companyId: string;
    endpointId: string;
    includeProcessed?: boolean;
  },
): Promise<LoadedChatQuestionFormSubmissionToken | null> {
  if (!isChatQuestionFormSubmitActionId(args.callbackId)) return null;
  const action = await db
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, args.companyId),
        eq(chatActions.endpointId, args.endpointId),
        eq(chatActions.kind, "question_form_submit"),
        eq(chatActions.providerActionId, args.callbackId),
        args.includeProcessed
          ? inArray(chatActions.status, ["issued", "processed"])
          : eq(chatActions.status, "issued"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const payload = parseChatQuestionFormSubmitTokenPayload(action?.payload);
  if (!action || !payload || !action.conversationId) return null;
  return {
    actionRowId: action.id,
    conversationId: action.conversationId,
    interactionId: payload.interactionId,
    principalId: action.principalId,
    payload,
    publicationId: payload.publicationId,
    result: action.result,
    status: action.status as "issued" | "processed",
  };
}

/**
 * Atomic replay barrier for a validated modal response. Run this in the same
 * database transaction as the canonical interaction answer whenever possible.
 * Raw submitted field values are intentionally not copied into chat_actions.
 */
export async function claimChatQuestionFormSubmission(
  db: ChatQuestionFormMutationDb,
  args: {
    actionRowId: string;
    principalId: string;
  },
): Promise<boolean> {
  const claimed = await db
    .update(chatActions)
    .set({
      principalId: args.principalId,
      status: "processing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatActions.id, args.actionRowId),
        eq(chatActions.kind, "question_form_submit"),
        eq(chatActions.status, "issued"),
      ),
    )
    .returning({ id: chatActions.id });
  return claimed.length === 1;
}

/** Complete the durable form token without duplicating the answer payload. */
export async function completeChatQuestionFormSubmission(
  db: ChatQuestionFormMutationDb,
  args: { actionRowId: string; interactionId: string },
): Promise<boolean> {
  const completed = await db
    .update(chatActions)
    .set({
      status: "processed",
      result: {
        code: "question_form_answered",
        interactionId: args.interactionId,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatActions.id, args.actionRowId),
        eq(chatActions.kind, "question_form_submit"),
        eq(chatActions.status, "processing"),
      ),
    )
    .returning({ id: chatActions.id });
  return completed.length === 1;
}
