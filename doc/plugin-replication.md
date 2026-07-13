# Plugin Artifact Replication

Runtime plugin install, uninstall, and upgrade mutate the local npm tree on a
single replica. Without coordination, a second replica would serve a different
set of plugins — or none at all after a pod restart. Plugin artifact replication
solves this by publishing full-tree snapshots to shared object storage and
reconciling every replica to the latest snapshot automatically.

## Mechanics

### Generation ledger

Each published snapshot is a `.tgz` tarball of the entire plugin tree
(`~/.paperclip/plugins/`). The `plugin_artifact_generations` table is the
ledger: each row records a generation number, the object-storage key, a SHA-256
content hash, and the publisher's replica ID.

The generation number is a monotonically increasing integer. The table primary
key is also a unique constraint on generation, which the publish path exploits
as a CAS (compare-and-swap) primitive: only one writer can win a given
generation — concurrent installs race to claim the next integer and the loser
retries.

### Publish path (CAS)

Mutations — install, uninstall, upgrade — run inside the session-scoped
`"plugin-install"` advisory lock (`trySessionAdvisoryLock`, held on a dedicated
direct connection: the critical section spans an npm install plus tar+upload,
which is far too long for a pooled transaction-scoped lock). The lock is
try-acquire: if another mutation is in flight anywhere in the cluster the route
responds `409 {"error": "another plugin operation is in progress on this
instance"}` instead of queueing behind a minutes-long install.

Inside the lock the mutation runs on the replica's reconcile serialization
chain (`runExclusive`), in three steps:

1. **Converge first** — `reconcile()` brings the LOCAL tree to
   `max(generation)`. Without this, a replica that lags (worst case one 60s
   tick) would mutate a stale tree and its published snapshot would silently
   drop every newer peer install.
2. **Mutate** — the npm install/uninstall/upgrade plus registry write.
3. **Publish** — tar, upload, CAS-insert the next generation.

Because the mutation holds the serialization chain, no reconcile pass can swap
the tree out from under a running npm install on this replica; peers are
excluded by the lock.

The publish sequence is:

1. Read `max(generation)` from the ledger.
2. Tar the full plugin tree (`-C <pluginsDir> .`).
3. Compute SHA-256 of the tarball body.
4. Upload to object storage at `plugin-snapshots/gen-<N>.tgz` (where N = max + 1).
5. Attempt `INSERT INTO plugin_artifact_generations` for generation N.
6. On a unique-constraint violation (lost race): discard the object and retry from step 1, up to 5 attempts.
7. On success: write the local generation marker file and run GC.

The upload happens before the insert deliberately. A lost race orphans an
object in storage — harmless. An insert-before-upload would advertise a
generation whose tarball does not yet exist, which could cause reconciling
replicas to fetch a missing object.

### Marker file

A small text file, `.paperclip-snapshot-generation`, lives inside the plugin
tree itself. It contains the integer generation number that the local tree was
last verified to match. A missing or invalid file is treated as generation 0.

Because the marker lives inside the tree, a published tarball embeds the
publisher's marker from the previous generation — that stale value is harmless:
reconcile always rewrites the marker after swapping the tree in.

### Reconcile path

Replicas converge on the latest snapshot via `reconcile()`:

1. Read `max(generation)` from the ledger.
2. Read the local marker.
3. If local ≥ max: already current — mark synced, return.
4. Download the snapshot tarball for max generation.
5. Verify SHA-256 against the ledger row. Mismatch → abort (see Failure Modes).
6. Extract the tarball into a sibling staging directory (`<pluginsDir>.tmp-<gen>`).
7. Atomic swap: rename the live tree to `<pluginsDir>.old-<ts>`, rename the staging directory to the live path.
8. Write the new generation number to the marker file.
9. Call the hot-reload hook (errors logged, not rethrown — the tree is already swapped).
10. Best-effort cleanup of the old tree.

Reconcile calls are serialized on a chain shared with `runExclusive` mutation
sections: there are never two concurrent tree swaps, and a swap can never
interleave with an in-flight mutation. Calls that arrive while a follow-up pass
is already queued coalesce onto that pass instead of appending unboundedly. The
snapshot download is bounded by a 60s timeout so a wedged storage stream fails
the pass instead of parking the chain forever.

### GC

After publishing generation N, rows and objects older than `N - 2` are deleted
(keeping the last 3 generations). GC failures are logged but do not fail the
publish. Lagging replicas have a window of 3 generations to catch up before
their target generation is removed.

## Activation and gating

Replication is active when the storage provider is anything other than local
disk, or when `PAPERCLIP_PLUGIN_SNAPSHOTS=true` is set explicitly.

When replication is active:

