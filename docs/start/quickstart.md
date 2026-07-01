---
title: Quickstart
summary: Get Paperclip running in minutes
---

Get Paperclip running locally in under 5 minutes.

## Quick Start (Recommended)

```sh
npx paperclipai onboard --yes
```

This walks you through setup, configures your environment, and gets Paperclip running.

### Expected output

A successful run streams clack-style steps and finishes with a config summary. Exact box glyphs vary by terminal; the step labels and the final all-set line are what matter:

```text
paperclipai onboard
  Database ............. connection successful
  LLM Provider ......... API key is valid
  Quickstart ........... embedded database, file storage, local encrypted secrets
  Secrets .............. created PAPERCLIP_AGENT_JWT_SECRET in .env

Configuration saved
  Database: embedded
  LLM: <your provider>
  Server: local_trusted/private
  Storage: file
  Secrets: local-encrypted (strict mode off)

Next steps
  Run:         paperclipai run
  Reconfigure: paperclipai configure
  Diagnose:    paperclipai doctor

You're all set!
```


If you already have a Paperclip install, rerunning `onboard` keeps your current config and data paths intact. Use `paperclipai configure` if you want to edit settings.

To start Paperclip again later:

```sh
npx paperclipai run
```

> **Note:** If you used `npx` for setup, always use `npx paperclipai` to run commands. The `pnpm paperclipai` form only works inside a cloned copy of the Paperclip repository (see Local Development below).

## Local Development

For contributors working on Paperclip itself. Prerequisites: Node.js 20+ and pnpm 9+.

Clone the repository, then:

```sh
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3100](http://localhost:3100).

No external database required — Paperclip uses an embedded PostgreSQL instance by default.

When working from the cloned repo, you can also use:

```sh
pnpm paperclipai run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## Troubleshooting

Run `paperclipai doctor` first; it checks your config, database, and provider key, and auto-repairs what it can.

**All platforms**
- `Could not connect to database`: the embedded PostgreSQL did not start. Re-run `paperclipai doctor`, or make sure nothing else is bound to its port.
- `API key appears invalid`: re-enter your provider key with `paperclipai configure`.
- Port 3100 already in use: stop the other process, or set a different bind with `paperclipai configure`.
- `command not found: paperclipai`: you installed through npx, so prefix commands with `npx paperclipai`. The bare `paperclipai` and `pnpm paperclipai` forms only work inside a cloned repo.

**WSL (Windows)**
- Use a Linux-side Node via nvm, not the Windows Node on PATH; mixing them breaks the embedded database binary.
- Keep the project under the Linux home (for example ~/paperclip), not /mnt/c, or embedded storage will be slow and may fail to lock.
- Open the UI from Windows at http://localhost:3100 (WSL2 forwards localhost automatically).

**macOS**
- Requires Node 20+ and pnpm 9+ (brew install node pnpm). Check with `node -v`.
- On Apple Silicon, run a native arm64 Node so the embedded PostgreSQL binary matches your architecture.
- If Gatekeeper blocks a helper binary, allow it once under System Settings then Privacy and Security.

**Linux**
- Needs a recent glibc for the embedded PostgreSQL binary; on minimal or musl images, point Paperclip at an external database with `paperclipai configure`.
- If the UI does not load, confirm the server is listening on 3100 and not blocked by a local firewall.

## What's Next

Once Paperclip is running:

1. Create your first company in the web UI
2. Define a company goal
3. Create a CEO agent and configure its adapter
4. Build out the org chart with more agents
5. Set budgets and assign initial tasks
6. Hit go — agents start their heartbeats and the company runs

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind Paperclip
</Card>
