/**
 * Redaction for Capability live evidence (track 7U).
 *
 * The live session used to persist provider notifications, tool arguments, and
 * tool results verbatim, and the issue-thread projection then rendered those
 * records into the browser. That made every admitted browser a reader of
 * provider protocol traffic, prompts, thread/turn/item identifiers, model and
 * token metadata, and complete tool results — record classes the Capability
 * security boundary forbids on the public surface.
 *
 * The fix is applied at the point evidence is *recorded*, not at the point it
 * is rendered: `CapabilityLiveSession` writes only what this module allows, so a
 * new reader, a new frame type, a replay payload, or a future serialization
 * cannot reintroduce a value that was never retained. Everything downstream —
 * the projection, the public DTO, the NDJSON frames — narrows further, never
 * widens.
 *
 * What survives is purpose-built: the identifiers the projection needs to pair
 * a call with its result, the revisions it needs to show what changed, the
 * mock entity refs it needs to derive thread items, and our own denial copy.
 * Provider-authored payloads do not survive at all, with one deliberate
 * exception: the disposition summary a `finish_task`/`block_task`/
 * `request_review` call carries, because that text *is* the disposition card
 * the UX contract requires. It is carried under its own key so it reads as an
 * exposed field rather than as a passthrough of raw arguments.
 */

import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";

export type CapabilityEvidenceKind =
  | "session"
  | "provider_event"
  | "tool_exposure"
  | "tool_call"
  | "tool_result"
  | "interaction"
  | "process"
  | "diagnostic"
  | "cleanup";

/** Disposition copy is rendered, so it is bounded rather than unbounded. */
const MAX_DISPOSITION_CHARS = 500;
const MAX_FIELD_NAMES = 32;
const MAX_ENTITY_REFS = 64;

/**
 * Coarse categories for provider notifications. The protocol method name is
 * itself provider surface, so it is mapped to a fixed vocabulary and anything
 * unrecognised collapses to `other` instead of being echoed.
 */
const PROVIDER_EVENT_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  "turn/started": "turn_started",
  "turn/completed": "turn_completed",
  "turn/failed": "turn_failed",
  "item/started": "item_started",
  "item/completed": "item_completed",
  "item/agentMessage/delta": "assistant_delta",
  "item/reasoning/delta": "reasoning_delta",
  "item/reasoning/summaryTextDelta": "reasoning_delta",
  "item/reasoning/textDelta": "reasoning_delta",
  "item/plan/delta": "plan_delta",
  "item/commandExecution/outputDelta": "command_output_delta",
  "item/fileChange/outputDelta": "file_change_delta",
});

/**
 * Provider notifications are reduced to this fixed vocabulary at ingestion.
 * Exporting the classifier lets the live turn pump decide which sanitized
 * progress events deserve an immediate browser frame without duplicating the
 * protocol-method allowlist.
 */
export function capabilityProviderEventCategory(method: string): string {
  return PROVIDER_EVENT_CATEGORIES[method] ?? "other";
}

/** Operations whose input summary is the rendered disposition body (§9). */
const DISPOSITION_OPERATIONS: ReadonlySet<string> = new Set([
  "finish_task",
  "block_task",
  "request_review",
]);

/** Result fields the projection reads. Everything else is provider/mock payload. */
const RESULT_FIELDS = ["commandId", "commandKind", "disposition", "revision", "stateRevision"] as const;

const SESSION_FIELDS = ["action", "sessionId", "mode", "runner", "controlPlane", "reason"] as const;
const PROCESS_FIELDS = ["action", "reason"] as const;
const CLEANUP_FIELDS = ["reason", "authorityCleared", "mockStopped", "processExited"] as const;

const CATALOG_OPERATION_IDS: ReadonlySet<string> = new Set(
  CAPABILITY_SEMANTIC_TOOL_CATALOG.map((descriptor) => descriptor.operationId),
);

const CATALOG_INPUT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  CAPABILITY_SEMANTIC_TOOL_CATALOG.map((descriptor) => {
    const properties = descriptor.inputSchema.properties ?? {};
    return [descriptor.operationId, new Set(Object.keys(properties))] as const;
  }),
);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function copyFields(
  data: Record<string, unknown>,
  names: readonly string[],
): Record<string, CapabilityJsonValue> {
  const result: Record<string, CapabilityJsonValue> = {};
  for (const name of names) {
    const value = data[name];
    if (typeof value === "string") result[name] = clamp(value, MAX_DISPOSITION_CHARS);
    else if (typeof value === "number" || typeof value === "boolean") result[name] = value;
  }
  return result;
}

/**
 * Field *names* an operation declares, intersected with what the call actually
 * carried. A name the catalog does not declare is reported as its own count
 * rather than echoed, so a model-invented argument name never reaches a reader.
 */
