import type { PrpEvent } from "../protocol/phase1-contract.js";
import { validatePrpEvent } from "../protocol/phase1-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  reduceSessionEvents,
  type SessionSnapshot,
} from "../reducer/session-reducer.js";
import type { Phase2RunMetadata } from "../contracts/phase2.js";

export type Phase2LiveEventResult =
  | { ok: true; snapshot: SessionSnapshot; event: PrpEvent; issues: [] }
  | { ok: false; snapshot: SessionSnapshot; event: null; issues: string[] };

export function createPhase2LiveSnapshot(
  metadata: Phase2RunMetadata,
): SessionSnapshot {
  return createSessionSnapshotFromMetadata({
    fixtureName: metadata.fixtureName,
    identity: metadata.identity,
    capabilities: metadata.capabilities,
  });
}

export function applyPhase2LiveEvent(
  current: SessionSnapshot,
  value: unknown,
): Phase2LiveEventResult {
  const validation = validatePrpEvent(value);
  if (!validation.ok) {
    return {
      ok: false,
      snapshot: current,
      event: null,
      issues: validation.issues.map((issue) => `${issue.path} ${issue.message}`),
    };
  }
  if (validation.event.runId !== current.identity.runId) {
    return {
      ok: false,
      snapshot: current,
      event: null,
      issues: ["/runId live event must match the active run"],
    };
  }
  if (
    validation.event.normalizedSessionId !== undefined &&
    validation.event.normalizedSessionId !== current.identity.normalizedSessionId
  ) {
    return {
      ok: false,
      snapshot: current,
      event: null,
      issues: ["/normalizedSessionId live event must match the active session"],
    };
  }
  return {
    ok: true,
    snapshot: applyPrpEvent(current, validation.event),
    event: validation.event,
    issues: [],
  };
}

export function replayPhase2Events(
  metadata: Phase2RunMetadata,
  events: readonly PrpEvent[],
): SessionSnapshot {
  return reduceSessionEvents(createPhase2LiveSnapshot(metadata), events);
}

export function phase2SnapshotsMatch(
  live: SessionSnapshot,
  replay: SessionSnapshot,
): boolean {
  return JSON.stringify(live) === JSON.stringify(replay);
}
