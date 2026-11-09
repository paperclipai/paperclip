import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  parsePaperclipQuestionResponse,
  parsePaperclipQuestionSet,
  type PaperclipQuestionSet,
} from "../../contracts/question-set.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import type { HarnessRuntimeRequestResolution } from "../../contracts/harness-driver.js";

export const CURSOR_EXTENSION_REQUEST_METHODS = [
  "cursor/ask_question", "cursor/create_plan",
] as const;
// The pinned binary sends these with extMethod (a JSON-RPC ID), even though
// Cursor documents them as notifications. Acknowledge immediately with {}.
export const CURSOR_EXTENSION_NOTIFICATION_METHODS = [
  "cursor/update_todos", "cursor/task", "cursor/generate_image",
] as const;
export const CURSOR_CLIENT_CAPABILITIES = { _meta: { subagents: true } } as const;

type CursorExtensionInput = {
  method: string;
  questionSet: PaperclipQuestionSet;
  details: Record<string, unknown>;
  resolve(resolution: HarnessRuntimeRequestResolution): Record<string, unknown>;
  cancel(): Record<string, unknown>;
};
type CursorExtensionResult = { input: CursorExtensionInput }
  | { events: CanonicalProviderEvent[]; response: Record<string, unknown> };

/** One adapter belongs to exactly one active session/turn, never a warm process. */
export function createCursorProfileExtensionAdapter(context: {
  workspacePath: string; sessionId: string; turnId: string;
}) {
  const normalizeNotification = createCursorNotificationNormalizer(context);
  const normalizeSubagent = createCursorSubagentNormalizer();
  const children = new Map<string, { toolCallId: string; agentId?: string; parentSessionId: string; event: CanonicalProviderEvent; activity: string }>();
  const assertSession = (params: Record<string, unknown>) => {
    if (params.sessionId !== context.sessionId) throw new Error("Cursor extension has a stale parent session");
  };
  return {
    async request(method: string, params: Record<string, unknown>): Promise<CursorExtensionResult> {
      assertSession(params);
      if (method === "cursor/ask_question") {
        const question = normalizeCursorQuestionRequest(params);
        return { input: {
          method, questionSet: question.questionSet, details: { toolCallId: question.toolCallId },
          cancel: question.cancel,
          resolve(resolution) {
            if (resolution.action === "cancel") return question.cancel();
            if (resolution.action === "decline") return question.skip();
            if (resolution.action !== "submit" || !("response" in resolution)) throw new Error("Cursor questions require a complete canonical answer");
            return question.resolve(resolution.response);
          },
        } };
      }
      if (method === "cursor/create_plan") {
        const plan = normalizeCursorPlanRequest(params);
        return { input: {
          method, questionSet: plan.questionSet, details: { toolCallId: plan.toolCallId, revision: plan.revision },
          cancel: plan.cancel,
          resolve(resolution) {
            if (resolution.action === "cancel") return plan.cancel();
            if (resolution.action === "decline") return { outcome: { outcome: "rejected" } };
            if (resolution.action !== "submit" || !("response" in resolution)) throw new Error("Cursor plan decisions require the displayed revision");
            return plan.resolve(resolution.response);
          },
        } };
      }
      if (!(CURSOR_EXTENSION_NOTIFICATION_METHODS as readonly string[]).includes(method)) throw new Error("Unsupported Cursor extension request");
      return { events: await normalizeNotification(method, params), response: {} };
    },
    async notification(method: string, params: Record<string, unknown>): Promise<CanonicalProviderEvent[]> {
      assertSession(params);
      if (method !== "cursor/subagent_update") return normalizeNotification(method, params);
      // The transport synthesizes this method only from the two pinned native
      // session/update variants, after checking the active parent connection.
      const update = object(params.update);
      const parentSessionId = optionalText(params.parentSessionId, "parentSessionId", 1_000) ?? context.sessionId;
      if (parentSessionId !== context.sessionId && !children.has(parentSessionId)) throw new Error("Cursor child has an unknown parent");
      if (params.childSessionId !== undefined) {
        const childId = requiredText(params.childSessionId, "childSessionId", 1_000);
        const child = children.get(childId);
        if (!child || child.parentSessionId !== parentSessionId) throw new Error("Cursor child activity has no matching spawn");
        const summary = cursorChildActivitySummary(update);
        const combined = [child.activity, summary.text].filter(Boolean).join("\n");
        child.activity = boundedChildActivity(combined);
        const event = structuredClone(child.event);
        event.eventType = "delegation.updated";
        const nested = object((event.payload.children as unknown[])[0]);
        nested.activitySummary = child.activity;
        child.event = event;
        return [event, ...(summary.gap ? [notice(`${childId}:${String(update.sessionUpdate)}`, "cursor_child_detail_partial", summary.gap)] : [])];
      }
      const id = requiredText(update.subagentSessionId, "subagentSessionId", 1_000);
      if (id === context.sessionId) throw new Error("Cursor child cannot impersonate its parent session");
      const metadata = object(object(update._meta).cursor);
      const toolCallId = requiredText(metadata.toolCallId, "subagent toolCallId", 1_000);
      const agentId = optionalText(metadata.agentId, "subagent agentId", 1_000);
      const previous = children.get(id);
      if (update.sessionUpdate === "subagent_spawned") {
        if (previous || children.size >= 256) throw new Error("Cursor child session identity is duplicated or over capacity");
      } else if (update.sessionUpdate !== "subagent_state_update" || !previous) {
        throw new Error("Cursor child update has no spawn in this active turn");
      }
      if (previous && (previous.toolCallId !== toolCallId || previous.agentId !== agentId || previous.parentSessionId !== parentSessionId)) throw new Error("Cursor child update changed its origin identity");
      const event = normalizeSubagent(update);
      if (!event) throw new Error("Unsupported Cursor child update");
      const nested = object((event.payload.children as unknown[])[0]);
      const activity = boundedChildActivity([parentSessionId === context.sessionId ? undefined : `Parent child: ${stableId(parentSessionId)}`, previous?.activity, nested.activitySummary].filter(Boolean).join("\n"));
      nested.activitySummary = activity || null;
      children.set(id, { toolCallId, agentId, parentSessionId, event, activity });
      return [event];
    },
  };
}

