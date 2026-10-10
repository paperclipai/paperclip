import type { PaperclipQuestionResponse } from "../../contracts/harness-driver.js";

/**
 * OpenCode ships two incompatible server HTTP APIs:
 *
 * - V1 (`opencode-ai` 1.x) serves `/global/health`, `/session`,
 *   `/session/:id/prompt_async`, `/event`, `/permission`, `/question`.
 * - V2 (2.x) serves `/api/info`, `/api/session`, `/api/session/{id}/prompt`,
 *   `/api/event`, `/api/session/{id}/permission/{requestID}/reply`, and the
 *   forms API in place of questions.
 *
 * The driver talks to either through this thin client so the session logic
 * stays version-agnostic. The V1 client is byte-for-byte the previous request
 * shapes; the V2 client also normalizes the redesigned `session.*` event family
 * back into the V1-shaped provider events the canonical mapper already
 * consumes.
 */

export type OpenCodeApiVersion = "v1" | "v2";
export type OpenCodeProtocolVersion = "http+sse/v1" | "http+sse/v2";
export type OpenCodePermissionAction =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel";

/** The one V1 release Paperclip qualified end-to-end. */
export const QUALIFIED_OPENCODE_V1_VERSION = "1.18.34" as const;
/** The one V2 release Paperclip qualified live against `opencode serve`. */
export const QUALIFIED_OPENCODE_V2_VERSION = "2.0.26" as const;

/**
 * Qualified windows. A version inside a window is admitted; outside every
 * window the startup guard rejects it. V1 is frozen at the last qualified 1.x
 * release and V2 is pinned to the qualified 2.0 line.
 */
const VERSION_WINDOWS = [
  { minimum: [1, 18, 34], maximum: [2, 0, 0], label: "1.18.34 <= v < 2.0.0" },
  { minimum: [2, 0, 0], maximum: [2, 1, 0], label: "2.0.0 <= v < 2.1.0" },
] as const;

export function compareOpenCodeVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function isSemanticVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** Protocol family for an exact semantic version, or null when unqualified. */
export function openCodeApiVersionForVersion(
  version: string,
): OpenCodeApiVersion | null {
  const major = Number(version.split(".")[0]);
  if (!Number.isSafeInteger(major)) return null;
  if (major === 1) return "v1";
  if (major === 2) return "v2";
  return null;
}

export function isQualifiedOpenCodeVersion(version: string): boolean {
  return VERSION_WINDOWS.some(
    (window) =>
      compareOpenCodeVersions(version, `${window.minimum.join(".")}`) >= 0 &&
      compareOpenCodeVersions(version, `${window.maximum.join(".")}`) < 0,
  );
}

export function qualifiedOpenCodeWindows(): string {
  return VERSION_WINDOWS.map((window) => window.label).join(" or ");
}

export function unqualifiedOpenCodeVersionMessage(version: string): string {
  return (
    `OpenCode ${version} is not a question-conformance-qualified release. ` +
    `Paperclip Runner supports ${qualifiedOpenCodeWindows()} ` +
    `(qualified: ${QUALIFIED_OPENCODE_V1_VERSION}, ${QUALIFIED_OPENCODE_V2_VERSION}). ` +
    `Set PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_RUNNER_VERSION=1 to bypass this guard for an unverified run.`
  );
}

