# Hardened host backup candidate

This directory contains the QA-gated replacement for the BackBond host's
`paperclip-mempalace-backup` script, service, and timer.

The database restore authority is the fresh logical SQL backup created by the
supported `paperclipai db:backup` CLI command. The archive intentionally omits
the live embedded-PostgreSQL data directory. It includes `config.json`,
`secrets/master.key`, local-disk storage, the fresh logical dump, and the two
existing MemPalace trees. Each successful archive has a non-sensitive component
inventory and a SHA-256 sidecar manifest.

## QA restore path

Use the candidate release's supported `paperclipai db:restore` command against a
new home on `/mnt/paperclipdata`; never target the live instance home. The
complete command sequence, hash guard, table-name/count comparison, and health
check are documented under **Supported isolated restore** in
`doc/DEVELOPING.md`. Operators do not invoke `psql`, `pg_restore`, `createdb`, or
any other raw PostgreSQL command.

## Promotion gate

Do not install a candidate until the canonical QA child has independently tested
and approved the exact `candidate-files.sha256` identifier. A changed byte creates
a new candidate and invalidates prior QA.

## Install after QA approval

Run as root. Keep the timestamped directory until a later candidate is proven.

```sh
set -eu
candidate=/home/beai-agent/paperclip-backup-candidates/BEAAA-19887
rollback=/var/backups/paperclip-mempalace/config-rollback-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 -o root -g root "$rollback"
cp -a /usr/local/sbin/backup-paperclip-mempalace.sh "$rollback/"
cp -a /etc/systemd/system/paperclip-mempalace-backup.service "$rollback/"
cp -a /etc/systemd/system/paperclip-mempalace-backup.timer "$rollback/"
chown -R root:root "$rollback"
chmod -R go-rwx "$rollback"

install -m 0750 -o root -g root "$candidate/paperclip-mempalace-backup.sh" \
  /usr/local/sbin/backup-paperclip-mempalace.sh.new
install -m 0644 -o root -g root "$candidate/paperclip-mempalace-backup.service" \
  /etc/systemd/system/paperclip-mempalace-backup.service.new
install -m 0644 -o root -g root "$candidate/paperclip-mempalace-backup.timer" \
  /etc/systemd/system/paperclip-mempalace-backup.timer.new
mv -f /usr/local/sbin/backup-paperclip-mempalace.sh.new \
  /usr/local/sbin/backup-paperclip-mempalace.sh
mv -f /etc/systemd/system/paperclip-mempalace-backup.service.new \
  /etc/systemd/system/paperclip-mempalace-backup.service
mv -f /etc/systemd/system/paperclip-mempalace-backup.timer.new \
  /etc/systemd/system/paperclip-mempalace-backup.timer
systemctl daemon-reload
systemctl enable --now paperclip-mempalace-backup.timer
systemctl list-timers paperclip-mempalace-backup.timer --no-pager
```

## Rollback

Run as root with `rollback` set to the timestamped directory created above.
Restores are staged beside each target and renamed atomically. This does not
delete any logical or filesystem backup.

```sh
set -eu
install -m 0750 -o root -g root "$rollback/backup-paperclip-mempalace.sh" \
  /usr/local/sbin/backup-paperclip-mempalace.sh.rollback
install -m 0644 -o root -g root "$rollback/paperclip-mempalace-backup.service" \
  /etc/systemd/system/paperclip-mempalace-backup.service.rollback
install -m 0644 -o root -g root "$rollback/paperclip-mempalace-backup.timer" \
  /etc/systemd/system/paperclip-mempalace-backup.timer.rollback
mv -f /usr/local/sbin/backup-paperclip-mempalace.sh.rollback \
  /usr/local/sbin/backup-paperclip-mempalace.sh
mv -f /etc/systemd/system/paperclip-mempalace-backup.service.rollback \
  /etc/systemd/system/paperclip-mempalace-backup.service
mv -f /etc/systemd/system/paperclip-mempalace-backup.timer.rollback \
  /etc/systemd/system/paperclip-mempalace-backup.timer
systemctl daemon-reload
systemctl restart paperclip-mempalace-backup.timer
```

## Disk decision

The archive destination stays on the root filesystem and the script refuses a
destination on the live Paperclip filesystem or one with less than 8 GiB free.
Do not add swap or delete agent workspaces merely to reduce apparent pressure.
Prune or relocate a path only after its owner and regeneration procedure are
known and no live issue or rollback candidate depends on it.
