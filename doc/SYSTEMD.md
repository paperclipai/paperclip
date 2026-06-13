# Running Paperclip as a systemd service (Linux)

This guide shows how to run a single Paperclip instance under `systemd` on a
Linux host so it starts on boot, restarts on crash, and stays alive after the
shell that started it exits.

It complements the existing [Podman Quadlet guide](DOCKER.md#podman-quadlet-systemd)
— use this guide when you do not want to run Paperclip inside a container.

A ready-to-customize unit file ships at
[`deploy/systemd/paperclip.service`](../deploy/systemd/paperclip.service). The
steps below walk through installing it as a **user-level** unit, which keeps
Paperclip's state, ports, and processes scoped to the same UNIX user that
already owns `~/.paperclip`.

> Tracks: [#467](https://github.com/paperclipai/paperclip/issues/467).

## Why user units

Paperclip's embedded PostgreSQL data directory, secrets, storage, and logs all
live under `~/.paperclip` for the user that ran `paperclipai onboard`. A
systemd **user** unit inherits that user's HOME, file permissions, and tailnet
state without `sudo`, which avoids permission drift between interactive runs
(`paperclipai run`) and supervised runs.

If you need Paperclip to start before any user logs in — for example, on a
headless server with multiple operators — enable lingering for the dedicated
account (see step 2). The service will then come up at boot and survive
disconnects.

System-wide units (in `/etc/systemd/system/`) are also possible but are out of
scope here because they require a dedicated runtime user, explicit `User=`,
and careful handling of `XDG_RUNTIME_DIR`. Once the user-unit flow works for
you, lifting it to a system unit is a small change.

## Prerequisites

- Linux with `systemd` (any reasonably modern distro)
- Node.js 20+ and pnpm 9.15+ on `PATH` (matches the rest of the project)
- Paperclip already initialized for the target user (`paperclipai onboard`
  completed at least once, so `~/.paperclip/instances/<id>/config.json`
  exists)
- `paperclipai doctor` reports `All checks passed!` for the same user

Confirm the manual run works first:

```bash
paperclipai run
```

Stop it with `Ctrl+C` once the server prints its listen URL. The service we
install below performs the same boot sequence with no TTY.

## 1. Drop the unit in place

Copy the template into the user systemd directory:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/paperclip.service ~/.config/systemd/user/paperclip.service
```

If you do not have a Paperclip checkout handy, fetch the file directly:

```bash
curl -fsSL \
  https://raw.githubusercontent.com/paperclipai/paperclip/master/deploy/systemd/paperclip.service \
  -o ~/.config/systemd/user/paperclip.service
```

Open the unit and edit the two values flagged with `TODO`:

- `WorkingDirectory=` — absolute path Paperclip should run from. For an
  `npx paperclipai` install this is typically `%h/paperclip` (i.e.
  `~/paperclip`); for a source checkout it is the repo root.
- The `ExecStart=` line — uncomment one of the three options and delete the
  others depending on how Paperclip is installed on this host:

  | Install style | Recommended `ExecStart` |
  | ------------- | ----------------------- |
  | `npm install -g paperclipai` or `npx` | `/usr/bin/env npx --yes paperclipai run` |
  | Source checkout, pnpm available at runtime | `/usr/bin/env pnpm paperclipai run` |
  | Source checkout, no pnpm at runtime | `/usr/bin/env node %h/paperclip/cli/node_modules/tsx/dist/cli.mjs %h/paperclip/cli/src/index.ts run` |

The third form is useful when the service runs under a restricted PATH and
you want to avoid resolving the `pnpm` shim per restart.

## 2. Enable lingering (optional but recommended)

By default, user units shut down when the user logs out. For a long-running
server you almost always want the unit to start at boot and survive logouts:

```bash
sudo loginctl enable-linger "$USER"
```

Verify with `loginctl show-user "$USER" | grep Linger` — you should see
`Linger=yes`.

## 3. Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable --now paperclip.service
```

Check status:

```bash
systemctl --user status paperclip.service
```

You should see `Active: active (running)` once the embedded PostgreSQL cluster
is ready (a few seconds on cold start).

## 4. Verify

Tail the logs while the service finishes its first boot:

```bash
journalctl --user -u paperclip.service -f
```

You should see Paperclip's startup banner, the embedded PostgreSQL ready line,
and the `Server listening on …` line.

Hit the health endpoint from the same host:

```bash
curl -sf http://127.0.0.1:3100/api/health
```

If you configured Paperclip to bind to a tailnet IP, substitute that IP and
port.

## Common operations

| Action | Command |
| ------ | ------- |
| Restart the service | `systemctl --user restart paperclip.service` |
| Stop the service | `systemctl --user stop paperclip.service` |
| Disable autostart | `systemctl --user disable paperclip.service` |
| View recent logs | `journalctl --user -u paperclip.service -n 200 --no-pager` |
| Follow logs | `journalctl --user -u paperclip.service -f` |
| Show effective unit | `systemctl --user cat paperclip.service` |
| Show resource usage | `systemctl --user status paperclip.service` |

## Updating Paperclip

For `npx`-based installs, run `npx --yes paperclipai@latest run` once manually
to populate the cache, then `systemctl --user restart paperclip.service`.

For source checkouts:

```bash
cd ~/paperclip
git pull
pnpm install
pnpm build
systemctl --user restart paperclip.service
```

If a release changes the database schema, run `pnpm db:migrate` before
restarting.

## Troubleshooting

- **`Failed with result 'exit-code'` immediately on start** — run the same
  command from `ExecStart=` in your shell. The most common causes are a
  missing `WorkingDirectory`, a `node` binary not on the systemd `PATH`, or
  `paperclipai doctor` failing because `~/.paperclip` was created by a
  different user.
- **`Cannot find module '.../server/src/app.js'`** — Paperclip's CLI loads
  the server through `tsx`. If you start the service with `node …/cli/dist/…`
  the loader hook is not registered. Use the `pnpm paperclipai run` or
  explicit `tsx` `ExecStart=` lines from the template instead.
- **`Start request repeated too quickly`** — `StartLimitBurst` tripped after
  ten failed restarts in five minutes. Fix the underlying error, then run
  `systemctl --user reset-failed paperclip.service` before starting again.
- **Service runs but the port is unreachable from other hosts** — check the
  `server.bind` and `server.host` values in
  `~/.paperclip/instances/<id>/config.json`. Binding to `tailnet` requires
  `tailscaled` to already be up at start; if it is not, the unit will still
  start but the listener will only appear once the interface is available.
- **Disk-related crash loops (`ENOSPC`)** — Paperclip's adapters copy runtime
  configuration into `/tmp` between heartbeats. If `/tmp` fills up the
  service will restart but every run will fail the same way. Clean stale
  paths under `/tmp` (or mount more space) and the loop clears itself.

## Related

- [`deploy/systemd/paperclip.service`](../deploy/systemd/paperclip.service)
  — the sample unit file.
- [Podman Quadlet (systemd)](DOCKER.md#podman-quadlet-systemd) — the
  container-based alternative.
- [DEVELOPING.md](DEVELOPING.md) — local development, worktree management,
  CLI reference.
