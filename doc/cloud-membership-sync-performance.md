# Cloud membership synchronization

Trusted Cloud requests synchronize the user's profile, company membership and
default grants before they resolve authority. Synchronization writes are shared
only within one database client and process. Requests with different contexts
for the same user execute in order. An A, B, A sequence still applies all three
contexts. Other users can proceed independently.

Successful identical contexts retain the existing five-second write debounce.
Failed or partial synchronization invalidates the prior success, so a retry can
repair it. Membership reads, owner-elevation settings and stale administrator
removal remain fresh on each request. This cache does not store actors.

Guarded upserts preserve `updated_at` when profile fields, role and status do not
change. They still repair missing default grants. Access lists now sort these
rows by their last actual change. Profiles remain reachable beyond the first
200 memberships: lookup uses the existing company/principal index for an exact
principal ID, then at most one company-scoped alias query returning one row.
An exact ID takes precedence over another member's name, matching the UI's
stable-ID links. Name, email and normalized non-UUID ID aliases retain their
newest-membership-first ordering. A missing slug performs two queries, with no
membership paging. The fallback still scans company candidates; it does not
add an expression index or claim constant database CPU at every company size.

## Reproduce the local comparison

From the repository root, use a disposable PostgreSQL 17 container:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-cloud-membership-sync.ts \
  --baseline-ref=db70c5acd92f50fa37fb4f0dea3da0e7685089a2 --docker-postgres=17 \
  > /tmp/cloud-membership-sync.json
```

The harness imports the actual resolvers, applies normal migrations, seeds
synthetic data and removes its container. It does not use `DATABASE_URL`.
Two warmup pairs precede five alternating measured pairs. Each pair uses a
fresh synchronization scope and 20 simultaneous requests for one unchanged
user. Row triggers count updates, including updates that preserve values.

PostgreSQL 17.11 measured a median 51.07 ms before and 25.71 ms after. The ranges
were 47.21–63.25 ms and 24.17–29.32 ms. Membership statements fell from 20 to one,
and profile plus membership tuple updates fell from 40 to zero. All 20 complete
actor results matched on every sample. This measures local service work and
authority reads. It does not establish production request latency or remove
locks across replicas.

## Safety checks

Run the Cloud actor, Cloud transient database retry, company provisioning,
Cloud synchronization PostgreSQL and user profile route suites. They cover
coalescing, A/B/A transitions, failed partial writes, expiry, distinct users and
databases, grant repair, real role-change invalidation, imported-membership
revocation, owner-flag changes and cross-company denial. The profile regression
first returned 404 with the former 200-row lookup. The fixture now contains
601 memberships with timestamps differing within one millisecond. It checks
raw and normalized non-UUID IDs, a missing slug's two-statement bound, tenant
isolation, exact-ID priority and fallback ordering. Real PostgreSQL requests
compare all four alias fields against the route's own JavaScript canonical
slug output, including quotes, whitespace, punctuation, Unicode and email edge
cases. An exhaustive Unicode lowercase check verifies the two non-ASCII
characters that need explicit ASCII mappings in the SQL predicate, avoiding
database-locale differences. Whole-character replacements precede an
ASCII-only `translate`, preserving UTF-8 byte sequences on legacy `SQL_ASCII`
databases. A disposable `SQL_ASCII` database applies normal migrations and
exercises all four alias fields with en/em dashes, euro signs, neighboring
multibyte characters, dotted I and Kelvin signs. It also verifies that a euro
sign cannot incorrectly match the profile alias `k`.

No schema migration, startup work or deployment is required by this change.
