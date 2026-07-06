# 040 — Operator-Owned Prompt/Response Dataset & Training Pipeline

## Suggestion

Every agent run is a prompt → response pair with a *known outcome* — it got approved, rejected,
reworked, shipped, or abandoned; it cost X; it did or didn't move the goal. That is exactly the
raw material for improving agents: better prompts, regression evals, distillation, and
fine-tuning local models. Paperclip captures the ingredients but not in a usable form:

- **Run logs are opaque.** `run-log-store.ts` persists run output as raw `local_file` blobs
  (append/read-by-offset). Not queryable, not structured into prompt/response, not labeled.
- **Feedback exists but points at the vendor.** `feedbackVotes` (👍/👎 + reason, `redactionSummary`,
  `consentVersion`) and `feedbackExports` ship trace bundles to Paperclip's own telemetry
  backend (`telemetry.paperclip.ing`), gated by `feedbackDataSharingEnabled`. That improves
  *Paperclip*, not the operator's specific agents, and it leaves the building.

The gap: an **operator-owned, structured, outcome-labeled dataset** of their agents' interactions
that *stays with them* and feeds their own improvement loop. Add a first-class capture pipeline
that turns run history into a queryable, exportable training corpus the operator controls.

## How it could be achieved

1. **Structured interaction records.** Alongside the raw run log, persist a normalized record per
   run: system/role prompt, input context, the response/actions, tokens & cost (`cost_events`),
   adapter/model, and IDs linking it to its issue/agent/goal. Promotes today's opaque blobs into
   queryable rows/objects.
2. **Automatic outcome labels.** Derive labels from the work lifecycle that already exists —
   approved/rejected via `approvals.ts`, reopened/reworked, shipped, abandoned, Diminishing-
   Returns trip (idea 003), capped run (idea 024). These outcome labels are what make the data
   *training-grade* rather than just archived chatter. Layer the existing `feedbackVotes` 👍/👎 on
   top as explicit human signal.
3. **Reuse consent + redaction.** Run every record through the existing `feedback-redaction.ts`
   and outbound-secret/PII scanners (ideas 020, 034) before storage/export, and gate everything on
   the existing company consent flags. Critical distinction from the current feature: this dataset
   is **operator-owned and local by default** — it does not leave the instance unless the operator
   exports it.
4. **Useful export formats.** Export to (a) eval cases for the eval harness (idea 011) and A/B
   bake-offs (idea 032); (b) JSONL fine-tuning/preference-pair format (good vs rejected responses
   for the same task) for distilling a cheaper or **local model** (idea 008); (c) a plain dataset
   for external analysis.
5. **Close the loop.** "Mine your own history": surface which prompts/configs correlate with
   approvals vs rework, feeding capability-based assignment (idea 025), the trust ramp (idea 009),
   and prompt-cache/prompt-quality tuning (idea 037).

## Governance note

Two things must be explicit and on by operator choice, not default-on: (a) using captured agent
outputs as training data can carry **provider terms-of-service** implications depending on the
model, and (b) the corpus will contain customer/business data, so it inherits the retention/PII
governance (idea 034) and right-to-erasure obligations. Surface these clearly; keep it
local-and-consented.

## Perceived complexity

**Medium.** The capture point (`run-log-store.ts`), the outcome signals (approvals, rework,
votes), and the redaction/consent machinery all already exist — the work is normalizing runs into
structured, labeled records, a storage/query layer, and exporters for the eval/fine-tune formats.
The genuinely hard parts are (a) faithful, low-overhead capture across heterogeneous adapters
(each formats prompts/responses differently), (b) trustworthy automatic labeling, and (c) getting
the privacy/consent/ToS boundary right so the feature is an asset, not a liability. Ship structured
capture + auto-labels + a local query view first; add fine-tune/preference-pair export once the
labeled corpus proves useful.
