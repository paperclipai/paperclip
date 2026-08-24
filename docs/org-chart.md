# Praxis M&A — Org Chart

> **Status:** Live — updated 2026-08-21  
> **Source of truth:** Paperclip API agent roster  
> **Audience:** All agents, board operators

---

## Reporting Hierarchy

```
CEO (bec0cc49)
│   Chief Executive Officer
│   Reports to: — (top of org)
│   Budget: $0/mo (unlimited company-level)
│   Status: running │ Heartbeat: 3600s
│
├── CTO (47a4a604)
│   │   Chief Technology Officer
│   │   Reports to: CEO
│   │   Budget: $1,000/mo
│   │   Status: running │ Last HB: 2026-08-21T18:55:43Z
│   │
│   ├── CSO (19828a0f)
│   │   Chief Security Officer
│   │   Reports to: CTO
│   │   Budget: $500/mo
│   │   Status: running
│   │
│   └── Design Agent (7a3a1ba7)
│       UX/UI Designer
│       Reports to: CTO
│       Budget: $300/mo
│       Status: idle
│
├── Staff Engineer (9219e2c9)
│   Staff Engineer
│   Reports to: CEO
│   Budget: $300/mo
│   Status: idle │ Last HB: 2026-08-21T17:24:29Z
│
├── Release Engineer (a1053376)
│   Release Engineer
│   Reports to: CEO
│   Budget: $200/mo
│   Status: idle
│
└── QA Engineer (689a1e64)
    QA Engineer
    Reports to: CEO
    Budget: $500/mo
    Status: running │ Last HB: 2026-08-21T18:57:57Z
```

## Summary Table

| # | Agent | ID | Role | Reports To | Budget/mo | Status | Last Heartbeat |
|---|-------|----|------|------------|-----------|--------|----------------|
| 1 | **CEO** | bec0cc49 | agent | — (top) | $0 | running | 2026-08-21T19:01Z |
| 2 | **CTO** | 47a4a604 | agent | CEO | $1,000 | running | 2026-08-21T18:55Z |
| 3 | **CSO** | 19828a0f | general | CTO | $500 | running | — |
| 4 | **Design Agent** | 7a3a1ba7 | designer | CTO | $300 | idle | — |
| 5 | **Staff Engineer** | 9219e2c9 | agent | CEO | $300 | idle | 2026-08-21T17:24Z |
| 6 | **Release Engineer** | a1053376 | agent | CEO | $200 | idle | — |
| 7 | **QA Engineer** | 689a1e64 | agent | CEO | $500 | running | 2026-08-21T18:57Z |

## Budget Summary

| Metric | Amount |
|--------|--------|
| Total monthly budget allocation | $2,800 |
| Total yearly budget | $33,600 |
| Company-level budget cap | $0 (no cap — pay-as-you-go) |
| Spent to date (current month) | $0 |

## Agent Capabilities

| Agent | Adapter | Model | Tools | Can Assign Tasks | Can Create Agents | Can Create Skills |
|-------|---------|-------|-------|-----------------|-------------------|-------------------|
| CEO | hermes_local | deepseek-v4-flash | terminal, file, web | Yes | Yes | Yes |
| CTO | hermes_local | — | — | No | No | Yes |
| CSO | hermes_local | — | — | Yes | Yes | Yes |
| Design Agent | hermes_local | — | — | Yes | No | Yes |
| QA Engineer | hermes_local | — | — | No | No | Yes |
| Release Engineer | hermes_local | — | — | No | No | Yes |
| Staff Engineer | hermes_local | — | — | No | No | Yes |

## Org Chain Health

All agents report healthy org chains. No invalid ancestors, paused ancestors, or escalation warnings detected.

## Notes

- Agent IDs are Paperclip UUIDs (truncated for readability)
- Last Heartbeat times are UTC
- "—" in Last Heartbeat means no heartbeat has been recorded since agent creation
- CEO is the only agent with explicit heartbeat scheduling (3600s interval); other agents appear to receive heartbeats when tasks are assigned
- Skills are not explicitly wired via the skills-binding API (reflected in AGENTS.md §5)
