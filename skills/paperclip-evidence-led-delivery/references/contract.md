# Delivery contract

Fill the relevant fields in the existing Paperclip plan. Keep a small fix small.
Mark an inapplicable section with a reason; do not create placeholder artefacts.

## Intent and authority

- User request and current authorisation, with source/date:
- Current observed behaviour and evidence:
- Expected user benefit; exclusions:
- Owner, reviewers, workspace, branch/commit and dirty-file hashes:
- Policy digest, skill version and upstream pins:
- Release/contact/spend/data restrictions; any specifically authorised change:

## Requirements and acceptance

| ID | Prioritised user journey / requirement | Given / when / then, including failure paths | Verification artefact |
| --- | --- | --- | --- |

Requirements describe observable behaviour, not just implementation steps.

## Decisions and readiness

| Decision | Existing mechanism and real alternatives | Evidence, recommendation and counter-argument | Owner, outcome, deadline, reopen condition |
| --- | --- | --- | --- |

Ready means the next bounded task has adequate inputs, acceptance criteria,
authority and resolved dependencies. It does not mean every future unknown is
settled. Block only dependent work; continue useful independent work.

## Plan and task mapping

| Requirement IDs | Smallest change / reused mechanism | Owner and workspace | Blocker issue IDs | Verification |
| --- | --- | --- | --- | --- |

Include migration, rollback, privacy, security, accessibility and performance
work when affected. Keep the repo's own toolchain and checks.

## Experiment, when a benefit is being claimed

- Frozen incumbent, dataset/input lineage and held-out split:
- Hypothesis, primary quality measure and material benefit threshold:
- Non-regressions and failure/stop conditions:
- Time/trial budget, maximum three candidate trials by default:
- Runtime/hardware/model/instruction/tool configuration:
- Per-trial result, sample size/uncertainty, failures, latency, cost and rework:
- Decision: adopt / no change / defer, with supporting artefact:

## Verification and disposition

| Requirement/check | Exact artefact and command/procedure | Result: passed / failed / skipped / not run / stale | Evidence, reviewer and limitations |
| --- | --- | --- | --- |

- Independent review verdict and exact reviewed input hashes:
- Unresolved gaps and affected claims:
- Work product / permitted report link:
- Disposition and next owner/action, or valid completion:
- Release authority, rollback and observed runtime evidence if deploying:

This record does not execute or enforce a gate. Existing Paperclip permissions,
execution bindings, reviews and CI enforce their own contracts. Never describe
these prose fields as cryptographic attestations or measured results.
