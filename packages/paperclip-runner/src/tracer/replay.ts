import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
} from "../protocol/replay-contract.js";
import { reducePrpFixture, type SessionSnapshot } from "../reducer/session-reducer.js";

export type ReplayReplayResult =
  | { ok: true; snapshot: SessionSnapshot; issues: [] }
  | { ok: false; snapshot: null; issues: ProtocolValidationIssue[] };

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