export function allowsUnqualifiedOpenCodeRunnerVersion(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = environment.PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_RUNNER_VERSION?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function protocolVersionForApiVersion(
  apiVersion: OpenCodeApiVersion,
): OpenCodeProtocolVersion {
  return apiVersion === "v2" ? "http+sse/v2" : "http+sse/v1";
}

/** Classify a server-info payload once the transport has resolved it. */
export function classifyOpenCodeServerInfo(input: {
  version: unknown;
  apiVersion: OpenCodeApiVersion;
}): { version: string; apiVersion: OpenCodeApiVersion } | null {
  if (typeof input.version !== "string" || !isSemanticVersion(input.version))
    return null;
  const detected = openCodeApiVersionForVersion(input.version);
  if (detected === null) return null;
  return { version: input.version, apiVersion: detected };
}

/** Transport closure injected by the driver; keeps trace/redaction owned there. */
export interface OpenCodeTransport {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

export interface OpenCodeApiClient {
  readonly apiVersion: OpenCodeApiVersion;
  readonly protocolVersion: OpenCodeProtocolVersion;
  readonly eventPath: string;
  readonly eventTraceMethod: string;
  createSession(input: {
    title: string;
    providerID: string;
    modelID: string;
    agent?: string;
  }): Promise<Record<string, unknown>>;
  getSession(sessionId: string): Promise<Record<string, unknown>>;
  prompt(input: {
    sessionId: string;
    providerID: string;
    modelID: string;
    prompt: string;
    system?: string;
    /** V1 reasoning variant (openrouter). V2 ignores this field. */
    variant?: string;
  }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  messages(sessionId: string): Promise<unknown>;
  activeSessionIds(): Promise<Set<string>>;
  listPendingPermissions(): Promise<Record<string, unknown>[]>;
  listPendingQuestions(sessionId: string): Promise<Record<string, unknown>[]>;
  replyPermission(input: {
    sessionId: string;
    requestId: string;
    action: OpenCodePermissionAction;
  }): Promise<void>;
  replyQuestion(input: {
    sessionId: string;
    requestId: string;
    response: PaperclipQuestionResponse;
    nativeQuestions: Record<string, unknown>[];
    /** Canonical-label arrays used verbatim by the V1 client. */
    answers?: string[][];
  }): Promise<void>;
  replyQuestionAnswers(input: {
    sessionId: string;
    requestId: string;
    nativeQuestions: Record<string, unknown>[];
    answers: Record<string, { answers: string[] }>;
  }): Promise<void>;
  rejectQuestion(input: { sessionId: string; requestId: string }): Promise<void>;
  normalizeEvent(raw: unknown): unknown[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function tryParse(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export function openCodeQuestionId(
  question: Record<string, unknown>,
  index: number,
): string {
  const nativeId = text(question.id).trim();
  if (nativeId) return nativeId.slice(0, 160);
  const header = text(question.header)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return header || `question-${index + 1}`;
}

/** V1 question replies send ordered answer arrays (one per native question). */
export function openCodeAnswerArrays(
  nativeQuestions: Record<string, unknown>[],
  response: PaperclipQuestionResponse,
): string[][] {
  return nativeQuestions.map((nativeQuestion, index) => {
    const questionId = openCodeQuestionId(nativeQuestion, index);
    const question = response.answers[questionId];
    if (!question) return [];
    const options = Array.isArray(nativeQuestion.options)
      ? nativeQuestion.options.map(record)
      : [];
    const values = (question.selectedOptionIds ?? [])
      .map((optionId) => {
        const match = options.find(
          (option) => text(option.id) === optionId || text(option.value) === optionId,
        );
        return text(match?.label, text(match?.value, optionId));
      })
      .filter((value): value is string => typeof value === "string");
    if (question.text !== undefined) values.push(question.text);
    if (question.customText !== undefined) values.push(question.customText);
    return values;
  });
}

/**
 * V2 form replies send one `Form.Answer` map keyed by each field's `key`.
 * Field identity is carried through the synthesized native question.
 */
export function openCodeFormAnswer(
  nativeQuestions: Record<string, unknown>[],
  response: PaperclipQuestionResponse,
): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const [index, nativeQuestion] of nativeQuestions.entries()) {
    const key = text(
      nativeQuestion.key,
      openCodeQuestionId(nativeQuestion, index),
    );
    const fieldType = text(nativeQuestion.fieldType, text(nativeQuestion.type));
    const question = response.answers[key] ?? response.answers[openCodeQuestionId(nativeQuestion, index)];
    if (!question) {
      if (fieldType === "multiselect") answer[key] = [];
      else if (fieldType === "boolean") answer[key] = false;
      else answer[key] = "";
      continue;
    }
    const options = Array.isArray(nativeQuestion.options)
      ? nativeQuestion.options.map(record)
      : [];
    const values = (question.selectedOptionIds ?? []).map((optionId) => {
      const match = options.find(
        (option) => text(option.id) === optionId || text(option.value) === optionId,
      );
      return text(match?.value, text(match?.id, optionId));
    });
    const textValue = question.text ?? question.customText;
    if (fieldType === "multiselect") {
      answer[key] = textValue !== undefined ? [...values, textValue] : values;
    } else if (fieldType === "boolean") {
      answer[key] = textValue === "true" || values[0] === "true";
    } else if (fieldType === "number" || fieldType === "integer") {
      const numeric = Number(textValue ?? values[0]);
      answer[key] = Number.isFinite(numeric) ? numeric : 0;
    } else {
      answer[key] = textValue ?? values[0] ?? "";
    }
  }
  return answer;
}

// ---------------------------------------------------------------------------
// V1 client - the historical request shapes, unchanged.
// ---------------------------------------------------------------------------

class OpenCodeV1Client implements OpenCodeApiClient {
  readonly apiVersion = "v1" as const;
  readonly protocolVersion = "http+sse/v1" as const;
  readonly eventPath = "/event";
  readonly eventTraceMethod = "SSE /event";

  constructor(
    private readonly transport: OpenCodeTransport,
    private readonly directory: string,
  ) {}

  async createSession(input: {
    title: string;
    providerID: string;
    modelID: string;
  }): Promise<Record<string, unknown>> {
    return record(
      await this.transport.request("/session", {
        method: "POST",
        body: JSON.stringify({ title: input.title }),
      }),
    );
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return record(
      await this.transport.request(`/session/${encodeURIComponent(sessionId)}`),
    );
  }

  async prompt(input: {
    sessionId: string;
    providerID: string;
    modelID: string;
    prompt: string;
    system?: string;
    variant?: string;
  }): Promise<void> {
    await this.transport.request(
      `/session/${encodeURIComponent(input.sessionId)}/prompt_async`,
      {
        method: "POST",
        body: JSON.stringify({
          // OpenCode 1.18's PromptPayload carries the provider and model at
          // the top level. Keep the persisted provider/model form and adapt it
          // at this HTTP boundary.
          providerID: input.providerID,
          modelID: input.modelID,
          // Always select a deterministic variant on an ordinary turn so a
          // previous disabled turn cannot change this turn's provider defaults.
          ...(input.variant ? { variant: input.variant } : {}),
          ...(input.system ? { system: input.system } : {}),
          parts: [{ type: "text", text: input.prompt }],
        }),
      },
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.transport.request(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      { method: "POST" },
    );
  }

  async messages(sessionId: string): Promise<unknown> {
    return this.transport.request(
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  async activeSessionIds(): Promise<Set<string>> {
    const status = record(await this.transport.request("/session/status"));
    const active = new Set<string>();
    for (const [id, value] of Object.entries(status)) {
      const type = text(record(value).type);
      if (type && type !== "idle") active.add(id);
    }
    return active;
  }

  async listPendingPermissions(): Promise<Record<string, unknown>[]> {
    return listFrom(
      await this.transport.request(
        `/permission?directory=${encodeURIComponent(this.directory)}`,
      ),
      "permissions",
    );
  }

  async listPendingQuestions(sessionId: string): Promise<Record<string, unknown>[]> {
    void sessionId;
    return listFrom(
      await this.transport.request(
        `/question?directory=${encodeURIComponent(this.directory)}`,
      ),
      "questions",
    );
  }

  async replyPermission(input: {
    sessionId: string;
    requestId: string;
    action: OpenCodePermissionAction;
  }): Promise<void> {
    await this.transport.request(
      `/permission/${encodeURIComponent(input.requestId)}/reply?directory=${encodeURIComponent(this.directory)}`,
      {
        method: "POST",
        body: JSON.stringify({ reply: openCodePermissionReply(input.action) }),
      },
    );
  }

  async replyQuestion(input: {
    sessionId: string;
    requestId: string;
    response: PaperclipQuestionResponse;
    nativeQuestions: Record<string, unknown>[];
    answers?: string[][];
  }): Promise<void> {
    await this.transport.request(
      `/question/${encodeURIComponent(input.requestId)}/reply?directory=${encodeURIComponent(this.directory)}`,
      {
        method: "POST",
        body: JSON.stringify({
          answers:
            input.answers ??
            openCodeAnswerArrays(input.nativeQuestions, input.response),
        }),
      },
    );
  }

  async rejectQuestion(input: { requestId: string }): Promise<void> {
    await this.transport.request(
      `/question/${encodeURIComponent(input.requestId)}/reject?directory=${encodeURIComponent(this.directory)}`,
      { method: "POST" },
    );
  }

  async replyQuestionAnswers(input: {
    requestId: string;
    nativeQuestions: Record<string, unknown>[];
    answers: Record<string, { answers: string[] }>;
  }): Promise<void> {
    await this.transport.request(
      `/question/${encodeURIComponent(input.requestId)}/reply?directory=${encodeURIComponent(this.directory)}`,
      {
        method: "POST",
        body: JSON.stringify({
          answers: input.nativeQuestions.map(
            (question, index) =>
              input.answers[openCodeQuestionId(question, index)]?.answers ?? [],
          ),
        }),
      },
    );
  }

  normalizeEvent(raw: unknown): unknown[] {
    return [raw];
  }
}

// ---------------------------------------------------------------------------
// V2 client.
// ---------------------------------------------------------------------------

class OpenCodeV2Client implements OpenCodeApiClient {
  readonly apiVersion = "v2" as const;
  readonly protocolVersion = "http+sse/v2" as const;
  readonly eventPath = "/api/event";
  readonly eventTraceMethod = "SSE /api/event";

  readonly #normalizer = new OpenCodeV2EventNormalizer();

  constructor(private readonly transport: OpenCodeTransport) {}

  async createSession(input: {
    title: string;
    providerID: string;
    modelID: string;
    agent?: string;
  }): Promise<Record<string, unknown>> {
    const created = await this.transport.request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        model: { providerID: input.providerID, id: input.modelID },
        ...(input.agent ? { agent: input.agent } : {}),
      }),
    });
    return record(record(created).data);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    const value = await this.transport.request(
      `/api/session/${encodeURIComponent(sessionId)}`,
    );
    return record(record(value).data);
  }

  async prompt(input: {
    sessionId: string;
    providerID: string;
    modelID: string;
    prompt: string;
    system?: string;
  }): Promise<void> {
    // V2 carries the model on the session (set at creation) and the system
    // prompt on the selected agent (set through config), so the prompt body is
    // just the text.
    void input.providerID;
    void input.modelID;
    void input.system;
    await this.transport.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/prompt`,
      { method: "POST", body: JSON.stringify({ text: input.prompt }) },
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.transport.request(
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
    );
  }

  async messages(sessionId: string): Promise<unknown> {
    const value = await this.transport.request(
      `/api/session/${encodeURIComponent(sessionId)}/message`,
    );
    return record(value).data ?? value;
  }

  async activeSessionIds(): Promise<Set<string>> {
    const value = await this.transport.request("/api/session/active");
    const active = new Set<string>();
    for (const id of Object.keys(record(record(value).data))) active.add(id);
    return active;
  }

  async listPendingPermissions(): Promise<Record<string, unknown>[]> {
    const value = await this.transport.request("/api/permission/request");
    return listFrom(record(value).data, "");
  }

  async listPendingQuestions(sessionId: string): Promise<Record<string, unknown>[]> {
    const value = await this.transport.request(
      `/api/session/${encodeURIComponent(sessionId)}/form`,
    );
    return listFrom(record(value).data, "").map((form) => ({
      id: text(form.id),
      sessionID: text(form.sessionID, sessionId),
      title: text(form.title),
      questions: formFieldsToQuestions(form.fields),
    }));
  }

  async replyPermission(input: {
    sessionId: string;
    requestId: string;
    action: OpenCodePermissionAction;
  }): Promise<void> {
    await this.transport.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/permission/${encodeURIComponent(input.requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: openCodePermissionReply(input.action),
        }),
      },
    );
  }

  async replyQuestion(input: {
    sessionId: string;
    requestId: string;
    response: PaperclipQuestionResponse;
    nativeQuestions: Record<string, unknown>[];
  }): Promise<void> {
    await this.transport.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/form/${encodeURIComponent(input.requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          answer: openCodeFormAnswer(input.nativeQuestions, input.response),
        }),
      },
    );
  }

  async rejectQuestion(input: {
    sessionId: string;
    requestId: string;
  }): Promise<void> {
    await this.transport.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/form/${encodeURIComponent(input.requestId)}`,
      { method: "DELETE" },
    );
  }

  async replyQuestionAnswers(input: {
    sessionId: string;
    requestId: string;
    nativeQuestions: Record<string, unknown>[];
    answers: Record<string, { answers: string[] }>;
  }): Promise<void> {
    const answer: Record<string, unknown> = {};
    for (const [index, nativeQuestion] of input.nativeQuestions.entries()) {
      const key = text(
        nativeQuestion.key,
        openCodeQuestionId(nativeQuestion, index),
      );
      const values =
        input.answers[key]?.answers ??
        input.answers[openCodeQuestionId(nativeQuestion, index)]?.answers ??
        [];
      const fieldType = text(nativeQuestion.fieldType, text(nativeQuestion.type));
      answer[key] = fieldType === "multiselect" ? values : (values[0] ?? "");
    }
    await this.transport.request(
      `/api/session/${encodeURIComponent(input.sessionId)}/form/${encodeURIComponent(input.requestId)}/reply`,
      { method: "POST", body: JSON.stringify({ answer }) },
    );
  }

  normalizeEvent(raw: unknown): unknown[] {
    return this.#normalizer.normalize(raw);
  }
}

function openCodePermissionReply(
  action: OpenCodePermissionAction,
): "once" | "always" | "reject" {
  if (action === "accept") return "once";
  if (action === "accept_for_session") return "always";
  return "reject";
}

function listFrom(value: unknown, key: string): Record<string, unknown>[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record(value)[key])
      ? (record(value)[key] as unknown[])
      : [];
  return source.map(record);
}

export function createOpenCodeApiClient(input: {
  apiVersion: OpenCodeApiVersion;
  transport: OpenCodeTransport;
  directory: string;
}): OpenCodeApiClient {
  return input.apiVersion === "v2"
    ? new OpenCodeV2Client(input.transport)
    : new OpenCodeV1Client(input.transport, input.directory);
}

// ---------------------------------------------------------------------------
// V2 event normalization.
//
// The V2 server replaced the V1 `message.*`/`session.idle` event family with a
// granular `session.*` family. Rather than fork the canonical PRP mapper, this
// normalizer folds each V2 event into the exact V1-shaped provider event the
// mapper already understands. Turn attribution, semantic-result selection, and
// workspace handling therefore stay single-sourced.
// ---------------------------------------------------------------------------

interface SynthesizedProviderEvent {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

class OpenCodeV2EventNormalizer {
  #sequence = 0;
  readonly #text = new Map<string, string>();
  // V2 reports the tool name on the first event for a call and omits it on
  // later running/completed/failed updates. Retain it by call id so the
  // canonical tool part keeps its name (and its read-only classification)
  // across the whole call.
  readonly #toolNames = new Map<string, string>();

  #toolName(toolId: string, value: unknown): string {
    const name = text(value);
    if (name) {
      this.#toolNames.set(toolId, name);
      return name;
    }
    return this.#toolNames.get(toolId) ?? "";
  }

  normalize(raw: unknown): SynthesizedProviderEvent[] {
    const event = record(raw);
    const type = text(event.type);
    const data = record(event.data);
    const eventId = text(event.id, `${type}:${this.#sequence + 1}`);
    const sessionId = text(
      data.sessionID,
      text(record(data.info).sessionID, text(record(data.form).sessionID)),
    );
    const emit = (
      eventType: string,
      properties: Record<string, unknown>,
    ): SynthesizedProviderEvent[] => {
      this.#sequence += 1;
      return [
        {
          id: `${eventId}#${this.#sequence}`,
          type: eventType,
          properties: { ...(sessionId ? { sessionID: sessionId } : {}), ...properties },
        },
      ];
    };
    switch (type) {
      case "session.step.started": {
        const messageId = text(data.assistantMessageID);
        if (!messageId) return [];
        return emit("message.updated", {
          info: { id: messageId, sessionID: sessionId, role: "assistant" },
        });
      }
      case "session.text.started":
      case "session.reasoning.started":
        return this.#partStarted(type, data);
      case "session.text.delta":
      case "session.reasoning.delta":
        return this.#partDelta(type, eventId, data, false, emit);
      case "session.text.ended":
      case "session.reasoning.ended":
        return this.#partDelta(type, eventId, data, true, emit);
      case "session.tool.input.started": {
        const messageId = text(data.assistantMessageID);
        const toolId = text(data.id);
        if (!messageId || !toolId) return [];
        return emit("message.part.updated", {
          part: {
            id: toolId,
            messageID: messageId,
            type: "tool",
            tool: this.#toolName(toolId, data.name),
            callID: toolId,
            state: { status: "pending" },
          },
        });
      }
      case "session.tool.input.ended":
      case "session.tool.called": {
        const messageId = text(data.assistantMessageID);
        const toolId = text(data.id);
        if (!messageId || !toolId) return [];
        return emit("message.part.updated", {
          part: {
            id: toolId,
            messageID: messageId,
            type: "tool",
            tool: this.#toolName(toolId, data.name),
            callID: toolId,
            state: {
              status: "running",
              input:
                type === "session.tool.input.ended"
                  ? tryParse(data.text)
                  : record(data.input),
            },
          },
        });
      }
      case "session.tool.succeeded": {
        const messageId = text(data.assistantMessageID);
        const toolId = text(data.id);
        if (!messageId || !toolId) return [];
        const output =
          text(data.output) ||
          (typeof data.result === "string" ? data.result : "") ||
          (data.result !== undefined ? JSON.stringify(data.result) : "");
        return emit("message.part.updated", {
          part: {
            id: toolId,
            messageID: messageId,
            type: "tool",
            tool: this.#toolName(toolId, data.name),
            callID: toolId,
            state: { status: "completed", input: record(data.input), output },
          },
        });
      }
      case "session.tool.failed": {
        const messageId = text(data.assistantMessageID);
        const toolId = text(data.id);
        if (!messageId || !toolId) return [];
        return emit("message.part.updated", {
          part: {
            id: toolId,
            messageID: messageId,
            type: "tool",
            tool: this.#toolName(toolId, data.name),
            callID: toolId,
            state: {
              status: "error",
              input: record(data.input),
              error: text(
                record(data.error).message,
                text(data.error, "OpenCode tool call failed"),
              ),
            },
          },
        });
      }
      case "session.step.ended": {
        const messageId = text(data.assistantMessageID);
        if (!messageId) return [];
        return emit("message.updated", {
          info: {
            id: messageId,
            sessionID: sessionId,
            role: "assistant",
            ...(data.tokens !== undefined ? { tokens: data.tokens } : {}),
            ...(data.cost !== undefined ? { cost: data.cost } : {}),
          },
        });
      }
      case "session.execution.succeeded":
        return emit("session.idle", {});
      case "session.execution.failed":
        return emit("session.error", {
          error:
            data.error ??
            ({ name: "ProviderError", message: "OpenCode execution failed." } as const),
        });
      case "session.execution.interrupted":
        return emit("session.error", {
          error: {
            name: "MessageAbortedError",
            data: { message: "Aborted" },
          },
        });
      case "session.error":
        return emit("session.error", {
          error:
            data.error ??
            ({ name: "ProviderError", message: "OpenCode session failed." } as const),
        });
      case "permission.asked": {
        const title =
          [text(data.action), ...stringList(data.resources)].filter(Boolean).join(" ").trim() ||
          "requested operation";
        return emit("permission.updated", { ...data, title });
      }
      case "permission.replied":
        return emit("permission.replied", {
          requestID: text(data.requestID, text(data.id)),
          reply: text(data.reply),
        });
      case "form.created": {
        const form = record(data.form);
        const formId = text(form.id, text(data.id));
        if (!formId) return [];
        return emit("question.asked", {
          id: formId,
          title: text(form.title),
          questions: formFieldsToQuestions(form.fields),
        });
      }
      case "form.replied": {
        const formId = text(data.id, text(record(data.form).id));
        if (!formId) return [];
        return emit("question.replied", { id: formId });
      }
      case "form.cancelled": {
        const formId = text(data.id, text(record(data.form).id));
        if (!formId) return [];
        return emit("question.rejected", { id: formId });
      }
      default:
        return [];
    }
  }

  #partStarted(
    type: string,
    data: Record<string, unknown>,
  ): SynthesizedProviderEvent[] {
    const messageId = text(data.assistantMessageID);
    if (!messageId) return [];
    const partType = type.startsWith("session.text") ? "text" : "reasoning";
    const ordinal = Number.isSafeInteger(data.ordinal) ? data.ordinal : 0;
    const partId = `${messageId}:${partType}:${ordinal}`;
    this.#text.set(partId, "");
    return [];
  }

  #partDelta(
    type: string,
    eventId: string,
    data: Record<string, unknown>,
    terminal: boolean,
    emit: (eventType: string, properties: Record<string, unknown>) => SynthesizedProviderEvent[],
  ): SynthesizedProviderEvent[] {
    const messageId = text(data.assistantMessageID);
    if (!messageId) return [];
    const partType = type.startsWith("session.text") ? "text" : "reasoning";
    const ordinal = Number.isSafeInteger(data.ordinal) ? data.ordinal : 0;
    const partId = `${messageId}:${partType}:${ordinal}`;
    const fullText = text(data.text);
    const accumulated = terminal
      ? fullText || (this.#text.get(partId) ?? "")
      : `${this.#text.get(partId) ?? ""}${text(data.delta)}`;
    this.#text.set(partId, accumulated);
    if (terminal) this.#text.delete(partId);
    void eventId;
    return emit("message.part.updated", {
      part: {
        id: partId,
        messageID: messageId,
        type: partType,
        text: accumulated,
        ...(terminal ? { time: { start: Date.now(), end: Date.now() } } : {}),
      },
    });
  }
}