type CursorQuestionResult = { outcome:
  | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
  | { outcome: "skipped"; reason?: string }
  | { outcome: "cancelled" }
};
type CursorPlanResult = { outcome:
  | { outcome: "accepted" }
  | { outcome: "rejected"; reason?: string }
  | { outcome: "cancelled" }
};
type Todo = { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };

/** Native IDs are mapped through opaque UI IDs, including prototype-like keys. */
export function normalizeCursorQuestionRequest(value: unknown): {
  toolCallId: string;
  questionSet: PaperclipQuestionSet;
  accept(response: unknown): CursorQuestionResult;
  resolve(response: unknown): CursorQuestionResult;
  cancel(): CursorQuestionResult;
  skip(reason?: string): CursorQuestionResult;
} {
  const request = object(value);
  const toolCallId = requiredText(request.toolCallId, "toolCallId", 1_000);
  const nativeQuestions = array(request.questions, "questions", 64, true);
  const seenQuestions = new Set<string>();
  const bindings = nativeQuestions.map((raw, index) => {
    const question = object(raw);
    const nativeId = unique(requiredText(question.id, "question.id", 1_000), seenQuestions, "question ID");
    const seenOptions = new Set<string>();
    if (question.allowMultiple !== undefined && typeof question.allowMultiple !== "boolean") {
      throw new Error("Cursor allowMultiple must be boolean");
    }
    const options = array(question.options, "options", 128, true).map((rawOption, optionIndex) => {
      const option = object(rawOption);
      return {
        nativeId: unique(requiredText(option.id, "option.id", 1_000), seenOptions, "option ID"),
        id: `option-${optionIndex + 1}`,
        label: requiredText(option.label, "option.label", 1_000),
      };
    });
    return {
      nativeId, options,
      question: {
        id: `question-${index + 1}`,
        prompt: requiredText(question.prompt, "question.prompt", 4_000),
        required: true,
        answerMode: question.allowMultiple === true ? "multi_select" as const : "single_select" as const,
        options: options.map(({ id, label }) => ({ id, label })),
      },
    };
  });
  const questionSet = boundedQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: optionalText(request.title, "title", 1_000) ?? "Cursor needs input",
    questions: bindings.map(({ question }) => question),
  });
  const accept = (response: unknown): CursorQuestionResult => {
    const parsed = parsePaperclipQuestionResponse(questionSet, response);
    return { outcome: { outcome: "answered", answers: bindings.map(binding => ({
      questionId: binding.nativeId,
      selectedOptionIds: (parsed.answers[binding.question.id]?.selectedOptionIds ?? []).map(id => {
        const option = binding.options.find(candidate => candidate.id === id);
        if (!option) throw new Error("Cursor question option is no longer available");
        return option.nativeId;
      }),
    })) } };
  };
  return {
    toolCallId, questionSet, accept, resolve: accept,
    cancel: () => ({ outcome: { outcome: "cancelled" } }),
    skip: (reason?: string) => ({ outcome: { outcome: "skipped", ...(reason === undefined ? {} : { reason: requiredText(reason, "reason", 4_000) }) } }),
  };
}

