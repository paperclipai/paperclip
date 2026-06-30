/**
 * Adapter → ccrotate-target mapping.
 *
 * Extracted from the (deleted) ccrotate capacity tier-gate. The pool-state
 * gating that owned this lives no more — Penstock owns capacity server-side
 * (see penstock-availability-gate.ts). The mapping survives because the
 * heartbeat capacity-exhaustion escalation contract still keys its
 * `ccrotate_capacity_exhausted` issues on the target ("claude" | "codex"), and
 * the quota writeback still attributes burn per target.
 */
export type CcrotateTarget = "claude" | "codex";

export function mapAdapterToCcrotateTarget(adapterType: string): CcrotateTarget | null {
  if (adapterType === "claude_local") return "claude";
  if (adapterType === "claude_k8s") return "claude";
  if (adapterType === "codex_local") return "codex";
  if (adapterType === "opencode_k8s") return "codex";
  return null;
}
