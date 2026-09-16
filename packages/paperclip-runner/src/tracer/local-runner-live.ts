import type { PrpEvent } from "../protocol/replay-contract.js";
import { validatePrpEvent } from "../protocol/replay-contract.js";
import {
  applyPrpEvent,
  createSessionSnapshotFromMetadata,
  reduceSessionEvents,
  type SessionSnapshot,
} from "../reducer/session-reducer.js";
import type { LocalRunnerRunMetadata } from "../contracts/local-runner.js";

export type LocalRunnerLiveEventResult =
  | { ok: true; snapshot: SessionSnapshot; event: PrpEvent; issues: [] }
  | { ok: false; snapshot: SessionSnapshot; event: null; issues: string[] };

export function createLocalRunnerLiveSnapshot(
  metadata: LocalRunnerRunMetadata,
): SessionSnapshot {
  return createSessionSnapshotFromMetadata({
    fixtureName: metadata.fixtureName,
    identity: metadata.identity,
    capabilities: metadata.capabilities,
  });
}

export function applyLocalRunnerLiveEvent(
  current: SessionSnapshot,
  value: unknown,
): LocalRunnerLiveEventResult {
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

export function replayLocalRunnerEvents(
  metadata: LocalRunnerRunMetadata,
  events: readonly PrpEvent[],
): SessionSnapshot {
  return reduceSessionEvents(createLocalRunnerLiveSnapshot(metadata), events);
}

export function localRunnerSnapshotsMatch(
  live: SessionSnapshot,
  replay: SessionSnapshot,
): boolean {
  return JSON.stringify(live) === JSON.stringify(replay);
}