export function capabilityAllowlistedInputFields(operationId: string, input: unknown): string[] {
  const declared = CATALOG_INPUT_FIELDS.get(operationId) ?? new Set<string>();
  const present = Object.keys(asRecord(input));
  const known = present.filter((name) => declared.has(name)).sort();
  const unknownCount = present.length - known.length;
  const fields = unknownCount > 0 ? [...known, `${unknownCount} undeclared`] : known;
  return fields.slice(0, MAX_FIELD_NAMES);
}

function redactToolInput(operationId: string, input: unknown): Record<string, CapabilityJsonValue> {
  const summary: Record<string, CapabilityJsonValue> = {
    fields: capabilityAllowlistedInputFields(operationId, input),
  };
  if (!DISPOSITION_OPERATIONS.has(operationId)) return summary;
  const record = asRecord(input);
  const body = asString(record.summary) || asString(record.reason);
  if (body.length > 0) summary.dispositionSummary = clamp(body, MAX_DISPOSITION_CHARS);
  return summary;
}

/**
 * A tool result reduced to the shape the thread and evidence panel read: the
 * outcome, our own denial copy, the revisions, and the mock entity refs the
 * projection resolves into cards. Read-operation payloads — mock task bodies,
 * comment text, search hits — are dropped wholesale; the UI needs the fact of
 * the call, not its contents.
 */
export function redactCapabilityToolResult(result: unknown): Record<string, CapabilityJsonValue> {
  const record = asRecord(result);
  const inner = asRecord(record.result);
  const denial = asRecord(record.denial);
  const entityRefs = Array.isArray(inner.entityRefs)
    ? inner.entityRefs
        .filter((ref): ref is string => typeof ref === "string")
        .slice(0, MAX_ENTITY_REFS)
    : [];
  const redacted: Record<string, CapabilityJsonValue> = {
    ok: record.ok === true,
    stateRevision: typeof record.stateRevision === "number" ? record.stateRevision : 0,
    result: { ...copyFields(inner, RESULT_FIELDS), entityRefs },
  };
  if (record.ok === false) {
    redacted.denial = {
      code: clamp(asString(denial.code), 120),
      message: clamp(asString(denial.message), MAX_DISPOSITION_CHARS),
    };
  }
  return redacted;
}

/**
 * The single gate every evidence record passes through before it is retained.
 *
 * Unlisted kinds and unlisted fields produce `{}` rather than a passthrough, so
 * adding a record class is an explicit decision here instead of an accidental
 * disclosure at the far end of the stream.
 */
export function redactCapabilityEvidenceData(
  kind: CapabilityEvidenceKind,
  data: Record<string, unknown>,
): Record<string, CapabilityJsonValue> {
  switch (kind) {
    case "provider_event":
      return { event: capabilityProviderEventCategory(asString(data.method)) };
    case "diagnostic":
      // A provider diagnostic is operator surface, not board surface. Only the
      // fact that one was recorded survives.
      return { diagnostic: "withheld" };
    case "session":
      // `providerThreadId` and `providerSessionId` are deliberately absent:
      // provider thread identity is not a public record.
      return copyFields(data, SESSION_FIELDS);
    case "process":
      // Process ids are host detail; only the transport transition survives.
      return { ...copyFields(data, PROCESS_FIELDS), runnerExited: data.runnerExited === true };
    case "cleanup":
      return copyFields(data, CLEANUP_FIELDS);
    case "tool_exposure":
      return {
        operationIds: (Array.isArray(data.operationIds) ? data.operationIds : [])
          .filter((id): id is string => typeof id === "string" && CATALOG_OPERATION_IDS.has(id))
          .sort(),
        scenarioId: clamp(asString(data.scenarioId), 120),
      };
    case "tool_call": {
      const operationId = asString(data.operationId);
      return {
        callId: asString(data.callId),
        operationId,
        beforeRevision: typeof data.beforeRevision === "number" ? data.beforeRevision : 0,
        input: redactToolInput(operationId, data.input),
      };
    }
    case "tool_result": {
      const beforeRevision = typeof data.beforeRevision === "number" ? data.beforeRevision : 0;
      return {
        callId: asString(data.callId),
        operationId: asString(data.operationId),
        beforeRevision,
        afterRevision: typeof data.afterRevision === "number" ? data.afterRevision : beforeRevision,
        result: redactCapabilityToolResult(data.result),
      };
    }
    case "interaction":
      // The typed answer already reaches the UI through the mock interaction
      // record it resolved; a second raw copy in evidence buys nothing.
      return {
        interactionId: asString(data.interactionId),
        interactionKind: asString(data.interactionKind),
        outcome: asString(data.outcome),
        stateRevision: typeof data.stateRevision === "number" ? data.stateRevision : 0,
      };
    default:
      return {};
  }
}

