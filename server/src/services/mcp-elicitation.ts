import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { PaperclipQuestionSetPayload, PaperclipQuestionSetQuestion } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

/**
 * MCP form elicitation (spec 2026-07-28, client/elicitation): the provider's
 * question becomes a task-chat question card, and the person's answer on that
 * card becomes the elicitation result. Used by direct tool calls (stateless
 * `input_required` and older server-initiated `elicitation/create`) and by
 * MCP Tasks, so every path shows the same card and sends the same answer.
 */

export type McpFormElicitation = {
  message: string;
  requestedSchema: Record<string, unknown> | null;
};

export type McpElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };

/** At most this many fields per question, and form questions per round. */
export const MCP_ELICITATION_MAX_FIELDS = 10;
export const MCP_ELICITATION_MAX_FORMS_PER_ROUND = 4;
const MAX_OPTIONS = 100;

type Built =
  | { ok: true; questionSet: PaperclipQuestionSetPayload }
  | { ok: false; reason: "sensitive"; fields: string[] }
  | { ok: false; reason: "unsupported" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Provider text is shown as plain words. Links in a form are not clickable
 * (spec: Safe URL Handling), and secrets that slipped in are redacted.
 */
/** True for a card made from an app's question (direct or MCP Task), by its idempotency key. */
export function isAppQuestionCardKey(key: string | null | undefined): boolean {
  return typeof key === "string" && (key.startsWith("mcp-elicit:") || key.startsWith("mcp-task-input:") || key.startsWith("mcp-elicitation:"));
}

export function elicitationPlainText(value: string, max: number): string {
  return redactSensitiveText(value)
    .replace(/[<>]/g, "")
    .replace(/\]\(/g, "] (")
    .replace(/:\/\//g, ":​//")
    .slice(0, max);
}

// Secrets must go through a URL (spec: Form Mode Security). Matched on the
// field's name, title, and description.
const SENSITIVE_FIELD =
  /pass(?:word|wd|code|phrase)|secret|api[\s_-]?key|(?:access|refresh|auth|bearer|session|api)[\s_-]?token|\btokens?\b|credential|private[\s_-]?key|card[\s_-]?(?:number|no\b)|\bcvv\b|\bcvc\b|security[\s_-]?code|\bssn\b|social[\s_-]?security|one[\s_-]?time[\s_-]?(?:code|password)|\botp\b|\b2fa\b|\bmfa\b/i;

// The same secrets, asked for in the form's own words ("type your password
// in the notes field"). A bare "token" is left out: in prose it is too common.
const SENSITIVE_MESSAGE =
  /pass(?:word|wd|code|phrase)|secret|api[\s_-]?key|(?:access|refresh|auth|bearer|session|api)[\s_-]?token|credential|private[\s_-]?key|card[\s_-]?(?:number|no\b)|\bcvv\b|\bcvc\b|security[\s_-]?code|\bssn\b|social[\s_-]?security|one[\s_-]?time[\s_-]?(?:code|password)|\botp\b|\b2fa\b|\bmfa\b/i;

/** Field keys that ask for a secret; empty when the form is safe to show. */
export function elicitationSensitiveFields(schema: Record<string, unknown> | null): string[] {
  const properties = record(schema?.properties) ?? {};
  return Object.entries(properties).filter(([key, raw]) => {
    const property = record(raw) ?? {};
    if (property.format === "password" || property.writeOnly === true) return true;
    return [key, property.title, property.description].some((value) => typeof value === "string" && SENSITIVE_FIELD.test(value));
  }).map(([key]) => key);
}

type Choice = { value: unknown; label: string };

/** Enum choices from `enum`, `oneOf`/`anyOf` with `const`+`title` (SEP-1330). */
function choicesOf(schema: Record<string, unknown>): Choice[] | null {
  if (Array.isArray(schema.enum)) {
    const titles = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value, index) => ({ value, label: String(text(titles[index]) ?? value) }));
  }
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!variants) return null;
  const choices: Choice[] = [];
  for (const variant of variants) {
    const entry = record(variant);
    if (!entry || !("const" in entry)) return null;
    choices.push({ value: entry.const, label: String(text(entry.title) ?? entry.const) });
  }
  return choices;
}

