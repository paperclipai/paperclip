# OpenCode launch artifacts and cold recovery

OpenCode records the absolute paths and hashes of its Node executable, proxy,
and native executable in its durable provider state. An image upgrade can change
these files. A saved session must keep its admitted files. The Runner still
rejects a different launch profile.

For a new managed remote OpenCode session with durable object storage, Core puts
these three qualified files in the runtime account's private, content-addressed
launch directory. Core reads the home and UID from the runtime OS account
database. It does not infer ownership from `HOME`, a workspace path, or a provider
response. The launch receipt records this UID, the absolute directory, the pack
manifest, and the encrypted artifact identity.

Core saves the files before it releases the first provider turn. Artifact capture
uses the current native coordinator claim and the recorded Core admission. A
brief admission lock waits for at most one second and checks the current owner
after it acquires the lock. A stale, revoked, or unknown owner cannot publish.
The artifact operation does not grant execution or tool authority.

The archive is limited to 512 MiB of launch files. Core streams files and checks
hashes and file identity before and after capture. Pack-internal package links
can resolve to regular source files. Links outside the selected pack are refused.
The published launch directory contains regular files and private, owned
parents. Node and OpenCode must be qualified native ELF executables. A script
wrapper or a changed account fails closed. The selected runtime must still
supply the qualified native executables' platform and system dependencies.

The artifact object uses authenticated encryption and a company-bound key
wrapper. A company can reuse a ready object with the same file descriptor.
Canonical run and harness-backup references keep the object alive. Large launch
files are excluded from each later harness archive. A pending upload records its
exact encrypted object reference before upload, so an interrupted reply can be
retired without guessing an object key.

On cold recovery, Core restores the canonical Runner checkpoint, workspace
snapshot, and native harness data through their normal paths. It also verifies
and decrypts the recorded launch files. The runtime must have the same owned
account UID and absolute home. Core stages the exact files at the recorded
content-addressed paths. It does not replace files in the current image.

Published workspaces retain their recorded directory basename across lease
changes. A replacement allocation with the same provider base therefore keeps
the native session's absolute cwd. The workspace service can restore files to a
different base, but that alone does not authorize changing a native session's
cwd. This change adds no directory aliases and makes no change to the Rust
profile guard.

Live Runner reattachment does not download or replace the launch files.
Historical sessions that recorded image-rooted paths keep those paths. This
change cannot reconstruct files that were never saved. A governed fresh-session
transition can use a new pack after existing effects and receipts are reconciled.
It must not replay a previous turn or treat a missing result as proof that no
effect occurred.

Artifact cleanup uses the existing bounded checkpoint and backup expiration
owners. It requires closed work, settled native ownership, and exact stopped
remote execution receipts. A remaining backup or run reference keeps the object.
A failed external delete keeps its receipt and reference for a later normal
expiration attempt. There is no new idle scan or timer. Checkpoint deletion
rechecks resume handles after external deletion.

## Local qualification

Run the focused server suites with the repository's supported pnpm version:

```sh
pnpm --filter @paperclipai/server exec vitest run --config vitest.config.ts \
  src/services/native-runtime/native-harness-backup-storage.integration.test.ts \
  src/services/native-runtime/native-harness-backup-archive.test.ts \
  src/services/native-runtime/remote-opencode-artifacts.test.ts \
  src/services/native-runtime/native-provider-pack-admission.test.ts \
  src/services/native-runtime/native-session-executor.test.ts \
  src/__tests__/native-harness-backup-expiration.test.ts \
  src/__tests__/native-harness-backup-expiration-config.test.ts
```

The opt-in Linux qualification requires two locally cached Paperclip images with
full immutable image IDs and different OpenCode proxy hashes. Both images must
have the same Linux architecture and the standard qualified provider pack. The
new image must include the packaged Runner binary at
`/app/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd`.
Build the current checkout's Runner TypeScript SDK first. Use the local Docker
context that has the cached images:

```sh
pnpm --filter @paperclipai/paperclip-runner build:typescript
pnpm --filter @paperclipai/server exec tsx scripts/qualify-opencode-cold-recovery.mts \
  --context desktop-linux \
  --old-image "$OLD_IMAGE" \
  --new-image "$NEW_IMAGE" \
  --output /tmp/opencode-cold-recovery-result.json
```

The command accepts only full `sha256:` image IDs and a local Unix Docker
endpoint. It never pulls an image. It creates isolated PostgreSQL data and two
owned containers. The containers have no network, a read-only image filesystem,
resource limits, and a private fixture OS account. The synthetic model runs on
container loopback. No external model credential or API is used.

The command uses production workspace save/restore, encrypted checkpoint and
harness storage, artifact publication, admission, SDK transport, Rust Runner,
and actual OpenCode. It destroys the original allocation's account and controller
files, changes the image and allocation lease, and restores the same provider
session. It requires the useful workspace file and earlier model context to
survive. Exactly one model request is allowed in each turn. The result records
image IDs, pack digests, checkout revision and dirty state, lease identities,
byte counts, session continuity, and useful output. The command removes only its
own containers and PostgreSQL server. It retains its temporary evidence directory.

The independent object-store fixture uses the real StorageService and encrypted
streams with an owned local directory outside both destroyed allocations. This
qualifies the cold restore contract. It does not qualify a hosted S3 service,
a task's HTTP/actor workflow, or completion of an existing hosted task.
