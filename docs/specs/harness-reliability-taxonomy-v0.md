# Agent Harness Runtime Reliability — Observability Taxonomy & Classifier v0

Status: v0 internal contract. No production wiring, no live flag, no deploy.
Scope owner: EAOS Parallel Engineer (LET-410, derived from LET-161).

## 1. Why this exists

The harness today reports run outcomes in terms like "failed", "stalled", or
"blocked". Those words conflate very different operational realities:

- A run that produced a perfectly good diff but never recorded a final
  disposition is **not** the same as a run that lost its adapter mid-stream.
- An issue that is `blocked` on a dependency that itself shipped two days
  ago is **not** the same as one paused on a real deploy approval.
- A reviewer agent that rejected output is **not** the same as a reviewer
  stage that never resumed.

Without separating these, Command Center surfaces, dashboards, and CEO
escalations cannot name the **canonical next owner and next action**. The
v0 taxonomy below is the smallest shared vocabulary needed to fix that.

## 2. Categories

Each category maps `signals → (owner, next action, severity)`. The canonical
labels and routing live in code at
`packages/shared/src/harness-reliability/taxonomy.ts`. The table below is
descriptive; the file is authoritative.

| Category | Owner | Next action | Severity | What it means |
| --- | --- | --- | --- | --- |
| `product_failure` | Assignee agent | Investigate and fix product output | attention | Agent produced output that violates the product contract — not a harness/adapter issue. |
| `adapter_or_process_loss` | Platform | Retry adapter / restart worker | attention | Adapter, sandbox, or worker died, timed out, or returned no output. Useful-output may still exist on disk. |
| `useful_output_missing_disposition` | Assignee agent | Record final disposition | warn | Real artifacts (diff, comment, document) exist but no disposition was set. Forward step is closing out, not redoing work. |
| `stale_blocker` | Orchestrator | Refresh blocker or unblock | attention | Issue is blocked on a dependency that is itself done/cancelled. Holding the tree on a phantom. |
| `duplicate_recovery` | Platform | Deduplicate recovery actions | warn | Multiple recovery actions, self-wakes, or retries fired for the same signal. Continuing burns budget without progress. |
| `review_or_qa_failure` | Reviewer agent | Rerun review or QA | attention | Review/QA stage rejected the work, or stalled past expected runtime. |
| `approval_hold` | Human operator | Await approval decision | info | Work intentionally paused awaiting explicit approval (deploy, spend, scope). Not a failure. |
| `release_hold` | Release manager | Await release window | info | Work ready but held by release window or release-manager gate. Not a failure. |
| `healthy_in_progress` | — | Continue in progress | info | Forward-motion signals (queued, running, recently advanced). No intervention required. |
| `unclassified` | Orchestrator | Triage unclassified signal | warn | Signals do not match a v0 category. Surfaces must flag rather than drop silently. |

### 2.1 Classifier signal contract

The classifier consumes a normalized `HarnessReliabilitySignal` envelope.
Fields are optional — the classifier degrades to `unclassified` when the
input is insufficient.

```ts
type HarnessReliabilitySignal = {
  runLivenessState?: RunLivenessState | null;
  heartbeatRunStatus?: HeartbeatRunStatus | null;
  issueStatus?: IssueStatus | null;
  hasUsefulOutput?: boolean;
  dispositionRecorded?: boolean;
  adapterLost?: boolean;
  hasStaleBlocker?: boolean;
  recentRecoveryActionCount?: number;
  reviewOrQaRejected?: boolean;
  reviewOrQaStageHung?: boolean;
  awaitingApproval?: boolean;
  awaitingReleaseWindow?: boolean;
  selfWakeLoop?: boolean;
};
```

### 2.2 Classifier ordering (why order matters)

Many real signals match more than one category. The classifier resolves
that by ordering, from highest-precedence to lowest:

1. `approval_hold` — explicit, intentional pause.
2. `release_hold` — explicit, intentional pause.
3. `review_or_qa_failure` — explicit verdict or hung review stage.
4. `stale_blocker` — phantom dependency hold.
5. `duplicate_recovery` — recovery noise / self-wake loop.
6. `useful_output_missing_disposition` — work happened, disposition didn't.
7. `adapter_or_process_loss` — transport-level loss.
8. `product_failure` — finished but the product contract failed.
9. `healthy_in_progress` — forward motion.
10. `unclassified` — last resort, surface for triage.

The invariants are unit-tested in `classifier.test.ts`. The intent: a real
approval pause is never reported as "failed", a useful diff is never thrown
away as "adapter lost", and a phantom blocker is never hidden behind
recovery noise.

## 3. Reuse of existing types

