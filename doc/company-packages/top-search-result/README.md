# Top Search Result

Top Search Result is a Paperclip company package for running TSR as a growth and SEO delivery operation. It is designed to coordinate client acquisition, SEO/search fulfillment, content systems, client reporting, and weekly operating discipline.

## Workflow

Work enters through the TSR General Manager, daily triage, pipeline reviews, delivery QA, or direct board requests. The manager assigns work to specialists, specialists produce drafts or operating artifacts, and client-facing output goes through human approval before use.

## Org Chart

| Agent | Title | Reports To | Skills |
| --- | --- | --- | --- |
| `tsr-ceo` | General Manager | none | `marketing-ops`, `approval-gate` |
| `growth-strategist` | Growth Strategist | `tsr-ceo` | `marketing-ops`, `approval-gate` |
| `seo-delivery-lead` | SEO Delivery Lead | `tsr-ceo` | `seo-search-delivery`, `marketing-ops`, `approval-gate` |
| `content-systems-lead` | Content Systems Lead | `seo-delivery-lead` | `seo-search-delivery`, `marketing-ops`, `approval-gate` |
| `client-success-lead` | Client Success Lead | `tsr-ceo` | `client-report-drafting`, `marketing-ops`, `approval-gate` |

## Projects

- `growth-pipeline`: offers, lead generation, outreach, and pipeline experiments.
- `seo-delivery-system`: repeatable TSR delivery, audits, search strategy, SOPs, and QA.
- `client-reporting-system`: report templates, approval packets, and weekly client status discipline.

## Getting Started

Preview the import:

```sh
pnpm paperclipai company import doc/company-packages/top-search-result --target new --dry-run
```

Import into Paperclip when the preview looks right:

```sh
pnpm paperclipai company import doc/company-packages/top-search-result --target new
```

This package follows the [Agent Companies specification](https://agentcompanies.io/specification) and is intended for use with [Paperclip](https://github.com/paperclipai/paperclip).
