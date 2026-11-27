---
name: maintain-verification-skill
description: "Keep a project's verification skill and product/agent access maps aligned with current source and real evidence. Use for /maintain-verification-skill, auditing the verify skill, or reconciling feature and agent access coverage."
---

# Maintain a verification skill and its maps

Keep user journeys and agent access aligned with the app. For Paperclip, read the
[map contract](../../../maps/README.md), the
[feature index](../../../maps/feature-map/README.md), and the
[agent access index](../../../maps/agent-access-map/README.md). These are sibling
maps under `maps/`, with the same area filenames and capability IDs. Preserve
[Poteto's product format](../create-verification-skill/references/feature-map-example/).
Agent companions follow the shared contract; they do not duplicate user recipes.

An API endpoint, an OpenAPI actor label, a declared scenario tool and an admitted
production agent path are different evidence. Verify which permitted agent
surface can actually express an operation. Track source review, operation review
and executed proof separately. A source-only baseline is useful, but cannot
certify complete coverage or live behavior.

## Outcomes

Pick one and report source scope, live scope and remaining gaps separately:

- **clean** — the requested scope got source and live coverage, with no corrections.
- **changed** — proven skill/map/check corrections are ready to review; name any
  access gaps or unexecuted coverage that remains.
- **blocked** — requested coverage or a proven correction could not finish; name
  the unmet prerequisite and evidence captured so far.

A targeted audit covers its named areas; do not present it as a full pass. A full
pass reads every area from source and exercises every reachable feature, plus
relevant permitted-agent and denial paths. Report unreachable prerequisites and
not-run operations rather than silently reducing the scope.

## Edit scope

For Paperclip, edit the target verification skill, these maintenance instructions
when needed, `maps/`, and the map-specific structural check
`scripts/check-maps.mjs` / `scripts/check-maps.test.mjs`. Fix references to those
maps in contributor docs or skill instructions when their locations/IDs change.
Keep the maps in `maps/{feature-map,agent-access-map}/`, outside skill directories.

For other projects, maintain their existing verification skill and map locations;
the Paperclip directory convention does not authorize relocating another repo.
Never edit product APIs, permission enforcement, tool bindings or UI behavior
in a maintenance run. Record product/access gaps for implementation separately;
a permission denial is not authorization to widen access.

## Pass

0. **Locate the target and scope.** Find the project-local verification skill
   (usually `.agents/skills/verify-*/`). Several candidates: ask which; none:
   point to `/create-verification-skill`. Honor a requested narrower audit.
   Use Git diff/history to identify affected sources. Record the source revision
   and review evidence in the PR or evidence report, not a shared map ledger.

1. **Check both indexes.** Pair same-named feature and agent files, then match
   stable sub-feature IDs. Fix orphan/missing entries and broken references.
   For Paperclip run `node scripts/check-maps.mjs`. This checks structure,
   not API authorization, real tool bindings or live behavior.

2. **Source wave.** Use read-only subagents per area, with each reader owning
   the feature file and its access companion; schedule within available slots.
   Readers never edit or drive the app. Each returns the user capability/source
   entry points, likely drift with citations, meaningful operations, their APIs,
   actor/grant/resource/run/mode boundaries, real agent entry points by surface,
   missing access/discovery/policy decisions, and a concise verification recipe.
   Follow recent changes to routes, contracts, authorization, native tool
   admission, CLI and MCP as well as UI. Inspect actual route/service policy;
   compare it with OpenAPI and production bindings, not only scenario catalogs.

3. **Reconcile both maps.** Spot-check cited drift and merge recipes into as
   few app states as practical. Every affected business operation needs an API
   and a permitted agent path, or an explicit gap. A dedicated tool is optional
   when existing API/CLI/MCP fallback suffices. Distinguish native/remote access
   from legacy REST and personal assistant OAuth. Record field/scope limits,
   unavailable clients, protocol requirements and native fallback restrictions.
   Keep justified local/developer/operator exceptions, but split shared data
   operations from presentation. A board-only route records a restriction and
   any existing request/result handoff; an unresolved delegation question stays
   visible. Split broad baselines into per-operation records before marking
   them operation-reviewed. Add newly discovered capabilities only with concrete
   source; add their companion at the same time. Each feature recipe carries its
   own navigation metadata. Discovery generates the feature and access indexes;
   do not register new areas in shared READMEs or commit generated output. Keep
   durable Storybook verification routes in the affected feature recipe.

4. **Live pass.** Required for a verification maintenance pass even if source
   looks clean. The coordinator owns serial driving, using the target skill's
   existing launch/doctor/evidence/cleanup workflow and Paperclip's existing
   API/runner/MCP fixtures. Exercise the real user path and the relevant actual
   agent path separately. For access checks use the permitted agent identity,
   run, mode and target; assert results and relevant denials. A board request or
   board test-as-agent does not replace agent-credential proof. Use disposable
   fixtures for mutation/denial tests and record simulated providers honestly.
   Never assume an optional client is admitted to a native run.

   Keep three invariants: health-check before driving and after surprises;
   verify captured evidence survives cleanup; clean up everything the drive
   owned once no longer needed. Reset a wedged UI even if process health passes.
   Follow the target skill's session model: one long-lived owned server/UI
   instance, or isolated short-lived CLI sessions. After a skill-induced failure,
   fix within edit scope and retry once, restarting only what was invalidated.
   Record missing auth/provider/environment prerequisites and attempted paths.
   Re-drive changed harness helpers before shipping them. Final teardown follows
   the last proof attempt and preserves evidence.

5. **Triage and record.** User description/recipe drift updates the product map;
   endpoint/path/permission/discovery drift updates its companion. Missing or
   broken product behavior stays a product gap, with evidence. Never rewrite a
   recipe or mark an access exception to bless a failure. Map evidence states
   remain source-only/not-run unless an actual proof supports the named operation
   and surface. Keep run artifacts/results in the evidence location or issue;
   the generated `maps/generated/coverage.json` is a page-reference inventory,
   not passing test evidence.

6. **Review corrections.** Re-read changed files, check paired IDs/references and
   run the smallest relevant validation. Report outcome and source/live coverage
   honestly. If shipping is requested or already authorized, update the existing
   task PR where appropriate, or create at most one PR of proven corrections.
   A clean pass needs no branch or PR. Do not implement access-policy changes
   merely to make the maintenance report green.

Keep concise run notes and proof artifacts in the target skill's named evidence
location; do not commit ephemeral run logs as map content.

Origin and license: [NOTICE.md](NOTICE.md).
