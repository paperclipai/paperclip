# Logging

Server logs are written to `$PAPERCLIP_LOG_DIR/server.log` (default: `~/.paperclip/instances/default/logs/server.log`).

## Log Levels

- HTTP request success logs: `debug` level (not written to default info streams)
- Warnings (400-level): `warn` level
- Errors (500-level): `error` level

## Log Rotation

Managed by logrotate (`/etc/logrotate.d/paperclip`):
- Daily rotation
- 100 MB size cap
- 7-day retention
- Compression enabled

## Log Reduction

The `http-log-policy` middleware silences successful polling responses for high-frequency endpoints:
- Health checks
- Live run polling
- Log/stream endpoints
- Sidebar badge queries
- Static assets

This prevents the log file from growing uncontrollably during normal operations.
