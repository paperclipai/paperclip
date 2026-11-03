# Connection review counts

The contextual App sidebar uses `GET /api/tool-connections/:connectionId/review-counts`
for its Review badge. The response contains `pendingActionRequestCount` and
`quarantinedCatalogEntryCount`. The badge adds the pending count and one when the
quarantine count is positive. Both sidebar variants keep the 30 second cadence.
The key is a child of the existing company attention prefix so current mutations
and events still invalidate it.

The route uses existing connection read admission. It resolves UUIDs and UIDs,
checks company and current actor/responsible-user authority, and enforces personal
account restrictions before reading counts. An authorized archived connection
returns zero counts, as its absent legacy attention item did. Missing and hidden
connections retain normal admission errors. This read adds no execution authority.

The catalog owner reads two independent scalar aggregates in one SQL statement.
Pending counts join requests to invocations by invocation ID and constrain both
company IDs. SQL NULL signed arguments are excluded; empty signed text counts.
Multiple requests for one invocation count separately. No profile, rule or active
catalog projection runs for this read. The company-wide attention API is unchanged.

## Local performance proof (2026-11-02)

Baseline: `3f8ebfff8aa9febd0733c6f65b07485dcadfd0e2` on current master, including
both prior evaluator fixes (#18673 and #18681). Treatment is the count reader in
this change. Node v24.22.2, macOS, disposable real embedded PostgreSQL, one database
connection, no cross-request cache. The comparison calls the actual legacy
attention service and selects one connection's two counts, then calls the new
reader. All normalized results equal `{pendingActionRequestCount: 2,
quarantinedCatalogEntryCount: 3}`.

Fixture: 200 profiles, 76,000 rules, 1,900 active tools, 695 removed references,
12 agents, one sibling connection, six quarantine entries, signed/unsigned/resolved
requests and 2,000 unrelated historical invocations. Reproduction:

```sh
cd server
node --expose-gc --import ./node_modules/tsx/dist/loader.mjs scripts/benchmark-connection-review-counts.ts
```

After two warmup pairs, seven alternating measured pairs in a coordinated quiet
window produced:

| Service measurement | Legacy attention → selected counts | Scoped counts |
| --- | --- | --- |
| Queries | 7 | 1 |
| Returned application rows | 80,115 | 1 |
| Process CPU median (range), ms | 213.891 (209.329–228.552) | 1.680 (0.515–6.137) |
| Wall median (range), ms | 156.867 (151.739–162.289) | 1.248 (1.115–1.386) |

Separate work-volume instrumentation serialized database result values to JSON:
32,978,153 versus 66 bytes. This measures decoded application values, not network
bytes or HTTP response size. The legacy HTTP response never contains the rule
arrays. Work-volume serialization is disabled during every timed sample.

These are local source-service measurements, not deployed latency or capacity
claims. They exclude HTTP admission, network transport and serialization. They do
not measure PostgreSQL CPU. Scoped SQL still scans relevant pending/catalog data
using existing indexes; no migration or new cache was needed.

## Correctness and preserved failures

PostgreSQL differential tests cover sibling/company boundaries, multiple requests,
NULL and empty signed text, unsigned/resolved requests, null invocation connections,
cross-company historical references, unhealthy-only connections, archive/restore,
and changed rows between reads. Assembled HTTP tests use actual human sessions
and agent JWT authentication with explicit permissions. They exercise UID lookup,
missing/foreign resources, personal grant revocation and membership revocation.
Both sidebar variants have badge, disabled-before-identity and prefix invalidation
component tests.

The first SQL attempt embedded column references directly into scalar raw SQL.
Real PostgreSQL rejected the resulting ambiguous unqualified columns. Typed
Drizzle subqueries fixed that failure; the passing differential test exercises the
corrected query. An initial benchmark serialized result values inside its timed
instrumentation and inflated CPU. That run was discarded; the results above come
from a fresh alternating run with byte accounting outside timing. Initial HTTP
fixtures lacked agent membership/management grants and correctly received 403;
the accepted fixture supplies both and retains revocation denial checks.

The built static UI was also exercised in Chromium against an owned local-trusted
server and disposable PostgreSQL. The connection Permissions page showed Review 3,
issued the scoped count request, and made no company attention request. After
resolving requests and clearing quarantines, reload removed the badge. An archived
connection returned zero counts. This browser path uses board authority; separate
authenticated HTTP fixtures prove delegated agent authority. The first ad hoc
browser launcher omitted required decision-service options and failed at startup;
adding the standard no-op wake callback allowed the same journey to pass. No
product behavior was changed to recover that harness setup failure.

Required local recursive typecheck and full build passed. The first sandboxed
typecheck could not open the tsx IPC socket; the escalated rerun passed. Greptile
identified an invalid resolved-request fixture label (`denied`); it was corrected
to the declared `rejected` status. This preserves the non-pending exclusion that
the differential test verifies.

The first final-head CI run flagged the new explicit resource company assertion
because the route lacked a local `hasCompanyAccess` existence gate. Management
admission already rejects foreign resources with 404, but the route now also
follows the repository's two-step gate pattern. The static existence-oracle guard
and actual authenticated HTTP negative cases verify that pattern together.
