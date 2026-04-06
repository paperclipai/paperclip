---
title: macOS background service (LaunchAgent)
summary: Run Paperclip via launchd in your GUI session—no terminal window required, with logs and restart commands.
---

On macOS you can keep Paperclip running in the **background** using a **LaunchAgent** loaded in your **user GUI domain** (`gui/$(id -u)`). The job survives closing Terminal.app; it starts at login if `RunAtLoad` is enabled, and typically uses **`KeepAlive`** so `launchd` restarts the process if it exits.

This is **separate** from `pnpm dev` / `pnpm dev:once` in a terminal. Only one process should bind **`http://127.0.0.1:3100`**—do not run both the LaunchAgent and a dev server on the same port without stopping one of them.

## Repo template plist

> **Warning — replace every placeholder before use.** The example [`contrib/macos-launchagent/io.paperclip.local.plist`](https://github.com/paperclip-ai/paperclip/blob/master/contrib/macos-launchagent/io.paperclip.local.plist) uses generic placeholders such as **`/ABSOLUTE/PATH/TO/paperclip-repo`**, **`/Users/USERNAME`** (for `HOME`, `PAPERCLIP_HOME`, and log paths), and the Homebrew **`node`** path where shown. **Substitute real paths** for your machine, clone location, Node install, and log locations. Double-check each entry, then copy to `~/Library/LaunchAgents/` and run `launchctl bootstrap`; a wrong path fails silently or loops crash-only restarts.
>
> **Checklist:** repo root · Node binary · `tsx` / CLI entry · working directory · stdout log path · stderr log path · any extra paths in `EnvironmentVariables` or `ProgramArguments`.

A checked-in example:

- `contrib/macos-launchagent/io.paperclip.local.plist`

Copy it to `~/Library/LaunchAgents/` and load with `launchctl bootstrap` (see below).

The template sets recommended **environment variables** for a stable operator install:

| Variable | Purpose |
|----------|---------|
| `PAPERCLIP_MANAGED_BY_LAUNCHD=1` | Marks the process as the LaunchAgent service so [`scripts/kill-dev.sh`](https://github.com/paperclip-ai/paperclip/blob/master/scripts/kill-dev.sh) does **not** send SIGTERM to it. |
| `PAPERCLIP_STRICT_LISTEN_PORT=true` | Exit on startup if the configured port (e.g. 3100) is busy instead of silently binding the next free port (same boolean convention as other `PAPERCLIP_*` env flags: only the string `true` enables). |
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
  <string>true</string>
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

## Node memory: Paperclip vs test runners

A successful **`curl http://127.0.0.1:3100/api/health`** (e.g. HTTP **200**) only means the **Paperclip API** managed by your LaunchAgent (or a single dev server) is responding. It does **not** mean the machine has little RAM in use or that every **`node`** process in Activity Monitor belongs to Paperclip.

**Vitest** (and similar runners) spawn **multiple parallel Node workers** (`node (vitest 1)`, `node (vitest 2)`, …). Each worker can use **gigabytes** on a large monorepo. That memory is **independent** of the LaunchAgent process. Leftover workers also appear after **interrupted** test runs, **watch** mode left without a clean exit, or **several** terminals running tests at once—so total usage can climb into **tens of GB** while Paperclip still reports healthy.

**Diagnose**

```sh
pgrep -fl vitest
ps aux | grep -E '/paperclip(-[^/]+)?/' | grep node | grep -v grep
```

[`scripts/kill-dev.sh`](https://github.com/paperclip-ai/paperclip/blob/master/scripts/kill-dev.sh) targets Paperclip **dev** paths and skips `PAPERCLIP_MANAGED_BY_LAUNCHD`; it does **not** stop Vitest workers (different command lines).

**Clean up stray test workers** (stops Vitest processes on this user session—avoid if you rely on another Vitest run elsewhere):

```sh
pkill -f vitest
```

Or list PIDs with `pgrep -fl vitest` and **`kill`** specific ones.

**Reduce recurrence**

- Prefer **`vitest run`** for one-shot local runs; avoid leaving **`vitest --watch`** running unattended.
- This repo now caps root Vitest worker fan-out by default (`2` locally, `50%` on CI) via `vitest.config.ts`.
- Override when needed, e.g. **`PAPERCLIP_VITEST_MAX_WORKERS=4 pnpm test:run`** or `vitest run --maxWorkers=4`.

**LaunchAgent-specific:** keep **`PAPERCLIP_UI_DEV_MIDDLEWARE=false`** and a built UI so the **background** Paperclip process does not embed Vite (see env table above). That does **not** limit Vitest—you must manage test processes separately.

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

This prints a suggested `PATH=...` line you can merge into the plist (plain value, suitable for plist XML — not shell-escaped).

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

- **Repo `.env` and embedded Postgres:** the server loads **`$PAPERCLIP_HOME/instances/<id>/.env`**, then (if different) **`<WorkingDirectory>/.env`**. A development **`DATABASE_URL`** in the clone’s `.env` is ignored when **`config.json`** says **`embedded-postgres`** (so LaunchAgent with **`WorkingDirectory`** at the monorepo root still uses embedded DB). For a real external database, set **`database.mode`** to **`postgres`** and **`database.connectionString`** (or point **`DATABASE_URL`** only in that setup).
- The agent runs in **your login session**; logging out can stop GUI LaunchAgents depending on system settings.
- Before the first load (or after pulling large changes), run **`pnpm build`** at the repo root so `plugin-sdk`, server, and **UI** artifacts exist (`ui/dist` or packaged `server/ui-dist`). With `PAPERCLIP_UI_DEV_MIDDLEWARE=false`, `paperclipai doctor` fails until static UI artifacts are present (monorepo). Otherwise `paperclipai run` can fail with missing `dist` modules or fall back to API-only mode.
- Ensure **nothing else** is listening on the configured port (default **3100**) before bootstrap when using **`PAPERCLIP_STRICT_LISTEN_PORT=true`**; otherwise the process exits with a clear error instead of binding another port.
- If `paperclipai run` fails at boot, ensure the repo has been built (`pnpm build` / `paperclipai doctor`) so CLI dependencies resolve; see internal note `report/2026-03-30-launchd-startup-build-fix.md` for a historical example.
- Heartbeat recovery (orphan local PIDs after restart) is described in [Runtime runbook](/guides/board-operator/runtime-runbook).

## Related

- [Quickstart](/start/quickstart) — first-time local run
- [Developing](https://github.com/paperclip-ai/paperclip/blob/master/doc/DEVELOPING.md) (`doc/DEVELOPING.md` in repo) — `pnpm dev` vs `dev:once` vs CLI `run`
