# Closure-gate runbook

The closure-gate is the safety net that guards every `PATCH /api/issues/:id`
request which transitions an issue into a closed status (`done` or
`cancelled`). It is the only enforcement point that stands between an agent
attaching a `Fix-SHA` to a closure comment and that comment hitting the issue
thread with a fabricated upstream commit hash on it.

Source of truth: `server/src/services/closure-gate.ts`. The gate is wired
into the PATCH route handler at `server/src/routes/issues.ts` (immediately
after the cheap-recovery assign-profile guard and before the execution-policy
transition), so it runs on every status change to `done`/`cancelled` that is
accompanied by a closure comment.

## What the gate checks

For every closure transition, the gate inspects:

1. The closure `comment` body from the request.
2. The issue `title` from the persisted record (the `existing` row).
3. The issue `description` from the persisted record.
4. An optional `knownUpstreamShas` list — the set of SHAs that have been
   verified as reachable on the upstream default branch. Today this is
   supplied as an empty array by the route; the SHA-verification step is a
   planned follow-up that will call `git` on the upstream monorepo and feed
   the reachable set here.

## Verdict shape

`evaluateClosureGate` returns a discriminated union:

| Verdict                                          | Meaning                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `{ ok: true, reason: "valid_fix_sha" }`          | The comment contains one or more `Fix-SHA: <sha>` lines, every SHA is in `knownUpstreamShas`. |
| `{ ok: true, reason: "no_code_escape_hatch", kind }` | No falsifiable `Fix-SHA` (≥10 chars) in the comment, but the issue is on the no-code allowlist (title prefix `[UI]`/`[DATA]`/`[GAP]`/`[NO-CODE]`, or `Kind:` line in the description). Short-prefix-only Fix-SHA fragments are also accepted when the issue is on the no-code allowlist. |
| `{ ok: false, signal: "Signal A (Fabricated SHA)", details }` | Comment has a `Fix-SHA` reference (≥10 chars) that is not in `knownUpstreamShas`. Throws `unprocessable(422)` with `code: "closure_gate_blocked"`. Short prefixes that appear alongside the fabricated SHA are surfaced in `details.shortPrefixes` for visibility. |
| `{ ok: false, signal: "Signal D (Ambiguous Short Prefix)", details }` | Comment contains only `Fix-SHA` fragments shorter than the 10-character safety floor, and the issue is **not** on the no-code allowlist. The closure is rejected with `closure_gate_blocked`, but the signal is **not** a fabrication accusation — short prefixes are too collision-prone to verify against the upstream monorepo. The board is asked to provide the full 40-character SHA or a longer unambiguous prefix. |
| `{ ok: false, signal: "Signal A (Fabricated SHA)", details }` (no Fix-SHA path) | No `Fix-SHA` in the comment and the issue is not on the no-code allowlist. Throws `unprocessable(422)` with `code: "closure_gate_blocked"`. |

There is no `Signal B` failure path today. The `CLOSURE_GATE_SIGNAL.MissingMarker` constant
is reserved for a future revision that distinguishes "board-only data op with
no marker at all" from "code-bearing fix with a fabricated SHA".

## The no-code escape hatch

Board-only data operations — Secrets Vault placeholders, configuration
changes, UI affordances, pipeline fixture edits — frequently have no
issue-specific commit. Without an escape hatch, those issues would loop on
the original `Signal A (Fabricated SHA)` rejection forever, because the only
SHA available is the upstream default-branch anchor.

The escape hatch lets those issues close cleanly when **both** of the
following hold:

1. The closure comment does **not** contain a `Fix-SHA: <sha>` line (the
   normal code-bearing path is unaffected).
2. The issue is on the no-code allowlist. An issue qualifies if **any** of
   the following is true:
   - Its `title` starts with one of the documented prefixes:
     `[UI]`, `[DATA]`, `[GAP]`, `[NO-CODE]`.
   - Its `description` declares the kind via a line of the form
     `Kind: no-code`, `Kind: data-only`, or `Kind: ui-only`.

`Kind:` declarations in the **description** are the canonical form — they
survive title renames. The title prefix allowlist is the ergonomic
shortcut that lets board users tag a no-code issue by naming convention.

### Authoring a no-code closure comment

For a `[DATA]` issue titled `[DATA] Rotate Stripe webhook secret`, an
acceptable closure comment is:

```
Rotated the webhook secret in the Secrets Vault and confirmed the
new secret is delivered via Secrets Vault placeholders to the
relevant runtimes.

Kind: no-code
```

The `Kind: no-code` line on its own is sufficient when the issue title
already starts with `[DATA]` (or any other prefix in the allowlist) and the
description also carries `Kind: data-only` for redundancy.

For an issue without a title prefix, the description **must** carry the
`Kind:` declaration. Closure comments on a code-bearing issue that lack a
`Fix-SHA` will continue to be rejected with `Signal A`.

## Short-prefix safety

