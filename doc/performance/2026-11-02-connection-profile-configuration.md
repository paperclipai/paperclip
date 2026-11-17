# Connection Permissions configuration read

Baseline: `3f8ebfff8aa9febd0733c6f65b07485dcadfd0e2`, which includes #18673
and #18681. This change removes unrelated profile reads from AppDetail. The
profile service owns selection and projection. The route retains the connection
management guard and the full-list route's per-profile visibility checks. The
legacy full profile endpoint remains unchanged.

The new configuration DTO contains saved profile fields and complete ordered
entries and bindings. It has no summary or pending-review counts. Selection
matches the old UI: `app:<connectionId>` at any status, plus active
`connection_intent` profiles with exact metadata/key and a matching agent binding.
This is a presentation view, not effective access. Complete bindings preserve
save behavior and the empty-binding install fallback.

## Local experiment

Run with Node 24, pnpm 9 and installed dependencies:

```sh
node --expose-gc --import ./server/node_modules/tsx/dist/loader.mjs \
  server/scripts/benchmark-connection-profile-configuration.ts 5
```

The benchmark uses the existing real PostgreSQL profile fixture: 200 heavy
profiles, 76,000 rules, 1,900 active tools, 695 removed tools, and 12 agents. It
adds ten eligibility cases and one cross-connection rule. The selected connection
has two profiles and 1,391 rules. Each sample asserts equality of the complete
ordered selected configuration against the old full-list selection. Selected
rules are not truncated, even when they refer to another connection.

Five alternating unprofiled pairs ran in a coordinated quiet window on
macOS/arm64, Node v24.22.2, with forced GC before samples. Times below are
median [minimum, maximum] milliseconds. CPU measures Node process CPU, not
PostgreSQL CPU. The benchmark uses an identity visibility callback and excludes
HTTP, middleware, and authorization work. It separately serializes the actual
old full response and new configuration response.

| Measurement | Full list | Connection configuration |
| --- | --- | --- |
| Service wall | 200.927 [193.319, 213.390] | 6.414 [5.508, 6.973] |
| Node CPU | 262.751 [246.727, 271.573] | 27.525 [22.576, 29.308] |
| Select queries | 7 | 3 |
| Returned database rows | 78,139 | 1,397 |
| Actual response JSON bytes | 32,353,534 | 592,233 |
| JSON serialization wall | 90.714 [88.715, 99.304] | 1.644 [1.637, 1.745] |
| JSON serialization CPU | 90.644 [88.569, 96.778] | 1.654 [1.637, 1.807] |

This establishes local service work and payload reduction. It does not establish
hosted latency, foreground responsiveness under load, or live provider behavior.
Cost still grows with the selected profiles' complete configuration. Current
agent authorization can separately read selected profile entries and bindings;
those reads are excluded from this benchmark and remain in the request path.

## Correctness and acceptance

- The PostgreSQL differential test covers exact eligibility, null/non-string
  agent metadata, inactive intent profiles, wrong key/source/bindings, sibling
  and unmanaged profiles, complete binding ordering, fresh entry changes, empty
  app bindings, denied profile selection, and company isolation.
- The assembled HTTP integration fixture exercises standard agent keys and run
  JWTs. It checks private account visibility, missing connections, and fresh
  permission revocation. A profile spanning a hidden account is omitted while
  the displayed connection stays readable.
- AppDetail's component suite covers saved access and action toggles, complete
  access restatement, install fallback, removing grants, errors, and refresh.
  The configuration key is a distinct child of the existing profiles prefix,
  so existing mutation and reconnect invalidations still refresh it.

Preserved setup failures: the offline install lacked a locked package tarball;
a frozen online install passed. The first database attempt failed on sandbox
localhost binding restrictions; the escalated real PostgreSQL run passed. The
first HTTP suite could not resolve the unbuilt plugin SDK; the owning
`ensure-build-deps` command built it and the retry passed. A missing shared
barrel export failed the first shared typecheck and was fixed. The first broad
typecheck inherited an unpinned nested pnpm executable; its stalled owned
processes were stopped and the command was restarted with a pinned pnpm wrapper.

The added foreign-company HTTP assertion first expected 403. The existing guard
returned 404 to hide the resource, as designed. The test expectation was corrected;
production authorization did not change.