- install, uninstall, and upgrade run under the session advisory lock (409 on contention), converge to the latest generation first, and publish a snapshot before responding;
- local-path installs are rejected (a local path references one replica's filesystem and cannot be meaningfully replicated);
- every replica reconciles at startup (before the plugin loader runs), on `plugin.ui.updated` live events (debounced 2s to coalesce install bursts), and on a 60-second periodic tick;
- after a snapshot swap, the loader reconciles its runtime: it loads newly installed plugins, unloads uninstalled ones, and restarts workers whose registry version moved (a peer upgrade would otherwise leave the old worker code running).

| Env var | Default | Meaning |
|---|---|---|
| `PAPERCLIP_PLUGIN_SNAPSHOTS=true` | unset | Force-enable replication regardless of storage provider. |
| `PAPERCLIP_PLUGINS_MUST_SYNC=true` | unset | When set, the replica reports `503 {"ready": false}` from `GET /api/health/ready` until its first reconcile converges on the latest snapshot. `GET /api/health` (liveness) is unaffected. Use this to hold new pods out of the load balancer rotation until they are current. |

With `PAPERCLIP_PLUGINS_MUST_SYNC=true`, point the Kubernetes `readinessProbe`
(or load-balancer health check) at `GET /api/health/ready` — the gate lives
there, not on `/api/health`, so that liveness probes do not restart a healthy
pod that is merely catching up. Note: in authenticated-mode deployments that
use a plain TCP readiness probe, the flag does not affect routing unless the
probe is switched to an HTTP probe against `/api/health/ready`.

Single-replica and local-disk deployments: replication is disabled. Every
method is a no-op and `isSynced()` always returns true. Behavior is identical
to pre-replication.

## Propagation bounds

- **Event-triggered reconcile (in-process):** when a `plugin.ui.updated` event
  fires, all subscribers on the same process receive it within milliseconds.
  After the 2s debounce, reconcile runs. Total latency from install to
  in-process plugin hot-reload is roughly 2–3s.

- **Cross-replica propagation:** subscribers on other replicas receive
  `plugin.ui.updated` once the live-events transport delivers it. Until the
  cross-replica live-events transport is deployed (tracked upstream in
  [paperclipai/paperclip#5875](https://github.com/paperclipai/paperclip/pull/5875)),
  the 60-second periodic tick is the worst-case cross-replica bound. Once the
  transport lands, cross-replica event latency will collapse to the same
  ~2–3s window. The mutation routes do not depend on this bound for
  correctness: they converge to the latest generation before mutating, so a
  lagging replica cannot lose a peer's install.

- **Startup:** a new or restarted pod reconciles synchronously at startup before
  accepting plugin load. With `PAPERCLIP_PLUGINS_MUST_SYNC`, it is also held
  out of load-balancer rotation until that reconcile completes.

## Failure modes

**Hash mismatch on download.** Reconcile aborts and logs an error at `error`
level. The live tree is untouched; the replica continues serving the previous
plugin set. This is a signal that the object in storage is corrupt or was
overwritten outside the replication path. Manual investigation is required.

**Replica cannot converge (persistent reconcile errors).** The replica serves
the plugin set it last successfully reconciled to, and logs errors on every
failed reconcile attempt (both the 60s tick and event-triggered). With
`PAPERCLIP_PLUGINS_MUST_SYNC=true`, the pod reports not-ready from
`/api/health/ready` and a readiness probe pointed there removes it from
rotation; without it, the pod continues serving traffic with stale plugins.

**Publish failure during install/uninstall/upgrade.** The local tree mutation
succeeded (npm install ran, the registry row was written) but the snapshot
publish failed. The route returns `500` — louder is better here; a silent `200`
would leave other replicas unaware of a change they cannot converge to. The
operator should retry the install/uninstall/upgrade operation. The local mutation
is present but unreplicated until that retry succeeds.

**Orphaned objects in storage.** A lost CAS race uploads a tarball that is never
recorded in the ledger. These objects accumulate if GC does not cover them
(GC only deletes rows and their corresponding objects). They are harmless but
take up space; a periodic storage lifecycle rule can clean them up.

## Single-writer guarantee

The session-scoped `"plugin-install"` advisory lock serializes all mutating
operations across replicas that share the same PostgreSQL database; contenders
get an immediate `409` instead of queueing. The lock lives exactly as long as
its dedicated connection, so a crashed replica releases it implicitly. The CAS
on the generation primary key provides a second layer for any concurrent
writes that bypass the lock (e.g. from a misconfigured replica or a direct DB
operation). Both guarantees are needed: the lock ensures only one mutation
runs at a time; the CAS ensures the ledger remains consistent if the lock is
ever absent.

## Npm-only constraint

Local-path installs are rejected while replication is active. A local path
references a directory that exists only on the installing replica — tarring and
shipping that path to peers would replicate symlinks, dev checkouts, and other
host-specific state that other replicas cannot reconstruct. Publish the plugin
as an npm package and install it by name instead.

## See also

- `server/src/services/plugin-artifact-replication.ts` — service implementation
- `server/src/routes/plugins.ts` — `withReplicatedPluginMutation`, `PluginRouteReplicationDeps`
- `doc/scheduler-leadership.md` — analogous single-writer lease pattern for the heartbeat scheduler
