# CK Credential Vault

A central, encrypted, GUI-managed home for every web login/API key the AI company uses — built on
**Paperclip's native secret store** (no side-channel). Solves the "credentials scattered across 10+
plaintext files" problem and scales as we add personas/platforms.

## Where things live
- **The vault (source of truth):** Paperclip Secrets — GUI at `/CK/company/settings/secrets`.
  AES-256-GCM encrypted at rest; values are NEVER shown in the GUI or returned by the API (resolved
  server-side only). Company `e651858f-b11b-4b43-aa43-20c1192d7e98`.
- **Master key:** `/work/.pc-master.key` (in pc-build) via `PAPERCLIP_SECRETS_MASTER_KEY_FILE`.
  **Backed up** at `~/.secrets/paperclip-secrets-master.key`. ⚠️ Lose this key = every secret is
  undecryptable. Keep the backup safe.
- **Tooling:** `~/paperclip/.ck-vault/` (= `/work/.ck-vault/` in pc-build).

## The bridge (why a materializer exists)
Divino runs in its OWN container, not as a Paperclip agent, and the secret API never hands out
plaintext. So the vault can't inject into Divino directly. Instead a **materializer** regenerates the
exact credential files Divino's scripts already read, FROM the vault — losslessly.

## Files
- `decrypt.mjs` — runs in pc-build (has the master key). stdin: secret rows as JSON; stdout: decrypted
  `{name,description,value}`. The only place plaintext is produced; it never writes to disk.
- `import.py` — reads Divino's source files → creates vault secrets (idempotent; `--apply` to write).
- `templates/*.tmpl` — the exact byte format of each Divino file, with `{{slug}}` where a secret goes.
- `materialize.sh` — vault → decrypt → fill templates → write Divino's files. **Dry-run by default**
  (diffs against the live files); `--apply` writes them (0600).

## Routine ops
```bash
cd ~/paperclip/.ck-vault
python3 import.py            # preview what would be imported
python3 import.py --apply    # create missing secrets from the source files
bash materialize.sh          # DRY-RUN: prove the vault regenerates Divino's files byte-for-byte
bash materialize.sh --apply  # rewrite Divino's files from the vault (0600)
```
Rotate a password: edit it in the Paperclip GUI (New version), then `bash materialize.sh --apply`.

## Secrets currently in the vault (15 — the complete registry)
Machine-read: `divino-mail-infomaniak`, `divino-brave-api-key`, `divino-anibis`,
`divino-browserbase-api-key`, `divino-browserbase-project-id`.
Marketplace (from credentials.md): `divino-ricardo`, `divino-tutti`, `divino-locanto`, `divino-lapulga`.
Personas / DR (from Divino's seed): `divino-reddit-marco`, `divino-reddit-daniel`,
`divino-email-marco-gmx`, `divino-email-daniel-gmx`, `divino-corotos-marco`, `divino-encuentra24`.
Each carries `user=… · service=… · persona=…` in its description.

## Live sync (ACTIVE)
`.divino-mail.env`, `.creds-anibis.txt`, and `scripts.env` are generated FROM the vault. **Edit
credentials in the Paperclip GUI, not in those files.** A cron re-materializes automatically whenever
the vault differs (verified end-to-end: rotate in GUI → file updates within 15 min):
`*/15 * * * * /home/ckhermes/paperclip/.ck-vault/sync-cron.sh  # ck-vault-sync`.
To push a rotation immediately: `bash ~/paperclip/.ck-vault/materialize.sh --apply`.

## Posting scripts read from the vault (DONE)
`tools/tutti-post.mjs`, `tools/anibis-post.mjs`, and `lapulga-post.mjs` now read their marketplace
login via `secret('TUTTI_PASS' | 'ANIBIS_PASS' | 'LAPULGA_PASS' | …)` from the materialized
`scripts.env`, with the old constant kept as a `|| 'fallback'` (zero regression). Backups saved as
`*.bak-<ts>` alongside each script. `scripts.env` template carries `{{divino-tutti|anibis|lapulga}}`.
Syntax-checked (`node --check`) and `secret()` resolution verified. `fundort-post.mjs` is abandoned
(left as-is). The plaintext fallback can be deleted later once you're confident the vault path is solid.

## Constraints Divino confirmed (don't break these)
- `.divino-mail.env` = shell `KEY=VALUE`, **no quotes** (scripts `source` it).
- `.creds-anibis.txt` = `key: value` (parser does `split(':')`).
- `secrets/scripts.env` → mounted read-only at `/run/scripts.env`; write the **host** file, container
  sees it.
- `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` are container-injected (`docker run -e`) — out of scope.
