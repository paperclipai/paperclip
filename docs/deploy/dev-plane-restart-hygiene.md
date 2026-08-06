# Dev-Plane Deploy & Restart Hygiene

Operational runbook for restarting a dev/shared Paperclip control plane without killing in-flight agent work. Written after the 2026-07-06/07 failure spike, where a restart-heavy deploy window was the single largest source of failed tasks.

## Why this matters

Every control-plane restart hard-kills any heartbeat run in flight at that moment. The run is finalized as `failed` with `error_code = 'process_lost'`. There is an automatic single retry (`process_lost_retry`), but it is best-effort: in the 07-06/07 incident window only 12 of 36 lost runs recovered. On the evening of 07-06, **9 restarts in 90 minutes killed 16 in-flight runs**.

## Rules of thumb

1. **Batch your deploys.** Stack up changes and restart once, instead of restart-per-change. A restart storm (several restarts within an hour) multiplies run loss for near-zero benefit.
2. **Restart during low fleet activity.** Check for active runs before restarting; prefer windows where the fleet is quiet. A quick check against the control-plane DB:

   ```sql
   SELECT count(*) FROM heartbeat_runs WHERE status = 'running';
   ```

3. **Drain before restart (upcoming).** Graceful SIGTERM drain — stop accepting new runs, let in-flight runs finish or checkpoint, then exit — is being added in PAP-12930. Once it lands, send SIGTERM and wait for drain instead of hard-restarting. Until then, rule 2 is your drain.
4. **After any restart, glance at the damage.** See the detection queries below; confirm lost runs either retried successfully or get manual follow-up.

## How to spot a restart burst

Two signals, cross-referenced:

**1. Server start markers in the instance log.** Each boot logs `Server listening on <host>:<port>`. Logs live at `~/.paperclip/instances/<instance>/server.log`, rotated daily to `server.log-YYYYMMDD.gz`.

```bash
grep -h "Server listening" ~/.paperclip/instances/default/server.log
zgrep -h "Server listening" ~/.paperclip/instances/default/server.log-20260706.gz
```

Many markers minutes apart = restart burst.

**2. Same-minute `process_lost` clusters in `heartbeat_runs`.** Runs killed by a restart are finalized together, so they cluster on the same minute:

```sql
SELECT date_trunc('minute', finished_at) AS minute, count(*)
FROM heartbeat_runs
WHERE error_code = 'process_lost'
GROUP BY 1 HAVING count(*) > 1
ORDER BY 1 DESC;
```

If the cluster minutes line up with the `Server listening` timestamps, the failures are restart-inflicted, not a product regression.

**Note:** query the DB directly for this — the `/heartbeat-runs` list API ignores the `status=` filter and omits error fields.

## Checking recovery after a burst

Each `process_lost` run should have triggered one retry wake (`reason = 'process_lost_retry'`). To find lost runs that never recovered, look for `process_lost` failures with no subsequent successful run for the same issue, and re-wake or reassign those issues manually.

## Related failure modes (not restart-caused)

Seen in the same incident window; do not confuse them with restart damage:

- `workspace_validation_failed` — deterministic workspace validation retry loops (self-heal: PAP-12931).
- Provider quota exhaustion — dominant cause of `claude_transient_upstream` failures (quota-aware handling: PAP-12932).
