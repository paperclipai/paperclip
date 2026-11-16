# Rich link status caching

Rich link metadata belongs to the link preview service. GitHub pull requests are
the first provider. Links retain their exact navigation URL and use a canonical
resource URL for cache identity.

`link_previews` stores company, viewer, channel, resource kind, canonical URL,
free-form status, JSON metadata, check time and freshness expiry. It has no task
foreign key. The same resource on different tasks reuses a record. Channel,
resource kind, status and metadata are not GitHub enums; future provider adapters
can use their own values. This change does not register plugin resolvers.

Personal provider access remains viewer-scoped. The unique index is
`(company_id, viewer_id, canonical_url)`. The empty viewer is reserved for local
trusted mode. Company/board authorization runs before cache reads. Neither cache
endpoint is accessible to agents. Personal results never enter `external_objects`.
A cache fill is derivative read data; it does not mutate tasks or produce activity
feed events. Cache HTTP responses use `private, no-store`.

The browser registers mounted rich links after render. Up to 200 unique links
per active company view are eligible for automatic enrichment; further links
still work on hover/focus. One request reads up to 50 cached previews using one
indexed database select, without provider calls or task joins. The read-only GET
route also supports viewer-role members. Encoded request URLs stay below 6 KB. Duplicate links
share one browser query. Fresh browser results take precedence over older database
reads. Cache failures are quiet and do not block the task page.

After document load, core query settlement and a 500ms quiet delay, browser idle
callbacks resolve stale or missing status with at most three requests in flight.
Hover/focus uses the same query and server path, so overlapping requests coalesce.
Queued links are removed on unmount and scope changes dispose the coordinator.
There is no recurring refresh, window-focus lookup or server background worker.
New links from subsequent page content get their own one-shot enrichment.

The existing provider timeout, fixed-host lookup, managed connection selection,
public-access checks, negative cache window and process concurrency bound remain.
Provider results are stored before the successful lookup response completes when
the store is available within the shared five-second deadline. Stalled SQL keeps
its concurrency slot until it settles; the deadline still releases the response.
Expired process entries re-read durable storage before provider work. Both batch
reads and lookup fallback use check time to retain the newest known status; a
longer cache lifetime does not make an older status newer. When the durable read
fails too, provider-failure backoff stays local, so it cannot overwrite a saved
status that this process could not read. Database outages fall back to the
optional process cache/provider path. Successful
and unavailable results normally remain fresh for one minute; provider backoff
can extend that window up to one hour. Expired records retain last known status
for immediate display. An outage keeps that status and saves the negative
freshness window, so the page does not repeatedly retry.

Each company/viewer scope retains at most 1,000 rows. A write removes rows beyond
that limit, keeping the newest check times, and rows whose freshness expired more
than 30 days before the write's check time. A transaction-scoped advisory lock
serializes writes for that scope across replicas, so concurrent URL misses cannot
exceed the cap. Cleanup makes no queries during page hydration and starts no
background worker. Inactive scopes remain bounded and are cleaned on their next
write; company deletion removes all their rows. Normal stale status remains
available until it ages out or the scope reaches its quota. Negative results use
the same cap and retention policy as known status.

The single-link lookup route also limits each company/viewer to 600 requests per
minute per server process, using the existing in-memory request limiter. Excess
requests return 429 with Retry-After. Cached batch reads remain available during
that backoff and do not allocate stored rows. The durable quota is enforced across
replicas and remains effective when process-local request limits reset.
