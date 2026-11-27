# Per-turn follow-ups without re-uploading the repository

Status: measured. Snapshot seed chosen; not built. It is a scoped multi-day feature awaiting a decision (see "Experiment results").

## Problem

Per-turn remote sandboxes are the default (warm reuse, #20048, is on hold).
Each follow-up turn gets a fresh Daytona sandbox, and the controller uploads the
workspace into it again.

Measured on the paperclip repository clone (Daytona, Codex, per-turn), from the
run log's `workspace_sync.*` spans (baseline `ws-daytona-phases2`):

| Span | Cold turn | Follow-up turn |
|---|---|---|
| `workspace_sync.pack` (changed files) | 4.1 s | **0.54 s** |
| `workspace_sync.transfer` | 13.6 s | **13.3 s** |
| `workspace_sync.stage_workspace` | 17.8 s | 13.8 s |
| `runner.session.startup` | 5.5 s | 9.1 s |
| time to first token | 33.0 s | 31.2 s |

The follow-up's changes pack in half a second, but the transfer barely shrinks.
Each fresh sandbox receives the whole seed: the repository archive is 220 MB
(70 MB with gzip, 14,769 files), and 70 MB in about 13 s is about 5 MB/s from
the controller host to Daytona. Earlier per-turn runs measured 13–22 s per turn
for this transfer.

The host side already avoids rebuilding the seed: the workspace seed cache
(`workspace.seed_lookup`, `seed_replay`, overlay archive, deleted-file
manifest) packs only the overlay against a cached seed generation. The cost is
re-sending that seed over the controller's link on every turn.

## Goal

A follow-up turn on a fresh per-turn sandbox sends only the overlay (the
changed files and a deleted-file manifest against a content-hashed seed
manifest), and gets the seed from somewhere already inside the provider's
network. When anything is uncertain, it falls back to today's full upload.

Expected saving: about 12–13 s of the 13.3 s transfer per follow-up turn
(overlay upload under 1 s for typical turns), taking per-turn follow-up time to
first token from about 31 s to about 18 s on this repository. The remaining
large item is `runner.session.startup` (about 9 s: runner boot plus provider
session resume), which this design does not change.

## Design

**Seed identity.** The workspace seed cache already names a seed generation.
Key the provider-side seed by `(repository, base commit, seed generation
digest)`, with a content-hashed manifest (path → sha256, mode, size) stored next
to the seed.

**Where the seed lives, one of:**

1. **A Daytona snapshot per seed (preferred if it is fast to create).** The
   Daytona plugin already creates sandboxes from a named snapshot
   (`config.snapshot`). Build a snapshot whose image layers the seed over the
   runner image, once per seed key, and create follow-up sandboxes from it.
   - **Open question:** time to build a snapshot from a 70 MB context, and
     whether snapshot creation can run in the background after the first turn.
2. **A Daytona volume per seed.** Upload the seed archive to a volume once, then
   mount it in each per-turn sandbox and extract inside the sandbox.
   - **Open question:** volume read and extract time for 220 MB, which must stay
     well under 13 s to be worth it.

**Turn flow.**
1. Look up the seed key on the provider (snapshot or volume present and
   verified against its manifest digest).
2. If present: create the sandbox from the snapshot (or mount the volume and
   extract), then upload only the overlay through the existing `syncIn` path
   (files plus the deleted-file manifest), and verify the result with the
   existing workspace sentinel and `baselineSha256`.
3. If absent, unverifiable, or the overlay exceeds a threshold (for example
   20% of seed bytes, because the base moved far): do today's full upload, and
   build or refresh the provider seed in the background for the next turn.

**Safety.**
- The seed is read-only, keyed by content. A mismatch in the manifest digest
  falls back to the full upload, never to a partial workspace.
- The existing post-upload verification (sentinel, baseline hash) stays the
  final check before `turn.start`.
- Provider seeds are cleaned up with the environment and expire by age.
- Credentials never enter the seed: it is built from the same filtered
  workspace as today's upload.

## Next step: one bounded experiment

Before building anything, measure both seed locations with the existing harness
(`tests/restart-chaos/ttft-baseline.ts --env daytona --workspace-repo <paperclip clone>`):

1. Time to create a Daytona snapshot from the paperclip seed, and time to create
   a sandbox from it.
2. Time to mount a volume holding the seed archive and extract it inside a
   sandbox.
3. Overlay upload time for a typical follow-up (pack output 0.5 s).

Choose the location whose first-token time is lowest, then build it red/green
with a before-and-after measurement on the clone. That needs one Phase 3 harness
slot.

## Experiment results (2026-11-08)

Setup:
- Daytona `us`, 2 vCPU sandboxes, runner image `paperclip-daytona-runner@sha256:4b13c70a…`.
- The seed is a git archive of the paperclip clone: 58.7 MB gzip, 14,766 files.
- Timed with the Daytona SDK from the controller host, using a restricted key with snapshot and volume permissions.
- Every resource was deleted, and an account-wide listing confirmed none remained.

| Path | Per turn | One-time cost per seed generation |
|---|---|---|
| Direct upload (today) | create 0.97 s + upload 3.97 s + extract 1.43 s = **6.4 s** | none |
| Volume | create 0.86 s + extract from the mounted volume 5.95 s = **6.8 s** | create 6.8 s + writer sandbox 6.2 s + upload 5.3 s, about 18 s |
| Snapshot | create from snapshot 1.83 s; the seed is already in the image (copy 0.26 s; extracting it adds about 1.4 s unless it is extracted at build time) = **about 2–3.5 s** | **build 177 s** |

Findings:
- **The volume is ruled out.** Reading the archive from a mounted volume is slower than uploading it from the controller.
- **The snapshot wins.** It saves about 3–4 s per remote turn against this run's direct upload. It saves more when the controller link is slow: production follow-up transfers measured 6–16 s with zstd. That is below the 12–13 s estimated in "Goal", because direct upload was fast in this run.
- **Fork is unsupported** for these sandboxes (measured earlier the same day).
- **Transfer compression is exhausted.** The runner image already ships `zstd`, so production transfers are already compressed. #20104 adds a gzip fallback for images without zstd.
- **Snapshot builder facts:**
  - It runs as uid 1001 (`daytona`).
  - `Image.addLocalFile` copies an archive without extracting it.
  - Build steps must write somewhere that user owns. `/opt` is not writable by it, and it cannot delete a root-owned file in `/tmp`.

## Work to build the snapshot seed

This is a multi-day feature, not a single PR:

1. **Seed snapshot lifecycle.** Build a snapshot in the background after a full upload, keyed by repository, base commit, seed digest and the resolved runner image digest. A build takes about 177 s. Never block a turn on it.
2. **Sandbox creation.** The Daytona plugin creates per-turn sandboxes from the seed snapshot, which is layered on the environment's configured runner image. A runner image update changes the key, so it needs a new build; until that build finishes, turns use the full upload on the new image. A sandbox never starts from a snapshot of an older image.
3. **Verification and fallback.** Check the manifest digest before using the seed. On any mismatch or missing snapshot, do today's full upload. Keep the workspace sentinel and `baselineSha256` checks as the final gate.
4. **Expiry and cleanup.** Expire seeds by age, delete them when their environment is deleted, and handle provider snapshot quotas.
5. **Rebuild policy.** A base-commit move needs a new 177 s build; until then the overlay grows. Rebuild when the overlay passes a threshold.

## Out of scope

- Runner and provider session startup (`runner.session.startup`, about 9 s).
  Keeping the runner alive is the warm path, which stays on hold.
- Local environments; they have no upload.
