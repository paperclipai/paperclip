# Operations Hardening

This runbook is intentionally non-production by default. It does not modify agents,
keys, schedules, deployment configuration, or a live database.

## Supported runtime

Repository builds and the production image use Node 24.x. `.node-version`, the root
engine constraint, CI release jobs, and the Docker base image must remain aligned.

## Content-addressed build artifact

Build, snapshot, and verify before promotion:

```sh
pnpm build
mkdir -p tmp/release-artifacts
pnpm ops:build-artifact create --source server/dist --output tmp/release-artifacts
pnpm ops:build-artifact verify \
  --artifact tmp/release-artifacts/paperclip-build-<sha256> \
  --manifest tmp/release-artifacts/paperclip-build-<sha256>.manifest.json
```

The artifact name is its SHA-256 content digest. Verification fails on added,
removed, or modified files and on symbolic links. Promote the artifact and manifest
as one pair; record both the manifest hash and `artifactDigest` in release evidence.

## Dedicated-agent and key reconciliation

Export a redacted agent inventory, then run:

```sh
pnpm ops:inventory --agents /path/to/redacted-agents.json --keys-dir /path/to/key-metadata
```

The command never reads key contents and performs no mutation. Active OpenClaw
agents must use `heartbeat.enabled=false`, `wakeOnDemand=true`, and a unique existing
`claimedApiKeyPath`. Orphans are reported as
`retain_quarantined_pending_rotation_review`; never delete them from this report.
Rotate/revoke through the approved credential workflow before archival.

## Disposable restore drill

Run against a copied backup artifact only:

```sh
pnpm ops:restore-drill --backup /path/to/copied-paperclip-backup.sql.gz
```

The drill starts a temporary embedded PostgreSQL server, restores into a randomly
named temporary database, requires the complete transactional restore to succeed,
prints the input SHA-256, then removes the temporary server. It never connects to or
mutates the configured Paperclip database. A full disaster-recovery gate must also
verify local storage and the encrypted-secrets master key under their separate
approved procedures.

## Severity gate

Inventory `critical` and `error` findings fail the command. `warning` findings are
non-destructive review work. Production readiness requires zero critical/error
findings, an explicitly dispositioned warning list, a verified build artifact, and a
successful restore drill against the release backup copy.
