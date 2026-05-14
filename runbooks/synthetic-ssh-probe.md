# Synthetic SSH→Paperclip-API Probe — Runbook

The synthetic probe runs on the API box every 60s, exercises the same code path
as a real worker lease-acquire (SSH into the worker host, `curl /api/health`),
and pages when the path is degrading **before** a real assigned run is stranded.

Source: `server/src/services/synthetic-ssh-probe.ts`. Storage:
`synthetic_ssh_probe_results` in the API Postgres. Owner: Platform/SRE
(staffed by CTO timebox until a dedicated SRE IC is hired — see
[BLO-518](/BLO/issues/BLO-518#document-plan), lane map in
[BLO-519](/BLO/issues/BLO-519#comment-c347b205-1fa0-4797-aa8c-50812a9d4006)).

## Alerts

The probe pages when **either** condition holds:

- 3 consecutive failures against the same target.
- Median `total_ms` over a rolling 5-minute window > 7000 ms.

Repaging is suppressed for 15 minutes after the previous page.

## What to do when paged

1. Pull the last 30 minutes of probe rows:

    ```sql
    SELECT started_at, ok, total_ms, error_class, attempts_json->-1->>'stderrTail' AS last_err
    FROM synthetic_ssh_probe_results
    WHERE target_host = '69.25.95.32' AND started_at > now() - interval '30 minutes'
    ORDER BY started_at DESC;
    ```

2. Cross-check against the parent issue family
   [BLO-1487](/BLO/issues/BLO-1487) and the most recent strandings
   ([BLO-1449](/BLO/issues/BLO-1449), [BLO-1481](/BLO/issues/BLO-1481),
   [BLO-1484](/BLO/issues/BLO-1484)) — patterns we have already seen are
   re-keyed there.

3. From the API box, manually reproduce:

    ```sh
    ssh -o BatchMode=yes -o ConnectTimeout=10 oramadan@69.25.95.32 \
      "curl -fsS -m 8 https://paperclip.blockcast.net/api/health"
    ```

    If this fails the same way the synthetic does, the issue is on the worker
    host or the network egress between the API box and the worker host —
    **not** the API itself.

4. If the failure is intermittent and `host_load_avg_1m` is high on the
   probe rows, suspect resource pressure on `oramadan@69.25.95.32`.

## Silencing the alert

The probe writes via `pageCallback` configured at server boot. To silence:

- **Surgical**: set `PAPERCLIP_SYNTHETIC_SSH_PROBE_PAGE=false` in the API
  process env and roll the API. The probe keeps recording samples; only
  paging is suppressed.
- **Hard stop**: set `PAPERCLIP_SYNTHETIC_SSH_PROBE_DISABLE=true` and roll the
  API. The probe loop will not start. Use only when triaging unrelated
  noise; the probe is the early-warning for stranded runs.

## Resetting after an incident

After a fix lands, leave the probe running. The 24h dashboard widget
(`GET /api/synthetic-ssh-probe/last-24h`) shows the trendline returning to
nominal — no manual reset is needed.

## Retention

Rows older than 7 days are deleted on every probe tick. There is no manual
cleanup step.