const primitive = (value: unknown) => typeof value === "string" || typeof value === "number" || typeof value === "boolean";
const optionId = (index: number) => `choice_${index + 1}`;

type Field = { key: string; property: Record<string, unknown>; question: PaperclipQuestionSetQuestion; choices?: Choice[]; kind: "text" | "number" | "integer" | "boolean" | "single" | "multi" };

// Patterns stay within the fixed-width subset the question form can check
// safely (no repetition), so an email is a hint and the app validates it.
const FORMAT_HINT: Record<string, { help: string; pattern?: string }> = {
  email: { help: "An email address." },
  uri: { help: "A web address." },
  date: { help: "A date, like 2026-11-13.", pattern: "^\\d\\d\\d\\d-\\d\\d-\\d\\d$" },
  "date-time": { help: "A date and time, like 2026-11-13T09:30:00Z." },
};

function fieldFor(key: string, raw: unknown, required: boolean): Field | null {
  const property = record(raw);
  if (!property) return null;
  const prompt = elicitationPlainText(text(property.title) ?? key, 4000);
  const description = text(property.description);
  const help = (extra?: string) => {
    const value = [description ? elicitationPlainText(description, 3000) : null, extra].filter(Boolean).join(" ");
    return value ? { helpText: value.slice(0, 4000) } : {};
  };
  const base = { id: key.slice(0, 160), prompt, required };
  const select = (choices: Choice[], multi: boolean, defaults: unknown[], extra?: string): Field | null => {
    if (!choices.length || choices.length > MAX_OPTIONS || !choices.every((choice) => primitive(choice.value))) return null;
    return {
      key, property, choices, kind: multi ? "multi" : "single",
      question: {
        ...base, ...help(extra), answerMode: multi ? "multi_select" : "single_select",
        options: choices.map((choice, index) => ({
          id: optionId(index), label: elicitationPlainText(choice.label, 1000) || `Option ${index + 1}`,
          ...(defaults.some((value) => value === choice.value) ? { recommended: true } : {}),
        })),
      },
    };
  };
  const type = property.type;
  if (type === "array") {
    const items = record(property.items);
    const choices = items ? choicesOf(items) : null;
    if (!choices) return null;
    const limits = [
      typeof property.minItems === "number" ? `Choose at least ${property.minItems}.` : null,
      typeof property.maxItems === "number" ? `Choose at most ${property.maxItems}.` : null,
    ].filter(Boolean).join(" ");
    return select(choices, true, Array.isArray(property.default) ? property.default : [], limits || undefined);
  }
  const choices = choicesOf(property);
  if (choices) return select(choices, false, property.default === undefined ? [] : [property.default]);
  if (type === "boolean") {
    return select([{ value: true, label: "Yes" }, { value: false, label: "No" }], false, property.default === undefined ? [] : [property.default]);
  }
  if (type === "number" || type === "integer") {
    const minimum = typeof property.minimum === "number" && Number.isFinite(property.minimum) ? property.minimum : undefined;
    const maximum = typeof property.maximum === "number" && Number.isFinite(property.maximum) ? property.maximum : undefined;
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) return null;
    return {
      key, property, kind: type,
      question: {
        ...base, ...help(), answerMode: "text",
        ...(typeof property.default === "number" ? { initialText: String(property.default) } : {}),
        textValidation: { inputType: type, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) },
      },
    };
  }
  if (type === "string" || type === undefined) {
    const format = typeof property.format === "string" ? FORMAT_HINT[property.format] : undefined;
    if (typeof property.format === "string" && !format) return null;
    const minLength = Number.isInteger(property.minLength) && (property.minLength as number) >= 0 ? Math.min(property.minLength as number, 100_000) : undefined;
    const maxLength = Number.isInteger(property.maxLength) && (property.maxLength as number) >= 0 ? Math.min(property.maxLength as number, 100_000) : undefined;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) return null;
    const validation = {
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(format?.pattern ? { pattern: format.pattern } : {}),
    };
    return {
      key, property, kind: "text",
      question: {
        ...base, ...help(format?.help), answerMode: "text",
        ...(typeof property.default === "string" ? { initialText: property.default.slice(0, 100_000) } : {}),
        ...(Object.keys(validation).length ? { textValidation: validation } : {}),
      },
    };
  }
  return null;
}

