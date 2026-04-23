# Thin binding — Paperclip ↔ `proposal-forge` Layer B

> Read this when you need to get a frozen archival export from a Paperclip
> issue that already has a Layer A `ledger.json` attached.

## Scope

Paperclip does not re-implement truth generation. It invokes the existing
`proposal-forge` artisan commands via local subprocess and persists the
structured results back to the Paperclip issue as
`proposal-forge.receipt.json`.

- **Layer A (transcript → `ledger.json`)** — frozen in this skill. Runs on an
  agent attached to the extractor.
- **Layer B (ledger → claims → brief → frozen export with gates)** — single-homed
  in `proposal-forge`. Paperclip is a caller, never a re-implementer.

## Invocation mechanism

Local subprocess only. Both repos must be on the same machine.

- Env var: `PAPERCLIP_TRUTH_FORGE_PATH` → absolute path to a working
  `proposal-forge` checkout (contains `artisan` executable).
- Runner: `php artisan <signature>` with `cwd = $PAPERCLIP_TRUTH_FORGE_PATH`.
- Output: stdout + stderr captured verbatim; structured fields parsed from
  known printed lines (see "Parse contract" below).
- No HTTP shim. No changes to `proposal-forge`. No TS/Node re-implementation.

## Command chain

Each command is its own discrete Paperclip action. The plugin surfaces them as
separate buttons so the operator sees where they are in the chain.

### 1. `truth:import-liberty-ledger` (Layer A handoff)

```
php artisan truth:import-liberty-ledger \
  --transcript=/abs/path/to/transcript.json \
  --ledger=/abs/path/to/ledger.recovered.json \
  --title="<brief title>"
```

- **Input:** absolute paths to the transcript JSON (utterance array) and the
  Layer A `ledger.json` (the frozen-v1 output this skill produces).
- **Output parse:** `/truth_run #(\d+) imported/` → `run_id`.
- **Persist:** write `forge.step-1-import.stdout.txt` to the issue. Update
  receipt with `run_id`, `transcript_sha256` (if surfaced), and raw stdout
  pointer.

The command name is Liberty-historical but transcript-agnostic. Do not call a
different name; do not rename the command in `proposal-forge` (frozen pre-filing).

### 2. Atom acceptance — human gate

`proposal-forge` atoms import at `status=needs_review`. Paperclip has two
options; choose explicitly, do **not** default.

- **(a) Automated:** `php artisan truth:bulk-accept-atoms --run=<id>` — accepts
  every atom. Weaker provenance. Appropriate only when the agent's Layer A
  ledger already passed hallucination and omission audits.
- **(b) Manual (no CLI):** there is **no** artisan command for per-atom
  manual review. The operator updates `truth_atoms.status = 'accepted'` via
  the `proposal-forge` UI or direct database work, then records an
  attestation in Paperclip. The plugin's job is to surface that instruction
  truthfully — **do not fabricate a `truth:review-atoms` command name**, it
  does not exist.

The plugin exposes both as separate actions (`forge-bulk-accept-atoms` runs
the subprocess; `forge-attest-atom-review` is attestation-only, records
operator + timestamp + optional note, no subprocess invoked). The caller
picks.

### 3. `truth:synthesize-claims`

```
php artisan truth:synthesize-claims --run=<id> [--mode=standard] [--model=gpt-5.4-mini]
```

- **Preconditions:** at least one atom at `status=accepted`. Command fails fast
  otherwise; surface the error.
- **Output parse:** `/synthesis_run #(\d+)/` → `synthesis_run_id`. Token counts,
  verifier findings, and group distribution in the same stdout block.
- **Persist:** `forge.step-3-claims.stdout.txt` and receipt update.

Claims land at `status=needs_review` — not accepted. This is intentional.

### 4. Claim review — human gate (interactive)

```
php artisan truth:review-claims --run=<id>
```

Interactive. **Paperclip does not auto-run this.** The plugin surfaces:

- Status: `awaiting claim review`
- The exact command string (copyable)
- A "mark review complete" action that records the operator's attestation
  into the receipt (timestamp + operator identity from the Paperclip board
  context), without executing the artisan command.

There is no non-interactive equivalent. Do not synthesize a bulk-accept for
claims; that bypass does not exist in `proposal-forge`, and inventing one in
Paperclip would violate single-homing.

### 5. `truth:synthesize-brief`

```
php artisan truth:synthesize-brief --run=<id> [--title=...] [--model=gpt-5.4-mini]
```

- **Output parse:**
  - `/brief #(\d+) \(v(\d+)\) created · status=(\S+) · tokens (\d+) in \/ (\d+) out/`
    → `brief_id`, `brief_version`, `brief_status`, token counts.
  - `/brief_payload_hash: (\w+)/` → `brief_payload_hash`.
  - `/synthesis_run #(\d+) · input_hash: (\w+)/` → brief-synthesis input hash.
  - Section-count lines (`problem`, `constraint`, `opportunity`, `pilot`,
    `problem_statement`, `buyer_value_narrative`) — record observed vs.
    expected.
