---
name: add-runner-eval
description: Add or extend a Paperclip Runner protocol evaluation definition, roster, assertion, or report fixture with provenance and narrow validation.
---

# Add a Runner Eval

Use this skill for the **Runner Evals** family: a real Runner/provider session
against a seeded mock control plane. Product browser/server/database/Daytona
coverage belongs in [add-product-e2e-eval](../add-product-e2e-eval/SKILL.md).

Locate the Paperclip checkout using `PAPERCLIP_ROOT` when supplied, or
`git rev-parse --show-toplevel` from a checkout. From outside Git, inspect the
workspace roots (for example `~/paperclipai/paperclip`) and verify that the
selected root contains `packages/paperclip-runner` and `tests/runner-e2e`.
Locate `paperclip-evals` using `PAPERCLIP_EVALS_ROOT` or a discovered sibling;
a worktree's parent directory need not contain that repository. Read
`doc/evals.md` and `packages/paperclip-runner/docs/runner-protocol-live-evals.md`,
then inspect the nearest existing case, roster, schema, and report test before
editing. Definitions and authored cases belong in the sibling
`paperclip-evals/evals/paperclip-runner`; Runner integration, aggregation,
viewer, and publication behavior belongs in `packages/paperclip-runner`.
Keep the control-plane boundary explicit in names and documentation.

The sibling eval README is the concrete map: cases live under `cases/`,
company fixtures under `fixtures/`, runtime/model settings under `configs/`,
selections under `rosters/`, and maintained campaign membership under
`campaigns/live-direct-full.json`. Update inventory/coverage mappings when the
program requires them; a new file alone does not join the maintained campaign.
From the Evals repository root, adapt these provider-free checks to the case
and roster you changed. Run the reliability-plan validator only when that
separate plan changes:

```sh
python3 evals/paperclip-runner/tools/eval_program.py validate \
  --case evals/paperclip-runner/cases/get-task-context.json \
  --config evals/paperclip-runner/configs/live-codex-pinned.json
python3 evals/paperclip-runner/tools/run_live_roster.py validate \
  --roster evals/paperclip-runner/rosters/live-mini.json --run-id validate-new-case
python3 evals/paperclip-runner/tools/run_live_campaign.py validate \
  --campaign evals/paperclip-runner/campaigns/live-direct-full.json
python3 evals/paperclip-runner/tools/reliability_campaign.py validate \
  --plan evals/paperclip-runner/campaigns/paperclip-runner-reliability.json
```

Use nearby positive and negative grader cases/fixtures to calibrate the new
assertion, including malformed or missing evidence where the grader must fail
closed. Preserve the existing machine disposition and grade; product,
model/provider, grading, and infrastructure labels are analytical annotations,
not instructions to rewrite classifiers.

Author one bounded case with a deterministic semantic assertion and an
inspectable result. Declare its expected operation, state effect, provider
lane/profile, timeout and retry policy, and any required evidence. Do not grade
hidden reasoning, infer success from a provider terminal message, or invent
conversation/tool evidence. Public output follows the reviewed projection:
sanitized fixture conversation and allowlisted tool outcomes may be published;
raw trusted artifacts, credentials, secrets, private references, and hidden
reasoning may not.

Validate without provider calls first using the commands above and the relevant
report/render validation documented in the Runner docs. When a live run is
authorized, pin the Paperclip commit and exact 40-character
`paperclip-evals` commit, select the smallest useful roster, and retain the
complete provenance and cost record.

Update authoritative detailed docs when the contract or command changes, then
link from `doc/evals.md` rather than duplicating the Runner runbook. Keep public
reports immutable and use the reviewed projection; sanitized fixture
conversation and allowlisted tool outcomes may be public, while credentials,
secrets, private references, raw trusted payloads, and hidden reasoning must not
be exposed.
