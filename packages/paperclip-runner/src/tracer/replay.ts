import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
} from "../protocol/replay-contract.js";
import { reducePrpFixture, type SessionSnapshot } from "../reducer/session-reducer.js";

export type ReplayReplayResult =
  | { ok: true; snapshot: SessionSnapshot; issues: [] }
  | { ok: false; snapshot: null; issues: ProtocolValidationIssue[] };

/** @deprecated Use `ReplayReplayResult`; retained for public API compatibility. */
export type ReplayResult = ReplayReplayResult;

export function replayReplayFixtureText(text: string): ReplayReplayResult {
  const validation = parsePrpFixtureText(text);
  if (!validation.ok) {
    return { ok: false, snapshot: null, issues: validation.issues };
  }
  return { ok: true, snapshot: reducePrpFixture(validation.fixture), issues: [] };
}

export function formatReplayReplay(result: ReplayReplayResult): string {
  return JSON.stringify(result, null, 2);
}

/** @deprecated Use `replayReplayFixtureText`; retained for public API compatibility. */
export const replayFixtureText = replayReplayFixtureText;

/** @deprecated Use `formatReplayReplay`; retained for public API compatibility. */
export const formatReplayResult = formatReplayReplay;
