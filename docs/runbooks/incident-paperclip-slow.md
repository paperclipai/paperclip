# Incident Runbook: Paperclip Slow / Unresponsive

## Symptoms

- Pages load slowly or time out.
- Issue creation hangs.
- API requests return 502/503.
- High CPU usage on the host.

## Diagnostic Sequence

### 1. Quick Host Snapshot
```bash
uptime
free -h
df -h /
```
Look for: load average >> CPU count, low available memory, disk > 85%.

### 2. Process Drill-Down
```bash
top -bn1 | head -20
ps aux --sort=-%cpu | head -10
```
Identify the top CPU-consuming process. On this host, `node` (paperclip server) and `cloudflared` are expected.

### 3. Socket Pressure
```bash
ss -s
ss -tn state established '( dport = :3101 or sport = :3101 )' | wc -l
ss -tn state close-wait '( dport = :3101 or sport = :3101 )' | wc -l
```
- > 200 ESTABLISHED: elevated load, check for polling storms.
- > 500 ESTABLISHED: critical, restart cloudflared.
- > 50 CLOSE_WAIT: leaked connections, restart cloudflared.

### 4. Application Logs
```bash
journalctl -u paperclip.service --since "10 min ago" --no-pager | tail -50
tail -50 ~/.paperclip/instances/default/logs/server.log
```
Look for: repeated 404 responses, ERROR-level logs, timeout messages.

### 5. Cloudflared Logs
```bash
journalctl -u cloudflared-paperclip.service --since "10 min ago" --no-pager | tail -30
```
Look for: connection errors, tunnel reconnect loops.

### 6. Health and Metrics
```bash
curl -s http://127.0.0.1:3101/healthz | jq .
curl -s http://127.0.0.1:3101/metrics | head -20
```
Check: `db_ok`, `open_connections`, `log_size_mb`, `event_loop_lag_ms`.

## Immediate Remediation

### If CPU is saturated (polling storm):
```bash
sudo systemctl restart cloudflared-paperclip.service
sudo systemctl restart paperclip.service
```

### If disk is full:
```bash
sudo logrotate -f /etc/logrotate.d/paperclip
```

### If connections are leaked:
```bash
sudo systemctl restart cloudflared-paperclip.service
```

## Post-Recovery

1. Check the watchdog log: `tail -100 /var/log/paperclip-watchdog.log`
2. Verify watchdog timer is active: `systemctl status paperclip-watchdog.timer`
3. Check Paperclip Proposals for any auto-generated incident reports.