- **Persist:** `forge.step-5-brief.stdout.txt` and receipt update.

Brief lands at `status=needs_review`. A human `brief_reviewer` must accept it
before Phase 4 freeze — **but `truth:review-brief` does not exist as a
command**. This is the known gap flagged in the 2026-04-19 session recap.

### 6. `truth:freeze-export`

```
php artisan truth:freeze-export \
  --run=<id> \
  --brief=<id> \
  [--format=executive_brief_yaml --format=claims_json] \
  [--dry-run]
```

- **Output parse:**
  - `/release gate verdict: (\S+)/` → `gate_verdict` (PASS / WARN / FAIL).
  - Per-gate lines: `/gate (\d+) · (\S[^·]*?) (PASS|WARN|FAIL)/` — record
    all six gates with findings.
  - Per-export lines:
    `/export #(\d+) · format=(\S+) v(\d+) · sha256=(\w+) · (\d+) bytes/` →
    `export_id`, `format`, `version`, `sha256`, `bytes`.
- **Persist:** `forge.step-6-freeze.stdout.txt` and final receipt update.

Override path (`--admin-identity`, `--rationale`, `--force-override`) is
**not exposed** through the plugin. Overrides, when justified, are run by the
operator in a terminal. This preserves the audit_event trail in
`proposal-forge` and keeps Paperclip from becoming the override surface.

## Buyer-facing completion — unsupported

`truth:review-brief --run=<id>` does **not exist** in `proposal-forge`.

Until that command is authored in `proposal-forge` (post-filing concern), the
Paperclip binding ends at step 6 with the archival receipt. The UI must not
imply buyer-facing readiness. A follow-up note:

> Buyer-facing acceptance requires a `truth:review-brief` command that does
> not yet exist. Contact `proposal-forge` maintainers if you need it.

## Receipt schema — `proposal-forge.receipt.json`

Written back to the Paperclip issue as a document keyed
`proposal-forge.receipt.json`. Cumulative: each step updates the same
document (new revision) rather than producing a parallel file per step.

```json
{
  "receipt_version": 1,
  "skill_version": "paperclip-truth-extract@frozen-v1",
  "forge_path": "/abs/path/to/proposal-forge",
  "forge_head_sha_pin": "93456af",
  "observed_forge_head_sha": "93456afe8b2c1a9d3e4f5a6b7c8d9e0f1a2b3c4d",
  "transcript_doc_key": "transcript.input.json",
  "ledger_doc_key": "ledger.json",
  "transcript_file_path": "/tmp/paperclip-truth-extract/<issue-id>/transcript.json",
  "ledger_file_path": "/tmp/paperclip-truth-extract/<issue-id>/ledger.recovered.json",
  "steps": [
    {
      "step": 1,
      "command": "truth:import-liberty-ledger",
      "args": {
        "transcript": "...",
        "ledger": "...",
        "title": "...",
        "forge_head_sha_observed": "93456afe8b2c1a9d3e4f5a6b7c8d9e0f1a2b3c4d"
      },
      "started_at": "2026-04-22T22:10:03Z",
      "completed_at": "2026-04-22T22:10:05Z",
      "exit_code": 0,
      "stdout_doc_key": "forge.step-1-import.stdout.txt",
      "parsed": { "run_id": 3 }
    },
    {
      "step": 2,
      "command": "truth:bulk-accept-atoms",
      "args": { "run": 3, "forge_head_sha_observed": "93456af..." },
      "started_at": "...",
      "completed_at": "...",
      "exit_code": 0,
      "stdout_doc_key": "forge.step-2-bulk-accept.stdout.txt",
      "parsed": null
    },
    {
      "step": 3,
      "command": "truth:synthesize-claims",
      "args": { "run": 3, "mode": "standard", "model": "gpt-5.4-mini" },
      "exit_code": 0,
      "stdout_doc_key": "forge.step-3-claims.stdout.txt",
      "parsed": {
        "synthesis_run_id": 7,
        "tokens_in": 12450,
        "tokens_out": 2034,
        "claims_persisted": 31,
        "claims_rejected": 4,
        "group_distribution": { "problem": 8, "constraint": 6, "opportunity": 9 }
      }
    },
    {
      "step": 4,
      "command": "truth:review-claims (interactive, human)",
      "gate": "claim_review",
      "mode": "manual_attestation",
      "operator": "david@mojosolo.com",
      "attested_at": "2026-04-22T22:45:00Z",
      "note": "reviewed 31 claims in proposal-forge CLI; accepted as-is"
    },
    {
      "step": 5,
      "command": "truth:synthesize-brief",
      "args": { "run": 3, "title": "Liberty — executive brief v1" },
      "exit_code": 0,
      "stdout_doc_key": "forge.step-5-brief.stdout.txt",
      "parsed": {
        "brief_id": 2,
        "brief_version": 1,
        "brief_status": "needs_review",
        "brief_payload_hash": "e3b0c442...",
        "synthesis_input_hash": "8f2a1b9c...",
        "section_counts": {
          "problem": [5, 5],
          "constraint": [5, 5],
          "opportunity": [5, 5],
          "pilot": [3, 3],
          "problem_statement": [1, 1],
          "buyer_value_narrative": [1, 1]
        }
      }
    },
    {
      "step": 6,
      "command": "truth:freeze-export",
      "args": { "run": 3, "brief": 2, "formats": ["executive_brief_yaml", "claims_json"] },
      "exit_code": 0,
      "stdout_doc_key": "forge.step-6-freeze.stdout.txt",
      "parsed": {
        "gate_verdict": "PASS",
        "gates": [
          { "gate": 1, "name": "atom_evidence_binding", "status": "PASS", "findings": [] },
          { "gate": 2, "name": "claim_source_atoms", "status": "PASS", "findings": [] },
          { "gate": 3, "name": "brief_claim_binding", "status": "PASS", "findings": [] },
          { "gate": 4, "name": "payload_hash_consistency", "status": "PASS", "findings": [] },
          { "gate": 5, "name": "supersession_integrity", "status": "PASS", "findings": [] },
          { "gate": 6, "name": "export_byte_verifiability", "status": "PASS", "findings": [] }
        ],
        "exports": [
          { "export_id": 3, "format": "executive_brief_yaml", "version": 1, "sha256": "...", "bytes": 4821 },
          { "export_id": 4, "format": "claims_json", "version": 1, "sha256": "...", "bytes": 11204 }
        ]
      }
    }
  ],
  "archival_complete": true,
  "buyer_facing_complete": false,
  "buyer_facing_unsupported_reason": "truth:review-brief does not exist in proposal-forge; wait for filing + command authoring."
}
```