// A local alias keeps the class method signatures readable without exporting.
type synthetic_events = SynthesizedProviderEvent[];

function stringList(value: unknown): string[] {
  return array(value).map((entry) => text(entry)).filter(Boolean);
}

/**
 * Map V2 `Form.Field` entries into the V1-shaped native question records the
 * canonical question normalizer expects, preserving the form field `key` and
 * `type` so the reply can be rebuilt as a `Form.Answer`.
 */
export function formFieldsToQuestions(value: unknown): Record<string, unknown>[] {
  return array(value).slice(0, 64).map((entry) => {
    const field = record(entry);
    const fieldType = text(field.type, "string");
    const options = array(field.options).slice(0, 128).map((option) => {
      const parsed = record(option);
      return {
        id: text(parsed.value, text(parsed.id, text(parsed.label))),
        value: text(parsed.value, text(parsed.id, text(parsed.label))),
        label: text(parsed.label, text(parsed.value, text(parsed.id))),
        ...(text(parsed.description)
          ? { description: text(parsed.description) }
          : {}),
      };
    });
    return {
      id: text(field.key, text(field.id)),
      key: text(field.key, text(field.id)),
      header: text(field.title, text(field.key)),
      question: text(field.title, text(field.description, text(field.key))),
      ...(text(field.description) ? { description: text(field.description) } : {}),
      fieldType,
      type: fieldType,
      multiple: fieldType === "multiselect",
      required: field.required === true,
      custom: field.custom === true,
      ...(options.length > 0 ? { options } : {}),
    };
  });
}
