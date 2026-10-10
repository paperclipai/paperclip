import { readFileSync } from "node:fs";

export interface LocalIntegrityGoldenProfile {
  id: string;
  provider: string;
  adapter: string;
  originProvider: string;
  originMethod: string;
  acpxAgent?: "claude" | "codex";
  runId: string;
  normalizedSessionId: string;
  sourceInstanceId: string;
}

interface LocalIntegrityGoldenEventTemplate {
  sourceEventId: string;
  sourceSeq: number;
  itemId?: string;
  eventType: string;
  priority: 0 | 1 | 2;
  payload: Record<string, unknown>;
}

export interface LocalIntegrityGoldenFixture {
  schema: string;
  profiles: LocalIntegrityGoldenProfile[];
  turnId: string;
  events: LocalIntegrityGoldenEventTemplate[];
  expected: {
    eventTypes: string[];
    assistantItems: Array<{ itemId: string; channel: string; text: string }>;
    reasoningItemId: string;
    toolExecutionId: string;
    planId: string;
    questionRequestId: string;
    runTerminalState: string;
  };
}

export interface LocalIntegrityGoldenEvent {
  schema: "paperclip.prp.event.v1";
  sourceEventId: string;
  sourceSeq: number;
  sourceInstanceId: string;
  sourceKind: "runner";
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId?: string;
  eventType: string;
  schemaVersion: 1;
  priority: 0 | 1 | 2;
  emittedAt: string;
  payload: Record<string, unknown>;
}

export const localIntegrityBoundaryGolden = JSON.parse(
  readFileSync(
    new URL(
      "../protocol/fixtures/provider-boundary/local-integrity.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as LocalIntegrityGoldenFixture;

function replaceProfileMarkers<T>(
  value: T,
  profile: LocalIntegrityGoldenProfile,
): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll("$provider", profile.provider)
      .replaceAll("$adapter", profile.adapter)
      .replaceAll("$originProvider", profile.originProvider)
      .replaceAll("$originMethod", profile.originMethod),
  ) as T;
}

export function localIntegrityEventsFor(
  profile: LocalIntegrityGoldenProfile,
): LocalIntegrityGoldenEvent[] {
  return localIntegrityBoundaryGolden.events.map((template) => ({
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${profile.id}:${template.sourceEventId}`,
    sourceSeq: template.sourceSeq,
    sourceInstanceId: profile.sourceInstanceId,
    sourceKind: "runner",
    runId: profile.runId,
    normalizedSessionId: profile.normalizedSessionId,
    turnId: localIntegrityBoundaryGolden.turnId,
    ...(template.itemId ? { itemId: template.itemId } : {}),
    eventType: template.eventType,
    schemaVersion: 1,
    priority: template.priority,
    emittedAt: `2026-08-27T18:00:${String(template.sourceSeq).padStart(2, "0")}.000Z`,
    payload: replaceProfileMarkers(template.payload, profile),
  }));
}