function fieldsOf(schema: Record<string, unknown> | null): Field[] | null {
  if (schema && schema.type !== undefined && schema.type !== "object") return null;
  const properties = record(schema?.properties) ?? {};
  const entries = Object.entries(properties);
  if (entries.length > MCP_ELICITATION_MAX_FIELDS) return null;
  const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const fields: Field[] = [];
  for (const [key, raw] of entries) {
    const field = fieldFor(key, raw, required.has(key));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

/** The single "Continue" choice a form with no fields becomes. */
const CONTINUE_QUESTION_ID = "continue";

/**
 * The card for one form question, or why Paperclip will not show it. A form
 * asking for a secret is refused before anything is shown; a schema outside
 * the spec's flat primitive subset is refused rather than shown partly.
 */
export function buildElicitationQuestionSet(input: { appName: string; request: McpFormElicitation }): Built {
  const sensitive = elicitationSensitiveFields(input.request.requestedSchema);
  // A form whose message asks for a secret is refused too, whatever its fields are called.
  if (SENSITIVE_MESSAGE.test(input.request.message)) sensitive.unshift("message");
  if (sensitive.length) return { ok: false, reason: "sensitive", fields: sensitive };
  const fields = fieldsOf(input.request.requestedSchema);
  if (!fields) return { ok: false, reason: "unsupported" };
  const appName = elicitationPlainText(input.appName, 120) || "The app";
  const description = elicitationPlainText(input.request.message, 4000) || `${appName} needs more information to continue.`;
  const questions: PaperclipQuestionSetQuestion[] = fields.length
    ? fields.map((field) => field.question)
    : [{ id: CONTINUE_QUESTION_ID, prompt: description, required: true, answerMode: "single_select", options: [{ id: "continue", label: "Continue" }] }];
  return {
    ok: true,
    questionSet: {
      schema: "paperclip.question_set.v1",
      title: `${appName} needs your input`,
      description,
      submitLabel: `Send to ${appName}`.slice(0, 200),
      questions,
    },
  };
}

type CardState = { status: string; result: unknown; payload?: unknown };

/**
 * The elicitation result for a resolved card, or null while it waits.
 * Answered: `accept` with typed content. Skipped: `decline` (the person said
 * no). Anything else that ended the card (withdrawn, task closed, expired,
 * cancelled): `cancel`, since nobody made a choice.
 */
export function elicitationResponseForCard(request: McpFormElicitation, card: CardState | null | undefined): McpElicitationResponse | null {
  if (!card || card.status === "pending") return null;
  const result = record(card.result);
  if (card.status === "answered" && result?.outcome === undefined) {
    // A card saved before typed fields (an MCP Task waiting across the
    // upgrade) keeps its own options; read it the way it was built.
    const payload = record(card.payload);
    const content = payload && !payload.questionSet && Array.isArray(payload.questions)
      ? legacyCardContent(request, payload.questions, result)
      : elicitationContent(request, result);
    return { action: "accept", content };
  }
  if (card.status === "cancelled" && result?.outcome === "skipped") return { action: "decline" };
  return { action: "cancel" };
}

/** Map a person's card answers back onto the provider's schema, typed. */
export function elicitationContent(request: McpFormElicitation, result: unknown): Record<string, unknown> {
  const answers = (Array.isArray(record(result)?.answers) ? record(result)!.answers as unknown[] : [])
    .map(record).filter((answer): answer is Record<string, unknown> => Boolean(answer));
  const fields = fieldsOf(request.requestedSchema) ?? [];
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const answer = answers.find((candidate) => candidate.questionId === field.question.id);
    if (!answer) continue;
    const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds.filter((id): id is string => typeof id === "string") : [];
    const chosen = (field.choices ?? []).filter((_, index) => optionIds.includes(optionId(index))).map((choice) => choice.value);
    const typed = typeof answer.otherText === "string" ? answer.otherText.trim() : "";
    if (field.kind === "multi") { content[field.key] = chosen; continue; }
    if (field.kind === "single" || field.kind === "boolean") { if (chosen.length) content[field.key] = chosen[0]; continue; }
    if (!typed) continue;
    if (field.kind === "number" || field.kind === "integer") {
      const value = Number(typed);
      if (Number.isFinite(value) && (field.kind === "number" || Number.isInteger(value))) content[field.key] = value;
      continue;
    }
    content[field.key] = typed;
  }
  return content;
}

/**
 * Answers on a card built before typed fields: enum choices were listed in
 * the schema's order, and everything else was a written answer.
 */
function legacyCardContent(request: McpFormElicitation, storedQuestions: unknown[], result: unknown): Record<string, unknown> {
  const answers = (Array.isArray(record(result)?.answers) ? record(result)!.answers as unknown[] : [])
    .map(record).filter((answer): answer is Record<string, unknown> => Boolean(answer));
  const properties = record(request.requestedSchema?.properties);
  const textOf = (answer: Record<string, unknown> | undefined) => typeof answer?.otherText === "string" ? answer.otherText.trim() : "";
  if (!properties || !Object.keys(properties).length) {
    const text = textOf(answers.find((answer) => answer.questionId === "response"));
    return text ? { response: text } : {};
  }
  const content: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(properties).slice(0, MCP_ELICITATION_MAX_FIELDS)) {
    const property = record(raw) ?? {};
    const answer = answers.find((candidate) => candidate.questionId === key.slice(0, 120));
    if (!answer) continue;
    const enumValues = Array.isArray(property.enum) ? property.enum : [];
    const stored = storedQuestions.map(record).find((question) => question?.id === key.slice(0, 120));
    const options = Array.isArray(stored?.options) ? stored!.options.map(record) : [];
    const optionIds = Array.isArray(answer.optionIds) ? answer.optionIds : [];
    const index = options.findIndex((option) => typeof option?.id === "string" && optionIds.includes(option.id));
    if (index >= 0 && index < enumValues.length) { content[key] = enumValues[index]; continue; }
    const text = textOf(answer);
    if (!text) continue;
    if (property.type === "number" || property.type === "integer") {
      const value = Number(text);
      if (Number.isFinite(value) && (property.type === "number" || Number.isInteger(value))) content[key] = value;
    } else if (property.type === "boolean") {
      if (/^(true|yes|y|1)$/i.test(text)) content[key] = true;
      else if (/^(false|no|n|0)$/i.test(text)) content[key] = false;
    } else {
      content[key] = text;
    }
  }
  return content;
}

