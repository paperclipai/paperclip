# PRA-1211 — Enforce atomic writes to Traefik config

**Status:** DONE (2026-08-20)
**Owner:** COO
**Parent:** PRA-1207 (RCA: traefik crash from non-atomic file write)

## Root cause

On Aug 20 20:47:28 UTC, `/opt/traefik/traefik-config.yml` was overwritten
in-place. Traefik's `--providers.file.watch=true` picked up a partial YAML
state, crashed with a parse error, and took praesyn.com down ~26s.

## Audit — every writer of the Traefik config

Audited `/Users/benh/Programming/Business/web-services` (the deployment hub)
and `~/.hermes` skills for anything that writes the consolidated config
(`/opt/traefik/traefik-config.yml` on vps-1, legacy `/root/traefik/...`).

### Critical (in-place edits — could trigger the same crash)

| Script | Before (bug) | After (fix) |
|---|---|---|
| `ai-sms-assistant/backend/deploy-direct.sh` | `sed -i` in-place insert of router+service blocks, then `docker restart traefik` | Atomic `edit` via helper (temp file → YAML validate → `mv`), then graceful `HUP` reload |
| `ai-sms-assistant/frontend/deploy.sh` | `sed -i` in-place insert, then `docker restart traefik` | Atomic `edit` via helper + `HUP` reload |

### Medium (append — fast but not atomic)

| Script | Before (bug) | After (fix) |
|---|---|---|
| `workflow-engine/setup.sh` | `cat file >> config` | Atomic `append` via helper |
| `workflow-engine/deploy.sh` | `cat file >> config` | Atomic `append` via helper |
| `workflow-engine/clients/latus/deploy.sh` | three `cat >> config` heredocs | Atomic `append` ×3 via helper |
| `monitoring/setup.sh` | `cat >> config` via stdin pipe | Atomic `append` via helper |

### Low (initial provisioning — Traefik not yet live)

| Script | Note |
|---|---|
| `bin/docker-setup.sh` | Initial `cat >` when Traefik is first deployed (safe, but converted to helper anyway for consistency) |

### Reload audit (all replaced `docker restart` / `docker compose restart traefik`)

- `workflow-engine/setup.sh` → helper `reload` (HUP)
- `workflow-engine/deploy.sh` → helper `reload` (HUP)
- `workflow-engine/clients/latus/deploy.sh` → helper `reload` (HUP)
- `monitoring/setup.sh` → helper `reload` (HUP)
- `ai-sms-assistant/frontend/deploy.sh` step 9 → helper `reload` (HUP)
- `backups/scripts/restore.sh` → `docker kill -s HUP traefik` (runs on-host)

### Not writers (verified clean)

`headscale/deploy.sh`, `proton-bridge/deploy.sh`, `n8n/deploy.sh`,
`praesyn.com/deploy.sh`, `project-manager-service/deploy.sh`,
`ai-sms-assistant/0337/deploy.sh`, `monitoring/deploy.sh`,
`n8n/migrate-to-modular.sh` (one-time migration, `scp` only).

## Deliverable — `bin/traefik-atomic.sh`

Shared helper in `web-services/bin/traefik-atomic.sh`. Every writer now goes
through it. For each mutation it:

1. **Backs up** the live config (timestamped `.bak-YYYYMMDD-HHMMSS`)
2. **Writes to a temp file on the same filesystem** (`mktemp` in the config dir)
3. **Validates YAML** remotely with `python3 -c "import yaml; yaml.safe_load(...)"` before anything is swapped
4. **`mv`s atomically** — the file watcher sees either the old inode or the new inode, never a partial write
5. **Sends graceful reload** — `docker kill -s HUP traefik` (falls back to `docker compose restart traefik` if HUP fails)

Subcommands:

```bash
./bin/traefik-atomic.sh write   <host> <remote_path> [--no-reload]   # replace whole file (stdin)
./bin/traefik-atomic.sh append  <host> <remote_path> [--no-reload]   # append fragment (stdin)
./bin/traefik-atomic.sh edit    <host> <remote_path> <sed-expr> [--no-reload]
./bin/traefik-atomic.sh backup  <host> <remote_path>
./bin/traefik-atomic.sh reload  <host>
./bin/traefik-atomic.sh validate <host> <remote_path>
```

## Remaining decision (owner: founder/CTO)

- Keep `--providers.file.watch=true` (now safe: all writes are atomic mv) and
  rely on HUP for explicit reload, or remove the watcher entirely and make HUP
  the only reload path. Recommendation: keep watcher + atomic writes; the
  watcher is no longer a failure vector and preserves hot-reload for manual
  ops edits. The docker-setup.sh compose template now documents this.

## Verification

- `bash -n` passed on all 8 modified scripts + new helper.
- Helper is installed at `web-services/bin/traefik-atomic.sh` (executable).
- Live config was NOT modified during this work (audit + code changes only).
