# Paperclip VM Migration Design

**Date:** 2026-04-16
**Status:** Approved
**Author:** Amin Lalji

## Overview

Migrate Paperclip from a Docker container on docker-001 (LXC) to a first-class Ubuntu 24.04 VM (`paperclip-001`) on proxmox-002. Run Paperclip natively from source with systemd, local Postgres, NFS agent data, and restic backups. Eliminates Docker permission friction, `docker exec` hoops, and entrypoint complexity.

---

## Section 1: VM & OS Setup

**Proxmox VM:** `paperclip-001` on proxmox-002
- 4 vCPU / 8 GB RAM / 40 GB virtio disk
- Ubuntu 24.04 LTS cloud image
- Static IP on `192.168.50.x` (next available), added to DNS
- VM ID: next available in the 200s range after 220

**System packages:**
- Node.js 22 LTS (NodeSource apt repo)
- pnpm (via corepack)
- PostgreSQL 17 (apt, local install)
- git, gh, ripgrep, python3, openssh-server
- restic

**User:** `paperclip` (uid 1000), home at `/opt/paperclip`. UID 1000 matches the NFS share ownership — no permission mapping needed.

**NFS mount:** `/volume2/paperclip` from Synology (192.168.50.102) mounted at `/mnt/paperclip`.
- Options: `rw,nfsvers=3,hard,_netdev`
- Added to `/etc/fstab`
- Synology DSM: add paperclip-001 IP to `/volume2/paperclip` export with `no_root_squash`

---

## Section 2: Paperclip Installation & Service

**Source location:** `/opt/paperclip/app`

**Install steps:**
```bash
git clone https://github.com/paperclipai/paperclip /opt/paperclip/app
cd /opt/paperclip/app
git checkout master
# Apply our hotfix: keep loopback/link-local blocked when PLUGIN_ALLOW_PRIVATE_IPS=true
git cherry-pick 9e86377e   # fix(plugin-host): keep loopback and link-local blocked
pnpm install --frozen-lockfile
pnpm build
```

**Environment:** `/opt/paperclip/.env`, owned `root:paperclip`, mode `640`

```env
PAPERCLIP_HOME=/mnt/paperclip
DATABASE_URL=postgres://paperclip:<password>@localhost:5432/paperclip
PAPERCLIP_PUBLIC_URL=https://pc.thelaljis.com
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_PLUGIN_ALLOW_PRIVATE_IPS=true
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=<value>
PAPERCLIP_AGENT_JWT_SECRET=<value>
CLAUDE_CODE_OAUTH_TOKEN=<value>
GITHUB_TOKEN=<value>
GH_TOKEN=<value>
OPENAI_API_KEY=<value>
```

**Systemd — `paperclip.service`:**
```ini
[Unit]
Description=Paperclip Server
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paperclip
WorkingDirectory=/opt/paperclip/app
EnvironmentFile=/opt/paperclip/.env
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

PostgreSQL managed by the standard `postgresql@17-main.service` apt systemd unit.

**Update procedure going forward:**
```bash
cd /opt/paperclip/app
git pull
git cherry-pick <hotfix-sha>   # re-apply if needed after rebase
pnpm install --frozen-lockfile
pnpm build
systemctl restart paperclip
```

---

## Section 3: Data Migration

### Postgres

Live dump from docker-001 container piped directly to paperclip-001:

```bash
docker exec rhx-paperclip-db-1 pg_dump -U paperclip paperclip \
  | ssh paperclip@paperclip-001 psql -U paperclip paperclip
```

No downtime required for the dump — docker-001 stays live until cutover is verified.

### NFS Agent Data

No migration needed. paperclip-001 mounts the same Synology share (`/volume2/paperclip`) that docker-001 uses. All agent home dirs, plugins, worktrees, `.claude`, `.hermes`, `.ssh/authorized_keys` are immediately available at the correct UID (1000).

### Cutover Sequence

1. Confirm `systemctl status paperclip` healthy on paperclip-001
2. Hit `https://paperclip-001-ip:3100/api/health` — verify 200
3. Run `pg_dump` → restore (above)
4. Update `/opt/traefik/config/dynamic/services.yml` on docker-001:
   - Change `paperclip` service url from `http://rhx-paperclip-server-1:3100` to `http://192.168.50.x:3100`
   - Traefik picks up the change instantly (file provider, no reload needed)
5. Verify `https://pc.thelaljis.com` routes to new VM
6. `docker compose --project-name rhx-paperclip down` on docker-001

### Rollback Plan

If anything goes wrong before step 6:
1. Revert Traefik `services.yml` to `http://rhx-paperclip-server-1:3100`
2. `docker compose --project-name rhx-paperclip up -d` on docker-001
3. NFS data is shared — nothing lost

---

## Section 4: Restic Backups

**New Synology NFS export:** `/volume2/restic-paperclip-001`
- Add paperclip-001 IP to allowed hosts in DSM (same pattern as `restic-docker-001`)
- Mount on paperclip-001 at `/mnt/restic-paperclip-001`

**Backup scope:**
| Path | Reason |
|------|--------|
| `/var/lib/postgresql/17/main` | Local Postgres data |
| `/opt/paperclip/app` | Built source + applied patches |
| `/opt/paperclip/.env` | Secrets/config |

`/mnt/paperclip` (NFS agent data) excluded — lives on Synology already.

**Restic password:** `/opt/paperclip/.restic-password`, mode 600, owned root.

**Systemd units:**

`/etc/systemd/system/paperclip-backup.service`:
```ini
[Unit]
Description=Paperclip Restic Backup

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/restic backup \
  /var/lib/postgresql/17/main \
  /opt/paperclip/app \
  /opt/paperclip/.env \
  --password-file /opt/paperclip/.restic-password \
  --repo /mnt/restic-paperclip-001
ExecStartPost=/usr/bin/restic forget \
  --password-file /opt/paperclip/.restic-password \
  --repo /mnt/restic-paperclip-001 \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 3 \
  --prune
```

`/etc/systemd/system/paperclip-backup.timer`:
```ini
[Unit]
Description=Daily Paperclip Restic Backup

[Timer]
OnCalendar=02:00
Persistent=true

[Install]
WantedBy=timers.target
```

**Init:** `restic init --repo /mnt/restic-paperclip-001 --password-file /opt/paperclip/.restic-password`

---

## Summary

| Concern | Solution |
|---------|----------|
| Permissions | uid 1000 `paperclip` user matches NFS — no mapping |
| Tool installs | Native apt/npm — no `docker exec` |
| Process management | systemd — survives reboots, standard tooling |
| Database | Local Postgres 17 — no NFS fragility |
| Agent data | NFS `/mnt/paperclip` — unchanged, same share |
| Hotfix | Cherry-picked onto master after each `git pull` |
| Routing | Traefik file provider — one URL change, instant |
| Backups | Restic → Synology `/volume2/restic-paperclip-001` daily |
| Rollback | Revert Traefik URL, `docker compose up` — < 1 min |
