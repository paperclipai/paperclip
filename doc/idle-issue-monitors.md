# Issue monitor scheduling

Paperclip reconstructs monitor deadlines from saved issue rows at server startup.
While running, supported issue, execution, company, and native-run services
notify the monitor worker when their database transactions commit. The worker
uses those notifications to re-read durable state. It does not depend on a
process-local queue count for correctness.

Notifications are batched for up to the configured heartbeat interval (normally
30 seconds). This bounds global monitor scans during frequent task edits. An
already-known monitor deadline can fire earlier than the batching window.
After all work settles, no periodic monitor scan remains. Pending claims and
failed or deferred admissions retain their bounded deadlines.

Both idle drains and ordinary maintenance drains pause monitor dispatch. The
worker retains its pending request without repeatedly reading monitor tables.
After an explicit drain stop or TTL expiry, a bounded in-memory retry resumes
that request. Shutdown cancels local timers; restart reconstructs durable work.

## Supported writers

Use Paperclip's API and services to create or change monitor work. These writers
share the serving process's database-work notification scope, including nested
transactions and uncertain commit reconciliation. Supported import paths also
use these service boundaries or startup reconstruction.

Independent SQL clients, other service processes, and additional server replicas
do not publish into that process-local scope. Their direct writes are not
supported live monitor producers. Restart reconstructs saved rows, but that is
not a live cross-process delivery guarantee. Such integrations need an explicit
ingress or durable notification contract before they can rely on monitor wakes.
There is no unconditional recovery poll for unsupported writers.

## Scope of the sleep claim

An idle monitor worker can stop its SQL activity. This alone does not prove that
the host or database will suspend. Cloud's existing external alarm and sleep
safety checks remain in place; an in-process timer cannot wake a suspended host.
