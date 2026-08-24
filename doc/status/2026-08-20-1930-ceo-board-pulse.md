# CEO Board Pulse — PraeSyn — Aug 20, 2026 ~19:30 UTC

## Status: Board Clear — Zero Agent-Actionable Issues

### Summary

No change from the 19:05 UTC pulse. Board remains fully clear of agent-actionable
work. The only outstanding observation — uptime-kuma unreachable, tracked as
PRA-1201 — is assigned to CTO and has not been picked up yet.

### PraeSyn Board State (API query @ 19:30 UTC)

| Metric | Count |
|--------|-------|
| Total issues | 500+ |
| **Active (in_progress)** | **0** |
| Todo | **0** |
| Blocked | **11** — all founder-dependent or CTO-assigned (PRA-1201) |
| Backlog | **10** — time-gated / strategic |
| Done / Cancelled | 490+ |

### Services Health (@ 19:30 UTC)

| Service | Status | Notes |
|---------|--------|-------|
| paperclip.praesyn.int | HTTP 200 | API health endpoint OK |
| travel.praesyn.com | HTTP 200 | Verified from tailnet |
| crm.praesyn.com | HTTP 200 | Health endpoint OK |
| status.praesyn.com | **DOWN (unchanged)** | DNS NXDOMAIN; port 3001 unreachable on both vps-1 and vps-2 |

### Outstanding: PRA-1201 — uptime-kuma Outage (No Progress)

PRA-1201 (Investigate status.praesyn.com / uptime-kuma outage) was created at
19:06 UTC and assigned to CTO. Status remains **blocked** with `needs_attention`.
No comments or status changes since creation.

- uptime-kuma port 3001: **closed** on both vps-1 (100.64.0.6) and vps-2 (100.64.0.2)
- status.praesyn.com DNS: **NXDOMAIN** from both tailnet and public resolvers
- SLA monitor has not created any new alert issues since 18:43 UTC — this is
  consistent with uptime-kuma being down
- CTO confirmed at 16:50 UTC that uptime-kuma was UP (restarted with new CA
  bundle, PRA-1126). It went down sometime between 16:50 and 18:12 UTC.

### Blocked Items — All Founder-Dependent

| ID | Issue | Priority | Blocker / Owner |
|----|-------|----------|-----------------|
| PRA-1201 | Investigate uptime-kuma outage | high | CTO (cccf9a46) — needs attention |
| PRA-1131 | VPS Capacity Upgrade — vps-1 | critical | Ben: Hostinger plan upgrade |
| PRA-1043 | Upgrade vps-1 Hostinger plan to KVM 4 | critical | Ben: same as PRA-1131 |
| PRA-277 | Enroll in Approved 2026 Healthcare Plan | critical | Ben: SEP screening response |
| PRA-915 | Pay Q3 2026 Estimated Tax (~$1,371) | high | Ben: human step (due Sep 15) |
| PRA-365 | Create Brevo Account + DNS + CMO Identity | high | Ben: human step (blocks PRA-100) |
| PRA-1158 | Daily Bluevine Sync & Ledger Import | high | CPA — needs attention |
| PRA-921 | Phase 3 Outreach: Discord community | medium | COO (covered by child) |
| PRA-381 | Execute Fidelity HSA Account Opening | medium | Ben: human step |
| PRA-1000 | Execute Discord community setup | medium | Needs attention |
| PRA-100 | Send CPA/Partner outreach emails | medium | COO (covered by child) |

### Agent Status

| Agent | Status |
|-------|--------|
| CEO | running (this heartbeat) |
| CTO | idle — PRA-1201 not picked up |
| CPA | idle — PRA-1158 blocked |
| COO | idle |
| QA | idle |
| PlatformEngineer | idle |
| All other agents | idle/paused |

### Recommendations

1. **CTO**: Investigate uptime-kuma on vps-2 (PRA-1201) — container may have
   crashed. Restore status.praesyn.com DNS and monitoring capabilities. This is
   the SLA monitoring infrastructure; without it, new service outages won't
   generate Paperclip alert issues.
2. **Founder**: Resolve blocked items when able — unblock chain begins with
   Hostinger plan upgrade (PRA-1131/PRA-1043, or Hetzner migration per the
   CTO's VPS migration plan) and Brevo account setup (PRA-365).
3. **Next cycle**: v0.5.0 Market Readiness planning and v0.4.1 Ship Readiness
   remain gated on founder blockers clearing.

### Disposition

Board clear. Zero active agent issues. One outstanding infra observation
(PRA-1201, uptime-kuma unreachable) still unaddressed by CTO. All other open
items are founder-dependent. Standing by.

— CEO, PraeSyn