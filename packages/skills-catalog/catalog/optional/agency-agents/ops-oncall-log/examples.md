# On-Call Log — Examples

## Example: Weekly Log (Confluence)

**Input:** `/spartan:ops-oncall-log Mar 21 - Mar 28`

**Generated page:**

```markdown
# On-call Log: Mar 21 2026 – Mar 28 2026

## Alert Summary

| Alert | Count | Times | Cause | Resolution |
|-------|-------|-------|-------|------------|
| [High CPU on api-gateway](https://monitoring.example.com/monitors/12345) | 5 | [Mar 22 06:07 PM](https://monitoring.example.com/event/1), [Mar 23 02:15 AM](https://monitoring.example.com/event/2), [Mar 24 06:12 PM](https://monitoring.example.com/event/3), [Mar 25 01:30 AM](https://monitoring.example.com/event/4), [Mar 27 11:45 PM](https://monitoring.example.com/event/5) | _(to fill)_ | _(to fill)_ |
| [DB connection pool exhausted](https://monitoring.example.com/monitors/67890) | 3 | [Mar 22 09:30 PM](https://monitoring.example.com/event/6), [Mar 24 03:00 AM](https://monitoring.example.com/event/7), [Mar 26 08:15 PM](https://monitoring.example.com/event/8) | _(to fill)_ | Still active |
| [5xx spike on payments](https://monitoring.example.com/monitors/11111) | 1 | [Mar 25 04:22 PM](https://monitoring.example.com/event/9) | _(to fill)_ | _(to fill)_ |

**Total alerts:** 9 across 3 unique monitors

## Currently Active Alerts
- DB connection pool exhausted — active since Mar 26

## Notes
Payments 5xx was a transient issue caused by a third-party API outage. No action needed.

## Action Items for Next On-call
- Investigate recurring CPU alert on api-gateway — 5 triggers this week
- Follow up on DB connection pool — still active, may need pool size increase
```

## Example: Daily Log (Notion)

**Input:** `/spartan:ops-oncall-log today`

**Generated page:**

```markdown
# On-call Log: Mar 28 2026

## Alert Summary

| Alert | Count | Times | Cause | Resolution |
|-------|-------|-------|-------|------------|
| [Memory warning on worker-service](https://monitoring.example.com/monitors/22222) | 2 | [Mar 28 03:15 AM](https://monitoring.example.com/event/10), [Mar 28 07:45 AM](https://monitoring.example.com/event/11) | _(to fill)_ | _(to fill)_ |

**Total alerts:** 2 across 1 unique monitor

## Currently Active Alerts
None — all clear

## Notes
None

## Action Items for Next On-call
- Check memory trends on worker-service — 2 triggers today
```

## Example: No Alerts

```markdown
# On-call Log: Mar 14 2026 – Mar 21 2026

## Alert Summary

No alerts this period.

## Currently Active Alerts
None — all clear

## Notes
Quiet week. Deployed v2.3.1 of auth-service on Mar 18 with no issues.

## Action Items for Next On-call
- None
```
