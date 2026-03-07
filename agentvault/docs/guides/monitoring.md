# Monitoring Guide

Monitor canister health and performance.

## Overview

AgentVault provides comprehensive monitoring for deployed canisters.

## Commands

### Health Checks

```bash
# Basic health check
agentvault health

# Specific canister
agentvault health --canister-id <id>

# Detailed report
agentvault health --canister-id <id> --detailed
```

### Status

```bash
# Project status
agentvault status

# Specific canister
agentvault status --canister-id <id>
```

### Statistics

```bash
# Canister statistics
agentvault stats --canister-id <id>

# Time period
agentvault stats -c <id> --period 24h
```

### Continuous Monitoring

```bash
# Start monitoring
agentvault monitor --canister-id <id>

# With alerts
agentvault monitor -c <id> --alert --webhook <url>
```

## Health Indicators

| Indicator | Description | Healthy |
|-----------|-------------|---------|
| Status | Canister status | Running |
| Cycles | Cycles balance | > 1T |
| Memory | Memory usage | < 80% |
| Errors | Error rate | < 1% |
| Latency | Response time | < 1000ms |

## Metrics

### Available Metrics

```bash
agentvault stats --canister-id <id> --format json
```

```json
{
  "requests": 10000,
  "errors": 5,
  "errorRate": 0.0005,
  "avgLatency": 250,
  "p99Latency": 800,
  "memoryUsed": 134217728,
  "memoryLimit": 268435456,
  "cycles": 5000000000000
}
```

### Metrics Collection

| Metric | Type | Description |
|--------|------|-------------|
| `requests` | Counter | Total requests |
| `errors` | Counter | Total errors |
| `latency` | Histogram | Response times |
| `memory` | Gauge | Memory usage |
| `cycles` | Gauge | Cycles balance |

## Alerting

### Webhook Alerts

```bash
# Configure webhook
agentvault monitor --alert --webhook https://hooks.example.com/alert
```

### Alert Payload

```json
{
  "canisterId": "abcde-aaaab",
  "alert": "cycles_low",
  "value": 500000000000,
  "threshold": 1000000000000,
  "timestamp": "2026-02-12T14:30:00Z"
}
```

### Alert Types

| Alert | Trigger |
|-------|---------|
| `cycles_low` | Cycles below threshold |
| `memory_high` | Memory above threshold |
| `error_rate_high` | Error rate above threshold |
| `latency_high` | Latency above threshold |
| `canister_stopped` | Canister stopped unexpectedly |

## Log Analysis

### View Logs

```bash
# Recent logs
agentvault logs --canister-id <id>

# Follow logs
agentvault logs -c <id> -f

# Filter by level
agentvault logs -c <id> --level error

# Time filter
agentvault logs -c <id> --since 1h
```

### Log Levels

| Level | Description |
|-------|-------------|
| `debug` | Debug information |
| `info` | General information |
| `warn` | Warnings |
| `error` | Errors |

## Dashboard

The web dashboard provides visual monitoring:

```bash
cd webapp
npm install
npm run dev
```

Access at: `http://localhost:3000`

### Dashboard Features

- Real-time status updates
- Metrics visualization
- Log streaming
- Alert configuration
- Historical data

## Best Practices

### Monitoring Setup

- [ ] Enable health checks
- [ ] Configure alert webhooks
- [ ] Set up dashboard access
- [ ] Document escalation procedures

### Regular Checks

- [ ] Daily: Check cycles balance
- [ ] Weekly: Review error rates
- [ ] Monthly: Analyze trends
- [ ] Quarterly: Review and adjust thresholds

### Incident Response

1. Receive alert
2. Check dashboard for details
3. Review recent logs
4. Take corrective action
5. Document incident

## Related Guides

- [Troubleshooting](../user/troubleshooting.md)
- [Deployment](../user/deployment.md)
- [Backups](../user/backups.md)
