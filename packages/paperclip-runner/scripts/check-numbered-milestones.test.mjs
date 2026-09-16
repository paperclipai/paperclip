import assert from "node:assert/strict";
import { test } from "node:test";

import { findNumberedMilestoneNames } from "./lib/numbered-milestones.mjs";

test("rejects numbered construction labels in paths and identifiers", () => {
  const candidates = [
    "src/phase7/session.ts",
    "protocol/fixtures/phase-04b/input.json",
    "export class Phase3Runner {}",
    '"trace:phase2": "node dist/phase2.js"',
    "Phases 0 through 3",
  ];

  assert.deepEqual(
    candidates.map((candidate) => findNumberedMilestoneNames(candidate).length),
    [1, 1, 1, 2, 1],
  );
});

test("allows unnumbered domain phase terminology and semantic protocol versions", () => {
  const candidates = [
    "runtime.phase.changed",
    "phase: LifecyclePhase",
    "transition to the recovery phase",
    "paperclip.prp.control.v1",
  ];

  assert.ok(candidates.every((candidate) => findNumberedMilestoneNames(candidate).length === 0));
});