/** The approval question ID binds the entire displayed revision, not its title. */
export function normalizeCursorPlanRequest(value: unknown): {
  toolCallId: string;
  revision: string;
  questionSet: PaperclipQuestionSet;
  resolve(response: unknown): CursorPlanResult;
  cancel(): CursorPlanResult;
} {
  const request = object(value);
  const toolCallId = requiredText(request.toolCallId, "toolCallId", 1_000);
  const plan = requiredText(request.plan, "plan", 100_000);
  const name = optionalText(request.name, "name", 1_000);
  const overview = optionalText(request.overview, "overview", 4_000);
  const todos = parseTodos(request.todos);
  const phases = request.phases === undefined ? [] : array(request.phases, "phases", 64).map(value => {
    const phase = object(value);
    return { name: requiredText(phase.name, "phase.name", 1_000), todos: parseTodos(phase.todos) };
  });
  if (request.isProject !== undefined && typeof request.isProject !== "boolean") throw new Error("Cursor isProject must be boolean");
  const description = [overview, plan, todos.length ? `Todos\n${renderTodos(todos)}` : undefined,
    ...phases.map(phase => `Phase: ${phase.name}\n${renderTodos(phase.todos)}`),
    request.isProject === true ? "This is a project plan." : undefined,
  ].filter((part): part is string => part !== undefined).join("\n\n");
  // Reject rather than truncating a document that a person must approve.
  requiredText(description, "complete plan presentation", 100_000);
  const revision = createHash("sha256").update(JSON.stringify({ toolCallId, name, overview, plan, todos, phases, isProject: request.isProject ?? false })).digest("hex");
  const questionId = `plan-${revision}`;
  const questionSet = boundedQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title: name ?? "Review Cursor's plan", description, submitLabel: "Send decision",
    questions: [{ id: questionId, prompt: "How should Cursor proceed with this plan?", required: true,
      answerMode: "single_select", options: [
        { id: "accept", label: "Accept plan" },
        { id: "reject", label: "Reject plan" },
        { id: "cancel", label: "Cancel plan request" },
      ] }, { id: "reason", prompt: "Reason for rejecting the plan (optional)", required: false,
        answerMode: "text", textValidation: { maxLength: 4_000 } }],
  });
  return {
    toolCallId, revision, questionSet,
    resolve(response: unknown): CursorPlanResult {
      const parsed = parsePaperclipQuestionResponse(questionSet, response);
      const decision = parsed.answers[questionId]?.selectedOptionIds?.[0];
      const reason = parsed.answers.reason?.text;
      if (decision === "accept") {
        if (reason?.trim()) throw new Error("Cursor's accepted outcome cannot carry feedback; remove feedback or reject the plan");
        return { outcome: { outcome: "accepted" } };
      }
      if (decision === "reject") return { outcome: { outcome: "rejected", ...(reason ? { reason } : {}) } };
      return { outcome: { outcome: "cancelled" } };
    },
    cancel: () => ({ outcome: { outcome: "cancelled" } }),
  };
}

const RICH_EVENT_BYTE_LIMIT = 240 * 1024;
const TODO_DETAIL_OMITTED = "\n[Further todo detail omitted]";

