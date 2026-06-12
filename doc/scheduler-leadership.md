# Scheduler Leadership

The heartbeat/routines scheduler (timers, run resumption, recovery passes)
must run on exactly one server instance. Before leases, that was a manual
toggle: operators set `HEARTBEAT_SCHEDULER_ENABLED=false` on all but one
replica, and if that replica died, scheduling stopped until it came back.

With lease leadership, every replica is a candidate by default. One acquires
the lease and runs the scheduler — the *triggering* side: ticks, queued-run
promotion, recovery passes. The others serve traffic and renew their
candidacy. Failover is automatic. Execution of queued runs is separate and
distributed: every replica's executor claims and runs work regardless of
leadership (see `doc/distributed-run-execution.md`).

## Mechanics

- A single row in `scheduler_leader` is the lease. All time math uses the
  **database clock** (`now()`); client clocks never participate.
- Candidates try to take the lease every ~5s (jittered): delete it if
  expired, then `INSERT … ON CONFLICT DO NOTHING` — exactly one wins.
- The leader renews every ~5s with
  `UPDATE … WHERE leader_id = me AND expires_at >= now()`. The predicate is
  the fencing check: a paused or wedged process cannot re-extend an expired
  lease, and a renewal that matches zero rows demotes the local scheduler
  immediately.
- Lease TTL is 15s. Crash failover therefore takes at most ~15s + one retry
  interval. Graceful shutdown resigns (deletes the row), so rollout failover
  takes one retry interval (~5s) — small against the 30s scheduler tick.
- On every acquisition the scheduler re-runs its startup recovery chain
  (orphan reaping, queued-run resumption, stale-lock sweeps) — exactly the
  recovery a failover needs.

## Configuration

| Env | Meaning |
|---|---|
| `HEARTBEAT_SCHEDULER_ENABLED` (default true) | Participate in leader election. Set `false` for traffic-only replicas that must never run the scheduler. |

Single-replica deployments: the lone candidate acquires on its first pass at
boot — behavior is identical to before, including with the embedded database.

Deployments that pinned the scheduler manually (e.g. only ordinal-0 carries
`HEARTBEAT_SCHEDULER_ENABLED=true`) keep working unchanged: the pinned
replica is the only candidate and always wins. Removing the pin enables
automatic failover.

## Monitoring

`GET /api/health` returns a `scheduler` block in **both** the redacted and
full-details views, but with different fields:

**Redacted view** (unauthenticated / operator probe contract):

```json
"scheduler": {
  "candidate": true,
  "isLeader": false
}
```

The Kubernetes operator polls each pod's `/api/health` unauthenticated to
identify the scheduler leader (e.g. to apply a pod label). The two booleans
are sufficient for that — they reveal no sensitive lease data.

**Full-details view** (authenticated board/agent request):

```json
"scheduler": {
  "candidate": true,
  "isLeader": false,
  "leader": { "leaderId": "…", "hostname": "…", "electedAt": "…", "expiresAt": "…" }
}
```

`candidate` and `isLeader` describe the replica answering the probe; `leader`
is the current lease row (whoever holds it). An expired-looking `expiresAt`
with no takeover means no replica is a candidate — check
`HEARTBEAT_SCHEDULER_ENABLED` across the fleet.

## Pooler note

Lease operations are single short transactions — safe through any connection
pooling mode (unlike LISTEN or session-scoped advisory locks, which need
direct connections; see `doc/live-events.md`).
