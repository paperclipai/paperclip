/**
 * Evidence-shape registry for the artifact-evidence gate (BLO-4461).
 *
 * Maps an issue's label name to the set of evidence shapes the agent must
 * produce before transitioning the issue to `in_review`. Each shape names a
 * detectable pattern in the issue's comments or work_products — see
 * `evidence-gate.ts` for the detection logic.
 *
 * The registry is intentionally a plain object so operators can edit the
 * defaults or override per-instance via config at the call-site. The gate
 * evaluator never reads this file directly; it receives the registry as
 * input, which keeps the evaluator pure and testable.
 */

export type EvidenceShape =
  | "screenshot:1440x900"
  | "screenshot:390x844"
  | "checklist:done-when"
  | "test-output"
  | "kubectl-state"
  | "probe-output"
  | "url-probe"
  | "pr-link"
  | "ci-green"
  | "e2e-script"
  | "e2e-run"
  | "migration-output";

export interface EvidenceRegistryEntry {
  required: EvidenceShape[];
}

export type EvidenceRegistry = Record<string, EvidenceRegistryEntry>;

/**
 * Default registry. Keys are label names as they appear on issues
 * (case-insensitive lookup is the evaluator's job).
 *
 * Tuning notes:
 *   - `frontend`/`ui`/`cms-published` all share the same required set —
 *     viewport screenshots + a per-criterion checklist. Three aliases
 *     because real issues use whichever name the operator typed first.
 *   - `backend` requires a real test banner, not a "tests passed" claim.
 *   - `infra` requires observable post-state, not a "deployed" claim.
 *   - `cms-data-op` is light (single URL probe) because these are
 *     typically one-field CMS edits — over-gating slows the operator.
 *   - `pr` is the lightest of all: just a PR link. CI-green enforcement
 *     comes in Phase 2 (BLO-4828).
 */
export const DEFAULT_EVIDENCE_REGISTRY: EvidenceRegistry = {
  frontend: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when"],
  },
  ui: {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when"],
  },
  "cms-published": {
    required: ["screenshot:1440x900", "screenshot:390x844", "checklist:done-when"],
  },
  backend: {
    required: ["test-output", "checklist:done-when"],
  },
  infra: {
    required: ["kubectl-state", "probe-output"],
  },
  "cms-data-op": {
    required: ["url-probe"],
  },
  pr: {
    required: ["pr-link"],
  },
  "db-migration": {
    required: ["migration-output"],
  },
  migration: {
    required: ["migration-output"],
  },
};

/**
 * Required evidence for issues that match no registry entry. Single weak
 * shape so the gate's verdict is `warn` (not `block`) for unlabeled work —
 * historically not every issue gets labeled, and we don't want the gate to
 * become a chore for refactor / doc-only issues.
 */
export const DEFAULT_UNLABELED_REQUIRED: EvidenceShape[] = ["checklist:done-when"];