/** Todo activity is a display snapshot, never the document sent for approval. */
function boundTodoProjection(event: CanonicalProviderEvent, todos: Todo[]): CanonicalProviderEvent[] {
  const fits = () => Buffer.byteLength(JSON.stringify(event)) <= RICH_EVENT_BYTE_LIMIT;
  if (fits()) return [event];
  const summary = "Todo detail shortened to fit the activity limit; all todo identities and statuses are preserved.";
  event.payload.explanation = summary;
  const points = todos.map(todo => Array.from(todo.content));
  const prefixes = points.map(parts => {
    let units = 0;
    return parts.filter(point => { units += point.length; return units <= 3_940; });
  });
  const project = (limit: number) => {
    event.payload.steps = todos.map((todo, index) => ({
      stepId: stableId(todo.id),
      body: (points[index]!.length <= limit ? todo.content : prefixes[index]!.slice(0, limit).join("") + TODO_DETAIL_OMITTED)
        + (todo.status === "cancelled" ? "\n(Cancelled)" : ""),
      status: todo.status === "cancelled" ? "blocked" : todo.status,
    }));
  };
  // Measure serialized bytes (including JSON escaping), not string length.
  // A common prefix bound retains useful detail for every todo and never splits
  // a Unicode code point. At most 12 probes for the native 3,980-unit bound.
  let low = 0;
  let high = 3_980;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    project(mid);
    if (fits()) low = mid;
    else high = mid - 1;
  }
  project(low);
  if (!fits()) throw new Error("Cursor todo identities exceed the activity byte bound");
  return [event, notice(`${event.itemId}:todo-detail`, "cursor_todo_detail_partial", summary)];
}

/** Create one reducer per active turn; Cursor todo updates are deltas. */
export function createCursorNotificationNormalizer(input: { workspacePath: string; turnId: string }) {
  let todos = new Map<string, Todo>();
  let revision = 0;
  const planId = stableId(`cursor-plan:${input.turnId}`);
  return async (method: string, value: unknown): Promise<CanonicalProviderEvent[]> => {
    const request = object(value);
    const toolCallId = requiredText(request.toolCallId, "toolCallId", 1_000);
    const itemId = stableId(toolCallId);
    if (method === "cursor/update_todos") {
      if (typeof request.merge !== "boolean") throw new Error("Cursor todo merge must be boolean");
      const next = request.merge ? new Map(todos) : new Map<string, Todo>();
      for (const todo of parseTodos(request.todos)) next.set(todo.id, todo);
      if (next.size > 256) throw new Error("Cursor todo snapshot exceeds 256 items");
      const event: CanonicalProviderEvent = { eventType: "plan.updated", itemId, payload: {
        schema: "paperclip.plan.updated.v1", planId, revision: revision + 1,
        explanation: null,
        steps: Array.from(next.values(), todo => ({ stepId: stableId(todo.id),
          body: todo.status === "cancelled" ? `${todo.content}\n(Cancelled)` : todo.content,
          status: todo.status === "cancelled" ? "blocked" : todo.status })),
        complete: next.size > 0 && Array.from(next.values()).every(todo => todo.status === "completed"),
        syncStatus: "not_applicable", documentRevision: null,
      } };
      const events = boundTodoProjection(event, [...next.values()]);
      // Keep complete native detail for future deltas, but commit only after the
      // entire display snapshot fits the rich-event boundary.
      todos = next;
      revision++;
      return events;
    }
    if (method === "cursor/task") {
      const subtype = typeof request.subagentType === "string" ? request.subagentType : object(request.subagentType).custom;
      const durationMs = request.durationMs;
      if (durationMs !== undefined && (!Number.isSafeInteger(durationMs) || Number(durationMs) < 0)) throw new Error("Cursor task duration must be a nonnegative integer");
      return [{ eventType: "delegation.completed", itemId, payload: {
        schema: "paperclip.delegation.v1", delegationId: itemId, action: "spawn", status: "completed",
        children: [{ childId: stableId(optionalText(request.agentId, "agentId", 1_000) ?? toolCallId),
          role: optionalText(subtype, "subagentType", 160) ?? null,
          model: optionalText(request.model, "model", 240) ?? null, status: "completed",
          summary: requiredText(request.description, "description", 4_000),
          activitySummary: [requiredText(request.prompt, "prompt", 3_800), durationMs === undefined ? undefined : `Duration: ${durationMs} ms`].filter(Boolean).join("\n"),
        }],
      } }];
    }
    if (method === "cursor/generate_image") {
      const description = requiredText(request.description, "description", 4_000);
      const filePath = optionalText(request.filePath, "filePath", 4_096);
      const reference = filePath === undefined ? null : await cursorWorkspaceArtifactReference(input.workspacePath, filePath);
      const references = request.referenceImagePaths === undefined ? [] : array(request.referenceImagePaths, "referenceImagePaths", 16);
      const viewed: CanonicalProviderEvent[] = [];
      for (let index = 0; index < references.length; index++) {
        const source = requiredText(references[index], "referenceImagePath", 4_096);
        const reference = await cursorWorkspaceArtifactReference(input.workspacePath, source);
        const referenceId = stableId(`${toolCallId}:reference:${index}`);
        viewed.push({ eventType: "artifact.viewed", itemId: referenceId, payload: {
          schema: "paperclip.artifact.viewed.v1", artifactId: referenceId, reference, mediaType: "image/*", title: "Cursor image reference",
        } });
      }
      return [{ eventType: "artifact.generated", itemId, payload: {
        schema: "paperclip.artifact.generated.v1", artifactId: itemId,
        status: "completed", reference, mediaType: "image/*", registered: false, failure: null,
      } }, notice(`${toolCallId}:description`, "cursor_image", description),
      ...viewed,
      ...(filePath && reference === null ? [notice(`${toolCallId}:path`, "cursor_artifact_path_rejected", "Cursor reported an image location that could not be verified inside this workspace.", "warning")] : [])];
    }
    throw new Error(`Unsupported Cursor notification method ${method}`);
  };
}