/**
 * The one-line `Runner & events` detail. Built from the redacted record rather
 * than by stringifying it, so the evidence panel shows a sentence a reader can
 * use instead of a JSON dump that happens to be safe today.
 */
export function capabilityEvidenceDetail(
  kind: CapabilityEvidenceKind,
  data: Record<string, CapabilityJsonValue>,
): string {
  const value = (name: string): string => {
    const entry = data[name];
    return typeof entry === "string" || typeof entry === "number" ? String(entry) : "";
  };
  switch (kind) {
    case "provider_event":
      return `provider event · ${value("event") || "other"}`;
    case "diagnostic":
      return "provider diagnostic · withheld from the public view";
    case "session":
      return `session · ${value("action") || "recorded"}`;
    case "process":
      return `process · ${value("action") || "recorded"}`;
    case "cleanup":
      return `cleanup · ${data.authorityCleared === true ? "authority cleared" : "recorded"}`;
    case "tool_exposure": {
      const ids = Array.isArray(data.operationIds) ? data.operationIds.length : 0;
      return `tool exposure · ${ids} operation${ids === 1 ? "" : "s"}`;
    }
    case "tool_call": {
      const fields = asRecord(data.input).fields;
      const count = Array.isArray(fields) ? fields.length : 0;
      return `tool call · ${value("operationId")} · ${count} field${count === 1 ? "" : "s"}`;
    }
    case "tool_result": {
      const result = asRecord(data.result);
      return `tool result · ${value("operationId")} · ${result.ok === true ? "ok" : "denied"} · revision ${value("afterRevision")}`;
    }
    case "interaction":
      return `interaction · ${value("interactionKind")} · ${value("outcome")}`;
    default:
      return kind;
  }
}

export interface CapabilityEvidenceDetailRow {
  label: string;
  value: string;
}

/**
 * Complete browser-safe detail for one retained event.
 *
 * This intentionally enumerates each field rather than stringifying `data`.
 * The retained record is already redacted, but the public diagnostics surface
 * remains fail-closed when a future ingestion field is added.
 */
export function capabilityEvidenceDetails(
  kind: CapabilityEvidenceKind,
  data: Record<string, CapabilityJsonValue>,
): CapabilityEvidenceDetailRow[] {
  const rows: CapabilityEvidenceDetailRow[] = [];
  const add = (label: string, value: CapabilityJsonValue | undefined): void => {
    if (typeof value === "string" && value.length > 0) rows.push({ label, value });
    else if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ label, value: String(value) });
    }
  };
  const addList = (label: string, value: CapabilityJsonValue | undefined): void => {
    if (!Array.isArray(value)) return;
    const entries = value.filter((entry): entry is string => typeof entry === "string");
    rows.push({ label, value: entries.length === 0 ? "none" : entries.join(", ") });
  };

  switch (kind) {
    case "provider_event":
      add("Event", data.event);
      break;
    case "diagnostic":
      add("Visibility", data.diagnostic);
      break;
    case "session":
      add("Action", data.action);
      add("Session", data.sessionId);
      add("Mode", data.mode);
      add("Runner", data.runner);
      add("Control plane", data.controlPlane);
      add("Reason", data.reason);
      break;
    case "process":
      add("Action", data.action);
      add("Reason", data.reason);
      add("Runner exited", data.runnerExited);
      break;
    case "cleanup":
      add("Reason", data.reason);
      add("Authority cleared", data.authorityCleared);
      add("Mock stopped", data.mockStopped);
      add("Process exited", data.processExited);
      break;
    case "tool_exposure":
      add("Scenario", data.scenarioId);
      addList("Operations", data.operationIds);
      break;
    case "tool_call": {
      const input = asRecord(data.input);
      add("Call", data.callId);
      add("Operation", data.operationId);
      add("Before revision", data.beforeRevision);
      addList("Input fields", input.fields as CapabilityJsonValue | undefined);
      add("Disposition summary", input.dispositionSummary as CapabilityJsonValue | undefined);
      break;
    }
    case "tool_result": {
      const result = asRecord(data.result);
      const value = asRecord(result.result);
      add("Call", data.callId);
      add("Operation", data.operationId);
      add("Before revision", data.beforeRevision);
      add("After revision", data.afterRevision);
      add("Outcome", result.ok === true ? "ok" : "denied");
      add("State revision", result.stateRevision as CapabilityJsonValue | undefined);
      add("Command", value.commandId as CapabilityJsonValue | undefined);
      add("Command kind", value.commandKind as CapabilityJsonValue | undefined);
      add("Disposition", value.disposition as CapabilityJsonValue | undefined);
      add("Result revision", value.revision as CapabilityJsonValue | undefined);
      break;
    }
    case "interaction":
      add("Kind", data.interactionKind);
      add("Outcome", data.outcome);
      add("State revision", data.stateRevision);
      break;
  }
  return rows;
}
