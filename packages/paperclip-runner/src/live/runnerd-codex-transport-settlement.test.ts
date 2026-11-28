// Retained-settlement maintenance suite (core + epoch/terminal-ack matrix).
// Revocation, home-scoped, and terminal-replay cases live in
// runnerd-codex-transport-settlement-revocation.test.ts so Vitest schedules
// both halves in parallel across workers instead of serializing ~124s in one file.
import { it } from "vitest";
import {
  runRetainedSettlementCase,
  SETTLEMENT_TEST_TITLE,
  type RetainedSettlementCase,
} from "../../test/support/runnerd-settlement-harness.js";

const CORE_SETTLEMENT_CASES: RetainedSettlementCase[] = [
  { alreadyEnded: false, appendFailure: false },
  { alreadyEnded: true, appendFailure: false },
  { alreadyEnded: true, appendFailure: true },
  { alreadyEnded: true, appendFailure: false, bareCodex: true },
  { alreadyEnded: true, appendFailure: false, epochFailure: "launch_intent" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "spawned" },
  { alreadyEnded: true, appendFailure: false, epochFailure: "retired" },
  { alreadyEnded: true, appendFailure: false, holdSpawned: true },
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "pending" },
  { alreadyEnded: true, appendFailure: false, completedTerminalAck: "completed" },
];

it.each(CORE_SETTLEMENT_CASES)(
  SETTLEMENT_TEST_TITLE,
  runRetainedSettlementCase,
  40_000,
);
