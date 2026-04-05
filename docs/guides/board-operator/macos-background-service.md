---
title: macOS background service (LaunchAgent)
summary: Run Paperclip via launchd in your GUI session—no terminal window required, with logs and restart commands.
---

On macOS you can keep Paperclip running in the **background** using a **LaunchAgent** loaded in your **user GUI domain** (`gui/$(id -u)`). The job survives closing Terminal.app; it starts at login if `RunAtLoad` is enabled, and typically uses **`KeepAlive`** so `launchd` restarts the process if it exits.

This is **separate** from `pnpm dev` / `pnpm dev:once` in a terminal. Only one process should bind **`http://127.0.0.1:3100`**—do not run both the LaunchAgent and a dev server on the same port without stopping one of them.

## Repo template plist

A checked-in example (edit paths if your clone or username differs):

- `contrib/macos-launchagent/io.paperclip.local.plist`

Copy it to `~/Library/LaunchAgents/` and load with `launchctl bootstrap` (see below).

The template sets recommended **environment variables** for a stable operator install:

| Variable | Purpose |
|----------|---------|
| `PAPERCLIP_MANAGED_BY_LAUNCHD=1` | Marks the process as the LaunchAgent service so [`scripts/kill-dev.sh`](https://github.com/paperclip-ai/paperclip/blob/master/scripts/kill-dev.sh) does **not** send SIGTERM to it. |
| `PAPERCLIP_STRICT_LISTEN_PORT=1` | Exit on startup if the configured port (e.g. 3100) is busy instead of silently binding the next free port. |
| `PAPERCLIP_UI_DEV_MIDDLEWARE=false` | Serve the built UI from static assets (`pnpm build`) instead of embedding Vite (lower memory; avoids typical dev middleware failures under launchd). |
| `SERVE_UI=true` | Keep the board UI enabled (default, set explicitly for clarity). |
| `NODE_OPTIONS=--max-old-space-size=8192` | Reduces out-of-memory risk during startup. |

## `kill-dev.sh` vs LaunchAgent

[`scripts/kill-dev.sh`](https://github.com/paperclip-ai/paperclip/blob/master/scripts/kill-dev.sh) terminates Node processes whose command line looks like a Paperclip checkout. Processes that include **`PAPERCLIP_MANAGED_BY_LAUNCHD=1`** (or `=true`) in their environment are **skipped** so your background service keeps running.

To **stop** the LaunchAgent-managed server intentionally:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
```

## Typical layout (example)

Adjust paths to match your machine and clone location.

| Item | Example |
|------|--------|
| **Plist** | `~/Library/LaunchAgents/io.paperclip.local.plist` |
| **Label** | `io.paperclip.local` |
| **Working directory** | Your repo root (e.g. `~/paperclip` or `~/src/paperclip`) |
| **Program** | Homebrew Node: `/opt/homebrew/bin/node` |
| **Arguments** | `tsx` CLI then `cli/src/index.ts` **`run`** (same idea as `pnpm paperclipai run`) |
| **Env** | `HOME`, `PATH` (see [PATH and local adapters](#path-and-local-adapters)), `PAPERCLIP_HOME` (e.g. `~/.paperclip`), optional `PAPERCLIP_INSTANCE_ID` (default `default`) |
| **Stdout / stderr** | e.g. `~/.paperclip/launchd.stdout.log` and `~/.paperclip/launchd.stderr.log` |

A minimal plist shape:

```xml
<key>Label</key>
<string>io.paperclip.local</string>
<key>WorkingDirectory</key>
<string>/ABSOLUTE/PATH/TO/paperclip-repo</string>
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/ABSOLUTE/PATH/TO/paperclip-repo/cli/node_modules/tsx/dist/cli.mjs</string>
  <string>/ABSOLUTE/PATH/TO/paperclip-repo/cli/src/index.ts</string>
  <string>run</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>PAPERCLIP_MANAGED_BY_LAUNCHD</key>
  <string>1</string>
  <key>PAPERCLIP_STRICT_LISTEN_PORT</key>
  <string>1</string>
  <key>PAPERCLIP_UI_DEV_MIDDLEWARE</key>
  <string>false</string>
  <key>SERVE_UI</key>
  <string>true</string>
</dict>
<key>RunAtLoad</key>
<true/>
<key>KeepAlive</key>
<true/>
```

After changing the plist, reload the agent:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
```

## Restart without editing the plist

```sh
launchctl kickstart -k "gui/$(id -u)/io.paperclip.local"
```

## Verify

```sh
launchctl print "gui/$(id -u)/io.paperclip.local" | head -30
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/api/health
```

With static UI (`PAPERCLIP_UI_DEV_MIDDLEWARE=false`), you should **not** see a separate listener for Vite HMR (e.g. port **13100** when the API is on 3100). If you still see it, confirm the plist sets `PAPERCLIP_UI_DEV_MIDDLEWARE=false` and reload the agent.

## PATH and local adapters

LaunchAgents use the `PATH` from the plist only (not your interactive shell). If local adapters (Codex, OpenCode, tools installed via nvm/fnm, etc.) work in Terminal but not under launchd, merge in the PATH from a shell where they work:

```sh
# From Terminal, after adapters work:
printenv PATH
```

Copy the result into the plist `PATH` value, ensuring **`/opt/homebrew/bin`** (or Intel Homebrew) remains present for `node` if you invoke it by bare name.

Helper (repo root):

```sh
./scripts/print-launchagent-path-hint.sh
```

This prints a suggested `PATH=...` line you can merge into the plist.

## Stderr log vs current health

`launchd.stderr.log` is **append-only**. A stack trace or `FatalProcessOutOfMemory` at the end of the file may be from a **previous** crash after `KeepAlive` restarted the process. Always confirm the live state with `launchctl print` and `curl /api/health` before assuming the current run is broken.

To reduce noise after an incident you may truncate or archive the log files (with the agent stopped, if you want a clean file):

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
: > ~/.paperclip/launchd.stderr.log
: > ~/.paperclip/launchd.stdout.log
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/io.paperclip.local.plist
```

## Operational notes

- The agent runs in **your login session**; logging out can stop GUI LaunchAgents depending on system settings.
- Before the first load (or after pulling large changes), run **`pnpm build`** at the repo root so `plugin-sdk`, server, and **UI** artifacts exist (`ui/dist` or packaged `server/ui-dist`). With `PAPERCLIP_UI_DEV_MIDDLEWARE=false`, `paperclipai doctor` fails until static UI artifacts are present (monorepo). Otherwise `paperclipai run` can fail with missing `dist` modules or fall back to API-only mode.
- Ensure **nothing else** is listening on the configured port (default **3100**) before bootstrap when using **`PAPERCLIP_STRICT_LISTEN_PORT=1`**; otherwise the process exits with a clear error instead of binding another port.
- If `paperclipai run` fails at boot, ensure the repo has been built (`pnpm build` / `paperclipai doctor`) so CLI dependencies resolve; see internal note `report/2026-03-30-launchd-startup-build-fix.md` for a historical example.
- Heartbeat recovery (orphan local PIDs after restart) is described in [Runtime runbook](/guides/board-operator/runtime-runbook).

## Related

- [Quickstart](/start/quickstart) — first-time local run
- [Developing](https://github.com/paperclip-ai/paperclip/blob/master/doc/DEVELOPING.md) (`doc/DEVELOPING.md` in repo) — `pnpm dev` vs `dev:once` vs CLI `run`
