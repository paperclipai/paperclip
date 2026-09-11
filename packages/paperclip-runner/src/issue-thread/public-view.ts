/**
 * The public issue-thread DTO (track 7U).
 *
 * `projectCapabilityIssueThread` produces the view contract; this module produces
 * the *published* form of it. Every field is copied by name, so a field added
 * to the projection — or to a record it passes through — cannot reach a browser
 * until it is listed here. That is the property the previous serialization
 * lacked: it handed the projection straight to `JSON.stringify`, so each new
 * evidence field became public the moment it was recorded.
 *
 * Two further narrowings happen here:
 *
 * - Provider-authored identifiers (thread, turn, item/call ids) are replaced by
 *   stable in-view aliases. Anchors, evidence refs, and thread items keep
 *   working because the same alias is used everywhere the id appeared, and the
 *   aliases are derived from view order, so successive interim frames of one
 *   turn agree with each other and with the settled payload.
 * - Anything the caller declares withheld — provider thread/session identity —
 *   is scrubbed from the encoded DTO as a final pass, so a value that slipped
 *   into a free-text field still does not ship.
 *
 * This is the only shape the browser is given, for interim frames, terminal
 * payloads, reconnect/replay payloads, and error paths alike.
 */

import type {
  CapabilityEvidenceAuthorizationRecord,
  CapabilityEvidenceCallRecord,
  CapabilityEvidenceControlPlaneRecord,
  CapabilityEvidenceModel,
  CapabilityEvidenceParityRecord,
  CapabilityEvidenceRef,
  CapabilityEvidenceRunnerRecord,
  CapabilityEvidenceStateDiffRecord,
  CapabilityEvidenceToolsRecord,
  CapabilityEvidenceTraceabilityRecord,
  CapabilityIssueThreadSnapshot,
  CapabilityThreadInteractionCard,
  CapabilityThreadInteractionPayload,
  CapabilityThreadItem,
  CapabilityThreadLink,
  CapabilityThreadTurn,
} from "./types.js";
import { CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA } from "./types.js";
import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";

/**
 * Structurally the view contract: the browser renders one component tree for
 * the deterministic fixtures and for live sessions, and a second shape would
 * only invite the two to drift. The guarantee lives in the builder below, not
 * in a second set of field names.
 */
export type CapabilityPublicIssueThreadView = CapabilityIssueThreadSnapshot;

export interface CapabilityPublicThreadViewOptions {
  /**
   * Values that must not appear anywhere in the published DTO — provider thread
   * and session identity. Short values are ignored: scrubbing a two-character
   * token out of prose would corrupt more than it protects.
   */
  readonly withheldValues?: readonly string[];
}

/** Below this a value is too short to scrub without damaging unrelated text. */
const MIN_SCRUBBABLE_LENGTH = 8;
const WITHHELD = "[withheld]";
const MAX_DETAIL_CHARS = 240;
const MAX_BODY_CHARS = 20_000;

/** Tool payloads are summaries by the time they arrive; this is the fence. */
const TOOL_INPUT_KEYS = ["fields", "dispositionSummary"] as const;
const TOOL_RESULT_KEYS = ["ok", "stateRevision", "denial", "result"] as const;
const TOOL_DENIAL_KEYS = ["code", "message"] as const;
const TOOL_RESULT_INNER_KEYS = [
  "commandId",
  "commandKind",
  "disposition",
  "revision",
  "stateRevision",
  "entityRefs",
] as const;