/** References are hints, never instructions to read/upload paths. Revalidate on use. */
export async function cursorWorkspaceArtifactReference(workspacePath: string, filePath: string): Promise<string | null> {
  if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath) || filePath.includes("\\")) return null;
  try {
    const workspace = await realpath(workspacePath);
    // macOS commonly presents /var while realpath returns /private/var.
    let lexical = relative(resolve(workspacePath), resolve(workspacePath, filePath));
    if (!contained(lexical) && isAbsolute(filePath)) lexical = relative(workspace, filePath);
    if (!contained(lexical)) return null;
    const target = resolve(workspace, lexical);
    const physical = await realpath(target);
    const physicalRelative = relative(workspace, physical);
    if (!contained(physicalRelative) || physical !== target || !(await lstat(target)).isFile()) return null;
    return physicalRelative.split(sep).join("/");
  } catch { return null; }
}

/** Call only after the host has verified parent-session/child-session ownership. */
export function normalizeCursorSubagentUpdate(value: unknown): CanonicalProviderEvent | null {
  const update = object(value);
  if (update.sessionUpdate !== "subagent_spawned" && update.sessionUpdate !== "subagent_state_update") return null;
  const metadata = object(object(update._meta).cursor);
  const itemId = stableId(requiredText(metadata.toolCallId, "subagent toolCallId", 1_000));
  const state = update.sessionUpdate === "subagent_spawned" ? "running" : update.state;
  const status = state === "cancelled" ? "interrupted" : state === "disconnected" ? "failed" : state;
  if (!["running", "completed", "failed", "interrupted"].includes(String(status))) throw new Error("Unknown Cursor subagent state");
  return { eventType: status === "running" ? "delegation.started" : "delegation.completed", itemId, payload: {
    schema: "paperclip.delegation.v1", delegationId: itemId, action: "spawn", status,
    children: [{ childId: stableId(requiredText(update.subagentSessionId, "subagentSessionId", 1_000)),
      role: optionalText(update.name, "name", 160) ?? null, model: optionalText(metadata.model, "model", 240) ?? null,
      status, summary: update.task === "" ? null : optionalText(update.task, "task", 4_000) ?? null,
      activitySummary: state === "disconnected" ? "Cursor child disconnected before settling." : null }],
  } };
}

function cursorChildActivitySummary(update: Record<string, unknown>): { text: string; gap?: string } {
  const kind = requiredText(update.sessionUpdate, "child update kind", 160);
  if (["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"].includes(kind)) {
    const content = object(update.content);
    if (content.type === "text" && typeof content.text === "string" && content.text.length <= 65_536) {
      return { text: `${kind === "agent_thought_chunk" ? "Reasoning" : kind === "user_message_chunk" ? "Input" : "Output"}: ${content.text}` };
    }
    return { text: `Child ${kind} contains non-text content.`, gap: "Cursor child media is reported as activity; nested transcript media rendering is not supported yet." };
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = requiredText(update.toolCallId, "child toolCallId", 1_000);
    const title = optionalText(update.title, "child tool title", 4_000) ?? toolCallId;
    const status = optionalText(update.status, "child tool status", 160) ?? "running";
    return { text: `Tool ${title}: ${status}`, gap: "Cursor child tool lifecycle is attributed to the child; raw input, output, locations and diffs need a nested tool surface and are not rendered in this summary." };
  }
  if (kind === "plan") {
    const entries = array(update.entries, "child plan entries", 256);
    return { text: `Child plan: ${entries.map(value => { const entry = object(value); return `[${requiredText(entry.status, "child plan status", 160)}] ${requiredText(entry.content, "child plan step", 4_000)}`; }).join("; ")}` };
  }
  return { text: `Child activity: ${kind}`, gap: `Cursor child update ${kind} was retained as a kind notice; its fields need a nested transcript surface.` };
}

