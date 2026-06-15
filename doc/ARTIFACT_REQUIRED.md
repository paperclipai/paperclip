# `artifact_required` — close-gate metadata declaration

## What it is

A machine-readable declaration on an issue that the server uses to refuse a
status transition to `done` until a named artifact is supplied. Authors mark
the gate in the issue **description**; agents or humans clear it by posting a
**comment** that carries the artifact value.

The gate is enforced in `server/src/services/issues.ts` inside
`issueService.update()` at the same point where status transitions are
validated. It applies symmetrically to all callers (REST `PATCH /issues/:id`,
plugin updates, internal services).

## Declaration shape

In the issue description:

```
artifact_required: <key>
```

Parsing rules:

- The keyword is **case-insensitive** (`artifact_required`, `Artifact_Required`,
  etc.).
- The key after the colon is **case-sensitive at match time** — store it
  lowercase.
- The key must match `[a-z][a-z0-9_]*` (snake_case starting with a letter).
- Leading whitespace, markdown blockquote `>`, and list markers (`-`, `*`) are
  tolerated.
- The declaration is recognized inside fenced code blocks as well as plain
  body text — the parser does not strip fences. This is intentional: BEAAA-5440
  declares its own gate inside a code fence for emphasis, and that form must
  work.
- Multiple declarations are allowed; duplicates are folded.

## Satisfaction

A declared key is **satisfied** when at least one non-deleted comment on the
same issue contains the pattern `<key>: <non-empty value>` (matched
case-insensitively, value must contain at least one non-whitespace character).
Surrounding text is freeform — a line, a sentence, or a code fence are all
acceptable carriers.

A comment whose body is itself another `artifact_required: <key>` line does
**not** clear the gate. The declaration describes the requirement; only a
delivered `<key>: <value>` clears it.

## Enforcement

- On `status` → `done`:
  - The issue's own `artifact_required` declarations are checked against its
    comment history. Unsatisfied declarations block the transition.
  - For a **parent** issue, every still-open child (status not in `done`,
    `cancelled`) is checked the same way. Any child with an unsatisfied gate
    blocks the parent transition — this is the cascade-close guard from
    BEAAA-5287.
  - Already-closed children (`done` or `cancelled`) are **not** re-validated.
    Their close was gated when it happened; this rule is "no retroactive
    enforcement."
- On `status` → `cancelled`: **not gated**. Cancellation is an explicit
  operator decision to abandon the work; gating it would trap genuinely
  abandoned tickets.
- On any other transition: not gated.

## Error shape

A blocked transition raises HTTP 422 with body:

```json
{
  "error": "Cannot transition issue to done: artifact_required gate failed — BEAAA-5440 requires [merged_sha_on_canon_master_at_close]",
  "details": {
    "code": "ARTIFACT_REQUIRED_MISSING",
    "missingArtifacts": [
      {
        "issueId": "…",
        "issueIdentifier": "BEAAA-5440",
        "missingKeys": ["merged_sha_on_canon_master_at_close"]
      }
    ]
  }
}
```

Agents that receive this should either (a) post a comment supplying the
artifact and retry, (b) remove the `artifact_required` declaration from the
description (requires the same authority that added it), or (c) cancel the
issue instead.

## Worked example — `merged_sha_on_canon_master_at_close`

The Backbond CTO's standing rule from BEAAA-5288 is that every code-commit
ticket must cite the merged SHA at close. To enforce this, the ticket carries:

```
artifact_required: merged_sha_on_canon_master_at_close
```

To close it, the closing agent posts a comment such as:

```
Landed on canon master. merged_sha_on_canon_master_at_close: 1a2b3c4d5e6f7890
```

The gate then clears.

## Out of scope

- Detection of declarations not encoded as `artifact_required: <key>` lines —
  e.g. structured database fields, attached YAML, or work-product file
  contents.
- Retroactive enforcement on already-closed children when a parent transitions
  to done.
- Validation of the **value** beyond non-emptiness. Format checks (e.g. the
  shape of a git SHA) are out of scope for v0.1 — a future revision could
  register per-key validators.

## Implementation references

- Service guard: `server/src/services/issues.ts` — search for
  `assertArtifactRequiredSatisfiedOnDone`.
- Pure-function parsers: `parseArtifactRequiredKeys`,
  `findUnsatisfiedArtifactKeys` exported from the same file.
- Tests: `server/src/__tests__/issue-artifact-required-gate.test.ts`.
