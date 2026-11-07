# Code Review Governance

Reusable review-process artefacts for Paperclip (engineering operating model).

These sit beside the author-facing [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)
and the contributor rules in [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Use them
on every non-trivial pull request before merge.

## Templates

| Artefact | Path | When to use |
|---|---|---|
| Code review checklist | [`code-review-checklist.md`](code-review-checklist.md) | Every PR that changes runtime behaviour, schema/API, auth, data, or release tooling; recommended for substantial docs too |

## Author vs reviewer

```text
Author
  → Fill .github/PULL_REQUEST_TEMPLATE.md completely
  → CI / Commitperclip quality gates must pass (required PR sections)

Reviewer (Code Reviewer or human maintainer)
  → Walk doc/reviews/code-review-checklist.md
  → Match approvals to change class (low / medium / high)
  → Record blocking notes or approve

Release (after merge)
  → Release Engineer uses release readiness artefacts when deploying
```

## Branch protection and review expectations

Documented expectations for `master` (and protected release branches). Exact
GitHub branch-protection settings are owned by maintainers; this section is the
engineering contract contributors and agents must satisfy before merge.

1. **PR template** — Description must follow [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md). Required sections are enforced by Commitperclip / quality gates (`.github/scripts/check-pr-template.mjs`).
2. **CI gates** — Paperclip CI (lint, typecheck, tests, build, and other required checks) must be green. Do not request merge on red gates.
3. **Automated review** — Greptile must be **5/5** with no open P2+, recommendations, or follow-ups (`CONTRIBUTING.md`).
4. **Human / Code Reviewer checklist** — Reviewer walks [`code-review-checklist.md`](code-review-checklist.md) and applies the change-class gate table.
5. **CODEOWNERS** — Paths listed in [`.github/CODEOWNERS`](../../.github/CODEOWNERS) (release infra, dependency manifests, skills) require review from the named owners when those files change.
6. **High-risk changes** — Auth, payments, data migrations, and external contracts need two approvals (Reviewer + Lead or CTO), a security pass on the checklist, and an attached rollback plan. Risk-tier label automation is a separate follow-up.

### Merge rule

If a material checklist item is unchecked and has no documented exception, do
not approve. Prefer request-changes over silent waive.

## Related docs

- [Contributing Guide](../../CONTRIBUTING.md)
- [PR template](../../.github/PULL_REQUEST_TEMPLATE.md)
- [CODEOWNERS](../../.github/CODEOWNERS)
- [Release Checklist](../RELEASE-CHECKLIST.md)
- [Untrusted PR Review](../UNTRUSTED-PR-REVIEW.md)
