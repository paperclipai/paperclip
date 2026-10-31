# External object refresh deadlines

External-object refresh uses the delivery coordinator. The server registers the
service in both heartbeat-scheduler configurations. It no longer calls the
company-wide aggregate sweep on each heartbeat tick.

`external-objects.ts` owns automatic eligibility, resolver selection, refresh
claims, provider results and the next deadline. `index.ts` supplies registration
and admission gates. The existing scoped deadline helper owns wake coalescing,
page reconciliation, fair company selection, retry backoff and shutdown.

## Durable obligations and quiet states

An automatic refresh needs an active company, a retained mention in that company,
a non-null `next_refresh_at` and an available resolver. Injected resolvers,
including custom `url/link` resolvers, remain supported. A plugin resolver needs a
ready plugin with `external.objects.read`, a matching provider/object declaration,
and no company setting that disables it. Built-in resolvers remain available
independently of optional plugin support.

A plugin result carries its selected plugin ID inside the host owner. Persistence
rechecks that exact plugin's readiness, read capability, object declaration and
same-company enabled setting in the result update. Another available resolver
cannot authorize an obsolete plugin response. A rejected response releases only
its own claim; the due row remains for a fresh allowed resolver. Plugin RPC
payloads and public result shapes do not contain this host selection context.


Terminal objects are passive. The existing exception remains: GitHub
`not_found` snapshots without `data.probeVerified=true` need a repository-visibility
probe before their terminal verdict is definitive. A null deadline retains its
existing never-refresh meaning. Registration does not change stored timestamps.

The worker reconstructs eligible deadlines in pages of at most 250 rows. A
company notification reads that company only. Ordinary ingestion uses object IDs
or stable provider/object/external identity hints, including concurrent upserts,
so one mention write does not reconstruct all company history. A due callback reads only its
object. Pages select scheduling columns and retain compact deadlines in memory.
Dispatch uses fair batches of at most 50 objects. The deadline is the later of
`next_refresh_at` and the current refresh lease expiry. Lease renewals and atomic
refresh tokens continue to exclude another claimant.

Unsupported generic links, orphan objects, disabled plugins, empty configuration
and retained terminal history do not schedule fallback discovery. Manual refresh
retains its existing `no_resolver` result. Actual provider failures retain their
saved retry deadline. Unexpected failures retain scoped coordinator backoff;
restart reconstructs the saved object and any unexpired claim.

The supported-resolver and retained-reference approach follows the related draft
[PR #17298](https://github.com/paperclipai/paperclip/pull/17298) by
[@kaluli123123](https://github.com/kaluli123123). This change adapts that eligibility
pattern to scoped scheduling, adds dynamic plugin/company permission predicates,
and fences automatic result persistence. It does not modify that draft PR.

## Producer and transaction audit

| Mutation | Owner and activation |
| --- | --- |
| Issue title/description, comment and document references | Existing sync methods register object intent before mention replacement and stable identity intent before object upsert. Routes, runtime tools, adapters and plugin paths reuse these methods. |
| Comment/document disappearance | Sync derives the retained mention owners and registers only those companies before deleting obsolete mentions. |
| Last mention removal and reattachment | Mention replacement invalidates company deadlines. Retained objects stay available for reattachment. |
| Issue deletion | Issue service registers its company before cascading mention deletion. |
| Company status/archive/deletion, including budget pause/resume | Company and budget services register company reconstruction before status or deletion writes. |
| Feature enable/disable | Instance settings registers global reconstruction before the experimental-settings write. |
| Plugin manifest/status/uninstall | Plugin registry registers reconstruction before lifecycle writes. Installed plugins acquire support through the ordinary ready transition. |
| Plugin company configuration and enabled setting | Registry writes register only the affected company. There is no plugin-readiness poll. |
| Manual and automatic resolver result | Result persistence registers object intent in the same transaction. Automatic persistence rechecks reference and resolver eligibility. Lost support releases the worker's own claim without publishing the stale result. |
| Normalized GitHub ingress | The event service registers company intent with the snapshot write. It clears the old refresh token, so an older provider response cannot overwrite that event. |
| Import and restore | No independent object-table importer exists in the source baseline. Supported reference ingestion uses the ordinary sync boundary. Startup reconstructs restored durable objects. |

Notifications are awaited before writes. Caller-owned and nested transactions
retain the outer commit boundary through the existing database-work protocol.
Rollback does not publish the write. Notifications received during a scan or an
active resolver remain dirty until a successful reconciliation.

The supported live writer model is one shared `createDb` signal owner, including
its transactions and child pools. These process-local signals do not cover
independent SQL clients or other replicas. Such writers must invoke the supported
service boundary or arrange explicit reconstruction/restart. Existing normalized
GitHub ingress uses the supported boundary. No permanent database listener or
periodic global safety scan is added.

## Acceptance evidence

The focused suite uses real PostgreSQL with a controlled simulated provider.
Ordinary sync and registry/settings writes create work; the fixture does not
pre-create the tested resolved outcome. Assertions independently read saved
objects. Tests measure owner reads and provider calls across former tick windows.

Coverage includes empty and terminal quiet, unsupported links, orphan removal and
reattachment, feature/company eligibility, plugin readiness and permission loss
during a held provider call, exact and earlier deadlines, durable provider retry,
rollback and outer commit after nested savepoint release, startup and paginated
reconstruction, inactive companies, never-refresh rows, first work during drain,
warm standby, failed refresh after restart, lease renewal, duplicate exclusion,
and shutdown while a provider call remains active. The GitHub ingress suite also
checks a real normalized event superseding a held resolver response.

The conservative external-object host-sleep blocker remains. An in-process
deadline cannot wake stopped compute. This change proves worker quiet and
reactivation in the tested process; it does not establish Cloud alarm coverage,
host/database suspension or deployed savings.


## Host cancellation and registered ownership

The resolver contract accepts an optional host `AbortSignal`. The worker passes
its coordinator signal through refresh to the resolver. This reuses the narrow
provider-owned capability introduced with merge-confirmation work: GitHub combines
host cancellation with a ten-second request budget for real fetch, response-body
reads and visibility probes. Plugin RPC payloads remain unchanged. The host
observes cancellation while retaining handlers for any eventual plugin/custom
result; it releases only its own claim and cannot publish that late result.
Startup does not await provider work. Shutdown closes the active GitHub HTTP
request, and its saved due row can resume immediately after restart.

The old `refreshDueObjects*` batch helpers are removed. Existing selection,
lease, concurrent manual refresh, terminal-history and not-found recovery tests
now enter through the registered scheduler owner. The removed baseline control
recorded six SQL reads over three empty aggregate ticks; the current quiet-work
acceptance measures zero recurring SQL after settlement. The scheduled check retains its
post-refresh scoped read to revalidate current company, reference and resolver
eligibility and recover an authoritative lease after a competing writer; all such
reads target one object rather than rebuilding a company.