The closure comment `Fix-SHA:` parser accepts fragments of 7–64 hex
characters, but the verdict logic only treats a fragment as a falsifiable
upstream commit hash when it is at least
`CLOSURE_GATE_MIN_FIX_SHA_PREFIX_LENGTH` (10) characters long. Anything
shorter is too collision-prone to verify against the upstream monorepo —
seven-character prefixes collide routinely in real git histories, and even
eight-/nine-character prefixes share enough prefix space across large
monorepos that a single SHA can be ambiguous.

The verdict logic partitions the extracted `Fix-SHA` fragments into two
buckets before deciding:

- `longShas` (≥10 chars): the only fragments that can trigger
  `Signal A (Fabricated SHA)`. They are checked against
  `knownUpstreamShas`.
- `shortPrefixes` (<10 chars): surfaced as
  `Signal D (Ambiguous Short Prefix)` when the issue is **not** on the
  no-code allowlist. They never trigger `Signal A` on their own.

### Why short prefixes never signal fabrication

`Signal A` is specifically "the closure claims a code-bearing fix pointed at
SHA X, but X is not reachable on the upstream default branch." A 7- or
8-character hex fragment is not a falsifiable claim about a specific
upstream commit — it is too collision-prone to even identify. Treating a
short prefix as evidence of fabrication produced false-positive rejections
on closures that referenced real fixes by short prefix (a common practice
when copying commit refs from `git log` one-liners).

`Signal D` preserves the rejection (the closure cannot be verified!) while
making the failure mode honest: "the SHA you provided is too short for me
to verify — please supply the full 40-character SHA or a longer
unambiguous prefix."

### Short prefixes + no-code allowlist

When a closure comment contains only short-prefix `Fix-SHA` fragments and
the issue is on the no-code allowlist (title prefix or `Kind:` line), the
gate accepts the closure via the no-code escape hatch. The short prefix
is treated as incidental noise, not a falsifiable SHA claim. This avoids
double-rejecting legitimate board-only closures where the agent happened
to include a short commit reference from a related worktree.

### Mixing short and long prefixes

When a closure comment contains both short and long `Fix-SHA` fragments:

- The long fragments are checked against `knownUpstreamShas`. If any
  fabricated long SHA is found, the verdict is `Signal A` with the
  short fragments surfaced in `details.shortPrefixes` for visibility.
- If all long fragments resolve, the verdict is `valid_fix_sha` —
  short prefixes never downgrade an accepted closure.

## Signaling convention

## Signaling convention

`CLOSURE_GATE_KIND_TOKENS` (the recognized kind tokens) is exported for
agents and UI surfaces to share. Adding a new kind requires a coordinated
edit of:

1. `CLOSURE_GATE_KIND_TOKENS` in `server/src/services/closure-gate.ts`.
2. The matching title prefix in `CLOSURE_GATE_TITLE_PREFIX_ALLOWLIST` if
   the new kind has a conventional title tag.
3. This runbook.

There is no per-company allowlist yet — the kind set is global. A future
revision may source the allowlist from a per-company configuration table;
for now it is derived from issue metadata to keep the surface area small.

## Audit trail

When the gate accepts a closure via the no-code escape hatch, the route
emits an activity-log entry:

```json
{
  "action": "issue.closure_gate.escape_hatch",
  "entityType": "issue",
  "entityId": "<issue-uuid>",
  "details": {
    "kind": "no-code",
    "requestedStatus": "done",
    "source": "PATCH /api/issues/:id"
  }
}
```

`valid_fix_sha` closures do not currently emit a dedicated activity entry
beyond the standard issue-update log; the `Fix-SHA` lines remain on the
comment body for downstream audit.

## Authoring a `request_confirmation` for a no-code issue

When the agent needs board sign-off before closing a no-code issue, the
`request_confirmation` interaction should call out the escape hatch in the
decision copy so the board understands what they are approving. Suggested
wording for the `summary` field:

> "Approve closing this `[DATA]` issue via the no-code escape hatch. No
> upstream commit is associated with the change."

And the `detailsMarkdown` should reference this runbook by path so the
reviewer can verify the marker convention. The gate does not inspect the
interaction payload — it only fires on the eventual closure comment —
but referencing the escape hatch up front removes ambiguity on the
reviewer side and prevents re-runs of "why is there no `Fix-SHA`?"

## Known limitations

- `knownUpstreamShas` is always empty today. Any `Fix-SHA:` comment will be
  rejected with `Signal A (Fabricated SHA)` until the SHA-verification
  follow-up lands. Plan accordingly: prefer the no-code escape hatch on
  issues that genuinely do not have an upstream commit, and rely on the
  hash-verification path only for code-bearing fixes after the follow-up
  is in place.
- The gate is intentionally conservative — it inspects only the closure
  comment text, never the title. Comments that contradict the title
  (e.g. `[DATA] Rotate secret` closed with a `Fix-SHA:` line) are accepted
  on the `Fix-SHA` path and would only be caught once the SHA-verification
  follow-up rejects the fabricated hash.