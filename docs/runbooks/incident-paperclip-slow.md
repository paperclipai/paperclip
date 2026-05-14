# Incident Runbook: Paperclip Slow / Hung

Use this sequence when Paperclip pages stall, issue actions hang, or CPU spikes.

## 1) Host snapshot

```sh
uptime
free -h
df -h
top -b -n1 | head -40
```

Look for:

- load average climbing rapidly
- memory pressure / swap churn
- root disk >85%

## 2) Process drill-down

```sh
ps -eo pid,ppid,pcpu,pmem,rss,etime,cmd --sort=-pcpu | head -30
```

Look for:

- `paperclipai` process pinned high CPU
- long-lived node process with rising RSS

## 3) Socket pressure on app port (:3101)

```sh
ss -s
ss -Htan | awk '$1 == "ESTAB" && ($4 ~ /:3101$/ || $5 ~ /:3101$/) {c++} END {print "established_3101=" c+0}'
ss -Htan | awk '$1 == "CLOSE-WAIT" && ($4 ~ /:3101$/ || $5 ~ /:3101$/) {c++} END {print "close_wait_3101=" c+0}'
```

Look for:

- `established_3101 > 200` (warning)
- `established_3101 > 500` (critical)
- `close_wait_3101 > 50` (critical)

## 4) App and tunnel logs

```sh
tail -n 200 /home/paperclip/.paperclip/instances/default/logs/server.log
journalctl -u paperclip.service -n 200 --no-pager
journalctl -u cloudflared-paperclip.service -n 200 --no-pager
```

Look for:

- repeated 404/429/5xx request storms
- upstream timeout/reconnect loops
- cloudflared disconnect/reconnect churn

## 5) Health and metrics

```sh
curl -sS http://127.0.0.1:3101/healthz | jq .
curl -sS http://127.0.0.1:3101/metrics | head -80
```

Check:

- `db_ok` true
- `open_connections`, `event_loop_lag_ms`, `log_size_mb` trends

## 6) Immediate remediation

1. If unhealthy 3+ minutes: restart app service.
2. If disk >90%: force logrotate.
3. If socket leak severe: restart cloudflared service.

Commands:

```sh
sudo systemctl restart paperclip.service
sudo logrotate -f /etc/logrotate.d/paperclip
sudo systemctl restart cloudflared-paperclip.service
```

## 7) Post-incident follow-up

- Capture timeline and thresholds breached.
- Attach last 20 app/tunnel log lines.
- Open/append post-mortem in `docs/runbooks/post-mortem-2026-05-13.md`.
- Confirm watchdog timer and alert routing are active.

