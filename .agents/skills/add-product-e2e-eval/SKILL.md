---
name: add-product-e2e-eval
description: Add or extend a Paperclip full-stack runner E2E workflow, fixture, matcher, or report evidence path for local or Daytona execution.
---

# Add a Product E2E Eval

Use this skill for **Product E2E Evals**: real Chromium, Paperclip server,
database, runner, provider, and optionally Daytona. Everyday Workflows are in
this family even when their packaged results are imported into Evalbook. Runner
protocol cases against the mock control plane belong in
[add-runner-eval](../add-runner-eval/SKILL.md).

Locate the repository using `PAPERCLIP_ROOT` when supplied, or
`git rev-parse --show-toplevel` from a checkout. From outside Git, inspect
workspace roots such as `~/paperclipai/paperclip`; verify the selected root
contains `tests/runner-e2e` and `packages/paperclip-runner`. Run commands from
that repository root. The copied skill may live outside the checkout.
Read `doc/evals.md`, then the authoritative
`tests/runner-e2e/README.md`, `FIXTURES.md`, `SECURITY.md`, and
`EVERYDAY-WORKFLOWS.md` for the selected area. Inspect the nearest existing
catalog entry, case, harness flow, matcher, evidence writer, and report test
before changing anything. Keep the user journey on production browser/API
surfaces; do not add private runner hooks or direct fixture database writes.

Define one bounded workflow with a clear user outcome, durable state
assertions, and independent evidence. Declare profile, environment, expected
provider turns, timeout, cleanup, screenshots, artifact checks, and billing
scope. Keep credentials and secrets out of catalog data, screenshots, fixture
metadata, logs, and tracked files. Daytona images must be immutable digest
references. Use the existing result validator, failure classifier, screenshot
policy, and Product E2E report pipeline rather than duplicating them.

Register the workflow in `tests/runner-e2e/catalog.ts` and the relevant
`fixture-registry.ts` paths. Everyday cases and actions live in
`everyday-cases.ts` and `everyday-flow.ts`; match the existing suite's structure.
Wire its
profile/environment/case IDs through existing selector and matcher tables, and
add report/catalog coverage tests where the surrounding suite does so. Calibrate
new grading assertions with a valid outcome and a plausible wrong outcome;
missing evidence must not produce a pass. Confirm
discovery before running it:

```sh
pnpm test:e2e:runner -- --list --suite <suite-name>
pnpm test:e2e:runner -- --list --suite everyday-workflows
```

`--all` intentionally excludes the manual `everyday-workflows` suite and other
explicit-only cells. Use the exact suite or execution ID for those. The Product
E2E generator is `pnpm test:e2e:runner:report`; an Everyday Workflows result may
also be imported into Evalbook with its canonical importer, but it remains a
Product E2E run and should use its packaged dashboard/report first.

Run credential-free checks first:

```sh
pnpm test:e2e:runner:typecheck
pnpm test:e2e:runner:unit
pnpm test:e2e:runner -- --list
```

For an authorized live check, use the smallest explicit local `--id` selector.
Select Daytona only with the configured immutable image and credentials. A
full `--all` campaign is paid and is for the governed workflow. Verify results
from the packaged attempt evidence and dashboard; passing model-authored tests
cannot override the independent oracle.

Classify a completed wrong workflow as product or model/provider behavior as
the assertions warrant. Startup, transport, and timeout symptoms require
evidence-based attribution: they may indicate a Paperclip/Runner product bug,
provider behavior, or infrastructure. Preserve the observed failure and cause
separately, keep the existing machine grade/classifier unchanged, and retain
partial attempts, retries, source SHA, catalog/definition digest, model/profile,
environment, grader version, timing, tokens, runtime estimates, and cost
coverage. Do not claim qualification from a partial/manual selection.

Update `README.md`, `FIXTURES.md`, `SECURITY.md`, or
`EVERYDAY-WORKFLOWS.md` when their authoritative contract changes, and link
from `doc/evals.md`. Do not recreate Evalbook HTML or publish raw trusted
traces, videos, archives, databases, workspaces, credentials, SVG, provider
session IDs, or hidden reasoning. Public sanitized fixture conversation, marked
screenshots, and allowlisted structured evidence are expected when the existing
publisher permits them.
