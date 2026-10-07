# Paperclip desktop app

A Tauri shell that runs the Paperclip server on the user's machine and shows its
board in a native window. Modeled on `unsloth-studio`'s shape: the native shell
owns the backend process, waits for it to become healthy, and only then reveals
the app.

What differs from unsloth-studio is what gets loaded. Paperclip's server serves
its own UI, so there is no second frontend to build or bundle — once
`/api/health` answers, the window navigates to the server origin and the rest is
the ordinary web app. The only bundled frontend is `ui/index.html`, a boot page
that carries startup status while the server comes up.

## Layout

| Path | What it is |
| --- | --- |
| `src-tauri/src/launch.rs` | Resolves how to start a server, picks the port, probes health |
| `src-tauri/src/server.rs` | Owns the child process: spawn, health gate, log pump, shutdown |
| `src-tauri/src/commands.rs` | `boot_info` / `restart_server` for the boot window |
| `src-tauri/src/lib.rs` | Window setup, startup sequencing, exit reaping |
| `ui/index.html` | Boot page; no bundler, uses the global Tauri bridge |
| `scripts/generate-icons.mjs` | Regenerates the icon set (`pnpm --dir desktop icons`) |

## Running it

```sh
# 1. Build a server for the shell to run (or point the shell at another one).
pnpm --filter @paperclipai/server build

# 2. Install the Tauri CLI and run the shell.
npm --prefix desktop install
npm --prefix desktop run dev
```

`desktop` is intentionally **not** a pnpm workspace member: the Tauri CLI is a
heavy platform-specific download that no other package needs, and keeping it out
means CI installs for the web app do not carry it.

## How the shell finds a server

Resolution walks from most explicit to most implicit, and a miss is a readable
error on the boot page rather than a crash:

1. `PAPERCLIP_DESKTOP_SERVER` — an argv string (quotes honored for paths with spaces).
2. `PAPERCLIP_DESKTOP_SERVER_ENTRY` — one path, run with `node` (`PAPERCLIP_DESKTOP_NODE` overrides the interpreter).
3. `server/dist/index.js` in a repository checkout, found from `PAPERCLIP_DESKTOP_REPO`, the working directory, or the executable's location.
4. `server/src/index.ts` in that checkout, run with the repo's own `tsx` — the same entrypoint `pnpm dev` uses, so a clone with no build step still runs.
5. `paperclipai run` on `PATH`. `run` is the subcommand that onboards, checks, and serves; bare `paperclipai` only prints help.

The shell sets `PAPERCLIP_BIND=loopback` and `PAPERCLIP_BIND_HOST=127.0.0.1` on the
child, so it overrides an instance config that was onboarded with `--bind lan`: a
desktop shell never publishes Paperclip to the network. It also sets
`PAPERCLIP_DISABLE_CWD_ENV_FILE=true`, because the child's working directory is
whatever the shell was launched from and must not decide which `.env` applies.

`PAPERCLIP_DESKTOP_PORT` overrides the port; otherwise the first free port at or
above 3100 is used. If a Paperclip server already answers there, the shell adopts
it instead of starting a second one against the same database. Adoption checks
that the response is Paperclip's health document, not merely any HTTP 200, so an
unrelated process holding the port is never adopted.

## Process lifetime

The shell is the server's parent, so it also owns reaping it:

- Server stdout and stderr are drained into
  `<app-log-dir>/paperclip-server.log`, flushed per line. Draining matters: a
  full pipe buffer would block the server forever, and buffering would hide a
  slow start from someone watching the boot page.
- Closing the window or quitting stops the child. On Windows the child is also
  assigned to a job object with `KILL_ON_JOB_CLOSE`, so killing the shell still
  kills the server. If that assignment fails — nested-job restrictions in a
  sandbox or some CI — the log says so instead of the guarantee disappearing
  quietly.
- Startup is a health gate, not a sleep: the window stays hidden until
  `/api/health` answers, then navigates. A failed start leaves the boot page up
  with the error, a retry action, and an "Open logs" action.
- The Windows and Unix shutdown paths are not equivalent. Windows terminates the
  process tree through the job object; Unix sends `SIGTERM`, waits, then kills.
  Only the Windows path has been exercised.
- A managed instance already serving on a port other than the shell's chosen one
  is not detected, so the shell can start a second server against the same
  default data directory. `paperclipai run` performs the CLI's own foreground-run
  guard, so the `PATH` resolution path is protected; the checkout paths are not.

## Verified

`npm run check` (fmt, clippy `-D warnings`, tests) and a Windows NSIS bundle were
run on this branch. The supervisor was exercised two ways: against a stub server,
where the child spawned on the resolved port, the health gate requested
`/api/health`, the webview loaded the origin, and the child was gone after the
app exited; and against the real server started from this checkout with no
server running beforehand, where the shell started it, `/api/health` answered
`200`, and `/` returned the 9,549-byte board document titled "Paperclip".

Not verified: Linux and macOS bundles, the Unix shutdown path, and adoption when
the instance already serves on a non-default port.