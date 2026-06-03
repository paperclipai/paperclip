/**
 * Done-execution gate (narrated-completion hardening).
 *
 * Pure predicate: should a transition to `done` be blocked because there is no
 * evidence the agent actually executed the work?
 *
 * An agent run only produces real artifacts when it goes through an
 * issue-execution checkout, which sets `executionRunId`. Agents that merely
 * narrate "## Done" via the board API never acquire a run, so a `done`
 * transition with `executionRunId == null` and no pr-link evidence is a
 * narrated completion, not a real one.
 *
 * Guarded so it never blocks:
 *  - non-`done` transitions,
 *  - no-op `done` -> `done`,
 *  - human actors (only agent self-completions are gated),
 *  - issues whose last evidence verdict found a `pr-link` (recorded by the
 *    in_review evidence gate when a real PR was attached).
 *
 * Wired behind the instance flag `enableDoneExecutionGate` (default off).
 */

export interface DoneGateInput {
  /** The issue's current (pre-update) status. */
  fromStatus: string;
  /** The requested next status (undefined when the patch doesn't change status). */
  toStatus: string | undefined;
  /** The issue's current (pre-update) executionRunId; non-null iff a real run was checked out. */
  existingExecutionRunId: string | null;
  /** The issue's stored lastEvidenceVerdict (jsonb); shape is validated defensively. */
  lastEvidenceVerdict: unknown;
  /** True when the transition is driven by an agent (not a human). */
  isAgentActor: boolean;
}

function hasPrLinkEvidence(verdict: unknown): boolean {
  if (!verdict || typeof verdict !== "object") return false;
  const found = (verdict as { evidenceFound?: unknown }).evidenceFound;
  return Array.isArray(found) && found.includes("pr-link");
}

export function shouldBlockNarratedDone(input: DoneGateInput): boolean {
  if (input.toStatus !== "done") return false;
  if (input.fromStatus === "done") return false;
  if (!input.isAgentActor) return false;
  if (input.existingExecutionRunId != null) return false;
  if (hasPrLinkEvidence(input.lastEvidenceVerdict)) return false;
  return true;
}
