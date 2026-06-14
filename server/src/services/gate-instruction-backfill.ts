import { isIdentityRoutableBundleRole } from "./default-agent-instructions.js";

// Pure decision for the gate-instruction backfill (server/scripts/backfill-gate-instructions.ts).
// Kept IO-free so every branch is unit-testable; the script supplies the inputs
// (derived urlKey, bundle mode, current entry content, the generic default entry).
//
// Re-seed ONLY when all hold:
//   - the agent's identity (derived urlKey) is one of the gate roles, AND
//   - its bundle is managed, AND
//   - its current entry file is byte-for-byte the generic default seed.
// Any other state is skipped with a reason — custom edits, already-role-seeded
// bundles (role content != default), external/unmanaged agents, and
// missing/unreadable entries are never overwritten.

export type GateBackfillDecision =
  | { action: "reseed"; bundleRole: string }
  | { action: "skip"; reason: string };

export function decideGateBackfillAction(input: {
  urlKey: string | null;
  mode: "managed" | "external" | null;
  currentEntryContent: string | null;
  defaultEntryContent: string;
}): GateBackfillDecision {
  const { urlKey, mode, currentEntryContent, defaultEntryContent } = input;

  if (typeof urlKey !== "string" || !isIdentityRoutableBundleRole(urlKey)) {
    return { action: "skip", reason: "not-a-gate-agent" };
  }
  if (mode !== "managed") {
    return { action: "skip", reason: `not-managed:${mode ?? "none"}` };
  }
  if (currentEntryContent === null) {
    return { action: "skip", reason: "entry-missing" };
  }
  if (currentEntryContent !== defaultEntryContent) {
    return { action: "skip", reason: "custom-or-already-seeded" };
  }
  return { action: "reseed", bundleRole: urlKey };
}