/** Identifies one question by its words and schema, for answering an older server's repeat. */
export function elicitationQuestionHash(request: McpFormElicitation): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : record(value) ? Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return createHash("sha256").update(JSON.stringify(["paperclip:mcp-elicitation-question:v1", request.message, canonical(request.requestedSchema ?? {})])).digest("hex");
}

/** A form request from a stateless `inputRequests` entry or an older `elicitation/create` message. */
export function formElicitationOf(params: Record<string, unknown>): McpFormElicitation | null {
  if (params.mode !== undefined && params.mode !== "form") return null;
  return {
    message: typeof params.message === "string" ? params.message : "",
    requestedSchema: record(params.requestedSchema),
  };
}

/*
 * The server's requestState is opaque and may carry authority, so it is sealed
 * at rest, bound to the company and connection that received it.
 */
const STATE_CONTEXT = "paperclip:mcp-elicitation-state:v1";
const stateKey = (secret: string) => Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), STATE_CONTEXT, 32));
const stateAad = (scope: { companyId: string; connectionId: string }) => Buffer.from(JSON.stringify([STATE_CONTEXT, scope.companyId, scope.connectionId]));

export function sealElicitationState(secret: string, scope: { companyId: string; connectionId: string }, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(secret), iv);
  cipher.setAAD(stateAad(scope));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function openElicitationState(secret: string, scope: { companyId: string; connectionId: string }, sealed: string): string | null {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== "v1" || !iv || ciphertext === undefined || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", stateKey(secret), Buffer.from(iv, "base64url"));
    decipher.setAAD(stateAad(scope));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