The taxonomy sits **one layer above** existing run/issue states. It does
not replace any of:

- `RunLivenessState` (`packages/shared/src/constants.ts`) — per-run signal.
- `HeartbeatRunStatus` — transport-level run status.
- `IssueRecoveryActionKind` — what the recovery system *did*, not why.
- `SuccessfulRunHandoffStateKind` — disposition record itself.

The classifier consumes the first three as inputs and emits the
owner/action verdict the existing types deliberately do not express.

## 4. Command Center integration notes (v0)

What the UI can safely show **now** (pure, no API work needed):

- The static category catalog — labels, descriptions, default owners and
  actions — via `listHarnessReliabilityCategoryDescriptors()`.
- An evidence-row preview computed from a hand-built or fixture
  `HarnessReliabilitySignal`, via `harnessReliabilityVerdictToEvidenceRow`.
- A "Reliability legend" page or sidebar fed entirely from
  `HARNESS_RELIABILITY_CATEGORY_CATALOG`.

What must remain **preview / backend-derived** for v0:

- Real `HarnessReliabilityVerdict` rows attached to live issues or runs.
  v0 does not wire the classifier into the server (no DB column, no API
  field). UI should label any non-fixture verdict as "preview".

What needs **later API work** (not in v0 scope):

- A read-only `GET /api/issues/{id}/reliability-verdict` (or projection on
  the existing issue payload) that calls the classifier on real signals.
- A persisted classification history table if we want trend dashboards.
- Wiring the verdict into recovery-action selection so the recovery
  service stops at `duplicate_recovery` instead of firing again.
- Severity → Command Center color/badge map (out of scope until UI lane
  picks it up; the severity field is already stable).

Hard rules for v0 integration:

- No production runtime change, no live flag, no deploy.
- The classifier is pure and synchronous — safe to call from server, UI
  preview, and tests.
- Surfaces must distinguish preview/fixture verdicts from backend-derived
  verdicts (none exist yet) so users do not mistake the legend for live
  state.

## 5. Handoff — overlap with the Workflow Eval Packs lane

Workflow Eval Packs (LET-161 roadmap item #5, "Workflow Eval Packs / golden
tasks / replay regression") is the **only** other lane that plausibly
touches the same surface area. As of branch creation:

- No `eval-pack`, `EvalPack`, `workflow-eval`, `golden-task`, or replay
  module exists yet under `packages/shared/src/` or `server/src/`.
- No file in `packages/shared/src/harness-reliability/` is touched by any
  other open lane on this repo state.

Coordination contract with the Workflow Eval Packs lane:

1. **Vocabulary**. Eval Packs should *consume* this taxonomy when grading
   replays ("the golden task expected `healthy_in_progress`, got
   `product_failure`"). Eval Packs must not re-define overlapping
   categories. If a category is missing, file a delta against this spec
   rather than forking.
2. **Signal contract**. Eval Packs may extend `HarnessReliabilitySignal`
   with replay-specific optional fields (e.g. `expectedCategory`), but
   must not change existing field names or semantics.
3. **File ownership**. This lane owns
   `packages/shared/src/harness-reliability/**`. The Eval Packs lane is
   expected to create its own folder (e.g.
   `packages/shared/src/workflow-eval-packs/**`) and import the taxonomy.
4. **Conflict protocol**. If overlap appears, stop and coordinate through
   LET-161, per the global boundaries in the LET-410 brief.

## 6. Validation evidence (v0)

- `vitest packages/shared/src/harness-reliability/classifier.test.ts` —
  classifier ordering, required v0 fixtures (useful-output-but-failed-
  adapter, duplicate recovery, stale blocker, missing validation evidence,
  review-stage hang), holds, healthy path, evidence-row labels.
- Taxonomy catalog coverage test: every declared category has a
  descriptor, no `owner: none` entry has a non-`continue_in_progress`
  action.

## 7. Risk and rollback

- **Risk**: very low. v0 ships pure types, constants, and a synchronous
  classifier with no callers in server runtime, no DB migration, no live
  flag, no deploy.
- **Rollback**: revert the branch — no persisted state, no service
  restart, no migration to undo.
- **Future risk** (out of v0): when the classifier is wired into recovery
  selection, ensure the precedence rules above are still in force, or the
  system will mis-route real approval pauses as failures.

## 8. Next gates

- QA Validator 2: confirm classifier coverage of the v0 fixtures listed
  in section 2 and that the catalog/precedence invariants hold.
- Claude Reviewer: confirm the taxonomy is internally consistent, the
  classifier is pure, and the docs match the code.
- Both PASS gates are required before this lane can close (per LET-410).
