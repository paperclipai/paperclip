# FREEZE — paperclip-truth-extract v1

## Status

**Frozen.** Locked against modification until **2026-04-30**.

## Scope of freeze

The following files are frozen as `v1`:

- `SKILL.md` (this skill's governing doctrine)
- `references/protocol.md` (9-stage pipeline specification)
- `references/schemas.md` (utterance / atom / coverage-ledger schemas)
- `references/prompts.md` (system / extraction / audit / merge prompts)

The only **unfrozen** file in this skill directory is:

- `references/thin-binding.md` (Layer B binding to `proposal-forge`; mechanical
  only — invocation, parsing, receipt format)

## Why

On 2026-04-19, `proposal-forge@93456af` produced a defensible, byte-verifiable
archival chain from Liberty transcript bytes through frozen exports. Gates
1–6 are persisted; `sha256(payload_json) == export_sha256`; superseded
exports `#1/#2` are annotated, not erased. Active exports are `#3` and `#4`.

That chain is the IP filing input. Filing is due **2026-04-30**, ahead of the
TR Advisory Symposium disclosure (Huntington Beach, 2026-06-02 – 2026-06-04).

This skill produced the `ledger.recovered.json` that `truth:import-liberty-ledger`
ingested. It is **Layer A** of the evidence chain.

Modifying Layer A before filing would:

1. Break provenance between the skill-as-documented and the ledger-as-filed.
2. Force a re-run on Liberty to re-validate — risking timeline slip.
3. Create a second implementation surface at the moment single-homing matters
   most.

So: freeze. After filing lands, normal evolution resumes.

## Lift conditions

The freeze lifts when **all** of the following are true:

1. IP provisional is filed (target: 2026-04-30).
2. Filed artifact hashes are recorded in this repo under
   `docs/ip/filing-2026-04-30.yaml` (or equivalent), cross-referenced to
   the `proposal-forge` export `sha256` values from Liberty.
3. A lift note is added to `memory/context/` in the workspace-root repo
   explaining what changed, who authorized, and what the first post-filing
   modification intends to do.

Until then, this file and the files it freezes do not change.

## What Paperclip still actively develops (under this freeze)

- `references/thin-binding.md` — Layer B call surface, receipt schema.
- `packages/plugins/examples/plugin-truth-extract-example/` — plugin worker
  that shells out to `proposal-forge`, UI that surfaces explicit steps and
  human gates.

Those are **mechanical**. They do not touch truth generation. They invoke
proposal-forge and record what it returns.

## Provenance marker

| Layer | Home | Version | Validated on |
|-------|------|---------|--------------|
| A (transcript → ledger) | `paperclip/skills/paperclip-truth-extract/` | v1 (frozen) | Liberty, 2026-04-19 |
| B (ledger → brief → frozen export) | `proposal-forge@93456af` | Phase 4 complete | Liberty, 2026-04-19 |

Any change to either layer before filing breaks the chain.
