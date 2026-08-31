import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
} from "../protocol/replay-contract.js";
import {
  reducePrpFixture,
  type SessionSnapshot,
} from "../reducer/session-reducer.js";

export type ReplayResult =
  | { ok: true; snapshot: SessionSnapshot; issues: [] }
  | { ok: false; snapshot: null; issues: ProtocolValidationIssue[] };

export function replayFixtureText(text: string): ReplayResult {
  const validation = parsePrpFixtureText(text);
  if (!validation.ok) {
    return { ok: false, snapshot: null, issues: validation.issues };
  }
  return {
    ok: true,
    snapshot: reducePrpFixture(validation.fixture),
    issues: [],
  };
}

export function formatReplayResult(result: ReplayResult): string {
  return JSON.stringify(result, null, 2);
}
