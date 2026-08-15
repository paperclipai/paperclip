# Phase 0 mining summary (2026-08-15)

Source: `https://goc.yaaver.com` GET-only with AIP/ONS agent tokens from the build guide.
Raw dumps kept outside the Paperclip repo at `../phase0-data/` (not committed).

## Counts

| Company | Issues pulled | stranded_issue_recovery |
|---------|---------------|-------------------------|
| AIP     | 8601          | 1164                    |
| ONS     | 2261          | 616                     |

## High-confidence pattern chosen for seed

`stranded_issue_recovery_source_terminal`

- Match: `originKind == stranded_issue_recovery`
- Title: `^Recover (stalled issue|missing next step)\b`
- Gate: origin issue status is `done` or `cancelled`
- Action: mark recovery issue `done` with Deflector comment

AIP join check: 575 stranded recoveries had a terminal origin; most historical resolutions were `done`.

## Explicitly NOT seeded (too risky / not issue-shaped)

- Bulk list-endpoint `in_review` staleness (Wazir known bug): ops triage noise, not safe auto-resolve
- Origin uptime probe duplicate floods: needs temporal/dedup logic beyond v1
- Routine execution tickets: expected work, not deflect

## Wazir notes

Mined `Wazir/watchlog.md`, `Wazir/kb/`, `Wazir/SOPs/`, `Wazir/playbook/`. Useful for ops memory; no additional auto-resolve pattern cleared the conservatism bar.
