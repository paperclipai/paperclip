# Ticket inventory and GitHub tracking

Date: 2026-08-29
Status: maintained alongside the private repository issue tracker

The repository previously contained ticket/audit Markdown records without corresponding GitHub issues. This index is the reconciliation point. Issue numbers are filled in after creation and should be kept in sync when a ticket is closed or split.

| Markdown record | Tracking purpose | GitHub issue |
| --- | --- | --- |
| [Epics, human work, AI execution, and cycles](./2026-08-26-epics-human-ai-work-cycles.md) | historical first slice + follow-up linkage | [#29](https://github.com/AdeChrysler/paperclip/issues/29) · open |
| [Paper Zenova end-to-end audit](./2026-08-26-paper-zenova-end-to-end-audit.md) | historical evidence for A1–A8 | [#24](https://github.com/AdeChrysler/paperclip/issues/24) · open |
| [Dashboard usage analytics time selector](./2026-08-27-usage-analytics-time-selector.md) | shipped rollout record | [#30](https://github.com/AdeChrysler/paperclip/issues/30) · closed |
| [Audit follow-ups](./2026-08-29-audit-follow-ups.md) | revision-verifiable staging and release hygiene | [#24](https://github.com/AdeChrysler/paperclip/issues/24) · open |
| [Organization/company hierarchy](./2026-08-29-organization-company-hierarchy.md) | fix misleading creation semantics | [#25](https://github.com/AdeChrysler/paperclip/issues/25) · open |
| [Dashboard Nothing visual system](./2026-08-29-dashboard-nothing-visual-system.md) | consistent tokenized dashboard UI | [#26](https://github.com/AdeChrysler/paperclip/issues/26) · open |
| [App-wide Nothing visual sweep](./2026-08-29-nothing-app-wide-visual-sweep.md) | extend the visual language beyond the dashboard | [#31](https://github.com/AdeChrysler/paperclip/issues/31) · open |
| [Selective upstream resync](./2026-08-29-upstream-selective-resync.md) | port/adapt/reject decisions | [#27](https://github.com/AdeChrysler/paperclip/issues/27) · open |
| [Pre-dispatch quota gating](./2026-08-29-pre-dispatch-quota-gating.md) | prevent dead-credential dispatch | [#28](https://github.com/AdeChrysler/paperclip/issues/28) · open |
| [Epic execution linkage](./2026-08-29-epic-execution-linkage.md) | finish first-slice work model | [#29](https://github.com/AdeChrysler/paperclip/issues/29) · open |

## Tracking rules

- Closed historical records remain linked to the closed issue that records their evidence.
- Open follow-ups get separate actionable issues when they have a different owner or acceptance criteria.
- Do not create a second issue for a finding solely because a deployment branch changed; update the existing issue and this index.
- Do not put credentials, session cookies, or live customer identifiers in issue bodies.
