# Run diagnostics from a sandbox

The queue and HTTP/2 sandbox bridges admit these read-only routes through the
normal injected Paperclip API credential. The server still checks company,
authorization-boundary and private-task access, and applies its existing run
content and credential redaction. Admission through the bridge does not grant
access to another company's runs or a private task. A list can return a redacted
metadata stub for an unreadable run; count that as unread coverage rather than
inferring a failure cause.

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/api/companies/:companyId/heartbeat-runs` | Recent run history; use `?limit=200&summary=true` first (maximum 1000) |
| GET | `/api/companies/:companyId/live-runs` | Current active runs visible to this actor |
| GET | `/api/heartbeat-runs/:runId` | Run status, failure and execution details |
| GET | `/api/heartbeat-runs/:runId/events` | Run events; request bounded pages with `afterSeq` and `limit` |
| GET | `/api/heartbeat-runs/:runId/log` | Redacted log excerpt; use `offset` and `limitBytes` (maximum 1 MiB per call) |
| GET | `/api/heartbeat-runs/:runId/workspace-operations` | Workspace operation receipts for the run |
| GET | `/api/heartbeat-runs/:runId/issues` | Authorized task links for the run |
| GET | `/api/issues/:issueId/runs` | Run history for an authorized task |
| GET | `/api/issues/:issueId/recovery-actions` | Current and historical recovery records for an authorized task |

Start with recent run summaries, correlate exact task/run/workspace IDs, then
read only the necessary events or log excerpts. Report result caps and denied
reads explicitly. These routes do not authorize retry, cancellation, replay,
workspace repair, recovery resolution, or provider resource changes. Execution
control writes and provider-trace administration remain outside this bridge
diagnostic surface. Do not borrow a board token to work around a denial.
