// Retained-settlement maintenance suite (repeat-ack, revocation, home-scoped,
// and terminal-replay matrix) split out of runnerd-codex-transport-settlement.test.ts
// so Vitest schedules both halves in parallel across workers.
import { it } from "vitest";
import {
  runRetainedSettlementCase,
  SETTLEMENT_TEST_TITLE,
  type RetainedSettlementCase,
} from "../../test/support/runnerd-settlement-harness.js";

const REVOCATION_AND_HOME_SETTLEMENT_CASES: RetainedSettlementCase[] = [
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "repeat" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "abort" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "revoked" },
  { alreadyEnded: true, appendFailure: false, finalRetirementRevocation: "during_authorize" },
  { alreadyEnded: true, appendFailure: false, homeScoped: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true, unknownExit: true },
  { alreadyEnded: true, appendFailure: false, homeScoped: true, missingHome: true, startupFailureProof: true },
  {
    alreadyEnded: true,
    appendFailure: false,
    bareCodex: true,
    terminalReplay: true,
  },
];

it.each(REVOCATION_AND_HOME_SETTLEMENT_CASES)(
  SETTLEMENT_TEST_TITLE,
  runRetainedSettlementCase,
  40_000,
);
