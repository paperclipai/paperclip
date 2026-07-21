# Restore runbook — "my instance died, what now?"

This is the operator procedure for bringing a Paperclip instance back after the
disk is lost. It restores from the three durability tiers built in PAP-14639:

| Tier | Holds | Source |
|------|-------|--------|
| **Secret tier** | `secrets/master.key` (decrypts every DB-stored secret) | off-host custody / encrypted S3 |
| **Database** | Postgres (issues, agents, secrets ciphertext, memberships, …) | `pg_dump` backups (`data/backups/` + S3) |
| **Instance-state snapshot** | attachments, `codex-home` sqlite, config, bundles | encrypted S3 snapshot bundle |
| **State repo** | attributed history of AGENTS.md, skills, Claude memory | `state-repo.git` (+ your mirror, if connected) |

> P7 drills this runbook end-to-end on a clean host. Keep it in sync with what
> that drill actually runs — if a step here doesn't match the drill, the drill wins.

---

## 0. Before you start

You need, from off-host custody:

- **`master.key`** — 32 bytes. **Without it every secret in the database is
  unrecoverable, even with a perfect DB backup.** Restore it first.
- Access to the backup bucket (`PAPERCLIP_STORAGE_S3_BUCKET` / prefix) and the
  snapshot decryption key (age recipient / KMS, per the P2 custody decision).
- The instance id of the dead instance (the S3 keys are namespaced by it).

Provision a clean host with the same Paperclip version. Do **not** start the
server yet.

---

## 1. Restore the secret key (do this first)

```sh
# Recover master.key from off-host custody into the instance secrets dir.
install -m 600 /path/to/custody/master.key \
  "$HOME/.paperclip/instances/<instance>/secrets/master.key"
```

If the key is lost, DB-stored secrets cannot be decrypted; you would have to
re-enter every secret by hand after the rest of the restore. Treat key custody
as the highest-severity item in any DR review.

## 2. Restore the database

Fetch the newest `*.sql.gz` dump (local `data/backups/` if the disk survived,
otherwise from S3) and load it into a fresh Postgres data dir:

```sh
aws s3 cp "s3://$BUCKET/$PREFIX/db-backups/<latest>.sql.gz" ./restore.sql.gz
gunzip -c ./restore.sql.gz | psql "$PAPERCLIP_DATABASE_URL"
```

This restores issues, agents, memberships, routines, and the **encrypted**
secret values — which `master.key` (step 1) will decrypt at boot.

## 3. Restore the instance-state snapshot

The encrypted snapshot bundle carries attachments (`data/storage`), the
`codex-home` sqlite databases, `config.json`, and materialized bundles. Restore
it through the server API or CLI:

```sh
# List available snapshot object keys in the bucket, pick the newest, then:
paperclipai state restore instance-state/<instance>/<timestamp>.tar.age
# equivalent: POST /api/instance/state-snapshots/restore  { "objectKey": "…" }
```

Snapshots are written to `instance-state/<instance>/…`; retained copies live
under `retention/<days>-days/…` (see `doc/S3-BULK-STORAGE.md`). Codex sqlite is
captured with consistent `sqlite3 .backup` copies, so it restores cleanly.

## 4. Restore version-controlled agent state (state repo)

The state repo is the attributed history of each agent's `AGENTS.md`, skills,
and Claude memory. Restore it per company, from the on-disk bare repo, an
exported bundle, or **your connected mirror**:

```sh
# Dry run first — prints the file list without writing anything.
paperclipai state restore --from-git /path/to/state-repo.git \
  --company-id <companyId> --ref main --dry-run

# Then for real (drop --dry-run). --from-git also accepts an https:// mirror URL
# or a `paperclip-state-<cid>.bundle` exported from Settings → Backups.
paperclipai state restore --from-git https://github.com/acme/paperclip-state.git \
  --company-id <companyId> --ref main
```

This materializes instructions, skills, and memory markdown back to their
instance paths through the same manifest mapping that wrote them. If you only
have the DB backup, custom-agent instruction bundles were also persisted to
Postgres (PAP-14639 P5) and re-materialize on boot — the state repo adds the
*history*, and covers Claude memory, which the DB does not.

## 5. Boot and verify

Start the server, then confirm:

- [ ] Server boots; migrations report up to date.
- [ ] Agents show their instructions (`AGENTS.md`) and memory.
- [ ] A secret resolves (decrypt works ⇒ `master.key` is correct).
- [ ] An attachment/screenshot opens (storage restored).
- [ ] Settings → **Backups & version history** shows snapshot **Healthy** and a
      commit log; if a mirror was connected, **Test connection** succeeds.

If secret decryption fails, the wrong `master.key` was restored — go back to
step 1. If attachments 404, the snapshot (step 3) did not restore or targeted
the wrong instance id.

---

## Recovery-point notes

- Snapshots and DB backups run on a schedule; the most recent successful marker
  (shown on the Backups page) is your recovery point. `data/run-logs` and Claude
  transcripts are S3-only with lifecycle expiry (~90 d) and are **not** required
  for a functional restore — they are forensic.
- Continuous point-in-time restore for `codex-home` (Litestream) was evaluated
  in P4 and deferred; snapshots are the current RPO bound for that tier.