### Invariants the receipt must satisfy

1. Steps appear in strictly increasing order of `step`.
2. An exit-non-zero step blocks later steps; the receipt records the failure
   and the chain halts.
3. Manual-attestation steps carry an `operator` identity and `attested_at`;
   they do **not** carry `exit_code` or `stdout_doc_key`.
4. `archival_complete = true` requires steps 1, 3, 5, 6 all present with
   `exit_code = 0` (or step 2/4 attestation equivalents).
5. `buyer_facing_complete` is always `false` under this binding. Do not set
   it to `true`. If a post-filing `truth:review-brief` lands, a new receipt
   version will describe how to set it.

## Parse contract

Known line regexes, versioned with `skill_version`. Breakage means the
binding must be reviewed, not silently auto-corrected.

| Step | Regex | Captures |
|------|-------|----------|
| 1 | `/truth_run #(\d+) imported:/` | `run_id` |
| 3 | `/synthesis_run #(\d+) · status=(\S+) · tokens (\d+) in \/ (\d+) out/` | `synthesis_run_id`, `status`, `tokens_in`, `tokens_out` |
| 3 | `/claims: (\d+) emitted by model · (\d+) passed verifier · (\d+) persisted · (\d+) rejected/` | counts |
| 5 | `/brief #(\d+) \(v(\d+)\) created · status=(\S+) · tokens (\d+) in \/ (\d+) out/` | brief id + version + status + tokens |
| 5 | `/brief_payload_hash: (\w+)/` | `brief_payload_hash` |
| 5 | `/synthesis_run #\d+ · input_hash: (\w+)/` | `synthesis_input_hash` |
| 6 | `/release gate verdict: (\S+)/` | `gate_verdict` |
| 6 | `/gate (\d+) · (\S[^·]*?)\s+(PASS\|WARN\|FAIL)/` | per-gate: `gate`, `name`, `status` |
| 6 | `/\[(\w+)\] (\S+) · (.*)$/` | per-gate finding: `severity`, `code`, `message` |
| 6 | `/export #(\d+) · format=(\S+) v(\d+) · sha256=(\w+) · (\d+) bytes/` | `export_id`, `format`, `version`, `sha256`, `bytes` |

Test these against the stdout produced by `truth:*` in the current
`proposal-forge` checkout before relying on them. The regexes are pinned to
`proposal-forge@93456af` command output.

## Failure modes

- **Missing env:** `PAPERCLIP_TRUTH_FORGE_PATH` unset or not a directory →
  fail with a clear error; do not guess.
- **Missing artisan:** `$FORGE/artisan` not executable → same.
- **Command not found:** `truth:*` signature absent → record
  `proposal-forge` HEAD sha in the error; the binding is pinned to an
  observed command set.
- **Parse miss:** a known line not found in stdout → record raw stdout in the
  receipt step, set `parsed: null`, and halt. Do not fall back to heuristics.
- **Human gate skipped:** no `manual_attestation` record present before the
  next automated step → block and surface the missing gate.

## Non-goals

- Not a replacement for `proposal-forge`. Paperclip does not store claims,
  briefs, or exports as first-class entities. Those live in `proposal-forge`'s
  database.
- Not a buyer-facing delivery surface. See "Buyer-facing completion —
  unsupported" above.
- Not an override surface. `truth:freeze-export --force-override` is operator
  work, not plugin work.
