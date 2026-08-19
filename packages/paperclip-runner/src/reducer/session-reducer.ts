import type {
  PrpCapabilities,
  PrpEvent,
  PrpFixture,
  PrpIdentity,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";

export interface SessionTimelineEntry {
  position: number;
  sourceEventId: string;
  sourceSeq: number;
  eventType: PrpEvent["eventType"];
  emittedAt: string;
  itemId?: string;
  summary: string;
}

export interface SessionItemSnapshot {
  itemId: string;
  kind: string;
  status: "running" | "completed" | "failed";
  text: string;
}

export interface SessionRequestSnapshot {
  requestId: string;
  requestKind: string;
  type: string;
  status: string;
  prompt: string;
}

export interface SequenceGap {
  sourceKey: string;
  expected: number;
  received: number;
  missing: number[];
}

export interface SessionSnapshot {
  schema: "paperclip.prp.session-snapshot.v1";
  fixtureName: string;
  identity: PrpIdentity;
  capabilities: PrpCapabilities;
  runPhase: string;
  sessionState: "not_started" | "running" | "closed" | "failed";
  turnState:
    | "not_started"
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  activeTurnId: string | null;
  items: SessionItemSnapshot[];
  requests: SessionRequestSnapshot[];
  proposedResult: PrpStructuredRunResult | null;
  terminal: PrpTerminalState | null;
  timeline: SessionTimelineEntry[];
  sourceCursors: Record<string, number>;
  processedEventIds: string[];
  duplicateEventIds: string[];
  outOfOrderEventIds: string[];
  gaps: SequenceGap[];
  integrity: "complete" | "gap_detected";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function sourceKey(event: PrpEvent): string {
  return `${event.sourceKind}:${event.sourceInstanceId}`;
}

function humanizeProtocolValue(value: string): string {
  return value.replaceAll("_", " ");
}

function sentenceCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function requestSummary(type: string, prompt: string, action?: string): string {
  const detail = prompt.length > 0 ? `${type}: ${prompt}` : `${type} request`;
  return action === undefined ? detail : `${action} ${detail}`;
}

function timelineSummary(snapshot: SessionSnapshot, event: PrpEvent): string {
  const payload = record(event.payload);
  if (event.eventType === "runtime.phase.changed") {
    return `Phase changed to ${humanizeProtocolValue(stringValue(payload.phase, "unknown"))}`;
  }
  if (event.eventType === "item.started") {
    return `Started ${stringValue(payload.kind, "item")}`;
  }
  if (event.eventType === "item.delta") {
    return stringValue(payload.text, "Item updated");
  }
  if (event.eventType === "item.completed") {
    return `Completed ${stringValue(payload.kind, "item")}`;
  }
  if (event.eventType === "item.failed") {
    return stringValue(payload.message, "Item failed");
  }
  if (event.eventType === "run.result.proposed") {
    return stringValue(payload.summary, "Structured result proposed");
  }
  if (event.eventType === "run.terminal") {
    return `Run ${stringValue(payload.runTerminalState, "terminal")}`;
  }
  if (
    event.eventType === "runner.diagnostic" ||
    event.eventType === "harness.diagnostic"
  ) {
    const message = stringValue(payload.message);
    if (message.length > 0) {
      return message;
    }
    const code = stringValue(payload.code);
    if (code.length > 0) {
      return sentenceCase(humanizeProtocolValue(code));
    }
  }
  if (event.eventType === "runtime_request.created") {
    const request = record(payload.request ?? payload);
    return requestSummary(
      stringValue(request.type, "runtime"),
      stringValue(request.prompt),
    );
  }
  if (
    event.eventType === "runtime_request.resolved" ||
    event.eventType === "runtime_request.expired" ||
    event.eventType === "runtime_request.cancelled"
  ) {
    const requestId = stringValue(payload.requestId);
    const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
    const action = sentenceCase(
      humanizeProtocolValue(event.eventType.split(".").at(-1) ?? "updated"),
    );
    return request === undefined
      ? `${action} runtime request ${requestId}`.trim()
      : requestSummary(request.type, request.prompt, action);
  }
  return event.eventType.replaceAll(".", " ");
}

function upsertItem(
  items: SessionItemSnapshot[],
  event: PrpEvent,
  status: SessionItemSnapshot["status"],
): void {
  if (event.itemId === undefined) {
    return;
  }
  const payload = record(event.payload);
  const existing = items.find((item) => item.itemId === event.itemId);
  const text = stringValue(payload.text);
  if (existing === undefined) {
    items.push({
      itemId: event.itemId,
      kind: stringValue(payload.kind, "diagnostic"),
      status,
      text,
    });
    return;
  }
  existing.kind = stringValue(payload.kind, existing.kind);
  existing.status = status;
  if (event.eventType === "item.delta") {
    existing.text += text;
  } else if (text.length > 0) {
    existing.text = text;
  }
}

function applyProjection(snapshot: SessionSnapshot, event: PrpEvent): void {
  const payload = record(event.payload);
  switch (event.eventType) {
    case "runtime.phase.changed":
      snapshot.runPhase = stringValue(payload.phase, snapshot.runPhase);
      break;
    case "session.started":
    case "session.resumed":
      snapshot.sessionState = "running";
      break;
    case "session.closed":
      snapshot.sessionState = "closed";
      break;
    case "session.failed":
      snapshot.sessionState = "failed";
      break;
    case "turn.started":
      snapshot.turnState = "running";
      snapshot.activeTurnId = event.turnId ?? null;
      break;
    case "turn.completed":
      snapshot.turnState = "completed";
      snapshot.activeTurnId = null;
      break;
    case "turn.failed":
      snapshot.turnState = "failed";
      snapshot.activeTurnId = null;
      break;
    case "turn.interrupted":
      snapshot.turnState = "interrupted";
      snapshot.activeTurnId = null;
      break;
    case "turn.cancelled":
      snapshot.turnState = "cancelled";
      snapshot.activeTurnId = null;
      break;
    case "item.started":
    case "item.delta":
      upsertItem(snapshot.items, event, "running");
      break;
    case "item.completed":
      upsertItem(snapshot.items, event, "completed");
      break;
    case "item.failed":
      upsertItem(snapshot.items, event, "failed");
      break;
    case "runtime_request.created": {
      const request = record(payload.request ?? payload);
      const requestId = stringValue(request.requestId);
      if (
        requestId.length > 0 &&
        !snapshot.requests.some((candidate) => candidate.requestId === requestId)
      ) {
        snapshot.requests.push({
          requestId,
          requestKind: stringValue(request.requestKind, "runtime"),
          type: stringValue(request.type, "runtime"),
          status: stringValue(request.status, "pending"),
          prompt: stringValue(request.prompt),
        });
      }
      break;
    }
    case "runtime_request.resolved":
    case "runtime_request.expired":
    case "runtime_request.cancelled": {
      const requestId = stringValue(payload.requestId);
      const request = snapshot.requests.find((candidate) => candidate.requestId === requestId);
      if (request !== undefined) {
        request.status = event.eventType.split(".").at(-1) ?? request.status;
      }
      break;
    }
    case "run.result.proposed":
      snapshot.proposedResult = structuredClone(
        event.payload as PrpStructuredRunResult,
      );
      break;
    case "run.terminal":
      snapshot.terminal = structuredClone(event.payload as PrpTerminalState);
      snapshot.runPhase = "terminal";
      break;
  }
}

function addGap(snapshot: SessionSnapshot, event: PrpEvent, expected: number): void {
  const key = sourceKey(event);
  if (
    snapshot.gaps.some(
      (gap) => gap.sourceKey === key && gap.expected === expected && gap.received === event.sourceSeq,
    )
  ) {
    return;
  }
  snapshot.gaps.push({
    sourceKey: key,
    expected,
    received: event.sourceSeq,
    missing: Array.from(
      { length: event.sourceSeq - expected },
      (_, index) => expected + index,
    ),
  });
}

export function createSessionSnapshot(fixture: PrpFixture): SessionSnapshot {
  return createSessionSnapshotFromMetadata({
    fixtureName: fixture.name,
    identity: fixture.identity,
    capabilities: fixture.capabilities,
  });
}

export function createSessionSnapshotFromMetadata(input: {
  fixtureName: string;
  identity: PrpIdentity;
  capabilities: PrpCapabilities;
}): SessionSnapshot {
  return {
    schema: "paperclip.prp.session-snapshot.v1",
    fixtureName: input.fixtureName,
    identity: structuredClone(input.identity),
    capabilities: structuredClone(input.capabilities),
    runPhase: "queued",
    sessionState: "not_started",
    turnState: "not_started",
    activeTurnId: null,
    items: [],
    requests: [],
    proposedResult: null,
    terminal: null,
    timeline: [],
    sourceCursors: {},
    processedEventIds: [],
    duplicateEventIds: [],
    outOfOrderEventIds: [],
    gaps: [],
    integrity: "complete",
  };
}

export function applyPrpEvent(
  current: SessionSnapshot,
  event: PrpEvent,
): SessionSnapshot {
  if (current.processedEventIds.includes(event.sourceEventId)) {
    return current;
  }

  const snapshot = structuredClone(current);
  const key = sourceKey(event);
  const cursor = snapshot.sourceCursors[key] ?? 0;
  const expected = cursor + 1;
  if (event.sourceSeq <= cursor) {
    if (!snapshot.outOfOrderEventIds.includes(event.sourceEventId)) {
      snapshot.outOfOrderEventIds.push(event.sourceEventId);
    }
    snapshot.integrity = "gap_detected";
    return snapshot;
  }
  if (event.sourceSeq > expected) {
    addGap(snapshot, event, expected);
  }

  snapshot.sourceCursors[key] = event.sourceSeq;
  snapshot.processedEventIds.push(event.sourceEventId);
  snapshot.timeline.push({
    position: snapshot.timeline.length + 1,
    sourceEventId: event.sourceEventId,
    sourceSeq: event.sourceSeq,
    eventType: event.eventType,
    emittedAt: event.emittedAt,
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    summary: timelineSummary(snapshot, event),
  });
  applyProjection(snapshot, event);
  snapshot.integrity =
    snapshot.gaps.length > 0 || snapshot.outOfOrderEventIds.length > 0
      ? "gap_detected"
      : "complete";
  return snapshot;
}

export function reduceSessionEvents(
  current: SessionSnapshot,
  events: readonly PrpEvent[],
): SessionSnapshot {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.sourceEventId, (counts.get(event.sourceEventId) ?? 0) + 1);
  }

  let snapshot = structuredClone(current);
  for (const [eventId, count] of counts) {
    if (count > 1 && !snapshot.duplicateEventIds.includes(eventId)) {
      snapshot.duplicateEventIds.push(eventId);
    }
  }
  snapshot.duplicateEventIds.sort();
  for (const event of events) {
    snapshot = applyPrpEvent(snapshot, event);
  }
  return snapshot;
}

export function reducePrpFixture(fixture: PrpFixture): SessionSnapshot {
  return reduceSessionEvents(createSessionSnapshot(fixture), fixture.events);
}

export interface ReplayParitySummary {
  runId: string;
  integrity: SessionSnapshot["integrity"];
  timelineCount: number;
  duplicateEventIds: string[];
  gaps: SequenceGap[];
  turnTerminalState: string | null;
  runTerminalState: string | null;
}

export function replayParitySummary(snapshot: SessionSnapshot): ReplayParitySummary {
  return {
    runId: snapshot.identity.runId,
    integrity: snapshot.integrity,
    timelineCount: snapshot.timeline.length,
    duplicateEventIds: [...snapshot.duplicateEventIds],
    gaps: structuredClone(snapshot.gaps),
    turnTerminalState: snapshot.terminal?.turnTerminalState ?? null,
    runTerminalState: snapshot.terminal?.runTerminalState ?? null,
  };
}
