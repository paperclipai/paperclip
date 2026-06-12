# Live Events: Cross-Replica Transport

Operator UIs subscribe to per-company live events over WebSockets. With one
replica, an in-process emitter is the whole story. With `replicas > 1`, a
cross-replica transport fans events out so a WebSocket client connected to
replica B sees events that originate on replica A.

## Transport selection

| `PAPERCLIP_LIVE_EVENTS_TRANSPORT` | Behavior |
|---|---|
| unset / `postgres` (default) | Postgres LISTEN/NOTIFY on per-company channels. No new infrastructure. |
| `redis` | Redis pub/sub. Requires `PAPERCLIP_LIVE_EVENTS_REDIS_URL` (or `PAPERCLIP_REDIS_URL`). |
| `off` | In-process only. Multi-replica deployments WILL show stale UIs on non-originating replicas. |

## Delivery semantics

The transport is best-effort and at-most-once — a payload-free "doorbell,"
not a durable message bus:

- Events larger than the transport frame cap (7.5KB for Postgres NOTIFY)
  are delivered to remote replicas as a marker of the same event type with
  `payload: { __resync: true }`. Consumers refetch the state they render.
- When a replica's LISTEN connection reconnects (database restart,
  failover), subscribers on that replica receive a synthetic
  `transport.resync` event per company — anything published while
  disconnected is gone by design. The UI's poll-on-reconnect fallback
  covers the user-visible gap.
- Bursts are coalesced into batched NOTIFY frames (~25ms window). Postgres
  serializes all NOTIFY-issuing commits behind a global lock; coalescing
  keeps event traffic off that hot path.

## Pooler compatibility (PgBouncer et al.)

`LISTEN` does not work through transaction-mode connection pooling
(PgBouncer feature matrix: "Never"). The transport's database connection
must reach Postgres directly or through a session-mode pool. If your
`DATABASE_URL` points at a transaction-mode pooler, give the server a
direct URL as well; otherwise run with `PAPERCLIP_LIVE_EVENTS_TRANSPORT=off`
and rely on UI polling.

`LISTEN`/`NOTIFY` also do not run on hot-standby replicas — the transport
connects to the primary.

## Monitoring

`GET /api/health` (full-details view) includes:

```json
"liveEvents": { "mode": "transport", "originId": "…", "notificationQueueUsage": 0.0 }
```

`notificationQueueUsage` is `pg_notification_queue_usage()` — the fraction
of the 8GB notification queue in use. It should sit near 0. Values above
0.5 are logged as warnings: a lagging listener (often a session stuck in a
long transaction) is preventing queue cleanup, and at 1.0 every
NOTIFY-issuing transaction in the database starts failing at commit.
