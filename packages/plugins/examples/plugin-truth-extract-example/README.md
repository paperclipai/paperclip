# @paperclipai/plugin-truth-extract-example

Thin binding from Paperclip to `proposal-forge`'s Layer B truth pipeline.

Paperclip does **not** re-author truth generation. This plugin invokes
`proposal-forge`'s `truth:*` artisan commands via local subprocess and
records run IDs, brief IDs, export IDs, SHA256 hashes, gate verdicts, and
artifact paths as `proposal-forge.receipt.json` on the Paperclip issue.

> **Why thin?** As of 2026-04-22, the Liberty archival chain on
> `proposal-forge@93456af` is the IP filing input (due 2026-04-30). Replicating
> that pipeline in Paperclip pre-filing would create a second implementation
> surface, weaken provenance, and fork the IP. This plugin is the **caller**,
> single-homing all truth-generation logic in `proposal-forge`.

## The two layers

- **Layer A (transcript → `ledger.json`)** — frozen in the
  `paperclip-truth-extract` skill (`skills/paperclip-truth-extract/`). Runs on
  an agent with the skill attached, outside this plugin.
- **Layer B (ledger → claims → brief → frozen export with gates)** —
  single-homed in `proposal-forge`. Invoked by this plugin via subprocess.

The operator attaches `ledger.json` to the run; this plugin does not auto-run
Layer A.

## Prerequisites

1. A local `proposal-forge` checkout at a known absolute path.
2. Environment variable `PAPERCLIP_TRUTH_FORGE_PATH` set to that path. The
   plugin validates that `${PAPERCLIP_TRUTH_FORGE_PATH}/artisan` is
   readable before issuing a run.
3. `proposal-forge` commands present: `truth:import-liberty-ledger`,
   `truth:bulk-accept-atoms`, `truth:synthesize-claims`, `truth:review-claims`,
   `truth:synthesize-brief`, `truth:freeze-export`. Pinned to
   `proposal-forge@93456af`.
4. A Layer A `ledger.json` produced by the frozen
   `paperclip-truth-extract` skill.

Optional:

- `PAPERCLIP_TRUTH_WORK_DIR` — directory where the plugin writes transcript
  and ledger files for the artisan command to read. Defaults to
  `$TMPDIR/paperclip-truth-extract/<issue-id>/`.

## How the chain runs

Each step is an explicit action. No composite "do the pipeline" button.
Human gates (atom review, claim review) are surfaced as attestations, never
auto-invoked.

| # | Action | Command | Kind |
|---|--------|---------|------|
| 1 | `forge-import` | `truth:import-liberty-ledger` | subprocess |
| 2a | `forge-bulk-accept-atoms` | `truth:bulk-accept-atoms` | subprocess (weaker provenance) |
| 2b | `forge-attest-atom-review` | human review in terminal | attestation only |
| 3 | `forge-synthesize-claims` | `truth:synthesize-claims` | subprocess |
| 4 | `forge-attest-claim-review` | `truth:review-claims` (interactive) | attestation only |
| 5 | `forge-synthesize-brief` | `truth:synthesize-brief` | subprocess |
| 6 | `forge-freeze-export` | `truth:freeze-export` | subprocess |

### Buyer-facing completion — unsupported

`truth:review-brief` does **not exist** in `proposal-forge`. Until it is
authored there (post-filing concern), this binding ends at step 6 with the
archival receipt. The UI never sets `buyer_facing_complete = true`.

## Receipt

Every step updates `proposal-forge.receipt.json` on the issue (new revision
per step). The full schema lives in
`skills/paperclip-truth-extract/references/thin-binding.md`.

Subprocess steps record: `exit_code`, `started_at`, `completed_at`,
`stdout_doc_key`, `parsed` (structured fields extracted by pinned regexes —
see the parse contract in `thin-binding.md`). Parse misses are flagged with
`parse_miss: true`.

Attestation steps record: `operator`, `attested_at`, optional `note`, no
`exit_code` (no subprocess was run).

## Local install (dev)

```bash
pnpm --filter @paperclipai/plugin-truth-extract-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-truth-extract-example

export PAPERCLIP_TRUTH_FORGE_PATH=/abs/path/to/proposal-forge
```

Then:

1. Produce a Layer A `ledger.json` using an agent with the
   `paperclip-truth-extract` skill attached (happens outside this plugin).
2. Open the plugin page at
   `/plugins/paperclip.truth-extract-example/truth-extract`.
3. Paste the transcript (JSON utterances) and the Layer A ledger JSON. Click
   **Create run**.
4. Step through the six actions. For the two human gates, run the displayed
   command in a terminal, then click **Record attestation** with your
   operator identity.

## What this plugin deliberately does not do

- Re-implement Layer B in TS/Node. Hashes, gates, supersession logic all live
  in `proposal-forge`.
- Expose `truth:freeze-export --admin-identity --rationale --force-override`.
  Overrides are operator work, not plugin work, so the audit trail stays
  inside `proposal-forge`.
- Auto-run `truth:review-claims`. It is interactive; synthesizing a bypass
  would violate single-homing.
- Claim buyer-facing readiness.

## Scope note

Paperclip's V1 implementation contract (`doc/SPEC-implementation.md`) lists
plugins as out-of-scope in principle. This plugin is intentionally **thin**:
it stores artifacts, shells out to `proposal-forge`, and records what comes
back. All truth-generation logic stays in `proposal-forge`, so upgrades to
that pipeline do not require plugin changes beyond parse-contract review.

Post-filing evolution: replace subprocess with an HTTP wrapper if
`proposal-forge` gains one. Bump `receipt_version` and pin a new
`forge_head_sha_pin`.