function clamp(value: string, limit = MAX_DETAIL_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function asRecord(value: CapabilityJsonValue | null): Record<string, CapabilityJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function pick(
  source: Record<string, CapabilityJsonValue>,
  keys: readonly string[],
): Record<string, CapabilityJsonValue> {
  const result: Record<string, CapabilityJsonValue> = {};
  for (const key of keys) if (key in source) result[key] = source[key]!;
  return result;
}

/** Maps every provider-authored identifier in the view to an in-view alias. */
class Aliases {
  readonly #map = new Map<string, string>();
  readonly #ordered: string[];

  constructor(view: CapabilityIssueThreadSnapshot) {
    view.turns.forEach((turn, index) => this.#add(turn.id, `turn-${index + 1}`));
    view.evidence.calls.forEach((call, index) => this.#add(call.id, `call-${index + 1}`));
    // Longest first, so one raw id that contains another cannot be half-replaced.
    this.#ordered = [...this.#map.keys()].sort((left, right) => right.length - left.length);
  }

  #add(raw: string, alias: string): void {
    if (raw.length === 0 || this.#map.has(raw)) return;
    this.#map.set(raw, alias);
  }

  /** Rewrites an id-shaped string, including composite forms like `call:<id>`. */
  text(value: string): string {
    let result = value;
    for (const raw of this.#ordered) {
      if (!result.includes(raw)) continue;
      result = result.split(raw).join(this.#map.get(raw)!);
    }
    return result;
  }

  turn(value: string): string {
    return this.#map.get(value) ?? this.text(value);
  }
}

function publicRef(ref: CapabilityEvidenceRef, aliases: Aliases): CapabilityEvidenceRef {
  return { section: ref.section, recordId: aliases.text(ref.recordId) };
}

function publicLink(link: CapabilityThreadLink | null): CapabilityThreadLink | null {
  return link === null ? null : { label: clamp(link.label), href: clamp(link.href) };
}

function publicToolInput(value: CapabilityJsonValue): CapabilityJsonValue {
  const source = pick(asRecord(value), TOOL_INPUT_KEYS);
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((entry): entry is string => typeof entry === "string")
    : [];
  const summary = source.dispositionSummary;
  return {
    fields,
    ...(typeof summary === "string" ? { dispositionSummary: clamp(summary, 500) } : {}),
  };
}

function publicToolResult(value: CapabilityJsonValue | null): CapabilityJsonValue | null {
  if (value === null) return null;
  const source = pick(asRecord(value), TOOL_RESULT_KEYS);
  const inner = pick(asRecord(source.result ?? null), TOOL_RESULT_INNER_KEYS);
  const entityRefs = Array.isArray(inner.entityRefs)
    ? inner.entityRefs.filter((entry): entry is string => typeof entry === "string")
    : [];
  const denial = source.denial === undefined ? undefined : pick(asRecord(source.denial), TOOL_DENIAL_KEYS);
  return {
    ok: source.ok === true,
    stateRevision: typeof source.stateRevision === "number" ? source.stateRevision : 0,
    result: { ...inner, entityRefs },
    ...(denial === undefined ? {} : { denial }),
  };
}

function safeProviderScalar(value: CapabilityJsonValue | undefined, limit = MAX_DETAIL_CHARS): CapabilityJsonValue | undefined {
  if (typeof value === "string") return clamp(value, limit);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

/** Closed, family-specific projection for canonical provider activity. */
function publicProviderPayload(
  family: Extract<CapabilityThreadItem, { kind: "provider_activity" }>['family'],
  value: CapabilityJsonValue,
): CapabilityJsonValue {
  const source = asRecord(value);
  const common = (keys: readonly string[]) => Object.fromEntries(keys.flatMap((key) => {
    if (key === "output" && typeof source[key] === "string") {
      return [[key, source[key].slice(-(8 * 1024))]];
    }
    const projected = safeProviderScalar(source[key], key === "output" ? 8 * 1024 : 4_000);
    return projected === undefined ? [] : [[key, projected]];
  }));
  switch (family) {
    case "plan":
      return {
        ...common(["schema", "planId", "revision", "explanation", "complete", "syncStatus", "documentRevision"]),
        steps: (Array.isArray(source.steps) ? source.steps : []).slice(0, 256).map((entry) => {
          const step = asRecord(entry);
          return {
            stepId: clamp(typeof step.stepId === "string" ? step.stepId : "step", 160),
            body: clamp(typeof step.body === "string" ? step.body : "", 4_000),
            status: clamp(typeof step.status === "string" ? step.status : "pending", 32),
          };
        }),
      };
    case "tool_execution":
      return common(["schema", "executionId", "transport", "operation", "name", "target", "namespace", "readOnly", "status", "durationMs", "exitCode", "progress", "output", "outputBytes", "outputTruncated", "outputDigest"]);
    case "research":
      return {
        ...common(["schema", "researchId", "action", "status", "query", "url", "pattern"]),
        sources: (Array.isArray(source.sources) ? source.sources : []).slice(0, 64).map((entry) => {
          const candidate = asRecord(entry);
          const url = typeof candidate.url === "string" && /^https?:\/\//.test(candidate.url)
            ? clamp(candidate.url, 2_048) : null;
          return { sourceId: clamp(typeof candidate.sourceId === "string" ? candidate.sourceId : "source", 160), url, title: clamp(typeof candidate.title === "string" ? candidate.title : "Provider-reported source", 500), snippet: typeof candidate.snippet === "string" ? clamp(candidate.snippet, 4_000) : null };
        }),
      };
    case "delegation":
      return {
        ...common(["schema", "delegationId", "action", "status"]),
        children: (Array.isArray(source.children) ? source.children : []).slice(0, 64).map((entry) => {
          const child = asRecord(entry);
          return Object.fromEntries(["childId", "role", "provider", "model", "status", "summary", "activitySummary", "durationMs"].flatMap((key) => {
            const projected = safeProviderScalar(child[key], 4_000);
            return projected === undefined ? [] : [[key, projected]];
          }));
        }),
      };
    case "model_identity":
      return common(["schema", "routeId", "verificationId", "provider", "requestedModel", "fromModel", "effectiveModel", "reason", "usageBoundaryId", "status", "buffering", "summary"]);
    case "context":
      return common(["schema", "compactionId", "reason", "preTokens", "postTokens", "sameSession"]);
    case "artifact": {
      const projected = common(["schema", "artifactId", "status", "reference", "mediaType", "title", "registered", "transparentBackground", "failure"]);
      const reference = projected.reference;
      if (typeof reference === "string" && (reference.startsWith("/") || reference.split("/").includes(".."))) projected.reference = null;
      return projected;
    }
    case "review":
      return common(["schema", "reviewId", "state", "scope"]);
    case "hook":
      return common(["schema", "hookId", "event", "scope", "status", "blocking", "durationMs", "summary"]);
    case "memory": {
      const projected = common(["schema", "citationId", "messageItemId", "label", "available", "reference"]);
      if (typeof projected.reference === "string" && !projected.reference.startsWith("paperclip://")) projected.reference = null;
      return projected;
    }
    case "safety":
      return common(["schema", "reviewId", "targetExecutionId", "status", "decision", "summary"]);
    case "terminal":
      return common(["schema", "executionId", "origin", "inputClass", "byteCount"]);
    case "wait":
      return common(["schema", "waitId", "reason", "status", "plannedDurationMs", "elapsedDurationMs"]);
    case "provider_notice":
      return common(["schema", "noticeId", "severity", "category", "scope", "recoverable", "userActionable", "summary"]);
  }
}

function publicInteractionPayload(
  payload: CapabilityThreadInteractionPayload,
): CapabilityThreadInteractionPayload {
  switch (payload.kind) {
    case "questions":
      return {
        kind: "questions",
        submitLabel: clamp(payload.submitLabel),
        questions: payload.questions.map((question) => ({
          id: question.id,
          prompt: clamp(question.prompt, MAX_BODY_CHARS),
          control: question.control,
          ...(question.options === undefined
            ? {}
            : { options: question.options.map((option) => clamp(option)) }),
          ...(question.required === undefined ? {} : { required: question.required }),
        })),
      };
    case "confirmation":
      return {
        kind: "confirmation",
        targetSummary: clamp(payload.targetSummary, MAX_BODY_CHARS),
        acceptLabel: clamp(payload.acceptLabel),
        rejectLabel: clamp(payload.rejectLabel),
        requireRejectReason: payload.requireRejectReason,
      };
    case "checkbox":
      return {
        kind: "checkbox",
        options: payload.options.map((option) => ({
          id: option.id,
          label: clamp(option.label),
          ...(option.defaultSelected === undefined
            ? {}
            : { defaultSelected: option.defaultSelected }),
        })),
        minSelected: payload.minSelected,
        maxSelected: payload.maxSelected,
        acceptLabel: clamp(payload.acceptLabel),
        rejectLabel: clamp(payload.rejectLabel),
      };
    case "suggest_tasks":
      return {
        kind: "suggest_tasks",
        acceptLabel: clamp(payload.acceptLabel),
        tasks: payload.tasks.map((task) => ({
          id: task.id,
          title: clamp(task.title),
          description: clamp(task.description, MAX_BODY_CHARS),
        })),
      };
    case "item_verdicts":
      return {
        kind: "item_verdicts",
        submitLabel: clamp(payload.submitLabel),
        items: payload.items.map((item) => ({
          id: item.id,
          title: clamp(item.title),
          ...(item.requireReason === undefined ? {} : { requireReason: item.requireReason }),
          ...(item.lockedVerdict === undefined ? {} : { lockedVerdict: item.lockedVerdict }),
        })),
      };
  }
}

function publicInteractionCard(
  card: CapabilityThreadInteractionCard,
  aliases: Aliases,
): CapabilityThreadInteractionCard {
  return {
    interactionId: card.interactionId,
    interactionKind: card.interactionKind,
    title: clamp(card.title),
    prompt: clamp(card.prompt, MAX_BODY_CHARS),
    payload: publicInteractionPayload(card.payload),
    state: card.state,
    target: publicLink(card.target),
    stateLabel: clamp(card.stateLabel),
    resolvedSummary: card.resolvedSummary.map((entry) => clamp(entry)),
    reason: card.reason === null ? null : clamp(card.reason, MAX_BODY_CHARS),
    supersededBy: publicLink(card.supersededBy),
    evidenceRef: publicRef(card.evidenceRef, aliases),
  };
}

function publicItem(item: CapabilityThreadItem, aliases: Aliases): CapabilityThreadItem {
  const id = aliases.text(item.id);
  switch (item.kind) {
    case "user_message":
      return { kind: "user_message", id, at: item.at, author: item.author, body: item.body };
    case "agent_message":
      return {
        kind: "agent_message",
        id,
        at: item.at,
        author: item.author,
        body: item.body,
        streaming: item.streaming,
      };
    case "durable_comment":
      return {
        kind: "durable_comment",
        id,
        at: item.at,
        author: item.author,
        body: clamp(item.body, MAX_BODY_CHARS),
        operationId: item.operationId,
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "tool_activity":
      return {
        kind: "tool_activity",
        id,
        at: item.at,
        status: item.status,
        operationId: item.operationId,
        summary: clamp(item.summary),
        input: publicToolInput(item.input),
        result: publicToolResult(item.result),
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "progress_activity":
      return {
        kind: "progress_activity",
        id,
        at: item.at,
        activity: item.activity,
        status: item.status,
        label: clamp(item.label),
        summary: clamp(item.summary),
        eventCount: item.eventCount,
        details: item.details,
      };
    case "workspace_changes":
      return {
        kind: "workspace_changes",
        id,
        at: item.at,
        changeSet: {
          schema: item.changeSet.schema,
          changeSetId: aliases.text(item.changeSet.changeSetId),
          revision: item.changeSet.revision,
          source: item.changeSet.source,
          complete: item.changeSet.complete,
          files: item.changeSet.files.map((file) => ({
            path: clamp(file.path, 1024),
            operation: file.operation,
            previousPath: file.previousPath === null ? null : clamp(file.previousPath, 1024),
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            diff: file.diff === null ? null : clamp(file.diff, 262_144),
          })),
          totals: { ...item.changeSet.totals },
          patchArtifactRef: item.changeSet.patchArtifactRef === null
            ? null
            : clamp(item.changeSet.patchArtifactRef, 2048),
        },
      };
    case "workspace_file_reference":
      return {
        kind: "workspace_file_reference",
        id,
        at: item.at,
        reference: {
          schema: item.reference.schema,
          referenceId: aliases.text(item.reference.referenceId),
          source: item.reference.source,
          path: clamp(item.reference.path, 1024),
          displayName: clamp(item.reference.displayName, 255),
          mediaType: item.reference.mediaType === null ? null : clamp(item.reference.mediaType, 160),
          presentation: item.reference.presentation,
          line: item.reference.line,
          preview: item.reference.preview === null ? null : clamp(item.reference.preview, 262_144),
          previewTruncated: item.reference.previewTruncated,
          contentDigest: item.reference.contentDigest,
        },
      };
    case "provider_activity": {
      const payload = publicProviderPayload(item.family, item.payload);
      return {
        kind: "provider_activity", id, at: item.at, family: item.family,
        eventType: clamp(item.eventType, 160), status: item.status,
        title: clamp(item.title), summary: clamp(item.summary, MAX_BODY_CHARS),
        payload, evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    }
    case "interaction":
      return {
        kind: "interaction",
        id,
        at: item.at,
        ...publicInteractionCard(item, aliases),
      };
    case "document":
      return {
        kind: "document",
        id,
        at: item.at,
        documentKey: item.documentKey,
        title: clamp(item.title),
        author: item.author,
        revisionFrom: item.revisionFrom,
        revisionTo: item.revisionTo,
        staleBehind: item.staleBehind,
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "deliverable":
      return {
        kind: "deliverable",
        id,
        at: item.at,
        filename: clamp(item.filename),
        deliverableKind: item.deliverableKind,
        byteSize: item.byteSize,
        registeredBy: item.registeredBy,
        contentRef: clamp(item.contentRef),
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "dependency":
      return {
        kind: "dependency",
        id,
        at: item.at,
        createdTasks: item.createdTasks.map((task) => ({
          identifier: task.identifier,
          title: clamp(task.title),
        })),
        blockerEdges: item.blockerEdges.map((edge) => clamp(edge)),
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "disposition":
      return {
        kind: "disposition",
        id,
        at: item.at,
        operationId: item.operationId,
        status: item.status,
        body: clamp(item.body, MAX_BODY_CHARS),
        blockerOwner: item.blockerOwner,
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "denial":
      return {
        kind: "denial",
        id,
        at: item.at,
        operationId: item.operationId,
        reason: clamp(item.reason, MAX_BODY_CHARS),
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
    case "system_notice":
      return {
        kind: "system_notice",
        id,
        at: item.at,
        glyph: item.glyph,
        text: clamp(item.text, MAX_BODY_CHARS),
        evidenceRef: publicRef(item.evidenceRef, aliases),
      };
  }
}

function publicTurn(turn: CapabilityThreadTurn, aliases: Aliases): CapabilityThreadTurn {
  return {
    id: aliases.turn(turn.id),
    ordinal: turn.ordinal,
    mode: turn.mode,
    toolCallCount: turn.toolCallCount,
    at: turn.at,
    stoppedByUser: turn.stoppedByUser,
    items: turn.items.map((item) => publicItem(item, aliases)),
  };
}

function publicTools(record: CapabilityEvidenceToolsRecord, aliases: Aliases): CapabilityEvidenceToolsRecord {
  return {
    id: aliases.text(record.id),
    turnId: aliases.turn(record.turnId),
    rows: record.rows.map((row) => ({
      operationId: row.operationId,
      disposition: row.disposition,
      grant: row.grant,
      description: clamp(row.description),
    })),
  };
}

function publicCall(record: CapabilityEvidenceCallRecord, aliases: Aliases): CapabilityEvidenceCallRecord {
  return {
    id: aliases.text(record.id),
    turnId: aliases.turn(record.turnId),
    operationId: record.operationId,
    version: record.version,
    providerRequest: clamp(record.providerRequest),
    dispatchedCommand: clamp(record.dispatchedCommand),
    outcome: record.outcome,
    result: publicToolResult(record.result),
    redactions: record.redactions.map((entry) => clamp(entry)),
    threadAnchorId: aliases.text(record.threadAnchorId),
  };
}

function publicAuthorization(
  record: CapabilityEvidenceAuthorizationRecord,
  aliases: Aliases,
): CapabilityEvidenceAuthorizationRecord {
  return {
    id: aliases.text(record.id),
    turnId: aliases.turn(record.turnId),
    operationId: record.operationId,
    phase: record.phase,
    allowed: record.allowed,
    code: record.code,
    reason: clamp(record.reason, MAX_BODY_CHARS),
    claimsConsidered: record.claimsConsidered.map((claim) => clamp(claim)),
    redactions: record.redactions.map((entry) => clamp(entry)),
    stateChangeRef: record.stateChangeRef === null ? null : aliases.text(record.stateChangeRef),
    threadAnchorId: aliases.text(record.threadAnchorId),
  };
}

function publicControlPlane(
  record: CapabilityEvidenceControlPlaneRecord,
  aliases: Aliases,
): CapabilityEvidenceControlPlaneRecord {
  return {
    id: aliases.text(record.id),
    turnId: aliases.turn(record.turnId),
    category: record.category,
    outcome: clamp(record.outcome),
    reason: clamp(record.reason, MAX_BODY_CHARS),
    stateRevision: record.stateRevision,
    threadAnchorId: record.threadAnchorId === null ? null : aliases.text(record.threadAnchorId),
  };
}

function publicRunner(
  record: CapabilityEvidenceRunnerRecord,
  aliases: Aliases,
): CapabilityEvidenceRunnerRecord {
  return {
    id: record.id,
    turnId: aliases.turn(record.turnId),
    kind: record.kind,
    ordinal: record.ordinal,
    detail: clamp(aliases.text(record.detail)),
    details: record.details.map((entry) => ({
      label: clamp(entry.label),
      value: clamp(aliases.text(entry.value), MAX_BODY_CHARS),
    })),
  };
}

function publicStateDiff(
  record: CapabilityEvidenceStateDiffRecord,
  aliases: Aliases,
): CapabilityEvidenceStateDiffRecord {
  return {
    id: aliases.text(record.id),
    turnId: aliases.turn(record.turnId),
    fromRevision: record.fromRevision,
    toRevision: record.toRevision,
    rows: record.rows.map((row) => ({
      entityClass: row.entityClass,
      entityRef: clamp(row.entityRef),
      before: clamp(row.before),
      after: clamp(row.after),
    })),
  };
}

function publicTraceability(
  record: CapabilityEvidenceTraceabilityRecord,
  aliases: Aliases,
): CapabilityEvidenceTraceabilityRecord {
  return {
    id: record.id,
    turnId: aliases.turn(record.turnId),
    capabilityId: record.capabilityId,
    sourceAnchor: clamp(record.sourceAnchor),
    caseId: record.caseId,
    group: record.group,
    browserEvidenceRecipe: clamp(record.browserEvidenceRecipe, MAX_BODY_CHARS),
    expectedSemanticOperations: [...record.expectedSemanticOperations],
    forbiddenOperations: [...record.forbiddenOperations],
    requiredCapabilityGrants: [...record.requiredCapabilityGrants],
  };
}

function publicParity(
  record: CapabilityEvidenceParityRecord,
  aliases: Aliases,
): CapabilityEvidenceParityRecord {
  return {
    id: record.id,
    turnId: aliases.turn(record.turnId),
    assertion: clamp(record.assertion, MAX_BODY_CHARS),
    verdict: record.verdict,
    note: record.note === null ? null : clamp(record.note, MAX_BODY_CHARS),
  };
}

function publicEvidence(evidence: CapabilityEvidenceModel, aliases: Aliases): CapabilityEvidenceModel {
  return {
    tools: evidence.tools.map((record) => publicTools(record, aliases)),
    calls: evidence.calls.map((record) => publicCall(record, aliases)),
    authorization: evidence.authorization.map((record) => publicAuthorization(record, aliases)),
    control_plane: evidence.control_plane.map((record) => publicControlPlane(record, aliases)),
    runner: evidence.runner.map((record) => publicRunner(record, aliases)),
    state: evidence.state.map((record) => publicStateDiff(record, aliases)),
    traceability: evidence.traceability.map((record) => publicTraceability(record, aliases)),
    parity: evidence.parity.map((record) => publicParity(record, aliases)),
  };
}

/**
 * Final pass over the encoded DTO. The field-by-field copy above is the real
 * control; this exists so a value that reached a free-text field by some route
 * nobody anticipated still cannot ship, and so the property is testable by
 * scanning bytes rather than by reasoning about call graphs.
 */
function scrubWithheld(view: CapabilityPublicIssueThreadView, values: readonly string[]): CapabilityPublicIssueThreadView {
  const scrubbable = [...new Set(values.filter((value) => value.length >= MIN_SCRUBBABLE_LENGTH))]
    .sort((left, right) => right.length - left.length);
  if (scrubbable.length === 0) return view;
  let encoded = JSON.stringify(view);
  let replaced = false;
  for (const value of scrubbable) {
    if (!encoded.includes(value)) continue;
    encoded = encoded.split(value).join(WITHHELD);
    replaced = true;
  }
  // A turn streams hundreds of frames, and the common case is that the
  // field-by-field copy already left nothing to scrub. Re-parsing then would buy
  // an identical object for the price of a full round-trip per frame.
  if (!replaced) return view;
  return JSON.parse(encoded) as CapabilityPublicIssueThreadView;
}

/**
 * Builds the one shape the browser is allowed to see.
 *
 * Callers must publish this, not the projection: `payload`, every interim
 * frame, the settled frame, and every reconnect or replay response go through
 * here so a single omission cannot open a disclosure path that the other
 * responses closed.
 */
export function toCapabilityPublicThreadView(
  view: CapabilityIssueThreadSnapshot,
  options: CapabilityPublicThreadViewOptions = {},
): CapabilityPublicIssueThreadView {
  const aliases = new Aliases(view);
  const published: CapabilityPublicIssueThreadView = {
    schema: CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA,
    sessionId: view.sessionId,
    mode: view.mode,
    identity: {
      agentLabel: view.identity.agentLabel,
      runnerLabel: view.identity.runnerLabel,
      runnerAttached: view.identity.runnerAttached,
      controlPlaneLabel: view.identity.controlPlaneLabel,
      controlPlaneTooltip: clamp(view.identity.controlPlaneTooltip),
      replaySource: view.identity.replaySource,
    },
    issue: {
      identifier: view.issue.identifier,
      title: clamp(view.issue.title),
      status: view.issue.status,
      priority: view.issue.priority,
      assignee: view.issue.assignee,
      runState: clamp(view.issue.runState),
      scenarioId: view.issue.scenarioId,
      fixtureProfile: view.issue.fixtureProfile,
    },
    turns: view.turns.map((turn) => publicTurn(turn, aliases)),
    composer: {
      state: view.composer.state,
      helper: view.composer.helper === null ? null : clamp(view.composer.helper),
      reason: view.composer.reason === null ? null : clamp(view.composer.reason),
      pendingInteractionId: view.composer.pendingInteractionId,
    },
    evidence: publicEvidence(view.evidence, aliases),
    connection: { state: view.connection.state, attempt: view.connection.attempt },
    replay:
      view.replay === null ? null : { ordinal: view.replay.ordinal, total: view.replay.total },
    renderedAt: view.renderedAt,
  };
  return scrubWithheld(published, options.withheldValues ?? []);
}
