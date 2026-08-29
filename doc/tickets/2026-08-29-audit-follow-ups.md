# Paper Zenova audit follow-ups

Date: 2026-08-29
Status: open — historical audit findings are recorded; one operational follow-up remains actionable

## Source

- [Paper Zenova end-to-end audit](./2026-08-26-paper-zenova-end-to-end-audit.md)
- Environment: `paper.zenova.id` production and `paper-dev.zenova.id` staging
- Method: agent-browser navigation/network inspection plus source and route-registration audit

## Closed findings carried forward

The original audit records A1–A5, A7, and A8 as fixed and staging/prod validated:

- organization switcher and global organization routes
- missing cycles, improvement-suggestion, authenticator, GitHub, MCP, and notification route mounts
- quota timeout normalization and stale-sample preservation
- durable attachment enrichment and browser-artifact guidance
- browser profile/live-run/stream contracts
- safe issue deletion and parent-child deletion guard
- `/tasks` and `/work-overview` compatibility redirects

These remain regression requirements for future releases; they are not invitations to repeat destructive production testing.

## Open follow-ups

### Revision-verifiable staging promotion

The audit's A6 follow-up remains open:

1. A staging deploy job must wait for a healthy rollout rather than treating a queued Dokploy request as success.
2. The served application must expose an immutable build/server revision that can be compared with the candidate SHA.
3. The release check must fail when health is unavailable, the served revision differs, or the browser smoke check reports a non-2xx request/page error.
4. Production remains an explicit, separately authorized promotion after staging evidence.

### Verification hygiene

- Keep the heartbeat aggregate-load retry isolated and visible until the host-sensitive assertion is eliminated.
- Track the repository-wide token-gate debt separately; dashboard work must not add new violations.
- Durable screenshots require upload → attachment lookup → confirmation before an agent claims they are attached.

## Acceptance criteria

- A deployment report names the candidate SHA, health revision, rollout state, and smoke evidence.
- A deliberately stale deployment fails verification instead of reporting success.
- The production gate cannot be triggered by a staging deploy event alone.
- The audit docs and GitHub issue remain linked from the release checklist.
