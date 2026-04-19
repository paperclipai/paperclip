# CodeSM MaaS

CodeSM MaaS is a Paperclip company package for operating a 30-client marketing operations portfolio. It gives CodeSM a separate company context that can be paused, archived, or left behind cleanly if the contract ends.

## Workflow

Work enters through daily queue triage, client requests, weekly status rollups, delivery QA, or direct board requests. The Managing Director sets priorities, Portfolio Ops routes work, Fulfillment plans delivery, Reporting drafts updates, and QA checks artifacts before human approval.

Client-facing work remains draft-only until approved by the human operator.

## Org Chart

| Agent | Title | Reports To | Skills |
| --- | --- | --- | --- |
| `codesm-managing-director` | Managing Director | none | `portfolio-triage`, `marketing-ops`, `approval-gate` |
| `portfolio-ops-lead` | Portfolio Ops Lead | `codesm-managing-director` | `portfolio-triage`, `marketing-ops`, `approval-gate` |
| `marketing-fulfillment-lead` | Marketing Fulfillment Lead | `codesm-managing-director` | `marketing-ops`, `approval-gate` |
| `reporting-analyst` | Reporting Analyst | `portfolio-ops-lead` | `client-report-drafting`, `portfolio-triage`, `approval-gate` |
| `qa-approval-editor` | QA Approval Editor | `codesm-managing-director` | `client-report-drafting`, `marketing-ops`, `approval-gate` |

## Projects

- `portfolio-operations`: intake, routing, queue health, blockers, and weekly portfolio rollups.
- `delivery-quality-system`: QA criteria, sample reviews, SOPs, and risk reduction.
- `reporting-cycle`: report drafts, metric snapshots, and client-facing update packets.
- `client-01` through `client-30`: placeholder client projects, each with a baseline and next-actions starter task.

## Getting Started

Preview the import:

```sh
pnpm paperclipai company import doc/company-packages/codesm-maas --target new --dry-run
```

Import into Paperclip when the preview looks right:

```sh
pnpm paperclipai company import doc/company-packages/codesm-maas --target new
```

This package follows the [Agent Companies specification](https://agentcompanies.io/specification) and is intended for use with [Paperclip](https://github.com/paperclipai/paperclip).
