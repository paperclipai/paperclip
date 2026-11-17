# Database client internals

Diagnostics and driver details for `packages/db`. Setup and migration rules are in [DATABASE.md](DATABASE.md).

## Bounded response diagnostics

`PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW=<start>/<end>` enables one explicit UTC
window. Both timestamps use ISO format ending in `Z`. The window lasts at most
60 seconds and starts within 30 minutes. Unset, invalid, and expired windows
leave database construction unchanged. An expired window stays inactive after a
restart; remove the setting after the investigation.

The diagnostic measures awaited Postgres.js `unsafe` responses before Drizzle
column decoding. It issues no queries. Configuration is read when each database
client is created; setting the environment on an already-running process does
not install the capture on existing clients. Prepare the deployment artifact
before choosing the UTC window, then start the window after rollout and warm-up.

Server entry points use `withDatabaseOperation(owner, action)` to name the work
that executes queries. Owners are fixed semantic labels, never request paths,
company or run IDs, user input, or SQL. The execution owner is captured for each
query and retained through completion, including transactions and dedicated
pools. A prepared query reused by different operations keeps the owner of each
execution. The builder caller is separate from that execution owner.
Owner context is active while a valid future window is armed, up to 30 minutes
before its start, so work that crosses the start boundary keeps its owner. Query
accounting starts only at the window start. With no armed window, or after
expiry, the owner helper calls the action directly without a context scope.

The capture aggregates owner, static schema table, operation, calls, returned
rows, query errors, and total/maximum completion wall time. `totalWallMs` and
`maxWallMs` include pool, database, network, and event-loop waits; they are not
CPU measurements, and concurrent query durations overlap. Timing excludes the
capture's response sizing. Rank calls and returned rows both per second and per
completed service operation; a busy owner is not necessarily wasteful.

Response sizing samples successful results 1, 17, 33, and so on per aggregate
group (`sampleEvery: 16`). It examines at most
256 cells, 65,536 string code units, and 65,536 value bytes per sampled result;
an individual string over 16,384 code units is not measured. Parsed objects and
other complex values are not serialized. Oversized, complex, or unexamined
values leave an incomplete sample. `sampledValueBytes` is a lower bound over
sampled primitive values, not a total response-size estimate or network bytes.
Do not extrapolate it as the total bytes returned by the database. Inspect
`sampledResults`, `sampledRows`, `measuredValues`, `unmeasuredValues`, and
`incompleteSamples` alongside it. `sizingWallMs` records the diagnostic's sizing
work separately. Use a separate capture-disabled CPU profile to measure normal
processing cost.

The diagnostic emits at most 2,048 aggregate groups and a summary. Measurement
stops at the deadline. Environment-enabled
captures emit at most 64 records per second and can take another 33 seconds to
finish writing the bounded output. Wait for the summary before collecting it.
It never logs SQL, parameters, result
values, connection strings, or query errors. In-flight queries continue normally.

Semantic owners work in a bundled server without source maps. Specific owners
avoid stack capture. The generic `http.request` owner keeps its exact name but,
like an unowned query, also captures a bounded caller location during the window.
For wrapped query builders, a map-free hosted bundle retains one static generated
construction-site anchor (`dist-runtime/server.mjs`, `index.mjs`, or
`chunk-<build hash>.mjs`, with line and column). Correlate it with the exact serving
revision and bundle; it is not a TypeScript location or an execution-time CPU
owner. Capture wrapper frames are excluded before reading the stack, and deeper
frames in the same bundle are omitted.

Unscoped driver calls, including relational queries, do not accept generated
anchors: a bundled ORM helper could otherwise be mistaken for an application
caller. They can still retain existing public source/dist locations; linked
source maps and Node's `--enable-source-maps` may help resolve those locations.
Restore prior Node options after capture. Missing callers remain unknown and
still contribute to totals. Disabled, future and expired windows do not capture
stacks; wrappers installed for an armed window remain after expiry. Active census
stack capture, grouping and bounded sizing add measurement overhead. More caller
groups still share the existing group, page and output-rate caps. This diagnostic
is not a production performance improvement.

Look for `paperclip.db_response_capture.entry.v2` and
`paperclip.db_response_capture.summary.v2` in the process logs. Version 2 uses
sampled, bounded primitive-value sizing; do not interpret it as the version 1
all-result byte estimate. A log provider
can store `event` as a structured field instead of message text. Filter by that
field or read the bounded window from the exact deployment. Check the summary
and group totals, including the unattributed overflow group.

Fetch a complete capture as follows:

1. Read the summary events from the exact deployment and window. Keep each
   distinct `captureId` separately.
2. Each entry has a unique `groupIndex` within that capture and a `groupPage`.
   The summary gives `groupPageSize` (128) and `groupPages`. Fetch every page
   from zero through `groupPages - 1`, filtering on the entry event, `captureId`,
   and `groupPage`. Request at least `groupPageSize` matching records per page.
   A structured query can use
   `@event:paperclip.db_response_capture.entry.v2 AND @captureId:<id> AND @groupPage:0`.
