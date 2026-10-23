# Risk-tier labels and approval rules

Engineering operating-model automation for change-class (risk) gates.

This document is the source of truth for **risk-tier classification**, **GitHub
labels**, **required approvals**, and the **Commitperclip CI checks** that
block high-risk merges when the rollback plan artifact is missing.

Sibling review artefacts (PR template + human checklist) are owned separately;
this file must not depend on unmerged PR-template edits.

## Labels

Apply **exactly one** label on every pull request:

| Label | Change class | Typical scope |
|---|---|---|
| `risk:low` | Low | Docs, non-runtime tooling, comment/typo fixes |
| `risk:medium` | Medium | Business logic, internal APIs, UI behaviour |
| `risk:high` | High | Auth, payments/billing, data migrations, external contracts, release infra |

Alias forms accepted by CI (prefer the colon form above): `risk-low`,
`risk-medium`, `risk-high`.

If labels are not yet available in the repository, declare the tier in the PR
body instead:

```text
Risk tier: medium
```

CI prefers labels and will post an informational note when only the body form
is present.

### Creating labels (maintainer / Release Engineer)

Create these labels in GitHub (Settings → Labels) or via API:

| Name | Colour (suggested) | Description |
|---|---|---|
| `risk:low` | `0E8A16` | Low-risk change — 1 reviewer + CI |
| `risk:medium` | `FBCA04` | Medium-risk — reviewer + Lead Engineer + CI/tests |
| `risk:high` | `D93F0B` | High-risk — 2 approvals + rollback plan + security pass |

A machine-readable copy lives in [`.github/labels.yml`](../../.github/labels.yml)
for future label-sync tooling. Creating labels in GitHub is still a manual
Release Engineer / maintainer step until sync is wired.

## Approval matrix (code gate)

Aligned with the engineering operating model code gate:

| Tier | Required before merge |
|---|---|
| **Low** | 1 reviewer approval + CI green |
| **Medium** | 1 reviewer + Lead Engineer approval + CI + tests covering changed behaviour |
| **High** | 2 approvals (Reviewer + Lead or CTO) + security checklist pass + **rollback plan attached** |

Branch-protection settings that enforce reviewer counts remain a maintainer
responsibility. Commitperclip **documents** the required approvals on every PR
and **hard-fails** high-risk PRs that lack a rollback plan.

## Rollback plan artifact (high risk)

High-risk PRs must include **one** of:

1. A `## Rollback Plan` section (≥40 characters of real content after HTML
   comments are stripped), or
2. Under `## Risks`, an affirmative **rollback plan** with concrete steps or a
   durable link (e.g. `Rollback plan: …`, ≥20 characters of substance after the
   separator).

Checkbox-only items, negation prose (“No rollback plan is needed…”), empty
placeholders, and HTML comment hints alone do not count.

## CI enforcement

Gate script: [`.github/scripts/check-pr-risk-tier.mjs`](../../.github/scripts/check-pr-risk-tier.mjs)

Wired into Commitperclip quality gates via
[`.github/scripts/run-quality-gates.mjs`](../../.github/scripts/run-quality-gates.mjs).

Behaviour:

1. **Fail** if no risk tier is declared (label or body).
2. **Fail** if multiple conflicting risk-tier labels are present.
3. **Fail** if label and body declarations disagree.
4. **Fail** if tier is high and no rollback plan artifact is present.
5. **Inform** with the approval matrix for the declared tier.
6. **Inform** when changed paths look higher-risk than the declared tier
   (heuristic; does not auto-fail).

Path heuristics that suggest elevated risk (non-exhaustive):

- **High:** `packages/db/src/migrations/**`, auth/payment/billing paths,
  release workflows
- **Medium:** `packages/db/src/schema/**`, shared validators/types,
  `server/src/routes|services/**`, adapters

## Author workflow

1. Classify the change using the table above.
2. Apply the matching `risk:*` label (or declare `Risk tier:` in the body).
3. For high risk, write the rollback plan before requesting review.
4. Request the approvals required by the matrix.
5. Keep CI / Commitperclip green.

## Reviewer workflow

1. Confirm the declared tier matches the diff.
2. Walk the code-review checklist when that artefact is present.
3. Do not approve high-risk PRs without a plausible rollback plan.
4. For medium/high, confirm Lead / CTO approval expectations are met before
   merge.

## Related

- [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)
- [CONTRIBUTING.md](../../CONTRIBUTING.md)
- [CODEOWNERS](../../.github/CODEOWNERS)
- [Release checklist](../RELEASE-CHECKLIST.md)

<!-- Release note: PR dedup-search checkbox checked after Commitperclip gate (PSVA-1551). -->
<!-- Release note: PR body linked-issue fields filled for Commitperclip gate (PSVA-1524). -->
<!-- Release note: PR retitled feat(ci) after ci: prefix rejected source changes (PSVA-1551). -->
