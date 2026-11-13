---
name: paperclip-evals
description: Choose, inspect, validate, and report Paperclip Runner or Product E2E evaluations while preserving evidence, provenance, cost, and failure classification.
---

# Paperclip evals

Use this skill when a request concerns Paperclip evaluation selection,
interpretation, evidence, history, or a live run. Read `doc/evals.md` in the
Paperclip repository first. It defines the two families and their boundaries.

## Discover the repository

Do not assume the skill's installed location is inside a checkout. Locate the
repo explicitly with `git rev-parse --show-toplevel` from the current directory,
or inspect likely workspace roots and select the checkout containing
`package.json`, `tests/runner-e2e`, and `packages/paperclip-runner`. Locate the
private sibling `paperclip-evals` only when a Runner Eval needs its definitions;
use an explicit `PAPERCLIP_EVALS_ROOT` or a discovered sibling checkout. Never
invent a relative path from this copied skill into the repository.

## Route the request

Choose **Runner Evals** for real runner/provider protocol behavior against the
mock control plane. Authoritative details are in
`packages/paperclip-runner/docs/runner-protocol-live-evals.md` and the sibling
`paperclip-evals/evals/paperclip-runner` definitions.

Choose **Product E2E Evals** for real browser/server/database/runner/provider
workflows, including local and Daytona environments. Read
`tests/runner-e2e/README.md`, then `FIXTURES.md`, `SECURITY.md`, or
`EVERYDAY-WORKFLOWS.md` as relevant. Everyday Workflows remain Product E2E
even when imported into Evalbook. “Headless” is a browser mode, not a family.

## Work safely

Start with read-only catalog inspection and credential-free validation. For
Product E2E use `pnpm test:e2e:runner:typecheck`,
`pnpm test:e2e:runner:unit`, and `pnpm test:e2e:runner -- --list`; run one
explicit cell only when the user has authorized a live/paid run and the needed
credentials and immutable Daytona image are configured. For Runner Evals use
the pinned eval revision and the documented workflow/CLI. Never use a partial
selector as evidence of full coverage.

Keep source revisions, definition/catalog fingerprints, model/profile,
environment, selected cells, retries, timing, usage/cost coverage, and grader
version attached to every interpretation. Preserve partial attempts and
classify failures as product, model/provider behavior, grading/evidence, or
infrastructure from the observed failure and supported cause. A usable
completed behavior failure is not infrastructure; missing provider/profile,
transport, startup, or evidence requires examining the evidence before choosing
the cause.

Use the existing family generator and viewer. Public projections may contain
sanitized fixture conversation and allowlisted tool outcomes/evidence; follow
the family's projection and publisher checks. Do not expose raw trusted
artifacts, credentials, secrets, private data, provider session IDs, or hidden
reasoning. A refresh from retained evidence has zero provider calls and remains
the original measurement with a new presentation. Link the public histories
and hub from `doc/evals.md` when reporting results.

For adding a case or fixture, use the narrower [add-runner-eval](../add-runner-eval/SKILL.md)
or [add-product-e2e-eval](../add-product-e2e-eval/SKILL.md) skill.
