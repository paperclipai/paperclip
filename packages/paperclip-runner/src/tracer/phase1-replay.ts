import {
  parsePrpFixtureText,
  type ProtocolValidationIssue,
} from "../protocol/phase1-contract.js";
import { reducePrpFixture, type SessionSnapshot } from "../reducer/session-reducer.js";

export type Phase1ReplayResult =
  | { ok: true; snapshot: SessionSnapshot; issues: [] }
  | { ok: false; snapshot: null; issues: ProtocolValidationIssue[] };

export function replayPhase1FixtureText(text: string): Phase1ReplayResult {
  const validation = parsePrpFixtureText(text);
  if (!validation.ok) {
    return { ok: false, snapshot: null, issues: validation.issues };
  }
  return { ok: true, snapshot: reducePrpFixture(validation.fixture), issues: [] };
}

export function formatPhase1Replay(result: Phase1ReplayResult): string {
  return JSON.stringify(result, null, 2);
}
