# Semantic Catalog Reconciliation

**Document status:** Canonical reconciliation ledger (PAP-17025 gate + PAP-17039 collapse)<br>
**Date:** 2026-08-11<br>
**Source of truth:** `src/catalog/canonical-operations.ts` (`CAPABILITY_CANONICAL_OPERATIONS`) — the single hand-authored 41-operation list. Both catalog modules derive their operation set, placement, required claims, and task-mode policy from it.<br>
**Drift authority:** `src/catalog/reconciliation.ts` (machine-readable ledger), drift-checked by `src/catalog/reconciliation.test.ts` and `src/catalog/catalog-docs.test.ts`.<br>
**Parent plan:** Runner foundation review plan (PAP-17016), deliverable D and execution step 1.

## Purpose

The runner carried two independently hand-maintained semantic catalogs. PAP-17025
established one machine-readable authority over both and recorded every
divergence. **PAP-17039 performed the physical collapse:** the authoritative
operation list, placement, required claims, and task-mode policy now live once in
`src/catalog/canonical-operations.ts`, and both catalog modules derive from it —
neither declares an independent operation list or an independent claim/mode
policy any longer. Each catalog supplies only its per-surface *presentation*
(title, description, input/output schema, and the scenario-only mock mapping and
redaction rules), and a bidirectional parity check fails the build if either
catalog's presentation set drifts from the canonical surface.

## The two catalogs

| Catalog | Module | Count | Descriptor | Consumers |
| --- | --- | --- | --- | --- |
| Scenario / eval | `src/tools/` | 37 (14 always + 23 optional) | Rich: placement (`disposition`), `sideEffectClass`, `idempotency`, `redaction`, `mockCommandMapping` | `src/scenarios/*`, `src/conformance/*`; package-root default export |
| Live runtime | `src/semantic-tools/` | 28 (13 always + 15 optional) | Live: `exposure`, `allowedModes`, `disabledByDefault`, provider input/output schemas; runtime dispatcher + policy + redaction | `src/live/*` (live Codex), `src/issue-thread/*`, generated `semantic-tool-contracts.json`; package-root `acceptedCapabilitySemanticTools` |

Reconciled op-set relationship (pinned by the drift test):

- **24 shared** operation ids.
- **13 scenario-only:** `administer_company`, `export_company`, `inspect_operation_result`, `list_cases`, `list_company_skills`, `list_goals`, `list_projects`, `list_routines`, `list_secret_metadata`, `manage_routine`, `read_secret_value`, `sync_company_skills`, `upsert_case`.
- **4 live-only:** `get_agent`, `get_approval`, `get_approval_context`, `schedule_wake`.
- **Union = 41 operations.**

## Canonical authority decision

- **Single source of truth:** `src/catalog/canonical-operations.ts` hand-authors
  the 41-op union exactly once (`CAPABILITY_CANONICAL_OPERATIONS`), each entry
  naming surfaces, placement, optional group, claims, task modes, roles,
  side-effect class, idempotency, disabled-by-default, real-binding status, PRP
  evidence, and legacy aliases. Both catalog modules import it and project it:
  `src/tools/` renders the rich scenario descriptor and `src/semantic-tools/`
  renders the live provider descriptor.
- **Drift ledger:** `src/catalog/reconciliation.ts` enriches the canonical list
  with the scenario mock mapping and redaction flag (`CAPABILITY_CANONICAL_CATALOG`),
  and `capabilityCatalogReconciliation()` recomputes the op-set summary and any
  remaining metadata divergence between the two catalogs' actual descriptors.
- Neither `src/tools/` nor `src/semantic-tools/` is canonical; both are
  projections of `canonical-operations.ts`.

## Real-binding status (before real Paperclip service binding)

No operation is bound to a real Paperclip service yet; the deterministic mock is
the only backend (real-service binding is deliverable G). Each operation's
current executability is classified as:

- **`live_codex` (27):** executed by the live dispatcher against the mock and
  exposed to live Codex — the 24 shared ops (minus the test-only escape hatch)
  plus the 4 live-only ops.
- **`scenario_mock` (13):** defined only in the scenario/eval catalog and driven
  through the scenario runtime / mock extensions; no live dispatcher binding.
- **`test_only` (1):** `generic_api_request` — the escape hatch, which by rule
  **cannot count as product capability coverage**.

## Divergence ledger (after the PAP-17039 collapse)

`requiredClaims` and task modes are single-sourced from
`canonical-operations.ts`, so the two catalogs cannot diverge on them; the drift
test asserts both divergence sets are now **empty**. The reconciliation ledger
recomputes divergences from the two catalogs' actual descriptors:

