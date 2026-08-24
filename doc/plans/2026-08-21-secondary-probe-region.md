# Secondary Probe Region for Standard-Tier SLA Monitoring

**Author:** CTO, PraeSyn LLC
**Date:** 2026-08-21
**Issue:** PRA-1069
**Parent:** PRA-1055/PRA-1065

## Problem

The Standard-tier SLA monitor probes standard-tier clients from a single location
(Uptime Kuma on vps-1 / macOS host). When the probe infrastructure itself goes
down (e.g., the Aug 19-20 VPS outage), every standard-tier client appears down
simultaneously. There is no way to distinguish between:

- A genuine client outage (host is down, other regions see it too)
- A probe-infrastructure outage (all regions report down → probe infrastructure fault)

## Acceptance Criteria

1. Standard-tier client probes run from >=2 independent geographic/network locations
2. SLA breach classification includes probe-consensus logic (both probes must agree)
3. False-positive alerts are suppressed during probe-infrastructure outages
4. Re-fire suppression works for Standard tier (analogous to Premium's PRA-693)

## Architecture Options

### Option A: Secondary Uptime Kuma on vps-2

Deploy a second Uptime Kuma instance on vps-2 (or a separate lightweight
monitoring container) that duplicates the probe configuration of the primary
instance.

**Pros:**
- Familiar technology (already running Uptime Kuma on macOS)
- Full control over configuration
- No external dependencies

**Cons:**
- vps-2 is also in the same Hostinger data center (same physical node risk)
- Requires vps-2 to have adequate resources
- Both probes fail if the provider's network is down

### Option B: External Monitoring as Secondary (Recommended)

Use a SaaS monitoring service (Better Uptime, Checkly, Pingdom, or Hetzner's
built-in monitoring) as the secondary probe source. Configure it to monitor the
same standard-tier endpoints.

**Pros:**
- Truly independent — different provider, different infrastructure
- No resource cost on our VPS
- Typically includes status pages and alerting

**Cons:**
- Monthly cost (~$10-30/mo for basic tier)
- Data leaves our network (acceptable for public HTTP endpoints)
- Need to integrate alerts into Paperclip's SLA breach issue creation

### Option C: Multi-Region Open Source Probes

Deploy lightweight probe containers on multiple independent VPS instances
(e.g., one on Hetzner, one on DigitalOcean, one on the macOS host). Each
probe independently checks endpoints and reports status to a central aggregator.

**Pros:**
- Maximum independence
- No single point of failure
- Open source, self-hosted

**Cons:**
- Most complex to set up and maintain
- Requires 2+ VPS instances with Tailscale
- Needs a central aggregator/consensus service

## Recommended Approach: Option B (External Secondary) + Option C (Future)

**Phase 1 (immediate, no infra dependency):**
1. Choose a secondary monitoring provider (recommend: Better Uptime for simplicity,
   or Hetzner's free monitoring if using their VPS)
2. Configure the secondary monitor to check all standard-tier endpoints
3. The secondary monitor creates Paperclip issues via the API (like the primary does)
4. Add consensus logic: a StandardSLABreach issue is only created/confirmed when
   BOTH primary and secondary probes report the endpoint as down

**Phase 2 (requires VPS migration PRA-1131):**
1. Deploy a third probe on the new Hetzner VPS (or vps-2)
2. Implement majority-vote consensus (2 of 3 probes must agree)
3. Add re-fire suppression: if probe-1 is down but probe-2 and probe-3 see the
   endpoint as up, suppress the alert

## Implementation: Probe-Consensus Logic

The consensus logic lives in the API layer where SLA breach issues are created.
Currently, `checkStandardSLABreachDuplicate()` in `standard-sla-dedup.ts` handles
dedup. The flow would be:

```
External Monitor (primary) ──→ POST /api/issues (StandardSLABreach)
                                       │
                                       ▼
                              checkConsensus()
                              ┌─ Has secondary probe confirmed? ──→ Yes → Create issue
                              │        No
                              ▼
                          Queue check; retry after probe interval
                          If secondary doesn't confirm within
                          CONSENSUS_WINDOW (default: 5 min),
                          mark as false-positive and drop
```

## Dependencies

1. **PRA-1131 / PRA-1043** (VPS capacity/migration) — needed for Phase 2
2. **Secondary monitoring account** — human step (Ben signs up for service)
3. **API key for secondary monitor** — create agent API key for external monitor

## Future Enhancements

- Premium-tier clients already have multi-region (PRA-693); re-use that mechanism
- Status page (status.praesyn.com) — DNS currently broken; fix as part of this work
- Automated probe health checks — if a probe stops reporting, alert the CTO
