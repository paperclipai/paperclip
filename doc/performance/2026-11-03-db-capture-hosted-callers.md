# Hosted database capture construction sites

The bounded database response census could not distinguish map-free hosted
query builders. The `http.request` semantic owner suppressed stack capture;
unowned generated runtime paths failed the public caller allowlist. The control
bundles the actual capture module and real Drizzle into one file, rather than
assigning an application filename to an isolated mock function.

The change preserves exact semantic owners. Generic HTTP and unowned builders
retain one safe generated construction-site anchor. A local V8 stack boundary
removes capture wrappers before reading the stack. Deeper shared-chunk frames
are omitted. Specific semantic owners stay stack-free. The public stack parser rejects generated
anchors by default; only the trusted builder wrapper explicitly enables them. Unscoped driver and
relational paths deliberately remain unknown in map-free bundles: their first
frame can belong to the ORM. Prepared builders retain construction provenance,
not the later consumer location. Resolve each anchor against the exact serving
revision and generated bundle. No TypeScript or CPU ownership is inferred.

The fixture checks exact generated application lines for select, prepare and
execute, including repeated parameters, transactions and nested savepoints.
It checks unknown raw/relational calls and zero stack captures for disabled,
future, expired and specific-owner cases. Existing real PostgreSQL tests retain
query/error identity, prepared execution, transaction propagation, primitive
sizing and expiry behavior. Existing cap tests retain 2,048 groups, 128-entry
pages and 64 output events per second. More callers can reach these caps sooner.

## Local diagnostic overhead

Baseline: `09162fe893b464dd2ccdafd14bd3ef1611202a86`.
Five alternating rounds per mode, 1,000 serial queries per sample, after 500
warmup queries for each variant/mode. There are 40 measured samples. Both variants
use the same real bundled ORM and fake postgres-js thenable. Capture creation,
output flushing, printing and validation occur outside timing. Samples include
ORM compilation, census metadata, stack formatting and async bookkeeping. Empty
results exclude meaningful result-sizing work. Node v24.22.2 ran on a shared
18-logical-CPU host; load averages were 7.13/6.66/6.12. No other owned benchmark
ran, but the host was not idle. CPU is process CPU, including JIT/GC.

Microseconds per query, median [minimum–maximum]:

| Mode | Variant | Process CPU | Wall |
| --- | --- | --- | --- |
| disabled | current | 11.767 [7.687–25.037] | 8.543 [7.637–8.917] |
| disabled | candidate | 9.934 [8.294–31.978] | 8.260 [7.897–8.665] |
| unowned | current | 21.675 [14.754–32.634] | 15.841 [14.633–16.434] |
| unowned | candidate | 21.865 [14.563–33.807] | 15.642 [14.370–16.377] |
| http.request | current | 15.461 [9.734–17.897] | 10.528 [9.531–10.910] |
| http.request | candidate | 17.662 [15.080–20.058] | 15.169 [14.589–15.986] |
| response.presentation | current | 10.704 [9.656–11.078] | 9.870 [9.544–10.500] |
| response.presentation | candidate | 12.323 [9.884–16.804] | 10.758 [9.683–10.810] |
For both unowned and generic HTTP queries, the control yields no caller for
1,000 queries. The candidate yields two distinct exact application anchors,
covering all 1,000 queries. Both variants keep the same specific semantic owner
without caller locations. Disabled mode has no capture groups.

This is an attribution improvement with active measurement cost, not a product
speedup. Ranges overlap and are noisy. The HTTP median wall delta is about 4.6
microseconds per query in this fixture. Do not treat this as exact hosted overhead:
there is no database/network latency, Sentry/OTel stack formatting or deployed
traffic mix. Wrappers remain installed after expiry; they do not capture stacks.
Samples precede a review correction that made the standalone public parser reject
generated anchors by default. The measured private builder path still opts in
explicitly and has the same behavior. No timing is attributed to that default-only
contract correction. All original samples and the expanded proof are in
[the evidence file](fixtures/db-capture-hosted-callers-overhead.json). Only the
machine-specific executable path is redacted in that public copy.

## Reproduce

Use Node 24 and the frozen repository dependencies. From the repository root:

```sh
pnpm exec vitest run packages/db/src/response-capture.test.ts packages/db/src/response-capture-bundle.test.ts packages/db/src/response-capture-postgres.test.ts
node packages/db/src/__tests__/response-capture-overhead.mjs 09162fe893b464dd2ccdafd14bd3ef1611202a86 1000 > capture-overhead.jsonl
```

The helper reads the pinned baseline with `git show` into an esbuild loader.
It does not retain a cloned implementation or change production files. It
removes its temporary bundles in `finally`. No source maps, network services,
SQL parameters or real company data are required. The PostgreSQL test needs
local embedded PostgreSQL support. Preserve failures if that setup is unavailable.