function boundedChildActivity(text: string): string {
  if (text.length <= 4_000) return text;
  const prefix = "[Earlier child activity omitted]\n";
  const points = Array.from(text);
  const tail: string[] = [];
  let length = prefix.length;
  // Bound both UTF-16 consumers and the schema's Unicode code-point count.
  // Keep each complete code point when retaining the most recent activity.
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (length + point.length > 4_000) break;
    tail.push(point);
    length += point.length;
  }
  return prefix + tail.reverse().join("");
}

/** Preserve identity across delta state updates; use a fresh reducer per turn. */
export function createCursorSubagentNormalizer() {
  const children = new Map<string, Record<string, unknown>>();
  return (value: unknown): CanonicalProviderEvent | null => {
    const update = object(value);
    if (update.sessionUpdate !== "subagent_spawned" && update.sessionUpdate !== "subagent_state_update") return null;
    const id = requiredText(update.subagentSessionId, "subagentSessionId", 1_000);
    const previous = children.get(id);
    if (!previous && children.size >= 256) throw new Error("Cursor subagent inventory exceeds 256 children");
    const merged = { ...previous, ...update, _meta: {
      cursor: { ...(previous ? object(object(previous._meta).cursor) : {}), ...object(object(update._meta).cursor) },
    } };
    const normalized = normalizeCursorSubagentUpdate(merged);
    children.set(id, merged);
    return normalized;
  };
}

function notice(id: string, category: string, summary: string, severity: "info" | "warning" = "info"): CanonicalProviderEvent {
  const itemId = stableId(id);
  return { eventType: "provider.notice.recorded", itemId, payload: {
    schema: "paperclip.provider.notice.v1", noticeId: itemId, severity, category,
    scope: "turn", recoverable: true, userActionable: false, summary,
  } };
}
function boundedQuestionSet(value: unknown): PaperclipQuestionSet {
  const parsed = parsePaperclipQuestionSet(value);
  // Match the durable Rust question payload bound, including UTF-8 expansion.
  if (Buffer.byteLength(JSON.stringify(parsed)) > 196 * 1024) throw new Error("Cursor question presentation exceeds the durable input byte bound");
  return parsed;
}
function parseTodos(value: unknown): Todo[] {
  const seen = new Set<string>();
  return array(value, "todos", 256).map(raw => {
    const todo = object(raw);
    if (!["pending", "in_progress", "completed", "cancelled"].includes(String(todo.status))) throw new Error("Unknown Cursor todo status");
    return { id: unique(requiredText(todo.id, "todo.id", 1_000), seen, "todo ID"),
      content: requiredText(todo.content, "todo.content", 3_980), status: todo.status as Todo["status"] };
  });
}
function renderTodos(todos: Todo[]): string { return todos.map(todo => `- [${todo.status}] ${todo.content}`).join("\n"); }
function stableId(value: string): string { return `cursor-${createHash("sha256").update(value).digest("hex")}`; }
function contained(path: string): boolean { return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Cursor payload must be an object");
  return value as Record<string, unknown>;
}
function array(value: unknown, field: string, max: number, nonempty = false): unknown[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && value.length === 0)) throw new Error(`Cursor ${field} must contain ${nonempty ? "1" : "0"} through ${max} items`);
  return value;
}
function optionalText(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, max);
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) throw new Error(`Cursor ${field} must be nonempty text of at most ${max} characters`);
  return value;
}
function unique(value: string, seen: Set<string>, field: string): string {
  if (seen.has(value)) throw new Error(`Duplicate Cursor ${field}`);
  seen.add(value); return value;
}
