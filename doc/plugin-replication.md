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

Mutations — install, uninstall, upgrade — run inside the `"plugin-install"`
advisory transaction lock. That serializes writers within a single database
connection context. The publish sequence inside that lock is:

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

Reconcile calls are serialized: a new call that arrives while one is in-flight
queues exactly one follow-up pass behind it. There are never two concurrent tree
swaps.

### GC

After publishing generation N, rows and objects older than `N - 2` are deleted
(keeping the last 3 generations). GC failures are logged but do not fail the
publish. Lagging replicas have a window of 3 generations to catch up before
their target generation is removed.

## Activation and gating

Replication is active when the storage provider is anything other than local
disk, or when `PAPERCLIP_PLUGIN_SNAPSHOTS=true` is set explicitly.

When replication is active:

- install, uninstall, and upgrade run under the advisory lock and publish a snapshot before responding;
- local-path installs are rejected (a local path references one replica's filesystem and cannot be meaningfully replicated);
- every replica reconciles at startup (before the plugin loader runs), on `plugin.ui.updated` live events (debounced 2s to coalesce install bursts), and on a 60-second periodic tick.

| Env var | Default | Meaning |
|---|---|---|
| `PAPERCLIP_PLUGIN_SNAPSHOTS` | unset | Force-enable replication regardless of storage provider. |
| `PAPERCLIP_PLUGINS_MUST_SYNC` | unset | When set, the replica reports `503` from `/api/health` until its first reconcile converges on the latest snapshot. Use this to hold new pods out of the load balancer rotation until they are current. |

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
  cross-replica live-events transport is deployed, the 60-second periodic tick
  is the worst-case cross-replica bound. Once the transport lands, cross-replica
  event latency will collapse to the same ~2–3s window.

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
`PAPERCLIP_PLUGINS_MUST_SYNC`, the pod reports unhealthy and the load balancer
removes it from rotation; without it, the pod continues serving traffic with
stale plugins.

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

The `"plugin-install"` advisory lock serializes all mutating operations across
replicas that share the same PostgreSQL connection. The CAS on the generation
primary key provides a second layer for any concurrent writes that bypass the
lock (e.g. from a misconfigured replica or a direct DB operation). Both
guarantees are needed: the lock ensures only one mutation runs at a time; the
CAS ensures the ledger remains consistent if the lock is ever absent.

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
