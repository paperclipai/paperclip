# Paperclip via systemd (host `dev-1`)

This document describes the systemd-native deployment used on `dev-1`. It supplements [`docker.md`](./docker.md) — that file describes the containerized path; this one describes the path actually running in production on `dev-1`. The other deploy guides under `docs/deploy/` (compose, ECS, VPS) are unaffected.

The repository's `docker/docker-compose.yml` still exists, but on `dev-1` Paperclip is **not** run from it. There is no `docker-paperclip-1` container; the control plane runs directly under systemd as user `luis`.

## Why this matters for operators

The `claude_local`, `opencode`, and `codex` adapters resolve their CLI binaries through the supervisor's `PATH`. When systemd launches `paperclip.service` it starts with the minimal `PATH` defined by the unit file or by `/etc/paperclip/paperclip.env`, **not** the interactive shell `PATH` of user `luis`. If the env file does not set `PATH`, the supervisor ends up with `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` (systemd default) and CLIs installed under `~/.local/bin`, `~/.opencode/bin`, etc. become invisible — surfacing as `Command not found in PATH: "claude"` (see SIMAA-2177).

The code-side fix (well-known fallback dirs in `resolveCommandPath`) makes this self-healing for `claude`, `opencode`, `codex` and similar CLIs installed in standard locations. The configuration described below is the durable, explicit answer: setting `PATH` in `paperclip.env` so the supervisor never has to fall back.

## Unit layout on `dev-1`

```
/etc/systemd/system/paperclip.service   # unit file (root)
/etc/paperclip/paperclip.env            # env file, root-only (chmod 600)
```

Effective unit (`systemctl cat paperclip.service`):

```ini
[Service]
Type=simple
User=luis
EnvironmentFile=/etc/paperclip/paperclip.env
ExecStart=/home/luis/.nvm/versions/node/v24.15.0/bin/node \
          /home/luis/.nvm/versions/node/v24.15.0/bin/pnpm paperclipai run
Restart=on-failure
```

## Recommended `paperclip.env`

The env file is owned by `root`, mode `600`. Adjust the user paths to match the deploy host's `$HOME`.

```env
# /etc/paperclip/paperclip.env  (chmod 600, root-owned)

# PATH for the supervisor process. Order: user-local installs first (claude,
# opencode, codex live under ~/.local/bin or ~/.opencode/bin), then /usr/local,
# then system. Keep ~/.local/bin first so user-managed updates win.
PATH=/home/luis/.local/bin:/home/luis/.opencode/bin:/home/luis/.codex/bin:/usr/local/bin:/usr/bin:/bin

# Anything else the unit needs (database URL, log levels, etc.)
# DATABASE_URL=...
# PAPERCLIP_LOG_LEVEL=info
```

After editing, reload the unit and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart paperclip.service
```

## Verifying the effective PATH

The unit's static configuration tells you only what is *declared*, not what the running supervisor actually sees. To check the live PATH used by the running process, read `/proc/<MainPID>/environ` directly:

```bash
# 1. Live PATH of the running supervisor (authoritative)
sudo cat /proc/"$(systemctl show -p MainPID --value paperclip.service)"/environ \
  | tr '\0' '\n' \
  | grep '^PATH='

# 2. Cross-check that the env file resolves to the same PATH
systemctl show paperclip.service -p Environment -p EnvironmentFiles
sudo cat /etc/paperclip/paperclip.env | grep '^PATH='

# 3. Confirm the adapter binaries are reachable from that PATH
sudo -u luis env -i PATH="$(sudo cat /proc/"$(systemctl show -p MainPID --value paperclip.service)"/environ \
  | tr '\0' '\n' | grep '^PATH=' | cut -d= -f2-)" which claude opencode codex
```

If step 1 returns a `PATH=` line that does not include `~/.local/bin` (or wherever `claude` is installed), the env file is wrong or the service did not pick up the change — `sudo systemctl restart paperclip.service` and re-check.

If step 3 reports any of the three binaries missing, the symptom from SIMAA-2143 / SIMAA-2173 will return; install the CLI or extend `PATH` accordingly.

## Defense in depth: code-side fallback

Even with a correctly configured `paperclip.env`, the adapter code now consults a small list of well-known install locations when `PATH` lookup fails. The list is hard-coded in `packages/adapter-utils/src/server-utils.ts` (`defaultCommandFallbackDirs`) and covers `~/.local/bin`, `~/.npm-global/bin`, `~/.opencode/bin`, `~/.codex/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`. This is intentionally additive — `PATH` order is still respected first — so an operator's explicit configuration always wins.

Operators should still set `PATH` in `paperclip.env` rather than rely on the fallback alone. The fallback is meant to keep the system from breaking when the unit file is freshly bootstrapped or the env file is forgotten on a new host; it is not a substitute for declarative configuration.

## Related

- [`docker.md`](./docker.md) — containerized deploy (used elsewhere; not used on `dev-1`).
- [`overview.md`](./overview.md) — top-level deployment overview.
- SIMAA-2143 / SIMAA-2173 / SIMAA-2177 — historical context for why this guide exists.