- **Claims (0):** unified. `generic_api_request` carries a single claim,
  `test:generic_api_request`, on both surfaces.
- **Task modes (0):** unified to one canonical policy — **the live runtime
  exposure policy unioned with `skill_test`**. Reads stay open in every mode;
  work-writes (`report_progress`, `write_document`, `request_human_input`,
  `register_deliverable`) allow `standard`/`planning`/`skill_test`; lifecycle
  and state writes (`finish_task`, `block_task`, `request_review`, `create_task`,
  `set_dependencies`, request/decide/comment approvals, `control_workspace_service`)
  allow `standard`/`skill_test`. The `skill_test` mode makes every operation the
  eval harness must drive drivable, while the live runtime keeps its intended
  per-mode exposure.
- **Input-schema shape (reviewed intentional projection):** one input contract is
  projected two ways by design — the live provider descriptor threads
  `idempotencyKey` in-band with provider length/pattern bounds for the model,
  while the observable scenario runtime threads idempotency out-of-band. This is
  a single reviewed projection recorded in the ledger, not two independently
  authored schemas.

### Effect on live provider schemas (QA gate)

- The generated live contract golden `generated/capability/semantic-tool-contracts.json`
  is **byte-identical** after the collapse: it serializes name, description,
  input/output schema, exposure, and required claims — none of which changed on
  the live surface (`allowedModes` is not serialized).
- The live runtime **`allowedModes`** gained `skill_test` for the nine
  previously `standard`-only operations (`finish_task`, `block_task`,
  `request_review`, `create_task`, `set_dependencies`, `request_approval`,
  `decide_approval`, `control_workspace_service`, `schedule_wake`). This is a
  behavioral change to eval-harness exposure only; real live tasks never run in
  `skill_test` mode.

## Legacy MCP aliases

Legacy MCP aliases are indexed in `spec/capability/mcp-tool-map.yaml`
(`inventoryRole: legacy_alias_index`, generated from `packages/mcp-server`). Each
alias row carries a `foldedInto` disposition linking it to the native eval/
operation that now covers its behavior; the reconciliation drift test asserts
every row has one. The authority additionally records the direct native
operation for the well-known aliases (for example `paperclipListAgents` →
`list_agents`, `paperclipGetAgent` → `get_agent`, `paperclipListIssues` →
`search_tasks`, `paperclipCreateIssue` → `create_task`).

## Collapse decisions executed by PAP-17039

1. **One source of truth.** `src/tools/` and `src/semantic-tools/` no longer
   declare independent operation lists; both project
   `CAPABILITY_CANONICAL_OPERATIONS`. Placement, optional group, required claims,
   task modes, allowed roles, side-effect class, idempotency, and
   disabled-by-default are single-sourced. Bidirectional parity checks fail the
   build on any drift between a catalog's presentation and the canonical surface.
2. **`generic_api_request` claim unified** to `test:generic_api_request`
   (scenario callers/tests updated). It stays `test_only` and is excluded from
   product capability coverage.
3. **One canonical task-mode policy** (live runtime policy ∪ `skill_test`); the
   ledger's 15 task-mode divergences are resolved to zero.
4. **Input schema unified as one contract, projected two ways** — idempotency
   in-band with provider bounds for the model, out-of-band for the observable
   scenario runtime — recorded as the single reviewed intentional projection.
5. **Placement of scenario-only (13) and live-only (4) operations retained.** The
   13 scenario-only ops stay `scenario_mock` (eval-only via mock extensions); the
   4 live-only reads/continuation ops (`get_agent`, `get_approval`,
   `get_approval_context`, `schedule_wake`) stay `live_codex` with no scenario
   projection. No operation crossed surfaces this increment; a future real-service
   binding (deliverable G) is where scenario-only ops would gain a live binding.

Consumed by the real-surface-ledger (deliverable B) and eval (deliverable F)
tasks: the live contract golden is unchanged; the only behavioral delta is the
`allowedModes` `skill_test` addition described above.

## Verification

- `src/catalog/reconciliation.test.ts` — pins the op-set relationship, asserts
  both catalogs derive their operation set from the canonical source, asserts
  claims/modes/placement are single-sourced (no divergence), and requires a
  reviewed disposition for the surviving input-schema projection.
- `src/catalog/catalog-docs.test.ts` — recomputes the catalog counts and
  membership in `docs/capability-semantic-tools.md` from the catalog so a stale
  hand count fails.
- Live golden byte-identity checked by `check:semantic-contracts`; the scenario
  and live runtime behavior is covered by the `test:scenarios` suites.