3. If the provider's record limit is smaller than a page, fetch each
   `groupIndex` separately with the same capture ID. Each index matches one
   entry. Do not split by timestamp: entries can share a timestamp.
4. Deduplicate by `(captureId, groupIndex)`. Require every index from zero
   through `groups - 1`, with no gaps. Entry count must equal `groups`, summed
   `calls` must equal `completedQueries`, and summed `rows`, `sampledResults`,
   and `sampledValueBytes` must equal their summary totals. A missing page is an
   incomplete measurement. Keep overflow and unattributed groups visible.

Tagged raw-driver calls, streams, unawaited raw-driver
dispatch, and protocol overhead are not measured. Relational queries use a driver-level caller fallback.
Queries still in flight at the deadline are reported separately. The census does
not include every PostgreSQL statement or internal transaction command, so its
calls are not interchangeable with database-wide commit counters. It does not
measure SQL compilation, driver parsing CPU, or Drizzle row-mapping CPU. Use the
ranked owners to choose a narrow follow-up profile or synchronous-stage
measurement; do not attribute CPU by subtracting process CPU usage across an
asynchronous query. Remove the capture setting after collecting its final
summary; the absolute deadline already prevents further measurement.

## postgres.js patch

Source builds carry `patches/postgres@3.4.9.patch` for this behavior. It rejects
queued and later queries from a disconnected transaction or reserved connection,
and prevents a released, closed connection from returning to the open pool.
The patch covers both ESM and CommonJS. The regression suite terminates real
PostgreSQL backends and checks rejection, pool recovery, and transaction isolation.
Remove the patch when an upstream release passes these tests. Installs of the
unmodified `postgres` package outside this workspace do not include the patch.

The patch also preserves transaction connection reservation when pipelining is
disabled with `PGMAX_PIPELINE=0`. Without this fix, the driver's pipeline capacity
check skips the transaction reservation callback and `BEGIN` fails with
`UNSAFE_TRANSACTION`. Disabling pipelining makes a queued query wait for the next
available pool connection instead of sending it behind unrelated work on a busy
connection. This can help interactive requests that share a prepared-query pool
with slow background work. It does not make the SQL itself faster. The default
pipeline limit remains unchanged. Test transaction behavior before using this
setting with a driver build that does not include the patch.

The patch also releases a connection's receive buffer when the connection has
read every message in it. Without this fix, an idle connection keeps the buffer
of its last read until its next read: the socket chunk, or the whole buffer of
its largest recent message. At 340 open connections that each read a 1 MB row,
this held about 320 MB of `external` memory. The memory is outside the
JavaScript heap. `packages/db/src/postgres-receive-buffer.test.ts` checks that
the buffer is released. It also checks that results are reassembled correctly
when socket chunks end exactly at message boundaries, when they split messages
in the middle, and when the operating system chooses the chunks. Measure it with
`pnpm --filter @paperclipai/db exec node --expose-gc --import tsx scripts/benchmark-postgres-receive-buffer.ts`
(`CONNECTIONS` and `ROW_BYTES` are optional).

The patch also keeps the driver's connection queues proportional to the
connections they hold. Without this fix, the queue of idle connections keeps an
empty slot for every query it has handed out until it is completely empty. A
busy pool always has some idle connections, so that queue never empties. Each
new query then scans one slot for every query the process has already run. In a
simulation at 1,000 statements per second, dispatching a query used about 15%
of the main thread after 17 minutes, and the cost kept growing. The patched queue removes
the empty slots once there are more than 1,024 of them and more empty slots
than queued connections. It also searches only the queued connections.
`packages/db/src/postgres-queue.test.ts` checks the queue order and the work per
query, and `packages/db/src/postgres-queue-pool.test.ts` checks a real pool.
Measure it with
`pnpm --filter @paperclipai/db exec tsx scripts/benchmark-postgres-queue.ts`
(`SIMULATED_QUERIES` and `QUERIES` are optional).

## Relational queries inside transactions

Drizzle builds one relational query builder for every schema table when it
creates a database object, and it creates one for each transaction and each
savepoint. With the Paperclip schema that is about 100 KB per transaction.
`createDb` therefore opens transactions through a second Drizzle client on the
same postgres.js client, created without the schema, and builds `tx.query` the
first time a transaction reads it (`packages/db/src/lazy-transaction-queries.ts`).
`db.query`, `tx.query`, and `tx._` keep their contents. `BEGIN`, `SAVEPOINT`,
commit, rollback, and connection reservation remain Drizzle's and the driver's.

Measure the cost of a transaction and a savepoint with the command below. It
needs Node.js 25 or later, because Node.js 24 has no V8 allocation counter, and
it stops with that message on an older runtime:

```sh
cd packages/db
TSX_DISABLE_CACHE=1 node --expose-gc --import tsx scripts/benchmark-transaction-allocation.ts
```
